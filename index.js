// The Daily Water – Vercel Serverless Function
// The Guardian API (primär) + GNews (sekundär) + Claude Zusammenfassung

export const config = { maxDuration: 60 };

// The Guardian API - kostenlos, zuverlässig, kein Query-Format-Problem
const GUARDIAN = "https://content.guardianapis.com/search";

// GNews als Backup
const GNEWS = "https://gnews.io/api/v4/search";

const CATS = {
  aalen: {
    guardian: null, // Guardian hat keine Lokalnachrichten Aalen
    gnews:    { q: "Aalen", lang: "de" },
    ctx: "Lokalnachrichten aus Aalen, Ostalbkreis, Baden-Württemberg"
  },
  deutschland: {
    guardian: { q: "Germany", section: "world" },
    gnews:    { q: "Germany", lang: "en" },
    ctx: "Wichtigste aktuelle Nachrichten aus Deutschland"
  },
  welt: {
    guardian: { q: "world news", section: "world" },
    gnews:    { q: "world", lang: "en" },
    ctx: "Wichtigste weltweite Nachrichten"
  },
  water4you: {
    guardian: { q: "water supply drinking water", section: "environment" },
    gnews:    { q: "water", lang: "en" },
    ctx: "Wasserversorgung, Trinkwasser, Wasserwirtschaft – Water 4 You GmbH"
  },
  zielmaerkte: {
    guardian: { q: "water infrastructure Middle East Africa Asia" },
    gnews:    { q: "infrastructure", lang: "en" },
    ctx: "Wasser-Infrastrukturprojekte in Naher Osten, Afrika, Asien, Lateinamerika"
  },
  philippinen: {
    guardian: { q: "Philippines", section: "world" },
    gnews:    { q: "Philippines", lang: "en" },
    ctx: "Aktuelle Nachrichten aus den Philippinen"
  },
  business: {
    guardian: { q: "business economy", section: "business" },
    gnews:    { q: "business", lang: "en" },
    ctx: "Wirtschaft, Business, Märkte, Unternehmen"
  },
  ki_tech: {
    guardian: { q: "artificial intelligence technology", section: "technology" },
    gnews:    { q: "technology", lang: "en" },
    ctx: "KI und Technologie – neue Modelle, Regulierung, Startups"
  },
  aktien: {
    guardian: { q: "stock market finance DAX", section: "business" },
    gnews:    { q: "stocks", lang: "en" },
    ctx: "Aktienmarkt, Börse, DAX, Finanzen, Zinsen"
  }
};

async function fetchGuardian(apiKey, params) {
  const p = new URLSearchParams({
    "api-key": apiKey,
    "show-fields": "thumbnail,trailText,bodyText",
    "page-size": "8",
    "order-by": "newest",
    ...params
  });
  const r = await fetch(GUARDIAN + "?" + p);
  const d = await r.json();
  if (!r.ok || d.response?.status !== "ok") return [];
  return (d.response?.results || [])
    .filter(a => a.webTitle && (a.fields?.trailText || a.fields?.bodyText))
    .slice(0, 6)
    .map(a => ({
      title:       a.webTitle,
      description: a.fields?.trailText || a.fields?.bodyText?.slice(0, 300) || "",
      image:       a.fields?.thumbnail || "",
      url:         a.webUrl,
      source:      "The Guardian",
      date:        (a.webPublicationDate || "").slice(0, 10)
    }));
}

async function fetchGNews(apiKey, params) {
  const p = new URLSearchParams({
    apikey: apiKey,
    max: "8",
    sortby: "publishedAt",
    ...params
  });
  const r = await fetch(GNEWS + "?" + p);
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch { return []; }
  if (!r.ok || d.errors) return [];
  return (d.articles || [])
    .filter(a => a.title && a.description && !a.title.includes("[Removed]"))
    .slice(0, 6)
    .map(a => ({
      title:       a.title,
      description: a.description || "",
      image:       a.image || "",
      url:         a.url,
      source:      a.source?.name || "GNews",
      date:        (a.publishedAt || "").slice(0, 10)
    }));
}

