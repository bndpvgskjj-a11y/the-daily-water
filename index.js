// The Daily Water – Vercel Serverless Function v6
// Maximales Debugging um GNews Key Problem zu identifizieren

export const config = { maxDuration: 60 };

const GNEWS = "https://gnews.io/api/v4";

const CATS = {
  aalen:       { q:"Aalen",          lang:"de", ctx:"Lokalnachrichten aus Aalen, Ostalbkreis, Baden-Württemberg, Deutschland" },
  deutschland: { q:"Germany",        lang:"en", ctx:"Wichtigste aktuelle Nachrichten aus Deutschland, auf Deutsch zusammenfassen" },
  welt:        { q:"world",          lang:"en", ctx:"Wichtigste weltweite Nachrichten, auf Deutsch zusammenfassen" },
  water4you:   { q:"water",          lang:"en", ctx:"Nachrichten zu Wasserversorgung und Wasserwirtschaft für Water 4 You GmbH, auf Deutsch" },
  zielmaerkte: { q:"infrastructure", lang:"en", ctx:"Wasser- und Infrastrukturprojekte weltweit, auf Deutsch" },
  philippinen: { q:"Philippines",    lang:"en", ctx:"Aktuelle Nachrichten aus den Philippinen, auf Deutsch" },
  business:    { q:"business",       lang:"en", ctx:"Wirtschafts- und Business-Nachrichten, auf Deutsch" },
  ki_tech:     { q:"technology",     lang:"en", ctx:"KI und Technologienachrichten, auf Deutsch" },
  aktien:      { q:"stocks",         lang:"en", ctx:"Aktienmarkt und Finanznachrichten, auf Deutsch" },
};

async function askClaude(apiKey, system, user, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 5000 * i));
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2500,
        system,
        messages: [{ role: "user", content: user }]
      })
    });
    const d = await r.json();
    if (r.status === 429 && i < retries) continue;
    if (!r.ok) throw new Error("Claude " + r.status + ": " + (d?.error?.message || "Fehler"));
    return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  }
  throw new Error("Claude Rate-Limit. Bitte 1 Minute warten.");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")    { res.status(405).end(); return; }

  const AKEY = process.env.ANTHROPIC_API_KEY;
  const GKEY = process.env.GNEWS_API_KEY;

  if (!AKEY) { res.status(500).json({ error: { message: "❌ ANTHROPIC_API_KEY fehlt in Vercel → Settings → Environment Variables" } }); return; }
  if (!GKEY) { res.status(500).json({ error: { message: "❌ GNEWS_API_KEY fehlt in Vercel → Settings → Environment Variables" } }); return; }

  // Key-Format prüfen (GNews Keys sind 40 Zeichen hex)
  if (GKEY.length < 20) {
    res.status(500).json({ error: { message: "❌ GNEWS_API_KEY scheint ungültig (zu kurz: " + GKEY.length + " Zeichen). Bitte Key auf gnews.io prüfen." } });
    return;
  }

  const { category } = req.body || {};
  const cat = CATS[category];
  if (!cat) { res.status(400).json({ error: { message: "Unbekannte Kategorie: " + category } }); return; }

  try {
    // ── Schritt 1: GNews ──────────────────────────────────────────────────
    const params = new URLSearchParams({
      apikey: GKEY,
      q:      cat.q,
      lang:   cat.lang,
      max:    "8",
      sortby: "publishedAt"
    });
    const gnewsUrl = GNEWS + "/search?" + params;
    const nr = await fetch(gnewsUrl);

    // Rohantwort lesen (könnte kein JSON sein)
    const rawBody = await nr.text();
    let nd;
    try {
      nd = JSON.parse(rawBody);
    } catch(e) {
      throw new Error("GNews antwortete kein JSON (HTTP " + nr.status + "): " + rawBody.slice(0, 200));
    }

    if (!nr.ok) {
      throw new Error("GNews HTTP " + nr.status + ": " + JSON.stringify(nd));
    }
    if (nd.errors && nd.errors.length > 0) {
      throw new Error("GNews API Fehler: " + JSON.stringify(nd.errors) + " | Key-Länge: " + GKEY.length);
    }

    const arts = (nd.articles || [])
      .filter(a => a.title && a.description && !a.title.includes("[Removed]"))
      .slice(0, 6);

    if (arts.length === 0) {
      throw new Error("GNews: 0 Artikel. totalArticles=" + nd.totalArticles + " | Query: q=" + cat.q + " lang=" + cat.lang);
    }

    // ── Schritt 2: Claude ─────────────────────────────────────────────────
    const input = arts.map((a, i) =>
      "[" + (i+1) + "] " + a.title +
      "\nSource: " + (a.source?.name || "–") +
      " | " + (a.publishedAt || "").slice(0, 10) +
      "\n" + (a.description || "") +
      "\nImage: " + (a.image || "") +
      "\nURL: " + (a.url || "")
    ).join("\n\n");

    const raw = await askClaude(
      AKEY,
      "Du antwortest AUSSCHLIESSLICH mit einem validen JSON-Array. Kein Text davor oder danach. Keine Codeblöcke. Nur das Array.",
      "Kontext: " + cat.ctx + "\n\n" +
      arts.length + " echte aktuelle Artikel:\n\n" + input + "\n\n" +
      "JSON-Array auf Deutsch:\n" +
      '[{"title":"Titel auf Deutsch max 12 Wörter","category":"Thema","source":"Quelle","date":"TT.MM.JJJJ","summary":"2-3 Sätze auf Deutsch.","fullText":"6-8 Sätze auf Deutsch.","relevance":"hoch","imageUrl":"Bild-URL oder leerer String","articleUrl":"Artikel-URL"}]'
    );

    // ── Schritt 3: JSON ───────────────────────────────────────────────────
    const s = raw.indexOf("[");
    const e = raw.lastIndexOf("]");
    if (s < 0 || e <= s) throw new Error("Kein JSON. Claude: \"" + raw.slice(0, 200) + "\"");

    const result = JSON.parse(raw.slice(s, e + 1));
    if (!Array.isArray(result) || !result.length) throw new Error("Leeres Array.");

    res.status(200).json({ articles: result });

  } catch (err) {
    console.error("[daily-water]", category, err.message);
    res.status(500).json({ error: { message: err.message } });
  }
}
