import { normalizeStockHistory } from "../js/data/stock-history.js";
import { parseYahooChart, parseYahooQuote } from "../js/data/yahoo-chart.js";
import { readSnapshotHistory, readSnapshotQuote } from "../js/data/price-snapshot.js";
import { EXCHANGE_RATE_SOURCE, EXCHANGE_RATE_SOURCE_URL, normalizeExchangeRate } from "../js/data/exchange-rate.js";
import { normalizeHistoricalFx, PORTFOLIO_FX_SOURCE, PORTFOLIO_FX_SOURCE_URL,
  PORTFOLIO_FX_CURRENCIES, PORTFOLIO_FX_MAX_POINTS } from "../js/data/portfolio-history.js";
import { ApiError, readBoundedText } from "./request-body.mjs";

const MAX_PUBLIC_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_POINTS = 1600;
const MAX_HISTORY_ENTRIES = 80;
const PUBLISHED_PRICES_URL = "https://hugotristan.github.io/investment_helper/data/prices.json";
const DAY = 86400000;

function historicalFxStart(now) {
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 5);
  start.setUTCDate(start.getUTCDate() - 7);
  return start.toISOString().slice(0, 10);
}

function historicalFxSnapshot(raw, now, from) {
  if (!Array.isArray(raw) || !raw.length || raw.length > PORTFOLIO_FX_CURRENCIES.length * PORTFOLIO_FX_MAX_POINTS) return null;
  const start = Date.parse(from);
  const earliest = new Date(start - 7 * DAY).toISOString().slice(0, 10);
  const byCurrency = Object.fromEntries(PORTFOLIO_FX_CURRENCIES.map((currency) => [currency, []]));
  for (const row of raw) {
    if (row?.base !== "EUR" || !PORTFOLIO_FX_CURRENCIES.includes(row?.quote) || typeof row?.date !== "string"
      || row.date < earliest || !Number.isFinite(row.rate) || row.rate <= 0 || !Number.isFinite(1 / row.rate)) return null;
    byCurrency[row.quote].push({ date: row.date, rate: 1 / row.rate });
  }
  const snapshot = normalizeHistoricalFx({ schemaVersion: 1, source: PORTFOLIO_FX_SOURCE,
    sourceUrl: PORTFOLIO_FX_SOURCE_URL, generatedAt: new Date(now).toISOString(), byCurrency }, { now });
  if (!snapshot || Object.values(snapshot.byCurrency).some((points) => points.length < 200
    || Date.parse(points[0].date) - start > 14 * DAY || now - Date.parse(points.at(-1).date) > 7 * DAY)) return null;
  return snapshot;
}

export function marketTicker(input) {
  if (typeof input !== "string" || !/^[A-Z0-9^][A-Z0-9.^-]{0,30}$/.test(input)) {
    throw new ApiError(400, "INVALID_TICKER", "Choose a valid stock, ETF, or index ticker.");
  }
  return input;
}

