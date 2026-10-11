import test from "node:test";
import assert from "node:assert/strict";
import { calculateEtfExposure } from "../js/analysis/etf-exposure.js";
const funds = [{ tickers: ["FUND"], asOf: "2026-08-31", source: "Issuer", sourceUrl: "https://example.com", holdings: [{ id: "issuer", name: "Issuer", tickers: ["ABC", "XYZ"], weight: .2 }] }];
const input = { complete: true, hasEtfs: true, knownValue: 1100, rows: [{ ticker: "FUND", assetType: "ETFs", value: 1000 }, { ticker: "ABC", assetType: "Stocks", value: 100 }, { ticker: "XYZ", assetType: "Stocks", value: 0 }] };
test("look-through combines share classes, conserves value, and labels unreported constituents", () => {
  const copy = structuredClone(input);
  const result = calculateEtfExposure(input, { funds, now: Date.parse("2026-10-11") });
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].value, 300); assert.equal(result.unreported, 800);
  assert.equal(result.rows[0].value + result.unreported, 1100);
  assert.equal(result.rows[0].weight, 300 / 1100); assert.deepEqual(input, copy);
});
test("future or unsupported fund data remains unreported, and incomplete valuation withholds weights", () => {
  const result = calculateEtfExposure(input, { funds, now: Date.parse("2026-08-01") });
  assert.equal(result.unreported, 1000); assert.deepEqual(result.missingFunds, ["FUND"]);
  const incomplete = calculateEtfExposure({ ...input, complete: false }, { funds, now: Date.parse("2026-10-11") });
  assert.equal(incomplete.rows[0].weight, null); assert.equal(incomplete.unreportedWeight, null);
});
