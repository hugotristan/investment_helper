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
const PUBLISHED_BASE_URL = "https://hugotristan.github.io/investment_helper/data/";
const PUBLISHED_PRICES_URL = `${PUBLISHED_BASE_URL}prices.json`;
const PUBLIC_ASSET_LIMITS = Object.freeze({ "data/prices.json": 14 * 1024 * 1024,
  "data/exchange-rate.json": 16 * 1024, "data/portfolio-fx.json": 4 * 1024 * 1024 });
const DAY = 86400000;

// Only these embedded public market files can be read. Decompressed bytes are
// bounded before JSON parsing, just like provider replies; no ledger is read.
export function createMarketAssetReader(assets = {}) {
  const requests = new Map();
  return function readMarketAsset(path) {
    if (!Object.hasOwn(PUBLIC_ASSET_LIMITS, path)) return Promise.resolve(null);
    if (!requests.has(path)) requests.set(path, (async () => {
      const asset = assets[path];
      if (asset === undefined) return null;
      let response;
      if (typeof asset === "string") response = new Response(asset);
      else if (asset?.encoding === "gzip-base64" && typeof asset.data === "string") {
        if (asset.data.length > PUBLIC_ASSET_LIMITS[path] * 2) throw new Error("Invalid embedded public data.");
        const compressed = Uint8Array.from(atob(asset.data), (character) => character.charCodeAt(0));
        response = new Response(new Response(compressed).body.pipeThrough(new DecompressionStream("gzip")));
      } else throw new Error("Invalid embedded public data.");
      return JSON.parse(await readBoundedText(response, PUBLIC_ASSET_LIMITS[path]));
    })());
    return requests.get(path);
  };
}

function providerFailure(provider, error) {
  // Never return provider messages, response bodies, URLs, cookies or identities.
  // A small set of categories makes runtime failures visible without secrets.
  const reason = error?.publicFailureReason === "http" ? "http" : (error?.code === "BODY_TOO_LARGE" ? "size-limit"
    : error?.code === "INVALID_BODY" ? "body-runtime"
    : error?.name === "AbortError" || error?.name === "TimeoutError" ? "timeout"
    : error?.name === "SyntaxError" ? "invalid-json"
    : /illegal invocation|receiver|this.*(?:fetch|global|window)/i.test(String(error?.message || "")) ? "fetch-binding"
    : /TextDecoder|fatal|encoding|decode/i.test(String(error?.message || "")) ? "decoder-runtime"
    : /Intl|time.?zone|DateTimeFormat/i.test(String(error?.message || "")) ? "date-runtime"
    : error?.name === "TypeError" ? "network-or-runtime" : "invalid-data");
  return { provider, reason, ...(["TypeError", "RangeError", "ReferenceError", "SyntaxError", "AbortError", "TimeoutError"].includes(error?.name)
    ? { errorName: error.name } : {}), ...(Number.isInteger(error?.publicStatus) && error.publicStatus >= 100 && error.publicStatus <= 599
      ? { status: error.publicStatus } : {}) };
}

