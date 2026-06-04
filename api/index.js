// The Daily Water – Vercel API Route
// 1. Holt echte Artikel von NewsAPI
// 2. Lässt Claude sie auf Deutsch zusammenfassen
// 3. Gibt strukturiertes JSON zurück

const CATEGORY_QUERIES = {
  aalen: {
    url: "https://newsapi.org/v2/everything?q=Aalen+OR+Ostalbkreis+OR+Ellwangen+OR+%22Schw%C3%A4bisch+Gm%C3%BCnd%22&language=de&sortBy=publishedAt&pageSize=8",
    lang: "de"
  },
  deutschland: {
    url: "https://newsapi.org/v2/top-headlines?country=de&pageSize=8",
    lang: "de"
  },
  welt: {
    url: "https://newsapi.org/v2/top-headlines?language=de&pageSize=8&category=general",
    lang: "de"
  },
  water4you: {
    url: "https://newsapi.org/v2/everything?q=Wasserversorgung+OR+Trinkwasser+OR+Wasserwirtschaft+OR+%22water+supply%22+OR+%22water+quality%22&sortBy=publishedAt&pageSize=8",
    lang: "mixed"
  },
  zielmaerkte: {
    url: "https://newsapi.org/v2/everything?q=%22water+infrastructure%22+OR+%22water+project%22+OR+%22water+investment%22&language=en&sortBy=publishedAt&pageSize=8",
    lang: "en"
  },
  philippinen: {
    url: "https://newsapi.org/v2/everything?q=Philippines&language=en&sortBy=publishedAt&pageSize=8",
    lang: "en"
  },
  business: {
    url: "https://newsapi.org/v2/top-headlines?country=de&category=business&pageSize=8",
    lang: "de"
  },
  ki_tech: {
    url: "https://newsapi.org/v2/top-headlines?country=de&category=technology&pageSize=8",
    lang: "de"
  },
  aktien: {
    url: "https://newsapi.org/v2/everything?q=DAX+OR+B%C3%B6rse+OR+Aktien+OR+S%26P500+OR+Dow+Jones&language=de&sortBy=publishedAt&pageSize=8",
    lang: "de"
  }
};

const CATEGORY_CONTEXT = {
  aalen:       "Lokalnachrichten aus der Region Aalen, Ostalbkreis, Baden-Württemberg",
  deutschland: "Wichtigste Nachrichten aus Deutschland",
  welt:        "Weltweite Nachrichten und internationale Ereignisse",
  water4you:   "Nachrichten relevant für ein Wasserversorgungsunternehmen (Water 4 You GmbH)",
  zielmaerkte: "Nachrichten über Wasserprojekte und Infrastruktur in Zielmärkten (Naher Osten, Afrika, Asien, Lateinamerika)",
  philippinen: "Nachrichten aus den Philippinen",
  business:    "Business- und Wirtschaftsnachrichten",
  ki_tech:     "KI- und Technologienachrichten",
  aktien:      "Aktienmarkt- und Finanznachrichten"
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).end(); return; }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NEWS_KEY      = process.env.NEWS_API_KEY;

  if (!ANTHROPIC_KEY) {
    res.status(500).json({ error: { message: "ANTHROPIC_API_KEY nicht gesetzt." } });
    return;
  }
  if (!NEWS_KEY) {
    res.status(500).json({ error: { message: "NEWS_API_KEY nicht gesetzt." } });
    return;
  }

  const { category } = req.body;
  if (!category || !CATEGORY_QUERIES[category]) {
    res.status(400).json({ error: { message: "Ungültige Kategorie: " + category } });
    return;
  }

  try {
    // ── Step 1: Echte Artikel von NewsAPI holen ───────────────────────────
    const newsUrl = CATEGORY_QUERIES[category].url + "&apiKey=" + NEWS_KEY;
    const newsRes = await fetch(newsUrl);
    const newsData = await newsRes.json();

    if (newsData.status !== "ok") {
      throw new Error("NewsAPI Fehler: " + (newsData.message || newsData.status));
    }

    const articles = (newsData.articles || []).filter(a =>
      a.title && a.title !== "[Removed]" && a.description
    ).slice(0, 7);

    if (articles.length === 0) {
      throw new Error("Keine Artikel von NewsAPI erhalten für: " + category);
    }

    // ── Step 2: Artikel als Text für Claude aufbereiten ───────────────────
    const articleTexts = articles.map((a, i) =>
      `ARTIKEL ${i+1}:\nTitel: ${a.title}\nQuelle: ${a.source?.name || "Unbekannt"}\nDatum: ${a.publishedAt?.slice(0,10) || ""}\nBeschreibung: ${a.description || ""}\nInhalt: ${(a.content || "").slice(0, 300)}\nURL: ${a.url}\nBild: ${a.urlToImage || ""}`
    ).join("\n\n");

    // ── Step 3: Claude fasst die echten Artikel zusammen ─────────────────
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: "Du bist ein professioneller Nachrichtenredakteur. Du fasst echte Nachrichtenartikel auf Deutsch zusammen. Antworte AUSSCHLIESSLICH mit einem validen JSON-Array, kein Text davor oder danach, keine Codeblöcke.",
        messages: [{
          role: "user",
          content: `Kontext: ${CATEGORY_CONTEXT[category]}

Hier sind ${articles.length} echte aktuelle Nachrichtenartikel:

${articleTexts}

Erstelle für JEDEN dieser Artikel ein JSON-Objekt auf Deutsch. Behalte den echten Inhalt bei, fasse aber verständlich zusammen.

Antworte NUR mit diesem JSON-Array:
[
  {
    "title": "Prägnanter deutscher Titel (max 12 Wörter)",
    "category": "Thema in 1-2 Wörtern",
    "source": "Name der Originalquelle",
    "date": "Datum des Artikels (TT.MM.JJJJ)",
    "summary": "2-3 Sätze Zusammenfassung auf Deutsch.",
    "fullText": "6-8 Sätze ausführliche Zusammenfassung auf Deutsch mit allen wichtigen Details.",
    "relevance": "hoch oder mittel",
    "imageUrl": "exakte Bild-URL aus dem Originalartikel oder leer",
    "articleUrl": "exakte URL des Originalartikels"
  }
]`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      throw new Error(claudeData?.error?.message || "Claude API Fehler: " + claudeRes.status);
    }

    const rawText = (claudeData.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();

    const s = rawText.indexOf("[");
    const e = rawText.lastIndexOf("]");
    if (s < 0 || e <= s) throw new Error("Kein JSON in Claude-Antwort");

    const parsed = JSON.parse(rawText.slice(s, e + 1));
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("Leeres Array von Claude");

    res.status(200).json({ articles: parsed });

  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
}
