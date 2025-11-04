import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const {
  BING_API_KEY,
  BING_ENDPOINT,
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_DEPLOYMENT,
} = process.env;

const BING_HEADERS = { "Ocp-Apim-Subscription-Key": BING_API_KEY };

function sanitizeQuery(q) {
  return String(q || "").trim().slice(0, 80);
}

function toLakhs(rupees) {
  if (!rupees || isNaN(rupees)) return null;
  return `${(rupees / 100000).toFixed(2)} lakhs`;
}

function pickBestImage(items = []) {
  // Prefer large, relevant images
  const sorted = items
    .filter(i => i.contentUrl && i.name)
    .sort((a, b) => {
      const aw = (a.thumbnail && a.thumbnail.width) || 0;
      const bw = (b.thumbnail && b.thumbnail.width) || 0;
      return bw - aw;
    });
  return sorted[0] || null;
}

async function bingImageSearch(query) {
  const url = `${BING_ENDPOINT}/v7.0/images/search`;
  const { data } = await axios.get(url, {
    headers: BING_HEADERS,
    params: {
      q: query,
      mkt: "en-IN",
      safeSearch: "Moderate",
      count: 10,
    },
  });
  return data.value || [];
}

async function bingWebSearch(query) {
  const url = `${BING_ENDPOINT}/v7.0/search`;
  const { data } = await axios.get(url, {
    headers: BING_HEADERS,
    params: {
      q: query,
      mkt: "en-IN",
      responseFilter: "Webpages",
      count: 10,
      textDecorations: false,
      textFormat: "Raw",
      // You can add freshness if needed: freshness: "Month",
    },
  });
  const pages = (data.webPages && data.webPages.value) || [];
  return pages.map(p => ({
    name: p.name,
    url: p.url,
    snippet: p.snippet,
    displayUrl: p.displayUrl,
  }));
}

async function extractWithLLM({ carQuery, pages }) {
  const system = `
You are an automotive price extractor for India.
Objective: From given web search snippets and page urls, extract:
- brand (manufacturer)
- model (trim without year suffix)
- one_sentence_info (12–24 words, neutral tone)
- starting_price_inr (integer rupees, ex-showroom India preferred)
- top_variant_price_inr (integer rupees, ex-showroom India preferred)
- ex_showroom_or_on_road ("ex-showroom" or "on-road" and add city if clear)
- sources: array of up to 4 credible URLs used (manufacturer, Autocar India, ZigWheels, CarWale, GaadiWaadi, RushLane preferred)
- last_checked: ISO 8601 now (UTC)

If prices conflict, choose the most credible (manufacturer > large auto publications). If unsure, return null for price fields.

Return ONLY JSON with these keys. No markdown.
  `.trim();

  const snippets = pages.slice(0, 8).map((p, i) => `#${i+1} ${p.name}\nURL: ${p.url}\n${p.snippet}`).join("\n\n");

  const user = `
Car Query: "${carQuery}"

Search Results:
${snippets}
  `.trim();

  const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-08-01-preview`;

  const { data } = await axios.post(
    url,
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 450,
    },
    { headers: { "api-key": AZURE_OPENAI_API_KEY, "Content-Type": "application/json" } }
  );

  const text = data?.choices?.[0]?.message?.content?.trim() || "{}";
  // Ensure it's JSON
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = {
      brand: null,
      model: carQuery,
      one_sentence_info: "Could not reliably extract details from sources.",
      starting_price_inr: null,
      top_variant_price_inr: null,
      ex_showroom_or_on_road: null,
      sources: [],
      last_checked: new Date().toISOString(),
    };
  }

  return json;
}

app.get("/api/search", async (req, res) => {
  try {
    const query = sanitizeQuery(req.query.q);
    if (!query) {
      return res.status(400).json({ error: "Missing car name in 'q' parameter" });
    }

    // Prepare queries tailored to Indian market
    const webQuery = `${query} price India variants ex-showroom`;
    const imageQuery = `${query} car India`;

    const [pages, images] = await Promise.all([
      bingWebSearch(webQuery),
      bingImageSearch(imageQuery),
    ]);

    const imageItem = pickBestImage(images);
    const llmResult = await extractWithLLM({ carQuery: query, pages });

    const startingLakhs = toLakhs(llmResult.starting_price_inr);
    const topLakhs = toLakhs(llmResult.top_variant_price_inr);

    const payload = {
      query,
      brand: llmResult.brand,
      model: llmResult.model || query,
      info: llmResult.one_sentence_info,
      prices: {
        starting_inr: llmResult.starting_price_inr,
        starting_lakhs: startingLakhs,
        top_inr: llmResult.top_variant_price_inr,
        top_lakhs: topLakhs,
        basis: llmResult.ex_showroom_or_on_road || "ex-showroom (likely)",
      },
      image: imageItem
        ? {
            url: imageItem.contentUrl,
            name: imageItem.name,
            source: imageItem.hostPageUrl,
          }
        : null,
      sources: llmResult.sources || pages.slice(0, 4).map(p => p.url),
      last_checked: llmResult.last_checked || new Date().toISOString(),
      disclaimer: "Prices vary by city, taxes, and date; please verify with official sources.",
    };

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed", details: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
