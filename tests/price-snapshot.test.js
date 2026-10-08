import assert from "node:assert/strict";
import { test } from "node:test";
import { readSnapshotSeries, readSnapshotQuote } from "../js/data/price-snapshot.js";
import { parseYahooChart, parseYahooQuote } from "../js/data/yahoo-chart.js";
import { marketProxyTickers } from "../js/config/settings.js";

const DAY = 86400000;
const NOW = Date.now();
function record(ticker = "SPY") {
  return { ticker, source: "Yahoo Finance published snapshot", instrumentType: "ETF", currency: "USD",
    prices: Array.from({ length: 252 }, (_, index) => ({ date: new Date(NOW - (252 - index) * DAY).toISOString(),
      close: 100 + index, high: 101 + index, low: 99 + index, volume: 1000000 })),
    quote: { ticker, price: 351, currency: "USD", dayChangePercent: 0, quoteTime: new Date(NOW - 1000).toISOString(), source: "Yahoo Finance published quote" } };
}
function snapshot(records) {
  return { schemaVersion: 1, generatedAt: new Date(NOW - 500).toISOString(), byTicker: Object.fromEntries(records.map((item) => [item.ticker, item])) };
}

test("published histories retain original dates and cannot be rescued by a fresh generatedAt", () => {
  const data = snapshot([record()]);
  const revived = readSnapshotSeries(data, "SPY", { now: NOW });
  assert.equal(revived.prices.length, 252);
  assert(revived.prices[0].date instanceof Date);
  assert.equal(revived.historyAsOf, data.byTicker.SPY.prices.at(-1).date);
  assert.equal(data.byTicker.SPY.prices[0].date instanceof Date, false);
  data.byTicker.SPY.prices = data.byTicker.SPY.prices.map((point) => ({ ...point, date: new Date(Date.parse(point.date) - 10 * DAY).toISOString() }));
  data.byTicker.SPY.historyAsOf = new Date(NOW).toISOString();
  assert.equal(readSnapshotSeries(data, "SPY", { now: NOW }), null);
});

test("wrong symbols, sample histories, missing currency, short and future histories are unavailable", () => {
  for (const patch of [{ ticker: "OTHER" }, { source: "sample" }, { currency: "" }, { instrumentType: "FUTURE" },
    { prices: record().prices.slice(-199) }, { prices: record().prices.map((point) => ({ ...point, date: new Date(NOW + DAY).toISOString() })) }]) {
    const data = snapshot([record()]);
    Object.assign(data.byTicker.SPY, patch);
    assert.equal(readSnapshotSeries(data, "SPY", { now: NOW }), null);
  }
});

test("snapshot quotes preserve zero change and original times; stale, wrong-currency, or future quotes fail", () => {
  const data = snapshot([record()]);
  const quote = readSnapshotQuote(data, "SPY", { now: NOW });
  assert.equal(quote.dayChangePercent, 0);
  assert.equal(quote.quoteTime.toISOString(), data.byTicker.SPY.quote.quoteTime);
  for (const patch of [{ ticker: "QQQ" }, { currency: "EUR" }, { price: null }, { source: "sample" },
    { quoteTime: new Date(NOW + 1).toISOString() }, { quoteTime: new Date(NOW - 8 * DAY).toISOString() }]) {
    const bad = structuredClone(data);
    Object.assign(bad.byTicker.SPY.quote, patch);
    assert.equal(readSnapshotQuote(bad, "SPY", { now: NOW }), null);
  }
});

function chart({ interval = "1d", prices = [100, 110, 120], ticker = "SPY" } = {}) {
  const midnight = Math.floor(Date.UTC(2026, 9, 8) / 1000);
  return { chart: { result: [{ meta: { symbol: ticker, currency: "USD", instrumentType: "ETF", dataGranularity: interval,
    regularMarketTime: midnight + 16 * 3600, regularMarketPrice: 120, chartPreviousClose: 20, previousClose: 110 },
    timestamp: prices.map((_, index) => midnight - (prices.length - 1 - index) * 86400 + 13 * 3600),
    indicators: { quote: [{ close: prices }] } }] } };
}
const QUOTE_NOW = Date.UTC(2026, 9, 8, 17);

test("daily Yahoo snapshots use yesterday's actual close rather than the start-of-year chartPreviousClose", () => {
  const quote = parseYahooQuote(chart(), "SPY", { now: QUOTE_NOW });
  assert.equal(quote.previousClose, 110);
  assert.equal(quote.dayChangePercent, 120 / 110 - 1);
  const intraday = chart({ interval: "1m" });
  intraday.chart.result[0].meta.previousClose = 115;
  assert.equal(parseYahooQuote(intraday, "SPY", { now: QUOTE_NOW }).previousClose, 115);
  assert.equal(parseYahooQuote(chart({ prices: [120] }), "SPY", { now: QUOTE_NOW }).dayChangePercent, null);
});

test("Yahoo parsing rejects unrelated assets, missing metadata, and null prices", () => {
  assert.equal(parseYahooChart(chart({ ticker: "OTHER" }), "SPY"), null);
  assert.equal(parseYahooQuote(chart({ ticker: "OTHER" }), "SPY", { now: QUOTE_NOW }), null);
  const data = chart({ prices: [null, 0, 120] });
  assert.equal(parseYahooChart(data, "SPY").prices.length, 1);
  data.chart.result[0].meta.currency = "";
  assert.equal(parseYahooChart(data, "SPY"), null);
  data.chart.result[0].meta.currency = "USD";
  data.chart.result[0].meta.regularMarketTime += 86400;
  assert.equal(parseYahooQuote(data, "SPY", { now: QUOTE_NOW }), null);
});

test("browser scan, quotes and market proxies work from one same-origin fetch when all external requests fail", async (t) => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window = { setTimeout, clearTimeout };
  const data = snapshot([...new Set(["AAPL", "UUP", ...marketProxyTickers.map((item) => item.ticker)])].map(record));
  const originalFetch = globalThis.fetch;
  const requests = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    assert(String(url).endsWith("/data/prices.json"));
    assert.equal(options.credentials, "same-origin");
    return Response.json(data);
  };
  const { loadTickerSeries, loadQuoteSnapshots, loadMarketContext, validateWatchlistTicker } = await import("../js/data/market.js");
  const [series, quotes, context, valid] = await Promise.all([
    loadTickerSeries(["SPY", "QQQ", "AAPL", "UUP"]), loadQuoteSnapshots(["SPY", "QQQ", "AAPL", "UUP"]),
    loadMarketContext(), validateWatchlistTicker("AAPL")
  ]);
  assert.equal(requests.length, 1);
  assert.equal(series.length, 4);
  assert(series.every((item) => item.prices.length === 252 && item.source === "Yahoo Finance published snapshot"));
  assert.equal(quotes.count, 4);
  assert.equal(quotes.byTicker.get("UUP").dayChangePercent, 0);
  assert.equal(context.available, true);
  assert.equal(context.liveCount, marketProxyTickers.length);
  assert.equal(valid, "valid");
  // A new, uncovered ticker fails explicitly; it never gets invented prices.
  globalThis.fetch = async () => { throw new Error("CORS / relay offline"); };
  const missing = (await loadTickerSeries(["UNKNOWN"]))[0];
  assert.equal(missing.source, "unavailable");
  assert.deepEqual(missing.prices, []);
});
