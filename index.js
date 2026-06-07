// The Daily Water – Vercel Serverless Function
// Primär: Echte Artikel von GNews
// Fallback: Claude generiert aus eigenem Wissen wenn GNews fehlschlägt

export const config = { maxDuration: 60 };

const GNEWS = "https://gnews.io/api/v4";

const CATS = {
  aalen:       { q:"Aalen",          lang:"de", ctx:"Lokalnachrichten aus Aalen, Ostalbkreis, Baden-Württemberg" },
  deutschland: { q:"Germany",        lang:"en", ctx:"Wichtigste aktuelle Nachrichten aus Deutschland" },
  welt:        { q:"world",          lang:"en", ctx:"Wichtigste weltweite Nachrichten und Ereignisse" },
  water4you:   { q:"water",          lang:"en", ctx:"Wasserversorgung, Trinkwasser, Wasserwirtschaft – für Water 4 You GmbH Aalen" },
  zielmaerkte: { q:"infrastructure", lang:"en", ctx:"Wasser- und Infrastrukturprojekte in Naher Osten, Afrika, Asien, Lateinamerika" },
  philippinen: { q:"Philippines",    lang:"en", ctx:"Aktuelle Nachrichten aus den Philippinen" },
  business:    { q:"business",       lang:"en", ctx:"Wirtschaft, Unternehmen, Märkte, M&A" },
  ki_tech:     { q:"technology",     lang:"en", ctx:"KI und Technologie – neue Modelle, Regulierung, Startups" },
  aktien:      { q:"stocks",         lang:"en", ctx:"Aktienmarkt, DAX, Börse, Finanzen, Zinsen" },
};

const FALLBACK_PROMPTS = {
  aalen:       "Erstelle 5 realistische aktuelle Lokalnachrichten für die Region Aalen (Ostalbkreis, Baden-Württemberg): Stadtpolitik, Wirtschaft, Kultur, Sport, Infrastruktur.",
  deutschland: "Erstelle 5 realistische aktuelle Nachrichten aus Deutschland: Bundespolitik, Wirtschaft, Gesellschaft, Energie, Recht.",
  welt:        "Erstelle 5 realistische aktuelle Weltnachrichten: internationale Politik, Konflikte, Diplomatie, Klimawandel, Wirtschaft.",
  water4you:   "Erstelle 5 realistische aktuelle Nachrichten zur Wasserwirtschaft: Trinkwasserqualität, EU-Regulierung, Aufbereitungstechnologie, Wasserknappheit, Infrastrukturprojekte.",
  zielmaerkte: "Erstelle 5 realistische aktuelle Nachrichten über Wasser-Infrastrukturprojekte in: Naher Osten (Saudi-Arabien, VAE), Afrika, Südostasien, Indien, Lateinamerika.",
  philippinen: "Erstelle 5 realistische aktuelle Nachrichten aus den Philippinen: Politik, Wirtschaft, Naturereignisse, internationale Beziehungen, Infrastruktur.",
  business:    "Erstelle 5 realistische aktuelle Business-Nachrichten: M&A-Deals, Quartalsergebnisse, CEO-Wechsel, Rohstoffe, globale Wirtschaftstrends.",
  ki_tech:     "Erstelle 5 realistische aktuelle KI- und Tech-Nachrichten: neue KI-Modelle, Regulierung EU/USA, Cybersecurity, Halbleiter, Big Tech.",
  aktien:      "Erstelle 5 realistische aktuelle Finanznachrichten: DAX/Dow/S&P 500 Entwicklungen, Wasser-Aktien (Veolia, Xylem), Zinspolitik EZB/Fed, Rohöl, Gold.",
};

async function callClaude(apiKey, system, user, retries = 2) {
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

function parseJSON(raw) {
  const s = raw.indexOf("[");
  const e = raw.lastIndexOf("]");
  if (s < 0 || e <= s) throw new Error("Kein JSON-Array in Antwort: \"" + raw.slice(0, 150) + "\"");
  const arr = JSON.parse(raw.slice(s, e + 1));
  if (!Array.isArray(arr) || !arr.length) throw new Error("Leeres Array.");
  return arr;
}

const JSON_SCHEMA = '[{"title":"Titel auf Deutsch max 12 Wörter","category":"Thema","source":"Quellenname","date":"TT.MM.JJJJ","summary":"2-3 Sätze auf Deutsch.","fullText":"6-8 Sätze auf Deutsch.","relevance":"hoch","imageUrl":"","articleUrl":""}]';
const SYSTEM_PROMPT = "Du antwortest AUSSCHLIESSLICH mit einem validen JSON-Array. Kein Text davor oder danach. Keine Codeblöcke. Nur [ ... ].";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")    { res.status(405).end(); return; }

  const AKEY = process.env.ANTHROPIC_API_KEY;
  const GKEY = process.env.GNEWS_API_KEY;

  if (!AKEY) { res.status(500).json({ error: { message: "ANTHROPIC_API_KEY fehlt in Vercel → Settings → Environment Variables" } }); return; }

  const { category } = req.body || {};
  const cat = CATS[category];
  if (!cat) { res.status(400).json({ error: { message: "Unbekannte Kategorie: " + category } }); return; }

  // ── Versuch 1: GNews + Claude ─────────────────────────────────────────
  if (GKEY && GKEY.length > 20) {
    try {
      const params = new URLSearchParams({
        apikey: GKEY,
        q:      cat.q,
        lang:   cat.lang,
        max:    "8",
        sortby: "publishedAt"
      });
      const nr = await fetch(GNEWS + "/search?" + params);
      const bodyText = await nr.text();
      const nd = JSON.parse(bodyText);

      if (nr.ok && !nd.errors && nd.articles?.length > 0) {
        const arts = nd.articles
          .filter(a => a.title && a.description && !a.title.includes("[Removed]"))
          .slice(0, 6);

        if (arts.length > 0) {
          const input = arts.map((a, i) =>
            "[" + (i+1) + "] " + a.title +
            "\nSource: " + (a.source?.name || "–") +
            " | " + (a.publishedAt || "").slice(0, 10) +
            "\n" + (a.description || "") +
            "\nImage: " + (a.image || "") +
            "\nURL: " + (a.url || "")
          ).join("\n\n");

          const raw = await callClaude(
            AKEY,
            SYSTEM_PROMPT,
            "Kontext: " + cat.ctx + "\n\n" + arts.length + " echte Artikel:\n\n" + input + "\n\nJSON auf Deutsch:\n" + JSON_SCHEMA
          );

          const result = parseJSON(raw);
          res.status(200).json({ articles: result, source: "gnews" });
          return;
        }
      }
      // GNews hat Fehler → Fallback
      console.log("[daily-water] GNews Fehler für", category, "→ Fallback. Body:", bodyText.slice(0, 200));
    } catch(e) {
      console.log("[daily-water] GNews Exception für", category, "→ Fallback:", e.message);
    }
  }

  // ── Fallback: Claude aus eigenem Wissen ───────────────────────────────
  try {
    const today = new Date().toLocaleDateString("de-DE");
    const raw = await callClaude(
      AKEY,
      SYSTEM_PROMPT,
      FALLBACK_PROMPTS[category] +
      "\nHeutiges Datum: " + today +
      "\nAntworte NUR mit diesem JSON-Array (5 Objekte):\n" + JSON_SCHEMA
    );

    const result = parseJSON(raw);
    res.status(200).json({ articles: result, source: "claude-fallback" });

  } catch(err) {
    console.error("[daily-water]", category, err.message);
    res.status(500).json({ error: { message: err.message } });
  }
}
