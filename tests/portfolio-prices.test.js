import test from "node:test";
import assert from "node:assert/strict";
import { mergePortfolioPriceResults } from "../js/data/portfolio-prices.js";

const result = (ticker, quoteTime, price = 100) => ({ ticker, source: "Yahoo Finance chart",
  historyAsOf: "2026-10-09T00:00:00Z", prices: [{ date: "2026-10-09T00:00:00Z", close: price }],
  quote: { ticker, quoteTime, price } });

test("a late full scan keeps newer owned prices and fills missing holdings without changing market observations", () => {
  const owned = result("MSFT", "2026-10-09T20:00:00Z", 120);
  const missing = { ticker: "VWCE.DE", source: "unavailable", prices: [] };
  const fund = result("VWCE.DE", "2026-10-09T18:00:00Z", 140);
  const unrelated = result("SPY", "2026-10-09T20:00:00Z", 200);
  const results = [result("MSFT", "2026-10-09T18:00:00Z"), missing, unrelated];
  const before = structuredClone(results);
  const merged = mergePortfolioPriceResults(results, [owned, fund]);
  assert.equal(merged.find((item) => item.ticker === "MSFT"), owned);
  assert.equal(merged.find((item) => item.ticker === "VWCE.DE"), fund);
  assert.equal(merged.find((item) => item.ticker === "SPY"), unrelated);
  assert.deepEqual(results, before);
  // Newer broad-scan prices win; equally dated results retain richer scan evidence.
  const newest = result("MSFT", "2026-10-09T21:00:00Z", 125);
  assert.equal(mergePortfolioPriceResults([newest], [owned])[0], newest);
  assert.equal(mergePortfolioPriceResults([owned], [result("MSFT", owned.quote.quoteTime)])[0], owned);
  assert.equal(mergePortfolioPriceResults([owned], [{ ...missing, ticker: "MSFT" }])[0], owned);
});
