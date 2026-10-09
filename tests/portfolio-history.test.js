import assert from "node:assert/strict";
import test from "node:test";
import { PORTFOLIO_FX_SOURCE, PORTFOLIO_FX_SOURCE_URL, normalizeHistoricalFx, historicalRate } from "../js/data/portfolio-history.js";
import { readSnapshotHistory, readSnapshotSeries } from "../js/data/price-snapshot.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = 86400000;
const fx = (overrides = {}) => ({ schemaVersion: 1, source: PORTFOLIO_FX_SOURCE, sourceUrl: PORTFOLIO_FX_SOURCE_URL,
  generatedAt: "2026-10-09T20:00:00.000Z", byCurrency: { USD: [{ date: "2026-10-05", rate: 0.86 },
    { date: "2026-10-09", rate: 0.89 }] }, ...overrides });
const history = (overrides = {}) => ({ ticker: "AAPL", source: "Yahoo Finance published snapshot", currency: "USD",
  instrumentType: "EQUITY", prices: Array.from({ length: 1250 }, (_, i) => ({
    date: new Date(NOW - (1250 - i) * DAY).toISOString(), close: 100 + i })), splits: [], ...overrides });
const prices = (record) => ({ schemaVersion: 1, generatedAt: new Date(NOW).toISOString(), byTicker: { AAPL: record } });

test("dated FX normalizer preserves actual coverage and source without changing the input", () => {
  const input = fx({ byCurrency: { USD: fx().byCurrency.USD.toReversed(), GBP: [{ date: "2026-10-06", rate: 1.16 }] } });
  const before = structuredClone(input);
  const result = normalizeHistoricalFx(input, { now: NOW });
  assert.deepEqual(input, before);
  assert.equal(result.source, PORTFOLIO_FX_SOURCE);
  assert.equal(result.byCurrency.USD[0].date, "2026-10-05");
  assert(Object.isFrozen(result.byCurrency.USD));
  assert(Object.isFrozen(result.byCurrency.USD[0]));
  assert.equal(normalizeHistoricalFx(fx({ generatedAt: "2026-10-09T20:00:00Z" }), { now: NOW }).generatedAt,
    "2026-10-09T20:00:00.000Z");
  // Old retrieval times remain valid for old valuations, never become current rates.
  assert(normalizeHistoricalFx(fx({ generatedAt: "2026-10-05T20:00:00Z", byCurrency: { USD: [{ date: "2026-10-05", rate: 0.86 }] } }), { now: NOW }));
});

test("FX schema rejects fabricated provenance, future or impossible dates, invalid rates and duplicates", () => {
  for (const input of [null, {}, [], fx({ source: "estimated" }), fx({ sourceUrl: "https://other.test/" }),
    fx({ schemaVersion: 2 }), fx({ available: false }), fx({ available: "true" }), fx({ generatedAt: "2026-10-11T20:00:00Z" }),
    fx({ generatedAt: "2026-09-31T20:00:00Z" }), fx({ generatedAt: null }), fx({ byCurrency: {} }),
    fx({ byCurrency: { XYZ: [{ date: "2026-10-05", rate: 1 }] } }), fx({ byCurrency: { EUR: [{ date: "2026-10-05", rate: 1 }] } }),
    ...[0, -1, Infinity, "0.89", null].map((rate) => fx({ byCurrency: { USD: [{ date: "2026-10-05", rate }] } })),
    ...["2026-02-29", "2026-10-11", "2026-10-9"].map((date) => fx({ byCurrency: { USD: [{ date, rate: 0.89 }] } })),
    fx({ byCurrency: { USD: [fx().byCurrency.USD[0], fx().byCurrency.USD[0]] } }),
    fx({ byCurrency: { USD: Array(1601).fill(fx().byCurrency.USD[0]) } })]) {
    assert.equal(normalizeHistoricalFx(input, { now: NOW }), null, JSON.stringify(input));
  }
});

