
import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const {
  SERP_API_KEY,
  OPENAI_API_KEY,
  PORT,
} = process.env;

if (!SERP_API_KEY || !OPENAI_API_KEY) {
  console.warn("⚠️ Missing env vars. Required: SERP_API_KEY, OPENAI_API_KEY");
}

// ---------- Utilities ----------
function sanitizeQuery(q) {
  return String(q || "").trim().slice(0, 80);
}

function toLakhs(rupees) {
  const n = Number(rupees);
  if (!n || Number.isNaN(n)) return null;
  return `₹${(n / 100000).toFixed(2)} lakhs`;
}

function pickBestImageFromSerp(items = []) {
  // SerpAPI Google Images returns items with fields like:
  // { original, thumbnail, title, source, link, ... }
  // Prefer the first with an 'original' URL.
  for (const it of items) {
    if (it?.original) return it;
  }
  return items[0] || null;
}

// ---------- SerpAPI: Web & Images ----------
// Google Search (web results). SerpAPI docs: /search with engine=google. Returns organic_results[]. [1](https://serpapi.com/search-api)[2](https://serpapi.com/organic-results)
/*async function serpWebSearch(query) {
  const { data } = await axios.get("https://serpapi.com/search.json", {
    params: {
      engine: "google",
      q: query,
      // Localize to India for your use case:
      gl: "in",                  // country
      hl: "en",                  // language
      google_domain: "google.co.in",
      num: 10,                   // results count
      api_key: SERP_API_KEY,
      safe: "active",
    },
    timeout: 20000,
  });

  const items = Array.isArray(data?.organic_results) ? data.organic_results : []; // [2](https://serpapi.com/organic-results)
  // Normalize to { name, url, snippet }
  return items.map((r) => ({
    name: r?.title,
    url: r?.link,
    snippet: r?.snippet,
    displayUrl: r?.displayed_link,
  })).filter(p => p.url && p.name);
}

// Google Images. SerpAPI docs: /search with engine=google_images → images_results[]. [3](https://serpapi.com/google-images-api)
async function serpImageSearch(query) {
  const { data } = await axios.get("https://serpapi.com/search.json", {
    params: {
      engine: "google_images",
      q: query,
      gl: "in",
      hl: "en",
      ijn: 0,
      api_key: SERP_API_KEY,
      // Example: filter larger images via tbs, if you like:
      // tbs: "isz:l",
      safe: "active",
    },
    timeout: 20000,
  });
  return Array.isArray(data?.images_results) ? data.images_results : [];
} */


async function serpWebSearch(query) {
  try {
    const url = "https://serpapi.com/search.json";
    const params = { engine: "google", q: query, gl: "in", hl: "en", google_domain: "google.co.in", num: 10, api_key: process.env.SERP_API_KEY, safe: "active" };
    console.log("SerpAPI web:", url, params.engine);
    const { data } = await axios.get(url, { params, timeout: 20000 });
    const items = Array.isArray(data?.organic_results) ? data.organic_results : [];
    return items.map(r => ({ name: r?.title, url: r?.link, snippet: r?.snippet, displayUrl: r?.displayed_link })).filter(p => p.url && p.name);
  } catch (e) {
    const msg = e?.response?.data || e?.message;
    console.error("SerpAPI web search error:", msg);
    throw new Error(`SerpAPI web search failed: ${JSON.stringify(msg)}`);
  }
}

async function serpImageSearch(query) {
  try {
    const url = "https://serpapi.com/search.json";
    const params = { engine: "google_images", q: query, gl: "in", hl: "en", ijn: 0, api_key: process.env.SERP_API_KEY, safe: "active" };
    console.log("SerpAPI images:", url, params.engine);
    const { data } = await axios.get(url, { params, timeout: 20000 });
    return Array.isArray(data?.images_results) ? data.images_results : [];
  } catch (e) {
    const msg = e?.response?.data || e?.message;
    console.error("SerpAPI image search error:", msg);
    throw new Error(`SerpAPI image search failed: ${JSON.stringify(msg)}`);
  }
}



// ---------- LLM Extraction (OpenAI Chat Completions) ----------
async function extractWithLLM({ carQuery, pages }) {
  const system = `
You are an automotive price extractor for India.

Objective: From given web search snippets and page URLs, extract:
- brand (manufacturer)
- model (trim without year suffix)
- one_sentence_info (12–24 words, neutral tone)
- starting_price_inr (integer rupees, ex-showroom India preferred)
- top_variant_price_inr (integer rupees, ex-showroom India preferred)
- ex_showroom_or_on_road ("ex-showroom" or "on-road" and add city if clear)
- sources: array of up to 4 credible URLs used (manufacturer, Autocar India, ZigWheels, CarWale, GaadiWaadi, RushLane preferred)
- last_checked: ISO 8601 now (UTC)

If prices conflict, choose the most credible (manufacturer > large auto publications).
If unsure, return null for price fields.
Return ONLY JSON with these keys. No markdown.
`.trim();

  const snippets = pages.slice(0, 8)
    .map((p, i) => `#${i + 1} ${p.name}\nURL: ${p.url}\n${p.snippet || ""}`)
    .join("\n\n");

  const user = `
Car Query: "${carQuery}"

Search Results:
${snippets}
`.trim();

  const { data } = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",              // fast + good for extraction
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 500,
      response_format: { type: "json_object" },  // enforce JSON
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );

  const text = data?.choices?.[0]?.message?.content?.trim() || "{}";

  try {
    return JSON.parse(text);
  } catch (e) {
    return {
      brand: null,
      model: carQuery,
      one_sentence_info: "Could not reliably extract details from sources.",
      starting_price_inr: null,
      top_variant_price_inr: null,
      ex_showroom_or_on_road: null,
      sources: pages.slice(0, 4).map(p => p.url),
      last_checked: new Date().toISOString(),
    };
  }
}

// ---------- API ----------
app.get("/", (req, res) => {
  res.send("OK");
});

app.get("/api/search", async (req, res) => {
  try {
    const query = sanitizeQuery(req.query.q);
    if (!query) {
      return res.status(400).json({ error: "Missing car name in 'q' parameter" });
    }

    // Tailor queries for India market
    const webQuery = `${query} price India variants ex-showroom`;
    const imageQuery = `${query} car India`;

    const [pages, images] = await Promise.all([
      serpWebSearch(webQuery),
      serpImageSearch(imageQuery),
    ]);

    const bestImg = pickBestImageFromSerp(images);
    const llm = await extractWithLLM({ carQuery: query, pages });

    const payload = {
      query,
      brand: llm.brand,
      model: llm.model || query,
      info: llm.one_sentence_info,
      prices: {
        starting_inr: llm.starting_price_inr,
        starting_lakhs: toLakhs(llm.starting_price_inr),
        top_inr: llm.top_variant_price_inr,
        top_lakhs: toLakhs(llm.top_variant_price_inr),
        basis: llm.ex_showroom_or_on_road || "ex-showroom (likely)",
      },
      image: bestImg
        ? {
            url: bestImg.original || bestImg.thumbnail,
            name: bestImg.title,
            source: bestImg.link || bestImg.source,
          }
        : null,
      sources: Array.isArray(llm.sources) && llm.sources.length > 0
        ? llm.sources
        : pages.slice(0, 4).map(p => p.url),
      last_checked: llm.last_checked || new Date().toISOString(),
      disclaimer: "Prices vary by city, taxes, and date; please verify with official sources.",
    };

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed", details: err.message });
  }
});

const port = Number(PORT) || 8080;
app.listen(port, () => console.log(`Server running at http://localhost:${port}`));



