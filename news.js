// The Daily Water v5.1 – Einfache GNews Queries ohne OR-Operatoren

export const config = { maxDuration: 60 };

const GNEWS = "https://gnews.io/api/v4";

const CATS = {
  aalen:       { q:"Aalen Ostalbkreis",          lang:"de", ctx:"Lokalnachrichten Region Aalen, Ostalbkreis, Baden-Württemberg" },
  deutschland: { q:"Deutschland aktuell",         lang:"de", ctx:"Wichtigste Nachrichten aus Deutschland heute" },
  welt:        { q:"world news today",            lang:"en", ctx:"Wichtigste weltweite Nachrichten" },
  water4you:   { q:"Wasserversorgung Trinkwasser",lang:"de", ctx:"Nachrichten für Wasserversorger Water 4 You GmbH Aalen" },
  zielmaerkte: { q:"water infrastructure project",lang:"en", ctx:"Wasserprojekte in Naher Osten, Afrika, Asien, Lateinamerika" },
  philippinen: { q:"Philippines news",            lang:"en", ctx:"Aktuelle Nachrichten aus den Philippinen" },
  business:    { q:"Wirtschaft Unternehmen",      lang:"de", ctx:"Business und Wirtschaftsnachrichten" },
  ki_tech:     { q:"Künstliche Intelligenz KI",   lang:"de", ctx:"KI und Technologienachrichten" },
  aktien:      { q:"DAX Börse Aktien",            lang:"de", ctx:"Aktienmarkt und Finanznachrichten" },
};

async function askClaude(apiKey, system, user, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 4000 * i));
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
    if (!r.ok) throw new Error(`Claude ${r.status}: ${d?.error?.message}`);
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

  if (!AKEY) { res.status(500).json({ error: { message: "ANTHROPIC_API_KEY fehlt in Vercel Environment Variables" } }); return; }
  if (!GKEY) { res.status(500).json({ error: { message: "GNEWS_API_KEY fehlt in Vercel Environment Variables" } }); return; }

  const { category } = req.body || {};
  const cat = CATS[category];
  if (!cat) { res.status(400).json({ error: { message: "Unbekannte Kategorie: " + category } }); return; }

  try {
    // ── 1. GNews: einfacher Query ohne Operatoren ─────────────────────────
    const params = new URLSearchParams({
      apikey: GKEY,
      q:      cat.q,
      lang:   cat.lang || "de",
      max:    "8"
    });
    const nr = await fetch(`${GNEWS}/search?${params}`);
    const nd = await nr.json();

    if (!nr.ok) throw new Error(`GNews ${nr.status}: ${JSON.stringify(nd).slice(0, 200)}`);
    if (nd.errors) throw new Error(`GNews: ${JSON.stringify(nd.errors)}`);

    const arts = (nd.articles || [])
      .filter(a => a.title && a.description && !a.title.includes("[Removed]"))
      .slice(0, 6);

    if (arts.length === 0) throw new Error(`GNews: 0 Artikel für "${cat.q}". Antwort: ${JSON.stringify(nd).slice(0, 200)}`);

    // ── 2. Claude: Zusammenfassung ────────────────────────────────────────
    const input = arts.map((a, i) =>
      `[${i+1}] ${a.title}\nQuelle: ${a.source?.name || "–"} | ${(a.publishedAt || "").slice(0, 10)}\n${a.description || ""}\nBild: ${a.image || ""}\nURL: ${a.url || ""}`
    ).join("\n\n");

    const raw = await askClaude(
      AKEY,
      "Antworte NUR mit einem JSON-Array. Kein Text davor oder danach. Keine Codeblöcke. Nur [ ... ].",
      `Kontext: ${cat.ctx}\n\n${arts.length} echte Artikel:\n\n${input}\n\nJSON-Array auf Deutsch, ein Objekt pro Artikel:\n[{"title":"max 12 Wörter","category":"1-2 Wörter","source":"Quellenname","date":"TT.MM.JJJJ","summary":"2-3 Sätze.","fullText":"6-8 Sätze.","relevance":"hoch","imageUrl":"Bild-URL oder leer","articleUrl":"Artikel-URL"}]`
    );

    const s = raw.indexOf("[");
    const e = raw.lastIndexOf("]");
    if (s < 0 || e <= s) throw new Error(`Kein JSON. Claude antwortete: "${raw.slice(0, 150)}"`);

    const result = JSON.parse(raw.slice(s, e + 1));
    if (!Array.isArray(result) || !result.length) throw new Error("Claude: leeres Array");

    res.status(200).json({ articles: result });

  } catch (err) {
    console.error("[daily-water]", category, err.message);
    res.status(500).json({ error: { message: err.message } });
  }
}