// Each app instance caches public prices only. No private ledger data, visitor
// headers, or supplied URLs are passed to an external provider.
export function createMarketData({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const historyCache = new Map();
  const pending = new Map();
  let exchangeCache = null;
  let exchangeRequest = null;
  let historicalFxCache = null;
  let historicalFxRequest = null;
  let publishedCache = null;
  let publishedRequest = null;
  let publishedRetryAt = 0;
  const queue = [];
  let active = 0;
  const clock = () => typeof now === "function" ? now() : now;

  function networkSlot(work) {
    return new Promise((resolve, reject) => {
      queue.push({ work, resolve, reject });
      drain();
    });
  }
  function drain() {
    while (active < 3 && queue.length) {
      const { work, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve().then(work).then(resolve, reject).finally(() => { active -= 1; drain(); });
    }
  }

  async function fetchJson(url, maximumBytes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" }, credentials: "omit",
        redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error("Provider unavailable.");
      return JSON.parse(await readBoundedText(response, maximumBytes));
    } finally { clearTimeout(timer); }
  }

  function saveHistory(ticker, history, time) {
    const serialized = JSON.parse(JSON.stringify(history));
    historyCache.delete(ticker);
    historyCache.set(ticker, { history: serialized, checkedAt: time });
    while (historyCache.size > MAX_HISTORY_ENTRIES) historyCache.delete(historyCache.keys().next().value);
    return serialized;
  }

  async function publishedHistory(ticker, time) {
    let snapshot = publishedCache && time - publishedCache.checkedAt < 5 * 60000 ? publishedCache.snapshot : null;
    if (!snapshot) {
      if (!publishedRequest && time < publishedRetryAt) return null;
      if (!publishedRequest) {
        publishedRequest = (async () => {
          try {
            const raw = await fetchJson(PUBLISHED_PRICES_URL, 14 * 1024 * 1024);
            const generated = Date.parse(raw?.generatedAt);
            if (raw?.schemaVersion !== 1 || !Number.isFinite(generated) || generated > time || time - generated > 7 * DAY
              || !raw.byTicker || typeof raw.byTicker !== "object" || Array.isArray(raw.byTicker)) throw new Error("Invalid published prices.");
            publishedCache = { snapshot: raw, checkedAt: time };
            return raw;
          } catch { publishedRetryAt = time + 30000; return null; }
          finally { publishedRequest = null; }
        })();
      }
      snapshot = await publishedRequest;
    }
    const parsed = readSnapshotHistory(snapshot, ticker, { now: time });
    if (!parsed || time - Date.parse(parsed.historyAsOf) > 7 * DAY) return null;
    parsed.quote = readSnapshotQuote(snapshot, ticker, { now: time });
    return normalizeStockHistory(parsed, ticker, { now: time });
  }

  async function loadHistory(ticker) {
    ticker = marketTicker(ticker);
    const time = clock();
    const saved = historyCache.get(ticker);
    if (saved && time - saved.checkedAt < 5 * 60000) return saved.history;
    if (pending.has(ticker)) return pending.get(ticker);
    if (pending.size >= 96) throw new ApiError(429, "PRICES_BUSY", "Several prices are loading. Try again shortly.");
    const request = networkSlot(async () => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5y&interval=1d&events=splits`;
        const raw = await fetchJson(url, MAX_PUBLIC_HISTORY_BYTES);
        const result = raw?.chart?.result?.[0];
        if (!Array.isArray(result?.timestamp) || result.timestamp.length > MAX_POINTS
          || result.meta?.dataGranularity && result.meta.dataGranularity !== "1d"
          || result.timestamp.some((point) => !Number.isFinite(point) || point * 1000 > time)) throw new Error("Invalid daily history.");
        const parsed = parseYahooChart(raw, ticker);
        if (!parsed) throw new Error("Invalid stock identity.");
        parsed.quote = parseYahooQuote(raw, ticker, { now: time });
        if (parsed.quote) for (const field of ["name", "exchange", "marketState"]) {
          parsed.quote[field] = String(parsed.quote[field] || "").slice(0, 200);
        }
        const history = normalizeStockHistory(parsed, ticker, { now: time });
        if (!history) throw new Error("Invalid daily history.");
        return saveHistory(ticker, history, time);
      } catch {
        const published = await publishedHistory(ticker, time);
        if (published) return saveHistory(ticker, published, time);
        throw new ApiError(503, "PRICES_UNAVAILABLE", "The price provider is temporarily unavailable. Previously dated prices can still be used.");
      } finally { pending.delete(ticker); }
    });
    pending.set(ticker, request);
    return request;
  }

  async function loadExchangeRate() {
    const time = clock();
    if (exchangeCache && time - exchangeCache.checkedAt < 60 * 60000
      && normalizeExchangeRate(exchangeCache.rate, { now: time })) return exchangeCache.rate;
    if (exchangeRequest) return exchangeRequest;
    exchangeRequest = (async () => {
      try {
        const raw = await fetchJson(EXCHANGE_RATE_SOURCE_URL, 16 * 1024);
        const rate = normalizeExchangeRate({ schemaVersion: 1, available: true,
          base: raw.base, quote: raw.quote, rate: raw.rate, date: raw.date,
          source: EXCHANGE_RATE_SOURCE, sourceUrl: EXCHANGE_RATE_SOURCE_URL,
          retrievedAt: new Date(time).toISOString() }, { now: time });
        if (!rate) throw new Error("Invalid reference rate.");
        exchangeCache = { rate, checkedAt: time };
        return rate;
      } catch {
        throw new ApiError(503, "RATE_UNAVAILABLE", "The current USD-to-EUR reference rate is temporarily unavailable.");
      } finally { exchangeRequest = null; }
    })();
    return exchangeRequest;
  }

  async function loadHistoricalFx() {
    const time = clock();
    if (historicalFxCache && time - historicalFxCache.checkedAt < 60 * 60000
      && normalizeHistoricalFx(historicalFxCache.snapshot, { now: time })) return historicalFxCache.snapshot;
    if (historicalFxRequest) return historicalFxRequest;
    historicalFxRequest = (async () => {
      try {
        const from = historicalFxStart(time);
        const url = new URL(PORTFOLIO_FX_SOURCE_URL);
        url.search = new URLSearchParams({ base: "eur", quotes: PORTFOLIO_FX_CURRENCIES.join(",").toLowerCase(),
          from, to: new Date(time).toISOString().slice(0, 10) });
        const raw = await fetchJson(url.href, 4 * 1024 * 1024);
        const snapshot = historicalFxSnapshot(raw, time, from);
        if (!snapshot) throw new Error("Invalid historical reference rates.");
        historicalFxCache = { snapshot, checkedAt: time };
        return snapshot;
      } catch {
        throw new ApiError(503, "RATES_UNAVAILABLE", "Historical reference rates are temporarily unavailable. Previously dated rates can still be used.");
      } finally { historicalFxRequest = null; }
    })();
    return historicalFxRequest;
  }

  return { loadHistory, loadExchangeRate, loadHistoricalFx };
}
