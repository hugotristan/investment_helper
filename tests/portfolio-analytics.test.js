import test from "node:test";
import assert from "node:assert/strict";
import { calculatePortfolioAnalytics } from "../js/analysis/portfolio-analytics.js";
import { holdingEurReturn } from "../js/analysis/portfolio-returns.js";

function position(ticker, currency, currentValue, costBasis, options = {}) {
  return { ticker, id: ticker, currency, label: ticker, kind: "position", currentValue, costBasis,
    asOf: "2026-10-09T16:00:00Z", analysis: { instrumentType: "EQUITY" }, ...options };
}
function eurPosition(ticker, value, cost, options = {}) {
  const holding = position(ticker, "EUR", value, cost, options);
  return { ...holding, eur: holdingEurReturn(holding) };
}

test("cross-currency allocation and return rankings use current EUR values and actual historical EUR costs", () => {
  const usd = position("MSFT", "USD", 300, 290, { annotation: { groupId: "core" }, groupName: "Core" });
  usd.eur = holdingEurReturn(usd, { exchangeRate: { available: true, base: "USD", quote: "EUR", rate: 0.9 },
    eurCostBases: [{ id: "MSFT", ticker: "MSFT", currency: "USD", costBasis: 250 }] });
  const inputs = [eurPosition("VWCE.DE", 730, 700, { annotation: { groupId: "core" }, groupName: "Core", analysis: { instrumentType: "ETF" } }), usd];
  const original = structuredClone(inputs);
  const result = calculatePortfolioAnalytics(inputs);
  assert.equal(result.knownValue, 1000);
  assert.equal(result.rows[0].weight, 0.73);
  assert.equal(result.allocations.groups[0].value, 1000);
  assert.equal(result.allocations.groups[0].weight, 1);
  assert.deepEqual(result.allocations.types.map(({ label, value }) => [label, value]), [["ETFs", 730], ["Stocks", 270]]);
  assert.equal(result.best[0].ticker, "MSFT");
  assert.equal(result.best[0].gain, 20); // Native USD profit converted today would be only EUR 9.
  assert.equal(result.concentration.largestStock.ticker, "MSFT");
  assert.equal(result.concentration.topWeight, 1);
  assert.deepEqual(inputs, original);
});

test("unvalued currencies and manual amounts withhold all allocation weights and concentration", () => {
  const result = calculatePortfolioAnalytics([
    eurPosition("AAPL", 100, 80),
    { ...position("MSFT", "USD", 200, 150), eur: { currentValue: null, costBasis: 100, gain: null, gainPercent: null } },
    eurPosition("NVDA", 900, 800, { kind: "manual" })
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.knownValue, 100);
  assert.equal(result.valuedCount, 1);
  assert.equal(result.returnCount, 1);
  assert.equal(result.concentration, null);
  assert.deepEqual(result.missing, ["MSFT · USD", "NVDA · EUR"]);
  for (const rows of Object.values(result.allocations)) assert(rows.every(({ weight }) => weight === null));
  assert.equal(result.best.length, 1);
});

test("rankings separate gains from losses and exclude unknown or zero cost bases", () => {
  const result = calculatePortfolioAnalytics([
    eurPosition("AAPL", 150, 100), eurPosition("MSFT", 90, 100), eurPosition("NVDA", 75, 100),
    eurPosition("GOOGL", 100, 100), eurPosition("TSM", 200, 0),
    { ...eurPosition("AVGO", 100, 50), eur: { currentValue: 100, costBasis: null, gain: null, gainPercent: null } }
  ]);
  assert.equal(result.returnCount, 4);
  assert.deepEqual(result.best.map(({ ticker }) => ticker), ["AAPL"]);
  assert.deepEqual(result.worst.map(({ ticker }) => ticker), ["NVDA", "MSFT"]);
  assert.equal(result.concentration.topCount, 3);
  assert.equal(result.concentration.topWeight, 450 / 715);
});

test("allocation keeps listing currencies distinct, leaves unknown types unclassified, and handles empty or zero values", () => {
  const inputs = [eurPosition("MSFT", 100, 80, { analysis: null }),
    { ...eurPosition("MSFT", 50, 40), currency: "USD", annotation: { groupId: "unassigned" }, groupName: "Ungrouped" }];
  const result = calculatePortfolioAnalytics(inputs);
  assert.equal(result.allocations.holdings.length, 2);
  assert.equal(result.allocations.groups.length, 2);
  assert(result.allocations.types.some(({ label }) => label === "Unclassified"));
  assert.equal(calculatePortfolioAnalytics([]).knownValue, 0);
  assert.equal(calculatePortfolioAnalytics([]).concentration, null);
  const zero = calculatePortfolioAnalytics([eurPosition("AAPL", 0, 100)]);
  assert.equal(zero.complete, true);
  assert.equal(zero.rows[0].weight, null);
  assert.equal(zero.concentration, null);
});
