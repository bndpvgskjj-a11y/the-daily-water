// The Daily Water – Vercel Serverless Function
// GNews (einzelne englische Keywords) + Claude (Zusammenfassung auf Deutsch)

export const config = { maxDuration: 60 };

const GNEWS = "https://gnews.io/api/v4";

// Nur einzelne Wörter oder sehr kurze englische Phrasen
// GNews Free akzeptiert diese am zuverlässigsten
const CATS = {
  aalen:       { q:"Aalen",          lang:"de", ctx:"Lokalnachrichten aus Aalen, Ostalbkreis, Baden-Württemberg, Deutschland" },
  deutschland: { q:"Germany",        lang:"en", ctx:"Wichtigste aktuelle Nachrichten aus Deutschland – bitte auf Deutsch zusammenfassen" },
  welt:        { q:"world",          lang:"en", ctx:"Wichtigste weltweite Nachrichten – bitte auf Deutsch zusammenfassen" },
  water4you:   { q:"water",          lang:"en", ctx:"Nachrichten zu Wasserversorgung, Trinkwasser, Wasserwirtschaft – für Water 4 You GmbH Aalen – auf Deutsch" },
  zielmaerkte: { q:"infrastructure", lang:"en", ctx:"Wasser- und Infrastrukturprojekte in Naher Osten, Afrika, Asien, Lateinamerika – auf Deutsch" },
  philippinen: { q:"Philippines",    lang:"en", ctx:"Aktuelle Nachrichten aus den Philippinen – auf Deutsch zusammenfassen" },
  business:    { q:"business",       lang:"en", ctx:"Aktuelle Wirtschafts- und Business-Nachrichten – auf Deutsch zusammenfassen" },
  ki_tech:     { q:"technology",     lang:"en", ctx:"KI und Technologienachrichten – auf Deutsch zusammenfassen" },
  aktien:      { q:"stocks",         lang:"en", ctx:"Aktienmarkt, DAX, Börsen, Finanznachrichten – auf Deutsch zusammenfassen" },
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

  if (!AKEY) { res.status(500).json({ error: { message: "ANTHROPIC_API_KEY fehlt → Vercel Settings → Environment Variables" } }); return; }
  if (!GKEY) { res.status(500).json({ error: { message: "GNEWS_API_KEY fehlt → Vercel Settings → Environment Variables" } }); return; }

  const { category } = req.body || {};
  const cat = CATS[category];
  if (!cat) { res.status(400).json({ error: { message: "Unbekannte Kategorie: " + category } }); return; }

  try {
    // ── Schritt 1: Artikel von GNews ─────────────────────────────────────
    const url = GNEWS + "/search?" + new URLSearchParams({
      apikey: GKEY,
      q:      cat.q,
      lang:   cat.lang,
      max:    "8",
      sortby: "publishedAt"
    });

    const nr = await fetch(url);
    const nd = await nr.json();

    if (!nr.ok)    throw new Error("GNews " + nr.status + ": " + JSON.stringify(nd).slice(0, 300));
    if (nd.errors) throw new Error("GNews Fehler: " + JSON.stringify(nd.errors).slice(0, 300));

    const arts = (nd.articles || [])
      .filter(a => a.title && a.description && !a.title.includes("[Removed]"))
      .slice(0, 6);

    if (arts.length === 0) {
      throw new Error("GNews: Keine Artikel. Volle Antwort: " + JSON.stringify(nd).slice(0, 400));
    }

    // ── Schritt 2: Claude fasst zusammen ─────────────────────────────────
    const input = arts.map((a, i) =>
      "[" + (i+1) + "] " + a.title +
      "\nSource: " + (a.source?.name || "–") +
      " | Date: " + (a.publishedAt || "").slice(0, 10) +
      "\n" + (a.description || "") +
      "\nImage: " + (a.image || "") +
      "\nURL: " + (a.url || "")
    ).join("\n\n");

    const raw = await askClaude(
      AKEY,
      "Du antwortest AUSSCHLIESSLICH mit einem validen JSON-Array. Kein Text davor oder danach. Keine Codeblöcke. Nur das Array.",
      "Kontext: " + cat.ctx + "\n\n" +
      "Hier sind " + arts.length + " echte aktuelle Nachrichtenartikel:\n\n" + input + "\n\n" +
      "Erstelle auf DEUTSCH für jeden Artikel ein JSON-Objekt. Antworte NUR mit diesem Array:\n" +
      '[{"title":"Titel auf Deutsch, max 12 Wörter","category":"Thema 1-2 Wörter","source":"Quellenname","date":"TT.MM.JJJJ","summary":"2-3 Sätze Zusammenfassung auf Deutsch.","fullText":"6-8 Sätze ausführlicher Text auf Deutsch.","relevance":"hoch","imageUrl":"Bild-URL aus Artikel oder leerer String","articleUrl":"Artikel-URL"}]'
    );

    // ── Schritt 3: JSON extrahieren ───────────────────────────────────────
    const s = raw.indexOf("[");
    const e = raw.lastIndexOf("]");
    if (s < 0 || e <= s) throw new Error("Kein JSON. Claude antwortete: \"" + raw.slice(0, 200) + "\"");

    const result = JSON.parse(raw.slice(s, e + 1));
    if (!Array.isArray(result) || !result.length) throw new Error("Leeres Array von Claude.");

    res.status(200).json({ articles: result });

  } catch (err) {
    console.error("[daily-water]", category, err.message);
    res.status(500).json({ error: { message: err.message } });
  }
}
