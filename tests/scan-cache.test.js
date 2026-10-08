import assert from "node:assert/strict";
import { test } from "node:test";
import { loadScanCache, saveScanCache, SCAN_CACHE_KEY } from "../js/data/scan-cache.js";

const NOW = Date.UTC(2026, 9, 5, 16);
const DAY = 86400000;
function storage() {
  const items = new Map([["today-invest-model-state", "existing portfolio"]]);
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
}
function series(ticker = "ACME", overrides = {}) {
  return { ticker, source: "fixture", historyAsOf: new Date(NOW - DAY).toISOString(),
    prices: Array.from({ length: 200 }, (_, index) => ({ date: new Date(NOW - (200 - index) * DAY), close: 100 + index })), ...overrides };
}
function payload() {
  const history = series();
  const quote = { ticker: "ACME", price: 299, quoteTime: new Date(NOW - DAY), currency: "USD", dayChangePercent: 0 };
  return { series: [{ ...history, chartPrices: history.prices, quote }],
    quotes: { byTicker: new Map([["ACME", quote]]), count: 1, total: 1, source: "fixture" },
    news: { items: [{ title: "Company story", source: "Example", link: "https://example.com/story", pubDate: new Date(NOW - DAY).toISOString(), tickers: ["ACME"], directTickers: ["ACME"], sentiment: 0.2 }], sources: [], configured: 1, label: "1 source" },
    marketContext: { available: true, score: 60, confidence: 100, dataQuality: { eligible: true, asOf: new Date(NOW - DAY).toISOString() } } };
}

test("cache restores price and quote Dates, quote Maps, and saved research without touching portfolio storage", () => {
  const saved = storage();
  assert.equal(saveScanCache(payload(), { storage: saved, now: NOW }), true);
  const restored = loadScanCache({ storage: saved, now: NOW });
  assert(restored.series[0].prices[0].date instanceof Date);
  assert(restored.series[0].chartPrices[0].date instanceof Date);
  assert(restored.series[0].quote.quoteTime instanceof Date);
  assert(restored.quotes.byTicker instanceof Map);
  assert(restored.quotes.byTicker.get("ACME").quoteTime instanceof Date);
  assert.equal(restored.quotes.byTicker.get("ACME").dayChangePercent, 0);
  assert.equal(restored.news.byTicker.ACME[0].title, "Company story");
  assert.match(restored.news.label, /^Saved research from 2026-10-05T16:00:00.000Z/);
  assert.equal(restored.marketContext.dataQuality.asOf, "2026-10-04T16:00:00.000Z");
  assert.equal(restored.savedAt, "2026-10-05T16:00:00.000Z");
  assert.equal(saved.items.get("today-invest-model-state"), "existing portfolio");
});

test("samples and stale histories are excluded at both save and restore time", () => {
  const saved = storage();
  const data = payload();
  data.series.push(series("FAKE", { source: "sample" }));
  data.series.push(series("OLD", { historyAsOf: new Date(NOW - 8 * DAY).toISOString() }));
  assert.equal(saveScanCache(data, { storage: saved, now: NOW }), true);
  assert.deepEqual(loadScanCache({ storage: saved, now: NOW }).series.map((item) => item.ticker), ["ACME"]);
  const raw = JSON.parse(saved.items.get(SCAN_CACHE_KEY));
  raw.series.push(series("FAKE", { source: "sample" }));
  saved.items.set(SCAN_CACHE_KEY, JSON.stringify(raw));
  assert.deepEqual(loadScanCache({ storage: saved, now: NOW }).series.map((item) => item.ticker), ["ACME"]);
  assert.equal(loadScanCache({ storage: saved, now: NOW + 7 * DAY }), null);
  assert.equal(saveScanCache({ ...data, series: [series("FAKE", { source: "sample" })] }, { storage: saved, now: NOW }), false);
});

test("stale, future, malformed, and oversized cache records return null", () => {
  const saved = storage();
  saveScanCache(payload(), { storage: saved, now: NOW });
  const original = JSON.parse(saved.items.get(SCAN_CACHE_KEY));
  for (const savedAt of [new Date(NOW - 8 * DAY).toISOString(), new Date(NOW + DAY).toISOString(), "invalid"]) {
    saved.items.set(SCAN_CACHE_KEY, JSON.stringify({ ...original, savedAt }));
    assert.equal(loadScanCache({ storage: saved, now: NOW }), null);
  }
  for (const invalid of ["{", "null", JSON.stringify({ ...original, schemaVersion: 99 }), "x".repeat(4 * 1024 * 1024 + 1)]) {
    saved.items.set(SCAN_CACHE_KEY, invalid);
    assert.equal(loadScanCache({ storage: saved, now: NOW }), null);
  }
});

