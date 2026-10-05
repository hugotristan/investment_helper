import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { getElementById: () => ({}), querySelectorAll: () => [] };
globalThis.window = { setTimeout, clearTimeout };

const { evaluateDataQuality, hasQualifiedSignal } = await import("../js/analysis/data-quality.js");
const { scoreSeries, applyLearningSignal, stableRankSort } = await import("../js/analysis/scoring.js");
const { applyQuoteSnapshot } = await import("../js/data/market.js");
const { buildModelAllocation } = await import("../js/analysis/allocation.js");
const { sellSignalFor, holdSignalFor } = await import("../js/analysis/signals.js");
const { analyzeMarketContext } = await import("../js/analysis/market-context.js");
const { state } = await import("../js/storage.js");
const DAY = 24 * 60 * 60 * 1000;

function history(ticker = "ACME", { count = 253, asOf = Date.now() - DAY, source = "fixture", direction = 1 } = {}) {
  return {
    ticker, source,
    prices: Array.from({ length: count }, (_, index) => {
      const close = 100 * Math.exp(direction * index / 500) + Math.sin(index / 7);
      return { date: new Date(asOf - (count - 1 - index) * DAY), close,
        high: close + 1, low: close - 1, volume: 1000000 + index * 100 };
    })
  };
}

test("fresh real history qualifies through weekends, but stale/future history does not", () => {
  const monday = Date.UTC(2026, 9, 5, 16);
  const friday = Date.UTC(2026, 9, 2, 16);
  assert.equal(evaluateDataQuality(history("ACME", { asOf: friday }), monday).eligible, true);
  assert.equal(evaluateDataQuality(history("ACME", { asOf: monday - 7 * DAY }), monday).eligible, true);
  const stale = evaluateDataQuality(history("ACME", { asOf: monday - 7 * DAY - 1 }), monday);
  assert.equal(stale.eligible, false);
  assert.equal(stale.label, "Stale price history");
  const future = evaluateDataQuality(history("ACME", { asOf: monday + 2 * DAY }), monday);
  assert.equal(future.eligible, false);
  assert.equal(future.label, "Future-dated price history");
});

test("history qualification counts valid distinct daily prices", () => {
  const short = history("NEW", { count: 199 });
  short.prices.push({ ...short.prices.at(-1) });
  short.prices.push({ date: new Date(), close: NaN });
  short.prices.push({ date: new Date("invalid"), close: 100 });
  const quality = evaluateDataQuality(short);
  assert.equal(quality.eligible, false);
  assert.match(quality.reason, /199 are available/);
  assert.equal(evaluateDataQuality(history("NEW", { count: 200 })).eligible, true);
  assert.equal(evaluateDataQuality({ source: "fixture", prices: [] }).asOf, null);
});

test("sample and stale results cannot produce allocation or sell/hold signals", () => {
  const sample = scoreSeries(history("SAMPLE", { source: "sample" }), []);
  const stale = scoreSeries(history("STALE", { asOf: Date.now() - 9 * DAY }), []);
  for (const item of [sample, stale]) {
    assert.equal(item.score, null);
    assert.equal(item.label, "Data unavailable");
    assert.equal(item.setup.signal, "Data unavailable");
    assert.equal(item.setup.entryZone, "Unavailable");
    assert.equal(item.setup.invalidation, null);
    assert.equal(hasQualifiedSignal(item), false);
    assert.equal(sellSignalFor(item), null);
    assert.equal(holdSignalFor(item), null);
  }
  const allocation = buildModelAllocation([sample, stale], { score: null });
  assert.deepEqual(allocation.actions.map(({ ticker, percent }) => ({ ticker, percent })), [{ ticker: "Cash", percent: 100 }]);
  assert.equal(allocation.avoid.ticker, "-");
});

test("real quotes never repair sample, stale, or insufficient history", () => {
  for (const series of [history("ACME", { source: "sample" }), history("ACME", { asOf: Date.now() - 9 * DAY }), history("ACME", { count: 100 })]) {
    const prices = structuredClone(series.prices);
    const result = applyQuoteSnapshot(series, new Map([["ACME", { price: 999, quoteTime: new Date() }]]));
    assert.deepEqual(result.prices, prices);
    assert.equal(result.quote, undefined);
    assert.equal(evaluateDataQuality(result).eligible, false);
  }
});

