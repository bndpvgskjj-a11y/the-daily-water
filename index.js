// The Daily Water – Vercel API Route v3
// GNews.io (kostenlos, Production-tauglich) + Claude Zusammenfassung

const GNEWS_BASE = "https://gnews.io/api/v4";

// GNews unterstützt: q, lang, country, category, max, apikey
// Kategorien: general, world, nation, business, technology, entertainment, sports, science, health
const CATEGORY_CONFIG = {
  aalen: {
    params: { q: "Aalen OR Ostalbkreis OR \"Schwäbisch Gmünd\" OR Ellwangen", lang: "de", max: 8 },
    context: "Lokalnachrichten aus der Region Aalen (Ostalbkreis, Baden-Württemberg, Deutschland)"
  },
  deutschland: {
    params: { category: "general", lang: "de", country: "de", max: 8 },
    context: "Die wichtigsten aktuellen Nachrichten aus Deutschland"
  },
  welt: {
    params: { category: "world", lang: "de", max: 8 },
    context: "Die wichtigsten weltweiten Nachrichten"
  },
  water4you: {
    params: { q: "Wasserversorgung OR Trinkwasser OR \"water supply\" OR \"water quality\" OR Wasserwirtschaft", max: 8 },
    context: "Nachrichten relevant für ein Wasserversorgungsunternehmen (Water 4 You GmbH, Aalen)"
  },
  zielmaerkte: {
    params: { q: "\"water infrastructure\" OR \"water project\" OR \"water investment\" OR \"water treatment\"", lang: "en", max: 8 },
    context: "Wasserprojekte und Infrastruktur in Zielmärkten: Naher Osten, Afrika, Südostasien, Indien, Lateinamerika"
  },
  philippinen: {
    params: { q: "Philippines", lang: "en", country: "ph", max: 8 },
    context: "Aktuelle Nachrichten aus den Philippinen"
  },
  business: {
    params: { category: "business", lang: "de", max: 8 },
    context: "Aktuelle Business- und Wirtschaftsnachrichten"
  },
  ki_tech: {
    params: { category: "technology", lang: "de", max: 8 },
    context: "Aktuelle KI- und Technologienachrichten"
  },
  aktien: {
    params: { q: "DAX OR Börse OR Aktien OR \"S&P 500\" OR \"Dow Jones\" OR Zinsen", lang: "de", max: 8 },
    context: "Aktienmarkt- und Finanznachrichten"
  }
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")    { res.status(405).end(); return; }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GNEWS_KEY     = process.env.GNEWS_API_KEY;

  if (!ANTHROPIC_KEY) { res.status(500).json({ error: { message: "ANTHROPIC_API_KEY fehlt in Vercel Environment Variables." } }); return; }
  if (!GNEWS_KEY)     { res.status(500).json({ error: { message: "GNEWS_API_KEY fehlt in Vercel Environment Variables." } }); return; }

  const { category } = req.body || {};
  const config = CATEGORY_CONFIG[category];
  if (!config) { res.status(400).json({ error: { message: "Unbekannte Kategorie: " + category } }); return; }

  try {
    // ── Step 1: Echte Artikel von GNews holen ────────────────────────────
    const params = new URLSearchParams({ ...config.params, apikey: GNEWS_KEY });
    const endpoint = config.params.category
      ? `${GNEWS_BASE}/top-headlines?${params}`
      : `${GNEWS_BASE}/search?${params}`;

    const newsRes  = await fetch(endpoint);
    const newsData = await newsRes.json();

    if (!newsRes.ok) {
      throw new Error("GNews Fehler: " + (newsData?.errors?.join(", ") || newsRes.status));
    }

    const raw = (newsData.articles || []).filter(a =>
      a.title && a.description && a.title !== "[Removed]"
    ).slice(0, 7);

    if (raw.length === 0) {
      throw new Error("GNews lieferte keine Artikel für: " + category + ". Bitte prüfe den GNEWS_API_KEY.");
    }

    // ── Step 2: Artikel für Claude aufbereiten ───────────────────────────
    const articleTexts = raw.map((a, i) =>
      `[${i+1}] Titel: ${a.title}
Quelle: ${a.source?.name || "–"}
Datum: ${(a.publishedAt || "").slice(0, 10)}
Beschreibung: ${a.description || ""}
Bild-URL: ${a.image || ""}
Artikel-URL: ${a.url || ""}`
    ).join("\n\n");

    // ── Step 3: Claude fasst zusammen ────────────────────────────────────
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2500,
        system: `Du bist Nachrichtenredakteur. Du fasst echte Artikel auf Deutsch zusammen.
Antworte AUSSCHLIESSLICH mit einem JSON-Array.
Kein Text davor, kein Text danach, keine Markdown-Codeblöcke, keine Backticks.
Nur das reine JSON-Array das mit [ beginnt und mit ] endet.`,
        messages: [{
          role: "user",
          content: `Kontext: ${config.context}

Hier sind ${raw.length} echte aktuelle Artikel:

${articleTexts}

Erstelle für jeden Artikel ein JSON-Objekt. Halte dich strikt an die echten Inhalte.
Antworte NUR mit diesem JSON-Array (ein Objekt pro Artikel):
[{"title":"Deutscher Titel max 12 Wörter","category":"1-2 Wörter","source":"Quellenname","date":"TT.MM.JJJJ","summary":"2-3 Sätze Zusammenfassung auf Deutsch.","fullText":"6-8 Sätze ausführliche Zusammenfassung auf Deutsch.","relevance":"hoch","imageUrl":"exakte Bild-URL oder leerer String","articleUrl":"exakte Artikel-URL"}]`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      throw new Error("Claude Fehler: " + (claudeData?.error?.message || claudeRes.status));
    }

    const text = (claudeData.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();

    // Robust JSON extraction
    const s = text.indexOf("[");
    const e = text.lastIndexOf("]");
    if (s < 0 || e <= s) {
      // Log for debugging
      console.error("Claude raw response:", text.slice(0, 500));
      throw new Error("Kein JSON-Array in Claude-Antwort gefunden.");
    }

    const articles = JSON.parse(text.slice(s, e + 1));
    if (!Array.isArray(articles) || articles.length === 0) {
      throw new Error("Claude gab leeres Array zurück.");
    }

    res.status(200).json({ articles });

  } catch (err) {
    console.error("[daily-water]", category, err.message);
    res.status(500).json({ error: { message: err.message } });
  }
}
