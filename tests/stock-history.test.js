import assert from "node:assert/strict";
import test from "node:test";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = 86400000;
const emptySnapshot = { schemaVersion: 1, byTicker: {} };
const store = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
const chart = (ticker = "SNDK", overrides = {}) => ({ chart: { result: [{
  meta: { symbol: ticker, currency: "USD", instrumentType: "EQUITY", dataGranularity: "1d",
    regularMarketPrice: 115, regularMarketTime: Date.parse("2026-10-09T20:00:00Z") / 1000,
    longName: "SanDisk Corporation", ...overrides.meta },
  timestamp: ["2026-10-07", "2026-10-08", "2026-10-09"].map((date) => Date.parse(`${date}T13:30:00Z`) / 1000),
  indicators: { quote: [{ close: [100, 110, 115], high: [102, 112, 116], low: [99, 108, 114], volume: [1000, 1200, 1300] }] },
  ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "meta"))
}] } });
const inputHistory = (overrides = {}) => ({ ticker: "SNDK", source: "Yahoo Finance chart", currency: "USD",
  instrumentType: "EQUITY", prices: [{ date: "2026-10-07T13:30:00Z", close: 100 },
    { date: "2026-10-09T13:30:00Z", close: 115 }], splits: [], splitsComplete: true, ...overrides });
let sequence = 0;
const moduleForTest = () => import(`../js/data/stock-history.js?test=${++sequence}`);

test("a portfolio ticker outside the preset loads real five-year daily history and a dated quote without a 200-day minimum", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.credentials, "omit");
    assert(options.signal instanceof AbortSignal);
    return Response.json(chart());
  };
  const { loadStockHistory, readCachedStockHistory, STOCK_HISTORY_CACHE_KEY } = await moduleForTest();
  const storage = store();
  const result = await loadStockHistory("sndk", { snapshot: emptySnapshot, now: NOW, storage });
  assert.equal(result.ticker, "SNDK");
  assert.equal(result.prices.length, 3);
  assert.equal(result.prices[2].close, 115);
  assert.equal(result.historyAsOf, "2026-10-09T13:30:00.000Z");
  assert.equal(result.source, "Yahoo Finance chart");
  assert.equal(result.quote.quoteTime.toISOString(), "2026-10-09T20:00:00.000Z");
  assert.equal(result.quote.price, 115);
  assert.equal(result.splitsComplete, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/SNDK\?range=5y&interval=1d&events=splits$/);
  assert.equal(readCachedStockHistory("SNDK", { now: NOW, storage }).prices[0].close, 100);
  assert.match(storage.getItem(STOCK_HISTORY_CACHE_KEY), /2026-10-09T13:30:00.000Z/);
  assert.doesNotMatch(storage.getItem(STOCK_HISTORY_CACHE_KEY), /transactions|quantity|costBasis|cashAmount/);
});

test("recent published history avoids external requests and still returns full closes", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = () => { throw new Error("Published history should not request a provider"); };
  const { loadStockHistory } = await moduleForTest();
  const snapshot = { schemaVersion: 1, byTicker: { SNDK: inputHistory({ source: "Yahoo Finance published snapshot" }) } };
  const before = structuredClone(snapshot);
  const result = await loadStockHistory("SNDK", { snapshot, now: NOW, storage: store() });
  assert.equal(result.prices.length, 2);
  assert.equal(result.source, "Yahoo Finance published snapshot");
  assert.deepEqual(snapshot, before);
});

test("direct CORS failure uses the relay and concurrent duplicate calls share one request", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://query1")) throw new Error("CORS");
    return Response.json(chart());
  };
  const { loadStockHistory } = await moduleForTest();
  const storage = store();
  const [a, b] = await Promise.all([loadStockHistory("SNDK", { snapshot: emptySnapshot, now: NOW, storage }),
    loadStockHistory("SNDK", { snapshot: emptySnapshot, now: NOW, storage })]);
  assert.equal(a, b);
  assert.equal(calls.length, 2);
  assert.equal(a.source, "Yahoo Finance via CORS relay");
  const relay = new URL(calls[1]);
  assert.equal(relay.searchParams.get("url"), calls[0]);
});

test("network work is limited to three requests across overlapping batches", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let active = 0, peak = 0, calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1; active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return Response.json(chart(new URL(url).pathname.split("/").at(-1)));
  };
  const { loadStockHistories } = await moduleForTest();
  const options = { snapshot: emptySnapshot, now: NOW, storage: store() };
  const [a, b] = await Promise.all([loadStockHistories(["SNDK", "QCOM", "ASML", "ARM"], options),
    loadStockHistories(["QCOM", "DELL", "WDC", "STX"], options)]);
  assert.equal(peak, 3);
  assert.equal(calls, 7);
  assert.equal(a.QCOM, b.QCOM);
});

test("current UTC bars are excluded even after midnight in Tallinn and future observations are rejected", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const { loadStockHistory, normalizeStockHistory } = await moduleForTest();
  const now = Date.parse("2026-10-09T22:30:00Z");
  globalThis.fetch = async () => Response.json(chart());
  const result = await loadStockHistory("SNDK", { snapshot: emptySnapshot, now, storage: store() });
  assert.equal(result.historyAsOf, "2026-10-08T13:30:00.000Z");
  assert.equal(result.prices.length, 2);
  assert.equal(normalizeStockHistory(inputHistory({ prices: [{ date: "2026-10-11", close: 1 }] }), "SNDK", { now: NOW }), null);
});

