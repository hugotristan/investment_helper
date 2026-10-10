import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateHoldings, normalizeHolding } from "../js/analysis/holdings.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 5, 16);
const holding = (ticker = "ACME", overrides = {}) => ({
  id: ticker, kind: "position", ticker, label: ticker, shares: 10, averageCost: 80, currency: "USD", ...overrides
});
const result = (ticker = "ACME", overrides = {}) => ({
  ticker, source: "fixture", score: 70, latest: 95, currency: "USD",
  dataQuality: { eligible: true, asOf: new Date(NOW - 3 * DAY).toISOString() },
  quote: { ticker, price: 100, currency: "USD", quoteTime: new Date(NOW - DAY) }, ...overrides
});
const calculate = (holdings, results) => calculateHoldings(holdings, results, { now: NOW });

test("normalization accepts decimal inputs and rejects invalid quantities, costs, tickers, and currencies", () => {
  const normalized = normalizeHolding({ id: "one", ticker: " brk.b ", label: " Berkshire ", shares: "2.5", averageCost: "0", currency: "usd" });
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.holding, { id: "one", kind: "position", ticker: "BRK.B", label: "Berkshire", shares: 2.5, averageCost: 0, currency: "USD" });
  for (const invalid of [{ shares: 0 }, { shares: -1 }, { shares: "" }, { shares: "2oops" },
    { averageCost: -1 }, { averageCost: Infinity }, { ticker: "BAD TICKER" }, { ticker: "@AAPL" }, { currency: "US" }]) {
    const answer = normalizeHolding(holding("ACME", invalid));
    assert.equal(answer.ok, false, JSON.stringify(invalid));
    assert.equal(answer.holding, null);
    assert.equal(typeof answer.error, "string");
  }
});

test("recent qualified quotes calculate values, gains, and currency weights", () => {
  const answer = calculate([holding(), holding("SECOND", { shares: 5, averageCost: 120 })], [result(), result("SECOND")]);
  const [up, down] = answer.holdings;
  assert.equal(up.currentValue, 1000);
  assert.equal(up.costBasis, 800);
  assert.equal(up.gain, 200);
  assert.equal(up.gainPercent, 0.25);
  assert.equal(up.status, "up");
  assert.equal(up.source, "quote");
  assert.equal(up.asOf, new Date(NOW - DAY).toISOString());
  assert.equal(down.gain, -100);
  assert.equal(down.status, "down");
  assert.equal(up.weight, 1000 / 1500 * 100);
  assert.equal(down.weight, 500 / 1500 * 100);
  assert.deepEqual(answer.groups, [{ currency: "USD", total: 1500, costBasis: 1400, gain: 100, complete: true, legacyCount: 0 }]);
  assert.equal(answer.missingCount, 0);
});

test("missing or invalid quotes use recent daily prices only with known matching currency", () => {
  for (const quote of [null, { price: 100, currency: "USD" },
    { ticker: "ACME", price: 100, currency: "USD", quoteTime: new Date(NOW + DAY) },
    { ticker: "OTHER", price: 100, currency: "USD", quoteTime: new Date(NOW - DAY) },
    { ticker: "ACME", price: 100, currency: "USD", quoteTime: new Date(NOW - 8 * DAY) }]) {
    const row = calculate([holding()], [result("ACME", { quote })]).holdings[0];
    assert.equal(row.currentValue, 950);
    assert.equal(row.source, "daily");
    assert.equal(row.asOf, new Date(NOW - 3 * DAY).toISOString());
  }
  const unknown = calculate([holding()], [result("ACME", { quote: null, currency: undefined })]);
  assert.equal(unknown.holdings[0].currentValue, null);
  assert.equal(unknown.groups[0].total, null);
  assert.equal(unknown.groups[0].gain, null);
  assert.equal(unknown.groups[0].complete, false);
  assert.equal(unknown.missingCount, 1);
});

test("currencies must match exactly, including pence versus pounds", () => {
  for (const currency of ["EUR", "GBp"]) {
    const row = calculate([holding("ACME", { currency: "GBP" })], [result("ACME", {
      currency, quote: { ticker: "ACME", price: 100, currency, quoteTime: new Date(NOW - DAY) }
    })]).holdings[0];
    assert.equal(row.currentValue, null);
    assert.equal(row.source, "unavailable");
  }
  const mismatch = calculate([holding()], [result("ACME", { currency: "EUR", quote: { price: 100, currency: "EUR", quoteTime: new Date(NOW - DAY) } })]);
  assert.equal(mismatch.holdings[0].currentValue, null);
});

test("sample, unqualified, stale, and future histories cannot be rescued by a recent quote", () => {
  const bad = [
    { source: "sample fallback" }, { score: null }, { dataQuality: { eligible: false, asOf: new Date(NOW - DAY).toISOString() } },
    { dataQuality: { eligible: true, asOf: new Date(NOW - 7 * DAY - 1).toISOString() } },
    { dataQuality: { eligible: true, asOf: new Date(NOW + 2 * DAY).toISOString() } }
  ];
  for (const overrides of bad) {
    const row = calculate([holding()], [result("ACME", overrides)]).holdings[0];
    assert.equal(row.currentValue, null);
    assert.equal(row.costBasis, 800);
    assert.equal(row.gain, null);
    assert.equal(row.status, "unknown");
  }
});

