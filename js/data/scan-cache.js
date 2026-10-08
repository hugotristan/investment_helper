import { evaluateDataQuality, validHistoryPoints } from "../analysis/data-quality.js";

export const SCAN_CACHE_KEY = "investment-helper-scan-cache-v1";
const DAY_MS = 86400000;
const MAX_AGE_MS = 7 * DAY_MS;
const MAX_BYTES = 4 * 1024 * 1024;
const ARTICLE_TEXT_FIELDS = ["title", "description", "link", "pubDate", "source", "sourceId", "domain", "kind", "horizon", "evidenceScope"];
const ARTICLE_ARRAY_FIELDS = ["tickers", "directTickers", "sectorTickers", "marketTickers"];

export function saveScanCache({ series, quotes, news, marketContext }, { storage = globalThis.localStorage, now = Date.now() } = {}) {
  try {
    if (!Number.isFinite(now) || !Array.isArray(series)) return false;
    const incoming = qualifySeries(series, now);
    if (!incoming.length) return false;
    const previous = loadScanCache({ storage, now });
    const qualified = mergeSeries(series, incoming, previous?.series || []);
    const retainedQuotes = mergeQuotes(quotes, previous?.quotes, qualified, now);
    const savedAt = new Date(now).toISOString();
    const data = { schemaVersion: 1, savedAt, series: qualified,
      quotes: packQuotes(retainedQuotes, qualified, now), news: packNews(news),
      marketContext: qualifyContext(marketContext, now) };
    const serialized = JSON.stringify(data);
    if (oversized(serialized)) return false;
    storage.setItem(SCAN_CACHE_KEY, serialized);
    return true;
  } catch { return false; }
}

export function loadScanCache({ storage = globalThis.localStorage, now = Date.now() } = {}) {
  try {
    const serialized = storage.getItem(SCAN_CACHE_KEY);
    if (typeof serialized !== "string" || oversized(serialized) || !Number.isFinite(now)) return null;
    const data = JSON.parse(serialized);
    const savedTime = Date.parse(data.savedAt);
    if (data.schemaVersion !== 1 || !Number.isFinite(savedTime) || savedTime > now
      || now - savedTime > MAX_AGE_MS || !Array.isArray(data.series)) return null;
    const series = qualifySeries(data.series.map(reviveSeries), now);
    if (!series.length) return null;
    const quotes = unpackQuotes(data.quotes, series, now);
    const news = unpackNews(data.news, data.savedAt);
    return { series, quotes, news, marketContext: qualifyContext(data.marketContext, now), savedAt: data.savedAt };
  } catch { return null; }
}

function qualifySeries(series, now) {
  const seen = new Set();
  return series.filter((item) => {
    if (!item || !validTicker(item.ticker) || seen.has(item.ticker) || !evaluateDataQuality(item, now).eligible) return false;
    // Retention must not let a newer metadata date revive older actual bars.
    const points = validHistoryPoints(item);
    if (!evaluateDataQuality({ ...item, prices: points, historyAsOf: points.at(-1)?.date }, now).eligible) return false;
    seen.add(item.ticker);
    return true;
  }).slice(0, 180).map((item) => ({ ...item, prices: validHistoryPoints(item) }));
}

function mergeSeries(requested, incoming, previous) {
  const selected = new Map(previous.map((item) => [item.ticker, item]));
  for (const item of incoming) {
    const old = selected.get(item.ticker);
    if (!old || historyTime(item) >= historyTime(old)) selected.set(item.ticker, item);
  }
  const order = [...new Set(requested.map((item) => item?.ticker).concat(previous.map((item) => item.ticker)))];
  return order.filter((ticker) => selected.has(ticker)).slice(0, 180).map((ticker) => selected.get(ticker));
}

function historyTime(item) {
  return new Date(item.prices.at(-1)?.date || "invalid").getTime();
}

function mergeQuotes(incoming, previous, series, now) {
  const chosen = new Map();
  for (const quotes of [previous, incoming]) {
    for (const [ticker, quote] of packQuotes(quotes, series, now).entries) {
      const old = chosen.get(ticker);
      if (!old || new Date(quote.quoteTime).getTime() >= new Date(old.quoteTime).getTime()) chosen.set(ticker, quote);
    }
  }
  return { ...incoming, source: chosen.size ? "saved quote snapshots" : "none", byTicker: chosen, count: chosen.size, total: series.length };
}