test("malformed provenance, identity, currency, types, duplicate and impossible dates cannot become valued history", async () => {
  const { normalizeStockHistory } = await moduleForTest();
  for (const patch of [{ ticker: "OTHER" }, { source: "sample" }, { source: "Yahoo" }, { currency: "usd" },
    { instrumentType: "FUTURE" }, { prices: [] }, { prices: [{ date: "2026-02-30", close: 100 }] },
    { prices: [{ date: "2026-10-09", close: 0 }] }, { prices: Array(1601).fill(inputHistory().prices[0]) },
    { prices: [inputHistory().prices[0], inputHistory().prices[0]] }]) {
    assert.equal(normalizeStockHistory(inputHistory(patch), "SNDK", { now: NOW }), null, JSON.stringify(patch));
  }
  const damagedSplits = normalizeStockHistory(inputHistory({ splits: [{ date: "2026-10-08", numerator: 2, denominator: 0 }] }), "SNDK", { now: NOW });
  assert.equal(damagedSplits.splitsComplete, false);
});

test("wrong ticker, wrong asset type, and intraday payloads fail both routes without caching generated history", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const json of [chart("OTHER"), chart("SNDK", { meta: { instrumentType: "CRYPTOCURRENCY" } }),
    chart("SNDK", { meta: { dataGranularity: "1m" } }), chart("SNDK", { timestamp: [Date.parse("2026-10-11") / 1000] })]) {
    const { loadStockHistory, STOCK_HISTORY_CACHE_KEY } = await moduleForTest();
    const storage = store();
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return Response.json(json); };
    assert.equal(await loadStockHistory("SNDK", { snapshot: emptySnapshot, now: NOW, storage }), null);
    assert.equal(calls, 2);
    assert.equal(storage.getItem(STOCK_HISTORY_CACHE_KEY), null);
  }
});

test("a failed refresh preserves original dated cached history for older valuations and does not redate it", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const { loadStockHistory } = await moduleForTest();
  const storage = store();
  globalThis.fetch = async () => Response.json(chart());
  const first = await loadStockHistory("SNDK", { snapshot: emptySnapshot, now: NOW, storage });
  globalThis.fetch = async () => { throw new Error("Provider unavailable"); };
  const later = await loadStockHistory("SNDK", { snapshot: emptySnapshot, now: NOW + 10 * DAY, storage });
  assert.equal(later.historyAsOf, first.historyAsOf);
  assert.deepEqual(later.prices, first.prices);
  assert.equal(later.quote, undefined);
  assert.equal(later.prices.length, 3);
});

test("saved public histories are bounded, revalidated, and preserve latest 400 OHLCV for scans", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const storage = store();
  const fullChart = chart();
  const result = fullChart.chart.result[0];
  result.timestamp = Array.from({ length: 1200 }, (_, i) => (NOW - (1200 - i) * DAY) / 1000);
  result.indicators.quote[0] = { close: Array(1200).fill(100), high: Array(1200).fill(110), low: Array(1200).fill(90), volume: Array(1200).fill(1000) };
  globalThis.fetch = async () => Response.json(fullChart);
  const { loadStockHistory, STOCK_HISTORY_CACHE_KEY } = await moduleForTest();
  assert.equal((await loadStockHistory("SNDK", { snapshot: emptySnapshot, now: NOW, storage })).prices.length, 1200);
  const revivedModule = await moduleForTest();
  const revived = revivedModule.readCachedStockHistory("SNDK", { now: NOW, storage });
  assert.equal(revived.prices.length, 1200);
  assert.equal(revived.prices[0].high, undefined);
  assert.equal(revived.prices.at(-400).high, 110);
  assert.equal(revived.prices.at(-1).volume, 1000);
  const data = JSON.parse(storage.getItem(STOCK_HISTORY_CACHE_KEY));
  data.entries[0].history.ticker = "OTHER";
  storage.setItem(STOCK_HISTORY_CACHE_KEY, JSON.stringify(data));
  assert.equal((await moduleForTest()).readCachedStockHistory("SNDK", { now: NOW, storage }), null);
  storage.setItem(STOCK_HISTORY_CACHE_KEY, "x".repeat(4 * 1024 * 1024 + 1));
  assert.equal((await moduleForTest()).readCachedStockHistory("SNDK", { now: NOW, storage }), null);
});

test("a browser denying localStorage access still loads public market history and never opens portfolio storage", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true,
    get() { throw new DOMException("Storage denied", "SecurityError"); } });
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests += 1;
    assert.match(String(url), /\/SNDK\?range=5y&interval=1d&events=splits$/);
    assert.equal(options.body, undefined);
    return Response.json(chart());
  };
  const { loadStockHistory, readCachedStockHistory } = await moduleForTest();
  assert.equal(readCachedStockHistory("SNDK", { now: NOW }), null);
  const result = await loadStockHistory("SNDK", { snapshot: emptySnapshot, now: NOW });
  assert.equal(result.prices.length, 3);
  assert.equal(readCachedStockHistory("SNDK", { now: NOW }).historyAsOf, "2026-10-09T13:30:00.000Z");
  assert.equal(requests, 1);
});