test("a verified young stock can be valued without enough history for a market signal", () => {
  const date = new Date(NOW - DAY);
  const item = result("NEW", { score: null, instrumentType: "EQUITY", source: "Yahoo Finance chart",
    dataQuality: { eligible: false, asOf: date.toISOString(), reason: "Fewer than 200 daily prices." },
    historyAsOf: date.toISOString(), prices: [{ date, close: 95 }] });
  const valued = calculate([holding("NEW")], [item]).holdings[0];
  assert.equal(valued.currentValue, 1000);
  assert.equal(valued.gain, 200);
  assert.equal(item.dataQuality.eligible, false);
  assert.equal(item.score, null);
  const daily = calculate([holding("NEW")], [{ ...item, quote: null, latest: null }]).holdings[0];
  assert.equal(daily.currentValue, 950);
  assert.equal(daily.source, "daily");
  for (const bad of [{ source: "Sample fallback" }, { instrumentType: "FUTURE" },
    { prices: [] }, { dataQuality: { eligible: false, asOf: new Date(NOW).toISOString() } }]) {
    assert.equal(calculate([holding("NEW")], [{ ...item, ...bad }]).holdings[0].currentValue, null);
  }
  const substituted = { ...item, source: "Yahoo Finance chart + Yahoo intraday", latest: 1000,
    quote: { ...item.quote, quoteTime: new Date(NOW + 86400000), price: 1000 },
    prices: [{ date, close: 1000 }] };
  assert.equal(calculate([holding("NEW")], [substituted]).holdings[0].currentValue, null);
});

test("zero cost basis never produces an infinite return and unchanged prices are flat", () => {
  const answer = calculate([holding("FREE", { averageCost: 0 }), holding("FLAT", { averageCost: 100 })], [result("FREE"), result("FLAT")]);
  assert.equal(answer.holdings[0].costBasis, 0);
  assert.equal(answer.holdings[0].gain, 1000);
  assert.equal(answer.holdings[0].gainPercent, null);
  assert.equal(answer.holdings[1].gain, 0);
  assert.equal(answer.holdings[1].gainPercent, 0);
  assert.equal(answer.holdings[1].status, "flat");
});

test("rejected quote prices cannot masquerade as daily closes, while preserved or proven closes remain usable", () => {
  const asOf = new Date(NOW - 3 * DAY).toISOString();
  for (const invalidQuote of [
    { ticker: "ACME", price: 100, currency: "USD", quoteTime: new Date(NOW + DAY) },
    { ticker: "ACME", price: 100, currency: "USD", quoteTime: new Date(NOW - 8 * DAY) },
    { ticker: "OTHER", price: 100, currency: "USD", quoteTime: new Date(NOW - DAY) },
    { ticker: "ACME", price: 100, currency: "EUR", quoteTime: new Date(NOW - DAY) }
  ]) {
    const changed = result("ACME", { source: "fixture + Yahoo intraday", latest: 100, quote: invalidQuote,
      prices: [{ date: new Date(asOf), close: 100 }] });
    assert.equal(calculate([holding()], [changed]).holdings[0].currentValue, null);
    const preserved = { ...changed, dailyClose: { price: 95, currency: "USD", asOf } };
    const row = calculate([holding()], [preserved]).holdings[0];
    assert.equal(row.currentValue, 950);
    assert.equal(row.source, "daily");
    assert.equal(row.asOf, asOf);

    const unproven = { ...changed, source: "fixture", prices: undefined };
    assert.equal(calculate([holding()], [unproven]).holdings[0].currentValue, null);
    const genuine = { ...changed, source: "fixture" };
    assert.equal(calculate([holding()], [genuine]).holdings[0].currentValue, 1000);
  }
  const staleSnapshot = result("ACME", { source: "fixture + Yahoo intraday", quote: null,
    dailyClose: { price: 95, currency: "USD", asOf: new Date(NOW - 9 * DAY).toISOString() } });
  assert.equal(calculate([holding()], [staleSnapshot]).holdings[0].currentValue, null);
});

test("mixed currencies remain separate and incomplete groups report only known value", () => {
  const answer = calculate([holding(), holding("MISSING"), holding("EURO", { currency: "EUR", shares: 2, averageCost: 40 })], [result(), result("EURO", {
    currency: "EUR", quote: { ticker: "EURO", price: 50, currency: "EUR", quoteTime: new Date(NOW - DAY) }
  })]);
  assert.deepEqual(answer.groups, [
    { currency: "EUR", total: 100, costBasis: 80, gain: 20, complete: true, legacyCount: 0 },
    { currency: "USD", total: 1000, costBasis: 1600, gain: null, complete: false, legacyCount: 0 }
  ]);
  assert.equal(answer.holdings[0].weight, 100);
  assert.equal(answer.holdings[1].weight, null);
  assert.equal(answer.holdings[2].weight, 100);
  assert.equal(answer.missingCount, 1);
  assert.equal("total" in answer, false);
});

test("legacy manual amounts and status are preserved without invented gains", () => {
  const manual = { id: "legacy", kind: "manual", ticker: "ACME", label: "Existing amount", amount: 2000, status: "down", currency: "USD" };
  const before = JSON.stringify(manual);
  const answer = calculate([manual, holding()], [result()]);
  const row = answer.holdings[0];
  assert.equal(JSON.stringify(manual), before);
  assert.equal(row.amount, 2000);
  assert.equal(row.currentValue, 2000);
  assert.equal(row.status, "down");
  assert.equal(row.source, "manual");
  assert.equal(row.gain, null);
  assert.equal(row.gainPercent, null);
  assert.equal(row.costBasis, null);
  assert.equal(row.weight, 2000 / 3000 * 100);
  assert.deepEqual(answer.groups, [{ currency: "USD", total: 3000, costBasis: null, gain: null, complete: true, legacyCount: 1 }]);
});