function unavailable(code, message, failures) {
  const error = new ApiError(503, code, message);
  error.providerFailures = failures.slice(0, 3);
  return error;
}

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
export function createMarketData({ fetchImpl = (url, init) => globalThis.fetch(url, init), now = Date.now,
  readMarketAsset = async () => null, reportFailure = (details) => console.warn("Public market-data source failed.", details) } = {}) {
  const historyCache = new Map();
  const pending = new Map();
  let exchangeCache = null;
  let exchangeRequest = null;
  let historicalFxCache = null;
  let historicalFxRequest = null;
  let publishedCache = null;
  let publishedRequest = null;
  let publishedRetryAt = 0;
  let publishedFailures = [];
  const reported = new Map();
  const queue = [];
  let active = 0;
  const clock = () => typeof now === "function" ? now() : now;

  function failure(provider, error) {
    const details = providerFailure(provider, error);
    const time = clock();
    if (!reported.has(provider) || time - reported.get(provider) >= 60000) {
      reported.set(provider, time);
      // Fixed provider names and bounded categories only; one report per source
      // per minute prevents a large watchlist from flooding runtime logs.
      try { reportFailure(details); } catch { /* Diagnostics never block prices. */ }
    }
    return details;
  }

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
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" }, credentials: "omit",
        redirect: "error", signal: controller.signal });
      if (!response.ok) {
        const error = new Error("Provider unavailable.");
        error.publicFailureReason = "http";
        error.publicStatus = response.status;
        throw error;
      }
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

  function validPriceSnapshot(raw, time) {
    const generated = Date.parse(raw?.generatedAt);
    return raw?.schemaVersion === 1 && Number.isFinite(generated) && generated <= time && time - generated <= 7 * DAY
      && raw.byTicker && typeof raw.byTicker === "object" && !Array.isArray(raw.byTicker);
  }

  async function publishedHistory(ticker, time, failures) {
    let snapshot = publishedCache && time - publishedCache.checkedAt < 5 * 60000 ? publishedCache.snapshot : null;
    if (!snapshot) {
      if (!publishedRequest && time < publishedRetryAt) {
        failures.push(...publishedFailures);
        return null;
      }
      if (!publishedRequest) {
        publishedRequest = (async () => {
          try {
            const raw = await fetchJson(PUBLISHED_PRICES_URL, PUBLIC_ASSET_LIMITS["data/prices.json"]);
            if (!validPriceSnapshot(raw, time)) throw new Error("Invalid published prices.");
            publishedCache = { snapshot: raw, checkedAt: time };
            publishedFailures = [];
            return raw;
          } catch (error) { publishedFailures = [failure("published-prices", error)]; publishedRetryAt = time + 30000; return null; }
          finally { publishedRequest = null; }
        })();
      }
      snapshot = await publishedRequest;
    }
    failures.push(...publishedFailures);
    try { return snapshotHistory(snapshot, ticker, time); }
    catch (error) { failures.push(failure("published-prices", error)); return null; }
  }

  function snapshotHistory(snapshot, ticker, time) {
    if (!validPriceSnapshot(snapshot, time)) return null;
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
      } catch (error) {
        const failures = [failure("yahoo", error)];
        const published = await publishedHistory(ticker, time, failures);
        if (published) return saveHistory(ticker, published, time);
        try {
          const embedded = snapshotHistory(await readMarketAsset("data/prices.json"), ticker, time);
          if (embedded) return saveHistory(ticker, embedded, time);
          throw new Error("Invalid embedded prices.");
        } catch (embeddedError) { failures.push(failure("embedded-prices", embeddedError)); }
        throw unavailable("PRICES_UNAVAILABLE", "The price provider is temporarily unavailable. Previously dated prices can still be used.", failures);
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
      } catch (error) {
        const failures = [failure("ecb-current", error)];
        const rate = await publishedRate("exchange-rate.json", (raw) => normalizeExchangeRate(raw, { now: time }), failures);
        if (rate) { exchangeCache = { rate, checkedAt: time }; return rate; }
        throw unavailable("RATE_UNAVAILABLE", "The current USD-to-EUR reference rate is temporarily unavailable.", failures);
      } finally { exchangeRequest = null; }
    })();
    return exchangeRequest;
  }

  async function loadHistoricalFx() {
    const time = clock();
    if (historicalFxCache && time - historicalFxCache.checkedAt < 60 * 60000
      && validHistoricalFx(historicalFxCache.snapshot, time)) return historicalFxCache.snapshot;
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
      } catch (error) {
        const failures = [failure("ecb-history", error)];
        const snapshot = await publishedRate("portfolio-fx.json", (raw) => validHistoricalFx(raw, time), failures);
        if (snapshot) { historicalFxCache = { snapshot, checkedAt: time }; return snapshot; }
        throw unavailable("RATES_UNAVAILABLE", "Historical reference rates are temporarily unavailable. Previously dated rates can still be used.", failures);
      } finally { historicalFxRequest = null; }
    })();
    return historicalFxRequest;
  }

  function validHistoricalFx(raw, time) {
    const snapshot = normalizeHistoricalFx(raw, { now: time });
    const start = Date.parse(historicalFxStart(time));
    return snapshot && PORTFOLIO_FX_CURRENCIES.every((currency) => {
      const points = snapshot.byCurrency[currency];
      return points?.length >= 200 && Date.parse(points[0].date) - start <= 14 * DAY
        && time - Date.parse(points.at(-1).date) <= 7 * DAY;
    }) ? snapshot : null;
  }

  async function publishedRate(file, normalize, failures) {
    const provider = file === "exchange-rate.json" ? "published-current-fx" : "published-history-fx";
    try {
      const raw = await fetchJson(`${PUBLISHED_BASE_URL}${file}`, PUBLIC_ASSET_LIMITS[`data/${file}`]);
      const value = normalize(raw);
      if (!value) throw new Error("Invalid published reference rates.");
      return value;
    } catch (error) { failures.push(failure(provider, error)); }
    try {
      const raw = await readMarketAsset(`data/${file}`);
      const value = normalize(raw);
      if (!value) throw new Error("Invalid embedded reference rates.");
      return value;
    } catch (error) { failures.push(failure(provider.replace("published", "embedded"), error)); }
    return null;
  }

  return { loadHistory, loadExchangeRate, loadHistoricalFx };
}
