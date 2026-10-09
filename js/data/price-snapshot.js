import { evaluateDataQuality, validHistoryPoints } from "../analysis/data-quality.js";

const SNAPSHOT_URL = new URL("../../data/prices.json", import.meta.url);
let request = null;
let expiresAt = 0;

// One same-origin request serves histories, index proxies, and dated quotes.
// This also keeps working under GitHub Pages' /investment_helper/ base path.
export function loadPriceSnapshot() {
  if (request && Date.now() < expiresAt) return request;
  expiresAt = Date.now() + 5 * 60 * 1000;
  request = fetchSnapshot();
  return request;
}

async function fetchSnapshot() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(SNAPSHOT_URL, { cache: "no-cache", credentials: "same-origin", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    if (snapshot?.schemaVersion !== 1 || !snapshot.byTicker || typeof snapshot.byTicker !== "object"
      || Array.isArray(snapshot.byTicker) || !Number.isFinite(Date.parse(snapshot.generatedAt))
      || Date.parse(snapshot.generatedAt) > Date.now()) throw new Error("Invalid price snapshot");
    return snapshot;
  } catch (error) {
    expiresAt = Date.now() + 30000;
    return { schemaVersion: 1, generatedAt: null, byTicker: {}, available: false,
      reason: `Published prices unavailable: ${error?.message || "request failed"}.` };
  } finally {
    clearTimeout(timeout);
  }
}

function recordFor(snapshot, ticker) {
  return snapshot?.schemaVersion === 1 && Object.hasOwn(snapshot.byTicker || {}, ticker) ? snapshot.byTicker[ticker] : null;
}

export function readSnapshotHistory(snapshot, ticker, { now = Date.now() } = {}) {
  const record = recordFor(snapshot, ticker);
  if (!record || record.ticker !== ticker || record.source !== "Yahoo Finance published snapshot"
    || !Array.isArray(record.prices) || record.prices.length > 1600
    || !/^(?:[A-Z]{3}|GBp)$/.test(record.currency || "")
    || !["EQUITY", "ETF", "INDEX"].includes(String(record.instrumentType).toUpperCase())) return null;
  const prices = validHistoryPoints(record).map((point) => ({ ...point, date: new Date(point.date) }));
  const lastTime = prices.at(-1)?.date.getTime();
  if (!Number.isFinite(lastTime) || lastTime > now || !Number.isFinite(new Date(now).getTime())) return null;
  const splitsComplete = record.splitsComplete !== false && Array.isArray(record.splits) && record.splits.length <= 100
    && record.splits.every((split) => Number.isFinite(Date.parse(split?.date)) && Date.parse(split.date) <= now
      && Number.isFinite(split.numerator) && split.numerator > 0 && Number.isFinite(split.denominator) && split.denominator > 0);
  return { ticker, prices, historyAsOf: new Date(lastTime).toISOString(),
    instrumentType: record.instrumentType, currency: record.currency,
    splits: splitsComplete ? record.splits.map((split) => ({ ...split })) : [], splitsComplete,
    source: "Yahoo Finance published snapshot" };
}

export function readSnapshotSeries(snapshot, ticker, { now = Date.now() } = {}) {
  const history = readSnapshotHistory(snapshot, ticker, { now });
  if (!history) return null;
  // Scan-cache records deliberately stay small; portfolio history uses all
  // published completed closes through readSnapshotHistory instead.
  const series = { ...history, prices: history.prices.slice(-400) };
  return evaluateDataQuality(series, now).eligible ? series : null;
}

export function readSnapshotQuote(snapshot, ticker, { now = Date.now() } = {}) {
  const record = recordFor(snapshot, ticker);
  const quote = record?.quote;
  const time = Date.parse(quote?.quoteTime);
  if (!record || record.ticker !== ticker || !quote || quote.ticker !== ticker
    || /^sample\b/i.test(record.source || "") || /^sample\b/i.test(quote.source || "")
    || !Number.isFinite(quote.price) || quote.price <= 0 || !Number.isFinite(time)
    || time > now || now - time > 7 * 86400000
    || !/^[A-Za-z]{3}$/.test(quote.currency || "") || quote.currency !== record.currency) return null;
  return { ...quote, quoteTime: new Date(time), source: "Yahoo Finance published quote" };
}
