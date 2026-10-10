import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateDataQuality } from "../js/analysis/data-quality.js";
import { INSTRUMENT_SOURCE, INSTRUMENT_SOURCE_URL } from "../js/data/ticker-search.js";
import { loadStockHistory } from "../js/data/stock-history.js";
import { loadScanCache, saveScanCache } from "../js/data/scan-cache.js";

globalThis.window = { setTimeout, clearTimeout };
const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) || null, setItem(key, value) { storage.set(key, value); } };
const { validateWatchlistTicker, loadMarketSeries, loadQuoteSnapshots } = await import("../js/data/market.js");
const now = Date.now();
const yesterday = new Date(now - 86400000).toISOString();
const day = new Date(now);
const sourceAsOf = `${String(day.getUTCMonth() + 1).padStart(2, "0")}${String(day.getUTCDate()).padStart(2, "0")}${day.getUTCFullYear()}00:00`;
const empty = { schemaVersion: 1, generatedAt: new Date(now - 1000).toISOString(), byTicker: {} };
const young = { ticker: "NEW", currency: "USD", instrumentType: "EQUITY", source: "Yahoo Finance published snapshot",
  prices: [{ date: yesterday, close: 100 }], splits: [], splitsComplete: true };

test("fresh exchange listings and young published stocks validate without live quotes; nonsense does not", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const remote = [];
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/data/prices.json")) return Response.json({ ...empty, byTicker: { NEW: young } });
    if (path.endsWith("/data/sec-tickers.json")) return Response.json({ schemaVersion: 1, companyTickers: {} });
    if (path.endsWith("/data/instruments.json")) return Response.json({ schemaVersion: 1, source: INSTRUMENT_SOURCE,
      sourceUrl: INSTRUMENT_SOURCE_URL, generatedAt: new Date(now - 1000).toISOString(), sourceAsOf,
      entries: [{ ticker: "SNDK", label: "Sandisk Corporation", type: "stock", exchange: "Q", aliases: ["Sandisk"] }] });
    remote.push(path);
    throw new Error("Offline provider");
  };
  assert.equal(await validateWatchlistTicker("NEW"), "valid");
  assert.equal(await validateWatchlistTicker("SNDK"), "valid");
  assert.equal(remote.length, 0);
  const data = await loadMarketSeries("NEW");
  assert.equal(data.prices.length, 1);
  assert.equal(evaluateDataQuality(data).eligible, false);
  assert.equal(await validateWatchlistTicker("XXXXXXXXXXX"), "unavailable");
  assert.equal(await validateWatchlistTicker("BAD SYMBOL"), "invalid");
  assert.equal(await validateWatchlistTicker("BTC-USD"), "unsupported");
  assert.equal(remote.length, 2);
});

test("saved public history does not suppress a newer quote request", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const oldTime = Math.floor((now - 86400000) / 1000);
  globalThis.fetch = async () => Response.json({ chart: { result: [{
    meta: { symbol: "QUOTETEST", currency: "USD", instrumentType: "EQUITY", dataGranularity: "1d",
      regularMarketPrice: 100, regularMarketTime: oldTime, shortName: "Quote test" },
    timestamp: [oldTime], indicators: { quote: [{ close: [100] }] }, events: { splits: {} }
  }] } });
  const history = await loadStockHistory("QUOTETEST", { snapshot: empty, now, storage: null });
  assert.equal(history.quote.price, 100);
  const scanSeries = { ...history, prices: Array.from({ length: 200 }, (_, index) => ({
    date: new Date((oldTime - (199 - index) * 86400) * 1000), close: 100
  })) };
  assert.equal(saveScanCache({ series: [scanSeries], quotes: { source: "Yahoo Finance quote",
    byTicker: new Map([["QUOTETEST", history.quote]]) } }), true);
  assert.equal(loadScanCache().quotes.byTicker.get("QUOTETEST").price, 100);
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return Response.json({ chart: { result: [{ meta: { symbol: "QUOTETEST", currency: "USD", instrumentType: "EQUITY",
      regularMarketPrice: 120, regularMarketTime: Math.floor(now / 1000), shortName: "Sandisk" } }] } });
  };
  const quotes = await loadQuoteSnapshots(["QUOTETEST"]);
  assert.equal(quotes.byTicker.get("QUOTETEST").price, 120);
  assert(calls.some((url) => url.includes("range=1d")));
});
