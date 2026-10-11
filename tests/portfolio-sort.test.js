import test from "node:test";
import assert from "node:assert/strict";
import { sortPortfolioHoldings } from "../js/analysis/portfolio-sort.js";

test("holdings sort by size, EUR percentage performance, and name in both directions without moving missing values ahead", () => {
  const holdings = [
    { id: "c", ticker: "C", label: "Charlie", currentValue: 200, eur: { gainPercent: -0.1 } },
    { id: "a", ticker: "A", label: "Alpha", currentValue: 100, eur: { gainPercent: 0.2 } },
    { id: "b", ticker: "B", label: "Beta", currentValue: 300, eur: { gainPercent: 0 } },
    { id: "d", ticker: "D", label: "Delta", currentValue: null, eur: { gainPercent: null } }
  ];
  const before = structuredClone(holdings);
  const expected = {
    size: { asc: "ACBD", desc: "BCAD" },
    performance: { asc: "CBAD", desc: "ABCD" },
    name: { asc: "ABCD", desc: "DCBA" }
  };
  for (const [by, directions] of Object.entries(expected)) for (const [direction, order] of Object.entries(directions)) {
    assert.equal(sortPortfolioHoldings(holdings, { by, direction }).map((holding) => holding.ticker).join(""), order);
  }
  assert.deepEqual(holdings, before);
});
