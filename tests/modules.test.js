import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test, beforeEach } from "node:test";

const saved = new Map();
globalThis.localStorage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
};
// Portfolio rendering shares DOM references with the browser app. These tests
// exercise its calculations; full page interactions are checked in a browser.
globalThis.document = { getElementById: () => ({}), querySelectorAll: () => [] };
globalThis.window = { setTimeout, clearTimeout };

const { state, persist, saveLearningSnapshot, latestLearningPoint } = await import("../js/storage.js");
const { scoreSeries, applyLearningSignal, stableRankSort } = await import("../js/analysis/scoring.js");
const { buildModelAllocation } = await import("../js/analysis/allocation.js");
const { buildPortfolioReview, parsePortfolioPositions } = await import("../js/features/portfolio.js");
const { validateWatchlistTicker } = await import("../js/data/market.js");

beforeEach(() => {
  saved.clear();
  state.myPortfolioInput = "";
  state.learningHistory = [];
});

function series(ticker, direction) {
  return {
    ticker,
    source: "fixture",
    prices: Array.from({ length: 253 }, (_, index) => {
      const close = 100 * Math.exp(direction * index / 500) + Math.sin(index / 7);
      return {
        date: new Date(Date.now() - (252 - index) * 86400000),
        close, high: close + 1, low: close - 1, volume: 1000000 + index * 100,
      };
    }),
  };
}

test("qualified scoring is independent of local history and allocations retain limits", () => {
  state.learningHistory = [{ scores: [{ ticker: "ACME", score: 48 }, { ticker: "FALL", score: 55 }] }];
  const headlines = [
    { title: "Strong growth beats estimates", sentiment: 0.5, sourceId: "fixture-one", source: "Example", kind: "news" },
    { title: "Bullish outlook", sentiment: 0.3, sourceId: "fixture-two", source: "Example research", kind: "outlook" },
  ];
  const results = [series("SPY", 1), series("ACME", 1), series("FALL", -1)]
    .map((data) => applyLearningSignal(scoreSeries(data, headlines)))
    .sort(stableRankSort);
  // Raw technical scores are preserved; previous browser scores no longer alter signals.
  assert.deepEqual(results.map(({ ticker, score, rawScore }) => ({ ticker, score, rawScore })), [
    { ticker: "SPY", score: 83, rawScore: 83 },
    { ticker: "ACME", score: 77, rawScore: 77 },
    { ticker: "FALL", score: 26, rawScore: 26 },
  ]);
  const actions = buildModelAllocation(results, { score: 0, available: true }).actions;
  assert.deepEqual(actions.map(({ ticker, percent }) => ({ ticker, percent })), [
    { ticker: "SPY", percent: 37.2 }, { ticker: "ACME", percent: 16 }, { ticker: "Cash", percent: 46.8 },
  ]);
});

test("portfolio calculations retain manually entered amounts and up/down status", () => {
  const input = "SPY | Example fund | 700 | up\nACME | Example company | 300 | down";
  state.myPortfolioInput = input;
  assert.deepEqual(parsePortfolioPositions(input).map(({ amount, status }) => ({ amount, status })), [
    { amount: 700, status: "up" }, { amount: 300, status: "down" },
  ]);
  const results = [scoreSeries(series("SPY", 1), []), scoreSeries(series("ACME", -1), [])];
  const portfolio = buildPortfolioReview(results, { score: 50 });
  assert.equal(portfolio.total, 1000);
  assert.equal(portfolio.coreValue, 700);
  assert.equal(portfolio.downCount, 1);
  assert.deepEqual(portfolio.holdings.map(({ weight }) => weight), [70, 30]);
  assert.equal(state.myPortfolioInput, input);
});

test("storage preserves the existing key and bounded scan history", () => {
  state.myPortfolioInput = "ACME | Example company | 300 | down";
  persist();
  assert.equal(JSON.parse(saved.get("today-invest-model-state")).myPortfolioInput, state.myPortfolioInput);
  for (let score = 0; score < 100; score += 1) {
    saveLearningSnapshot([{ ticker: "ACME", score, latest: 100, dataQuality: { eligible: true } }], "fixture", "fixture");
  }
  assert.equal(state.learningHistory.length, 96);
  assert.equal(latestLearningPoint("ACME").score, 99);
  assert.equal(state.learningHistory[0].scores[0].score, 4);
});

test("ticker validation requires matching live stock or ETF metadata", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const cases = [
    ["ACME", { symbol: "ACME", instrumentType: "EQUITY", regularMarketPrice: 100 }, "valid"],
    ["VWCE.DE", { symbol: "VWCE.DE", instrumentType: "ETF", regularMarketPrice: 100 }, "valid"],
    ["GC-F", { symbol: "GC-F", instrumentType: "FUTURE", regularMarketPrice: 100 }, "unsupported"],
    ["ACME", { symbol: "OTHER", instrumentType: "EQUITY", regularMarketPrice: 100 }, "invalid"],
    ["ACME", { symbol: "ACME", instrumentType: "EQUITY", regularMarketPrice: 0 }, "unavailable"],
  ];
  for (const [ticker, meta, expected] of cases) {
    globalThis.fetch = async () => new Response(JSON.stringify({ chart: { result: [{ meta }] } }));
    assert.equal(await validateWatchlistTicker(ticker), expected);
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ chart: { error: { code: "Not Found" } } }), { status: 404 });
  assert.equal(await validateWatchlistTicker("ZZZZ"), "invalid");
  globalThis.fetch = async () => { throw new Error("Offline"); };
  assert.equal(await validateWatchlistTicker("ACME"), "unavailable");
});

test("all native module imports resolve without circular dependencies", async () => {
  const graph = new Map();
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) await collect(url);
      else if (entry.name.endsWith(".js")) graph.set(url.href, []);
    }
  }
  await collect(new URL("../js/", import.meta.url));
  graph.set(new URL("../app.js", import.meta.url).href, []);
  for (const [file, imports] of graph) {
    const source = await readFile(new URL(file), "utf8");
    for (const match of source.matchAll(/^import .* from "([^"]+)";/gm)) {
      const target = new URL(match[1], file).href;
      assert(graph.has(target), `Missing module: ${target}`);
      imports.push(target);
    }
  }
  const visited = new Set();
  function visit(file, stack = []) {
    assert(!stack.includes(file), `Circular import: ${stack.concat(file).join(" -> ")}`);
    if (visited.has(file)) return;
    for (const imported of graph.get(file)) visit(imported, stack.concat(file));
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
});