async function callClaude(apiKey, articles, ctx, retries = 2) {
  const input = articles.map((a, i) =>
    `[${i+1}] ${a.title}\nQuelle: ${a.source} | ${a.date}\n${a.description}\nBild: ${a.image}\nURL: ${a.url}`
  ).join("\n\n");

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
        max_tokens: 3000,
        system: "Antworte NUR mit einem JSON-Array. Kein Text davor/danach. Keine Codeblöcke. Nur [ ... ].",
        messages: [{
          role: "user",
          content: `Kontext: ${ctx}\n\n${articles.length} echte Artikel:\n\n${input}\n\nJSON-Array auf Deutsch:\n[{"title":"Titel auf Deutsch max 12 Wörter","category":"Thema","source":"Quellenname","date":"TT.MM.JJJJ","summary":"2-3 Sätze auf Deutsch.","fullText":"6-8 Sätze auf Deutsch.","relevance":"hoch","imageUrl":"Bild-URL","articleUrl":"Artikel-URL"}]`
        }]
      })
    });
    const d = await r.json();
    if (r.status === 429 && i < retries) continue;
    if (!r.ok) throw new Error("Claude " + r.status + ": " + (d?.error?.message || "Fehler"));
    const raw = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const s = raw.indexOf("["), e = raw.lastIndexOf("]");
    if (s < 0 || e <= s) throw new Error("Kein JSON. Claude: \"" + raw.slice(0, 150) + "\"");
    const result = JSON.parse(raw.slice(s, e + 1));
    if (!Array.isArray(result) || !result.length) throw new Error("Leeres Array.");
    return result;
  }
  throw new Error("Rate-Limit. Bitte 1 Minute warten.");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")    { res.status(405).end(); return; }

  const AKEY     = process.env.ANTHROPIC_API_KEY;
  const GKEY     = process.env.GNEWS_API_KEY;
  const GUARDIAN_KEY = process.env.GUARDIAN_API_KEY;

  if (!AKEY) {
    res.status(500).json({ error: { message: "ANTHROPIC_API_KEY fehlt in Vercel → Settings → Environment Variables" } });
    return;
  }

  const { category } = req.body || {};
  const cat = CATS[category];
  if (!cat) { res.status(400).json({ error: { message: "Unbekannte Kategorie: " + category } }); return; }

  try {
    let articles = [];
    let usedSource = "";

    // ── 1. The Guardian (wenn Key vorhanden und Kategorie supported) ──────
    if (GUARDIAN_KEY && cat.guardian) {
      articles = await fetchGuardian(GUARDIAN_KEY, cat.guardian);
      if (articles.length > 0) usedSource = "guardian";
    }

    // ── 2. GNews (wenn Guardian leer oder kein Key) ───────────────────────
    if (articles.length === 0 && GKEY && cat.gnews) {
      articles = await fetchGNews(GKEY, cat.gnews);
      if (articles.length > 0) usedSource = "gnews";
    }

    // ── 3. Fehler wenn keine Artikel ─────────────────────────────────────
    if (articles.length === 0) {
      const missing = [];
      if (!GUARDIAN_KEY) missing.push("GUARDIAN_API_KEY");
      if (!GKEY)         missing.push("GNEWS_API_KEY");
      throw new Error(
        missing.length > 0
          ? "Keine News-API Keys gefunden. Bitte in Vercel eintragen: " + missing.join(" und/oder ")
          : "Keine Artikel von News-APIs erhalten. Bitte Keys prüfen."
      );
    }

    // ── 4. Claude fasst zusammen ──────────────────────────────────────────
    const result = await callClaude(AKEY, articles, cat.ctx);
    res.status(200).json({ articles: result, source: usedSource });

  } catch (err) {
    console.error("[daily-water]", category, err.message);
    res.status(500).json({ error: { message: err.message } });
  }
}