function packQuotes(quotes, series, now) {
  const byTicker = new Map(series.map((item) => [item.ticker, item]));
  const entries = quotes?.byTicker instanceof Map ? [...quotes.byTicker] : Array.isArray(quotes?.entries) ? quotes.entries : [];
  return { source: "none", ...quotes, byTicker: undefined, total: series.length,
    entries: /^sample\b/i.test(quotes?.source || "") ? [] : entries
      .filter(([ticker, quote]) => byTicker.has(ticker) && validQuote(quote, ticker, byTicker.get(ticker), now)).slice(0, 180) };
}

function unpackQuotes(stored, series, now) {
  const packed = packQuotes(stored, series, now);
  const byTicker = new Map(packed.entries.map(([ticker, quote]) => [ticker, { ...quote, quoteTime: new Date(quote.quoteTime) }]));
  const { entries, ...metadata } = packed;
  return { ...metadata, byTicker, count: byTicker.size,
    label: `Saved quote snapshots: ${byTicker.size}/${metadata.total || series.length}` };
}

function validQuote(quote, ticker, series, now) {
  const time = new Date(quote?.quoteTime || "invalid").getTime();
  return quote && Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(time)
    && time <= now && now - time <= MAX_AGE_MS && time >= historyTime(series)
    && (!quote.ticker || quote.ticker === ticker) && (!series.currency || quote.currency === series.currency)
    && !/^sample\b/i.test(quote.source || "");
}

function reviveSeries(series) {
  if (!series || !Array.isArray(series.prices)) return null;
  const revivePoints = (points) => points.map((point) => ({ ...point, date: new Date(point.date) }));
  return { ...series, prices: revivePoints(series.prices),
    ...(Array.isArray(series.chartPrices) ? { chartPrices: revivePoints(series.chartPrices) } : {}),
    ...(series.quote ? { quote: { ...series.quote, quoteTime: series.quote.quoteTime ? new Date(series.quote.quoteTime) : null } } : {}) };
}

function packNews(news) {
  const items = (Array.isArray(news?.items) ? news.items : []).slice(0, 500).map(normalizeArticle);
  const sources = (Array.isArray(news?.sources) ? news.sources : []).slice(0, 500)
    .map(({ id, name, ok, via, count, domain, meta, error }) => ({ id, name, ok: Boolean(ok), via, count, domain, meta, error }));
  return { items, sources, configured: Number.isFinite(news?.configured) ? news.configured : 0,
    label: String(news?.label || "No research articles saved"), outlookCount: items.filter((item) => item.kind === "outlook").length };
}

function unpackNews(stored, savedAt) {
  const news = packNews(stored);
  const byTicker = Object.create(null);
  for (const article of news.items) {
    for (const ticker of article.tickers) {
      if (!byTicker[ticker]) byTicker[ticker] = [];
      byTicker[ticker].push(article);
    }
  }
  for (const ticker of Object.keys(byTicker)) {
    byTicker[ticker] = byTicker[ticker].sort((a, b) => Number(b.directTickers.includes(ticker)) - Number(a.directTickers.includes(ticker))).slice(0, 16);
  }
  return { ...news, byTicker, label: `Saved research from ${savedAt} · ${news.label}` };
}

function normalizeArticle(article) {
  const normalized = Object.fromEntries(ARTICLE_TEXT_FIELDS.map((key) => [key, String(article?.[key] || "")]));
  normalized.sentiment = Number.isFinite(article?.sentiment) ? article.sentiment : 0;
  for (const key of ARTICLE_ARRAY_FIELDS) normalized[key] = Array.isArray(article?.[key]) ? [...new Set(article[key].filter(validTicker))].slice(0, 180) : [];
  return normalized;
}

function qualifyContext(context, now) {
  const asOf = context?.dataQuality?.asOf || context?.asOf || null;
  const time = asOf ? Date.parse(asOf) : NaN;
  if (context?.available === true && Number.isFinite(context.score) && Number.isFinite(time)
    && time <= now + DAY_MS && now - time <= MAX_AGE_MS) return { ...context };
  return { ...context, available: false, eligible: false, score: null, confidence: null,
    label: "Market regime unavailable", horizon: "Unavailable",
    dataQuality: { ...context?.dataQuality, eligible: false, asOf,
      label: "Saved market context unavailable", reason: "The saved market context has no qualified recent timestamp." },
    evidence: Array.isArray(context?.evidence) ? context.evidence : [],
    risks: ["Saved market context is unavailable or stale; no regime signal is used."] };
}

function validTicker(value) { return typeof value === "string" && /^[A-Z0-9^][A-Z0-9.^-]{0,30}$/.test(value); }
function oversized(value) { return value.length > MAX_BYTES || new TextEncoder().encode(value).byteLength > MAX_BYTES; }