test("write quota and storage read errors never break the app", () => {
  assert.equal(saveScanCache(payload(), { now: NOW, storage: { setItem: () => { throw new Error("Quota exceeded"); } } }), false);
  assert.equal(loadScanCache({ now: NOW, storage: { getItem: () => { throw new Error("Storage blocked"); } } }), null);
  const data = payload();
  data.news.items[0].description = "x".repeat(4 * 1024 * 1024);
  assert.equal(saveScanCache(data, { storage: storage(), now: NOW }), false);
});

test("market context requires its own recent original timestamp and saved available flag", () => {
  const saved = storage();
  for (const context of [
    { available: true, score: 60 },
    { available: false, score: 60, dataQuality: { asOf: new Date(NOW - DAY).toISOString() } },
    { available: true, score: 60, dataQuality: { asOf: new Date(NOW - 8 * DAY).toISOString() } },
    { available: true, score: 60, dataQuality: { asOf: new Date(NOW + 2 * DAY).toISOString() } }
  ]) {
    saveScanCache({ ...payload(), marketContext: context }, { storage: saved, now: NOW });
    const restored = loadScanCache({ storage: saved, now: NOW });
    assert.equal(restored.marketContext.available, false);
    assert.equal(restored.marketContext.score, null);
    assert.equal(restored.marketContext.dataQuality.asOf, context.dataQuality?.asOf || null);
  }
});

test("cache caps symbols and articles while keeping only normal evidence arrays", () => {
  const saved = storage();
  const data = payload();
  data.series = Array.from({ length: 181 }, (_, index) => series(`SYM${index}`));
  data.news.items = Array.from({ length: 501 }, (_, index) => ({ title: `Story ${index}`, tickers: ["SYM0"], directTickers: "bad array", sectorTickers: ["SYM0", "SYM0"] }));
  assert.equal(saveScanCache(data, { storage: saved, now: NOW }), true);
  const restored = loadScanCache({ storage: saved, now: NOW });
  assert.equal(restored.series.length, 180);
  assert.equal(restored.news.items.length, 500);
  assert.deepEqual(restored.news.items[0].directTickers, []);
  assert.deepEqual(restored.news.items[0].sectorTickers, ["SYM0"]);
});

test("partial scans retain qualified failed and missing tickers in incoming order without redating prices or research", () => {
  const saved = storage();
  const first = payload();
  first.series[0].currency = "USD";
  first.series.push(series("KEEP", { currency: "EUR" }));
  assert.equal(saveScanCache(first, { storage: saved, now: NOW }), true);
  const originalDates = first.series[0].prices.map((point) => point.date.toISOString());
  const update = { series: [series("ACME", { source: "sample" }), series("NEW", { currency: "USD" })],
    quotes: { byTicker: new Map() }, news: { items: [], sources: [], label: "Current scan has no research" },
    marketContext: { available: false, score: null } };
  assert.equal(saveScanCache(update, { storage: saved, now: NOW + DAY }), true);
  const restored = loadScanCache({ storage: saved, now: NOW + DAY });
  assert.deepEqual(restored.series.map((item) => item.ticker), ["ACME", "NEW", "KEEP"]);
  assert.deepEqual(restored.series[0].prices.map((point) => point.date.toISOString()), originalDates);
  assert.equal(restored.series[0].historyAsOf, first.series[0].historyAsOf);
  assert.equal(restored.quotes.byTicker.get("ACME").quoteTime.toISOString(), first.quotes.byTicker.get("ACME").quoteTime.toISOString());
  assert.equal(restored.savedAt, new Date(NOW + DAY).toISOString());
  assert.equal(restored.news.items.length, 0);
  assert.match(restored.news.label, /Current scan has no research/);
  assert.equal(restored.marketContext.available, false);
});

test("newer actual histories replace saved prices while older incoming bars cannot replace them", () => {
  const saved = storage();
  assert.equal(saveScanCache(payload(), { storage: saved, now: NOW }), true);
  const newer = series("ACME", { currency: "USD", historyAsOf: new Date(NOW).toISOString() });
  newer.prices = newer.prices.map((point) => ({ ...point, date: new Date(point.date.getTime() + DAY), close: point.close + 20 }));
  const newQuote = { ticker: "ACME", price: 319, currency: "USD", quoteTime: new Date(NOW), dayChangePercent: 0 };
  assert.equal(saveScanCache({ ...payload(), series: [newer], quotes: { byTicker: new Map([["ACME", newQuote]]) } }, { storage: saved, now: NOW + DAY }), true);
  let restored = loadScanCache({ storage: saved, now: NOW + DAY });
  assert.equal(restored.series[0].historyAsOf, newer.historyAsOf);
  assert.equal(restored.series[0].prices.at(-1).close, 319);
  assert.equal(restored.quotes.byTicker.get("ACME").quoteTime.toISOString(), newQuote.quoteTime.toISOString());
  assert.equal(saveScanCache(payload(), { storage: saved, now: NOW + 2 * DAY }), true);
  restored = loadScanCache({ storage: saved, now: NOW + 2 * DAY });
  assert.equal(restored.series[0].historyAsOf, newer.historyAsOf);
  assert.equal(restored.series[0].prices.at(-1).close, 319);
  assert.equal(restored.quotes.byTicker.get("ACME").quoteTime.toISOString(), newQuote.quoteTime.toISOString());
});

