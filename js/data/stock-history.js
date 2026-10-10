import { loadPriceSnapshot, readSnapshotHistory, readSnapshotQuote } from "./price-snapshot.js";
import { parseYahooChart, parseYahooQuote } from "./yahoo-chart.js";

export const STOCK_HISTORY_CACHE_KEY = "investment-helper-stock-history-v1";
const DAY = 86400000;
const FRESH_MS = 5 * 60000;
const RETRY_MS = 30000;
const MAX_POINTS = 1600;
const MAX_SYMBOLS = 80;
const MAX_BYTES = 4 * 1024 * 1024;
const SOURCES = new Set(["Yahoo Finance published snapshot", "Yahoo Finance chart", "Yahoo Finance via CORS relay"]);
const memory = new Map();
const requests = new Map();
const queue = [];
let activeRequests = 0;

// These records contain public market data only. A request sends the ticker,
// never a portfolio's transactions, quantities, cost basis, or balances.
export async function loadStockHistory(ticker, { snapshot, now = Date.now(), storage = browserStorage() } = {}) {
  ticker = normalizeTicker(ticker);
  if (!ticker || !Number.isFinite(now)) return null;
  if (snapshot === undefined) snapshot = await loadPriceSnapshot();
  const published = normalizeStockHistory(readSnapshotHistory(snapshot, ticker, { now }), ticker, { now });
  if (published) {
    const quote = readSnapshotQuote(snapshot, ticker, { now });
    if (quote) published.quote = quote;
  }
  const saved = readCachedStockHistory(ticker, { now, storage });
  const best = newerHistory(published, saved);
  if (published && now - Date.parse(published.historyAsOf) <= 7 * DAY) return best;
  const checkedAt = memory.get(ticker)?.checkedAt;
  if (saved && Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt < FRESH_MS
    || Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt < RETRY_MS) return best;
  if (requests.has(ticker)) return requests.get(ticker);
  const request = withNetworkSlot(async () => {
    const loaded = await fetchStockHistory(ticker, now);
    const history = newerHistory(best, loaded);
    // A later retrieval never gives older bars or quotes a new observation date.
    if (history) memory.set(ticker, { history, checkedAt: now });
    else memory.set(ticker, { history: null, checkedAt: now });
    trimMemory();
    if (loaded) persistHistory(ticker, history, now, storage);
    return history;
  }).finally(() => requests.delete(ticker));
  requests.set(ticker, request);
  return request;
}

export async function loadStockHistories(tickers, options = {}) {
  const symbols = [...new Set((Array.isArray(tickers) ? tickers : []).map(normalizeTicker).filter(Boolean))];
  const snapshot = options.snapshot === undefined ? await loadPriceSnapshot() : options.snapshot;
  const entries = await Promise.all(symbols.map(async (ticker) => [ticker, await loadStockHistory(ticker, { ...options, snapshot })]));
  return Object.fromEntries(entries);
}

export function readCachedStockHistory(ticker, { now = Date.now(), storage = browserStorage() } = {}) {
  ticker = normalizeTicker(ticker);
  if (!ticker || !Number.isFinite(now)) return null;
  const cached = memory.get(ticker);
  const inMemory = normalizeStockHistory(cached?.history, ticker, { now });
  if (inMemory) return inMemory;
  const persisted = readCache(storage, now).find((entry) => entry.history.ticker === ticker);
  if (!persisted) return null;
  memory.set(ticker, persisted);
  trimMemory();
  return normalizeStockHistory(persisted.history, ticker, { now });
}

// Persisted data is untrusted. Recheck identity, provenance, currency, actual
// dated closes, and split metadata before using it in valuations or scans.
export function normalizeStockHistory(input, ticker, { now = Date.now() } = {}) {
  ticker = normalizeTicker(ticker);
  if (!ticker || !Number.isFinite(now) || !input || input.ticker !== ticker || !SOURCES.has(input.source)
    || !/^(?:[A-Z]{3}|GBp)$/.test(input.currency || "")
    || !["EQUITY", "ETF", "INDEX"].includes(String(input.instrumentType).toUpperCase())
    || !Array.isArray(input.prices) || !input.prices.length || input.prices.length > MAX_POINTS) return null;
  const utcToday = new Date(now).toISOString().slice(0, 10);
  const localParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Tallinn",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  const localToday = `${localParts.year}-${localParts.month}-${localParts.day}`;
  const completed = new Map();
  for (const point of input.prices) {
    const time = timestamp(point?.date);
    if (!Number.isFinite(time) || time > now || !Number.isFinite(point?.close) || point.close <= 0) return null;
    const date = new Date(time);
    const day = date.toISOString().slice(0, 10);
    if (day >= utcToday || day >= localToday) continue;
    if (completed.has(day)) return null;
    const clean = { date, close: point.close };
    for (const field of ["high", "low", "volume"]) if (Number.isFinite(point[field]) && point[field] >= 0) clean[field] = point[field];
    completed.set(day, clean);
  }
  const prices = [...completed.values()].sort((a, b) => a.date - b.date);
  if (!prices.length) return null;
  const validSplit = (split) => Number.isFinite(timestamp(split?.date)) && timestamp(split.date) <= now
    && Number.isFinite(split.numerator) && split.numerator > 0 && Number.isFinite(split.denominator) && split.denominator > 0;
  const splitsComplete = input.splitsComplete !== false && Array.isArray(input.splits) && input.splits.length <= 100
    && input.splits.every(validSplit);
  const splits = Array.isArray(input.splits) ? input.splits.slice(0, 100).filter(validSplit).map((split) => ({
    date: new Date(timestamp(split.date)).toISOString(), numerator: split.numerator, denominator: split.denominator,
    ...(typeof split.splitRatio === "string" ? { splitRatio: split.splitRatio.slice(0, 50) } : {})
  })) : [];
  const quote = normalizeQuote(input.quote, ticker, input.currency, now);
  return { ticker, currency: input.currency, instrumentType: String(input.instrumentType).toUpperCase(),
    source: input.source, prices, historyAsOf: prices.at(-1).date.toISOString(), splits, splitsComplete,
    ...(quote ? { quote } : {}) };
}