test("dated current quotes update qualified history while preserving its actual timestamp and zero daily change", () => {
  const series = history();
  const originalTime = series.prices.at(-1).date.toISOString();
  const updated = applyQuoteSnapshot(series, new Map([["ACME", { price: 220, quoteTime: new Date(), dayChangePercent: 0, quoteType: "EQUITY" }]]));
  assert.equal(updated.prices.at(-1).close, 220);
  assert.equal(series.prices.at(-1).close === 220, false);
  assert.equal(updated.historyAsOf, originalTime);
  assert.equal(evaluateDataQuality(updated).asOf, originalTime);
  assert.equal(scoreSeries(updated, []).oneDay, 0);
  const olderQuote = applyQuoteSnapshot(series, new Map([["ACME", { price: 999, quoteTime: new Date(Date.now() - 9 * DAY) }]]));
  assert.equal(olderQuote, series);
  assert.equal(applyQuoteSnapshot(series, new Map([["ACME", { price: 999 }]])), series);
  assert.equal(applyQuoteSnapshot(series, new Map([["ACME", { price: 999, quoteTime: new Date(Date.now() + DAY) }]])), series);
  assert.equal(applyQuoteSnapshot(series, new Map([["ACME", { ticker: "OTHER", price: 999, quoteTime: new Date() }]])), series);
});

test("mixed rankings and allocation use qualified instruments only", () => {
  const real = scoreSeries(history("SPY"), []);
  const sample = scoreSeries(history("FAKE", { source: "sample" }), []);
  const results = [sample, real].sort(stableRankSort);
  assert.equal(results[0].ticker, "SPY");
  const actions = buildModelAllocation(results, { score: 50 }).actions;
  assert(actions.some((item) => item.ticker === "SPY"));
  assert(actions.every((item) => item.ticker !== "FAKE"));
});

test("browser scan history changes only scoreDelta, preserving current-data scores and ranking", () => {
  const item = scoreSeries(history("ACME"), []);
  state.learningHistory = [{ scores: [{ ticker: "ACME", score: 10 }] }];
  const withHistory = applyLearningSignal(item);
  assert.equal(withHistory.score, item.score);
  assert.equal(withHistory.setup.signal, item.setup.signal);
  assert.equal(withHistory.scoreDelta, item.score - 10);
  assert.equal(withHistory.rawScore, item.score);
  const other = { ...item, ticker: "OTHER", score: item.score - 1 };
  state.learningHistory = [{ scores: [{ ticker: "ACME", score: 10 }, { ticker: "OTHER", score: 100 }] }];
  assert.equal([other, withHistory].sort(stableRankSort)[0].ticker, "ACME");
  assert.deepEqual(sellSignalFor({ ...item, scoreDelta: -90 }), sellSignalFor({ ...item, scoreDelta: 0 }));
  assert.deepEqual(holdSignalFor({ ...item, scoreDelta: 90 }), holdSignalFor({ ...item, scoreDelta: 0 }));
  state.learningHistory = [];
});

test("ETF metadata identifies funds outside the default symbol list", () => {
  const byChart = scoreSeries({ ...history("NEWFUND"), instrumentType: "ETF" }, []);
  const byQuote = scoreSeries({ ...history("NEWFUND"), quote: { quoteType: "ETF" } }, []);
  assert.equal(byChart.isFund, true);
  assert.equal(byQuote.isFund, true);
});

test("market regime requires real equity and credit coverage and excludes unavailable proxies", () => {
  const proxy = (ticker, options) => ({ ticker, series: history(ticker, options) });
  const onlySamples = analyzeMarketContext([proxy("SPY", { source: "sample" }), proxy("HYG", { source: "sample" })]);
  assert.equal(onlySamples.available, false);
  assert.equal(onlySamples.score, null);
  assert.equal(onlySamples.confidence, null);
  const real = [proxy("SPY"), proxy("QQQ"), proxy("HYG"), proxy("LQD")];
  assert.equal(analyzeMarketContext(real.slice(0, 3)).available, false);
  const baseline = analyzeMarketContext(real);
  const mixed = analyzeMarketContext(real.concat(proxy("^VIX", { source: "sample" }), proxy("TLT", { asOf: Date.now() - 9 * DAY })));
  assert.equal(baseline.available, true);
  assert.equal(mixed.score, baseline.score);
  assert.equal(mixed.liveCount, 4);
  assert.equal(mixed.metrics.vix, null);
  assert.equal(mixed.metrics.ratePressure, null);
  assert.equal(mixed.coverage, Math.round(4 / 11 * 100));
});