test("retention cannot revive sample or expired actual histories with a recent metadata date", () => {
  const saved = storage();
  saveScanCache(payload(), { storage: saved, now: NOW });
  const raw = JSON.parse(saved.items.get(SCAN_CACHE_KEY));
  raw.series[0].historyAsOf = new Date(NOW).toISOString();
  raw.series[0].prices = raw.series[0].prices.map((point) => ({ ...point, date: new Date(Date.parse(point.date) - 20 * DAY) }));
  raw.series.push(series("SAMPLE", { source: "sample" }));
  saved.items.set(SCAN_CACHE_KEY, JSON.stringify(raw));
  saveScanCache({ ...payload(), series: [series("NEW")] }, { storage: saved, now: NOW });
  assert.deepEqual(loadScanCache({ storage: saved, now: NOW }).series.map((item) => item.ticker), ["NEW"]);
  const serialized = saved.items.get(SCAN_CACHE_KEY);
  assert.equal(saveScanCache({ ...payload(), series: [series("NEW", { source: "sample" })] }, { storage: saved, now: NOW + DAY }), false);
  assert.equal(saved.items.get(SCAN_CACHE_KEY), serialized);
});

test("retained quotes keep original times and require ticker, currency, age, and daily-history consistency", () => {
  const saved = storage();
  const initial = payload();
  initial.series[0].currency = "USD";
  saveScanCache(initial, { storage: saved, now: NOW });
  const quote = initial.quotes.byTicker.get("ACME");
  const update = { ...payload(), series: [series("ACME", { source: "sample" }), series("NEW", { currency: "USD" })],
    quotes: { byTicker: new Map([["ACME", { ...quote, quoteTime: new Date(NOW), currency: "EUR" }]]) } };
  saveScanCache(update, { storage: saved, now: NOW + DAY });
  let restored = loadScanCache({ storage: saved, now: NOW + DAY });
  assert.equal(restored.quotes.byTicker.get("ACME").currency, "USD");
  assert.equal(restored.quotes.byTicker.get("ACME").quoteTime.toISOString(), quote.quoteTime.toISOString());
  const recent = series("ACME", { currency: "GBP", historyAsOf: new Date(NOW).toISOString() });
  recent.prices = recent.prices.map((point) => ({ ...point, date: new Date(point.date.getTime() + DAY) }));
  saveScanCache({ ...payload(), series: [recent], quotes: { byTicker: new Map([["ACME", { ...quote, currency: "GBP" }]]) } }, { storage: saved, now: NOW + DAY });
  restored = loadScanCache({ storage: saved, now: NOW + DAY });
  assert.equal(restored.quotes.byTicker.has("ACME"), false);
  const invalid = [
    { ...quote, ticker: "OTHER", quoteTime: new Date(NOW) },
    { ...quote, currency: "GBp", quoteTime: new Date(NOW) },
    { ...quote, currency: "GBP", quoteTime: new Date(NOW + 2 * DAY) },
    { ...quote, currency: "GBP", quoteTime: new Date(NOW - 8 * DAY) },
    { ...quote, currency: "GBP", quoteTime: new Date(NOW), source: "sample" }
  ];
  for (const bad of invalid) {
    saveScanCache({ series: [recent], quotes: { byTicker: new Map([["ACME", bad]]) } }, { storage: saved, now: NOW + DAY });
    assert.equal(loadScanCache({ storage: saved, now: NOW + DAY }).quotes.byTicker.has("ACME"), false);
  }
});

test("merged caches keep the 180-symbol cap and prioritize incoming order including failed saved tickers", () => {
  const saved = storage();
  const previous = Array.from({ length: 180 }, (_, index) => series(`OLD${index}`));
  assert.equal(saveScanCache({ series: previous }, { storage: saved, now: NOW }), true);
  assert.equal(saveScanCache({ series: [series("NEW"), series("OLD179", { source: "sample" })] }, { storage: saved, now: NOW + DAY }), true);
  const tickers = loadScanCache({ storage: saved, now: NOW + DAY }).series.map((item) => item.ticker);
  assert.equal(tickers.length, 180);
  assert.deepEqual(tickers.slice(0, 3), ["NEW", "OLD179", "OLD0"]);
  assert.equal(tickers.includes("OLD178"), false);
});