async function fetchStockHistory(ticker, now) {
  const direct = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5y&interval=1d&events=splits`;
  const relay = `https://api.allorigins.win/raw?url=${encodeURIComponent(direct)}`;
  for (const [index, url] of [direct, relay].entries()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), index ? 12000 : 8000);
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "omit", headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) continue;
      const text = await response.text();
      if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) continue;
      const json = JSON.parse(text);
      const result = json?.chart?.result?.[0];
      if (!Array.isArray(result?.timestamp) || result.timestamp.length > MAX_POINTS
        || result.meta?.dataGranularity && result.meta.dataGranularity !== "1d"
        || result.timestamp.some((value) => typeof value !== "number" || !Number.isFinite(value) || value * 1000 > now)) continue;
      const parsed = parseYahooChart(json, ticker);
      if (!parsed) continue;
      parsed.source = index ? "Yahoo Finance via CORS relay" : "Yahoo Finance chart";
      parsed.quote = parseYahooQuote(json, ticker, { now });
      const history = normalizeStockHistory(parsed, ticker, { now });
      if (history) return history;
    } catch {
      // CORS, provider failures, or malformed responses leave dated saved data intact.
    } finally { clearTimeout(timeout); }
  }
  return null;
}

function normalizeQuote(quote, ticker, currency, now) {
  const time = timestamp(quote?.quoteTime);
  if (!quote || quote.ticker !== ticker || quote.currency !== currency
    || !["Yahoo Finance quote", "Yahoo Finance published quote"].includes(quote.source)
    || !Number.isFinite(time) || time > now || now - time > 7 * DAY || !Number.isFinite(quote.price) || quote.price <= 0) return null;
  return { ...quote, quoteTime: new Date(time) };
}

function normalizeTicker(value) {
  const ticker = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9^][A-Z0-9.^-]{0,30}$/.test(ticker) ? ticker : null;
}

function browserStorage() {
  try { return globalThis.localStorage; }
  catch { return null; }
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value.slice(0, 10) ? time : NaN;
}

function newerHistory(left, right) {
  if (!left) return right;
  if (!right) return left;
  const selected = Date.parse(right.historyAsOf) > Date.parse(left.historyAsOf)
    || right.historyAsOf === left.historyAsOf && right.prices.length > left.prices.length ? right : left;
  const quotes = [left.quote, right.quote].filter(Boolean).sort((a, b) => b.quoteTime - a.quoteTime);
  return quotes.length ? { ...selected, quote: quotes[0] } : selected;
}

function readCache(storage, now) {
  try {
    const serialized = storage?.getItem(STOCK_HISTORY_CACHE_KEY);
    if (typeof serialized !== "string" || serialized.length > MAX_BYTES
      || new TextEncoder().encode(serialized).byteLength > MAX_BYTES) return [];
    const data = JSON.parse(serialized);
    if (data.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_SYMBOLS) return [];
    return data.entries.flatMap((entry) => {
      const checkedAt = timestamp(entry?.checkedAt);
      const history = normalizeStockHistory(entry?.history, entry?.history?.ticker, { now });
      return history && Number.isFinite(checkedAt) && checkedAt <= now ? [{ checkedAt, history }] : [];
    });
  } catch { return []; }
}

function persistHistory(ticker, history, now, storage) {
  try {
    const entries = readCache(storage, now).filter((entry) => entry.history.ticker !== ticker);
    entries.unshift({ history, checkedAt: now });
    let serialized;
    do {
      serialized = JSON.stringify({ schemaVersion: 1, entries: entries.slice(0, MAX_SYMBOLS).map((entry) => ({
        checkedAt: new Date(entry.checkedAt).toISOString(), history: compactHistory(entry.history)
      })) });
      if (serialized.length <= MAX_BYTES && new TextEncoder().encode(serialized).byteLength <= MAX_BYTES) break;
      entries.pop();
    } while (entries.length);
    if (entries.length) storage?.setItem(STOCK_HISTORY_CACHE_KEY, serialized);
  } catch { /* Storage limits do not affect the immutable portfolio ledger. */ }
}

function compactHistory(history) {
  return { ...history, prices: history.prices.map((point, index) => index < history.prices.length - 400
    ? { date: point.date, close: point.close } : point) };
}

function trimMemory() {
  if (memory.size <= MAX_SYMBOLS) return;
  const oldest = [...memory].sort((a, b) => a[1].checkedAt - b[1].checkedAt);
  for (const [ticker] of oldest.slice(0, memory.size - MAX_SYMBOLS)) memory.delete(ticker);
}

function withNetworkSlot(worker) {
  return new Promise((resolve, reject) => { queue.push({ worker, resolve, reject }); drainQueue(); });
}

function drainQueue() {
  while (activeRequests < 3 && queue.length) {
    const { worker, resolve, reject } = queue.shift();
    activeRequests += 1;
    Promise.resolve().then(worker).then(resolve, reject).finally(() => { activeRequests -= 1; drainQueue(); });
  }
}