test("FX lookup only uses a preceding dated observation within seven calendar days and EUR identity", () => {
  const input = normalizeHistoricalFx(fx(), { now: NOW });
  assert.deepEqual(historicalRate(input, "USD", "2026-10-08", { now: NOW }), { date: "2026-10-05", rate: 0.86 });
  assert.deepEqual(historicalRate(input, "USD", new Date("2026-10-10T16:00:00Z"), { now: NOW }), { date: "2026-10-09", rate: 0.89 });
  assert.deepEqual(historicalRate(input, "EUR", "2026-10-10", { now: NOW }), { date: "2026-10-10", rate: 1 });
  assert.equal(historicalRate(input, "USD", "2026-10-04", { now: NOW }), null);
  assert.equal(historicalRate(input, "USD", "2026-10-11", { now: NOW }), null);
  assert.equal(historicalRate(input, "EUR", "2026-10-11", { now: NOW }), null);
  assert.equal(historicalRate(input, "USD", "2026-02-29", { now: NOW }), null);
  assert.equal(historicalRate(input, "constructor", "2026-10-08", { now: NOW }), null);
  assert.equal(historicalRate(input, "CAD", "2026-10-08", { now: NOW }), null);
  assert.deepEqual(historicalRate(input, "USD", "2026-10-16", { now: NOW + 10 * DAY }), { date: "2026-10-09", rate: 0.89 });
  assert.equal(historicalRate(input, "USD", "2026-10-17", { now: NOW + 10 * DAY }), null);
  assert.equal(historicalRate(input, "USD", "2026-10-08", { now: Date.parse("2026-10-08T20:00:00Z") }), null);
});

test("full real price history is separate from the bounded recent scan series", () => {
  const record = history();
  const input = prices(record);
  const full = readSnapshotHistory(input, "AAPL", { now: NOW });
  const scan = readSnapshotSeries(input, "AAPL", { now: NOW });
  assert.equal(full.prices.length, 1250);
  assert.equal(scan.prices.length, 400);
  assert.equal(full.currency, "USD");
  assert.equal(full.splitsComplete, true);
  assert(full.prices[0].date instanceof Date);
  assert.equal(record.prices[0].date instanceof Date, false);
  assert.equal(scan.prices[0].close, full.prices.at(-400).close);
  const old = prices(history({ prices: record.prices.slice(0, -10) }));
  assert.equal(readSnapshotSeries(old, "AAPL", { now: NOW }), null);
  assert.equal(readSnapshotHistory(old, "AAPL", { now: NOW }).prices.length, 1240);
  const short = prices(history({ prices: record.prices.slice(-1) }));
  assert.equal(readSnapshotHistory(short, "AAPL", { now: NOW }).prices.length, 1);
  assert.equal(readSnapshotSeries(short, "AAPL", { now: NOW }), null);
});

test("history preserves known split events and distinguishes missing or malformed metadata", () => {
  const split = { date: "2026-09-01T13:30:00Z", numerator: 2, denominator: 1, splitRatio: "2:1" };
  const input = prices(history({ splits: [split] }));
  const read = readSnapshotHistory(input, "AAPL", { now: NOW });
  assert.equal(read.splitsComplete, true);
  assert.deepEqual(read.splits, [split]);
  read.splits[0].numerator = 10;
  assert.equal(split.numerator, 2);
  for (const splits of [undefined, null, [{}], [{ ...split, denominator: 0 }], [{ ...split, date: "2026-10-12T00:00:00Z" }]]) {
    assert.equal(readSnapshotHistory(prices(history({ splits })), "AAPL", { now: NOW }).splitsComplete, false);
  }
  assert.equal(readSnapshotHistory(prices(history({ splits: [], splitsComplete: false })), "AAPL", { now: NOW }).splitsComplete, false);
});

test("historical prices reject unrelated assets, fabricated sources, invalid metadata, future prices and excessive payloads", () => {
  for (const patch of [{ ticker: "OTHER" }, { source: "sample" }, { source: "anything" }, { currency: "usd" },
    { instrumentType: "FUTURE" }, { prices: [] }, { prices: Array(1601).fill(history().prices[0]) },
    { prices: [{ date: "2026-10-11T00:00:00Z", close: 100 }] }]) {
    assert.equal(readSnapshotHistory(prices(history(patch)), "AAPL", { now: NOW }), null);
  }
  assert.equal(readSnapshotHistory(prices(history()), "OTHER", { now: NOW }), null);
  assert.equal(readSnapshotHistory(prices(history()), "AAPL", { now: NaN }), null);
  assert.equal(readSnapshotHistory(prices(history({ currency: "GBp" })), "AAPL", { now: NOW }).currency, "GBp");
});

test("browser shares one same-origin historical FX request and retains original coverage during refresh failure", async (t) => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = NOW, calls = 0;
  t.after(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });
  Date.now = () => now;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    assert(String(url).endsWith("/data/portfolio-fx.json"));
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-cache");
    assert(options.signal instanceof AbortSignal);
    return Response.json(fx());
  };
  const { loadPortfolioFx } = await import("../js/data/portfolio-history.js?load-test");
  const [a, b] = await Promise.all([loadPortfolioFx(), loadPortfolioFx()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  now += 6 * 60000;
  globalThis.fetch = async () => { calls += 1; throw new Error("Network down"); };
  assert.equal(await loadPortfolioFx(), a);
  assert.equal(calls, 2);
  assert.equal(a.generatedAt, "2026-10-09T20:00:00.000Z");
});
