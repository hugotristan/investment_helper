import test from "node:test";
import assert from "node:assert/strict";
import { annualSummaryYears, calculateAnnualSummary } from "../js/analysis/annual-summary.js";
import { createPortfolioBook, normalizeTransaction, projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { PORTFOLIO_FX_SOURCE, PORTFOLIO_FX_SOURCE_URL } from "../js/data/portfolio-history.js";
const NOW = Date.parse("2026-02-01T12:00:00Z");
function book(start, entries = [], holdings = [], now = NOW) {
  const value = createPortfolioBook({ startDate: start, baseCurrency: "EUR", holdings, now });
  value.transactions = entries.map((entry, index) => {
    const result = normalizeTransaction({ id: `tx-${index}`, date: start, currency: "EUR", ...entry }, { startDate: start, baseCurrency: "EUR", now });
    assert.equal(result.ok, true, result.error); return result.transaction;
  }); return value;
}
const trade = (type, price, extra = {}) => ({ type, ticker: "AAPL", quantity: 1, price, ...extra });
function history(from, to, value = 100, ticker = "AAPL", currency = "EUR") {
  const prices = [];
  for (let stamp = Date.parse(from); stamp <= Date.parse(to); stamp += 86400000) {
    const date = new Date(stamp).toISOString().slice(0, 10);
    prices.push({ date, close: typeof value === "function" ? value(date) : value });
  }
  return { ticker, currency, source: "Yahoo Finance published snapshot", splits: [], splitsComplete: true, prices };
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("annual boundaries exclude prior funding and offset carried unrealized gains when old shares are sold", () => {
  const input = book("2025-12-30", [{ type: "deposit", amount: 1000 }, trade("buy", 100),
    trade("sell", 160, { date: "2026-01-05", fee: 2 }), { type: "dividend", ticker: "AAPL", amount: 10, date: "2026-01-06" },
    { type: "fee", amount: 3, date: "2026-01-07" }, { type: "deposit", amount: 500, date: "2026-01-08" },
    { type: "withdrawal", amount: 50, date: "2026-01-09" }]);
  const before = structuredClone(input), projection = projectPortfolioBook(input);
  const histories = { AAPL: history("2025-12-30", "2026-01-31", date => date === "2025-12-30" ? 100 : 150) };
  const m = calculateAnnualSummary({ book: input, year: 2026, histories, now: NOW });
  assert.equal(m.from, "2026-01-01"); assert.equal(m.to, "2026-01-31"); assert.equal(m.yearToDate, true);
  assert.equal(m.openingValue, 1050); assert.equal(m.closingValue, 1515);
  assert.equal(m.deposits, 500); assert.equal(m.withdrawals, 50); assert.equal(m.netFunding, 450);
  assert.equal(m.gain, 15); assert.equal(m.realizedGain, 58); assert.equal(m.unrealizedOpening, 50);
  assert.equal(m.unrealizedClosing, 0); assert.equal(m.unrealizedChange, -50);
  assert.equal(m.income, 10); assert.equal(m.fees, 5); assert.equal(m.otherValuationChanges, 0);
  close(m.return, m.months[0].return); assert.deepEqual(annualSummaryYears(input, NOW), [2026, 2025]);
  const prior = calculateAnnualSummary({ book: input, year: 2025, histories, now: NOW });
  assert.equal(prior.openingValue, 0); assert.equal(prior.closingValue, 1050); assert.equal(prior.gain, 50);
  assert.equal(prior.deposits, 1000); assert.equal(prior.realizedGain, 0); assert.equal(prior.partialTracking, true);
  assert.deepEqual(input, before); assert.deepEqual(projectPortfolioBook(input), projection);
});

test("year return links monthly returns instead of summing or annualizing a partial year", () => {
  const now = Date.parse("2026-03-01T12:00:00Z");
  const input = book("2026-01-01", [{ type: "opening_cash", amount: 100 }, trade("buy", 100)], [], now);
  const histories = { AAPL: history("2026-01-01", "2026-02-28", date => date < "2026-01-31" ? 100 : date < "2026-02-28" ? 110 : 99) };
  const m = calculateAnnualSummary({ book: input, year: 2026, histories, now });
  close(m.months[0].return, 0.1); close(m.months[1].return, -0.1); close(m.return, -0.01);
  assert.equal(m.openingValue, 100); assert.equal(m.closingValue, 99); assert.equal(m.gain, -1);
  assert.equal(m.openingCash, 100); assert.equal(m.deposits, 0); assert.equal(m.netFunding, 0);
  assert.equal(m.completeYear, false); assert.equal(m.months.length, 2);
});

test("missing prices preserve known EUR activity and settlement-based foreign fee estimates", () => {
  const input = book("2026-01-01", [{ type: "deposit", amount: 1000 },
    trade("buy", 330, { ticker: "MSFT", currency: "USD", fee: 3, cashCurrency: "EUR", cashAmount: 300 }),
    { type: "dividend", ticker: "MSFT", currency: "USD", amount: 12, cashCurrency: "EUR", cashAmount: 10 },
    { type: "fee", currency: "USD", amount: 2, cashCurrency: "EUR", cashAmount: 1.7 }]);
  const m = calculateAnnualSummary({ book: input, year: 2026, histories: {}, now: NOW });
  assert.equal(m.closingValue, null); assert.equal(m.gain, null); assert.equal(m.return, null);
  assert.equal(m.deposits, 1000); assert.equal(m.income, 10); assert.equal(m.incomeEstimated, false);
  close(m.fees, 300 * 3 / 333 + 1.7); assert.equal(m.feesEstimated, true);
  assert.equal(m.realizedGain, 0); assert.equal(m.months[0].endValue, null); assert.equal(m.transactions, 4);
  assert(m.reasons.some(reason => /prices|rates/.test(reason)));
  const foreignFunding = book("2026-01-01", [{ type: "deposit", currency: "USD", amount: 100 }]);
  assert.equal(calculateAnnualSummary({ book: foreignFunding, year: 2026, histories: {}, now: NOW }).deposits, null);
  const usdCash = createPortfolioBook({ baseCurrency: "USD", startDate: "2026-01-01", now: NOW });
  usdCash.transactions = [
    { id: "cash", type: "opening_cash", date: "2026-01-01", currency: "USD", amount: 100, cashCurrency: "USD", cashAmount: 100 },
    { id: "income", type: "dividend", date: "2026-01-02", ticker: "AAPL", currency: "USD", amount: 10, cashCurrency: "USD", cashAmount: 10 },
    { id: "fee", type: "fee", date: "2026-01-03", currency: "USD", amount: 2, cashCurrency: "USD", cashAmount: 2 }
  ];
  const fxHistory = { schemaVersion: 1, source: PORTFOLIO_FX_SOURCE, sourceUrl: PORTFOLIO_FX_SOURCE_URL, generatedAt: new Date(NOW).toISOString(),
    byCurrency: { USD: history("2026-01-01", "2026-01-31").prices.map(point => ({ date: point.date, rate: 0.9 })) } };
  const estimated = calculateAnnualSummary({ book: usdCash, year: 2026, histories: {}, fxHistory, now: NOW });
  close(estimated.income, 9); close(estimated.fees, 1.8); close(estimated.gain, 7.2);
  assert.equal(estimated.incomeEstimated, true); assert.equal(estimated.months[0].incomeEstimated, true);
  assert.equal(estimated.openingCash, null); // Native USD cash is not an exact broker EUR settlement.
});

test("a price gap with known endpoints withholds return and monthly gain without hiding endpoint period gain", () => {
  const input = book("2026-01-01", [{ type: "opening_cash", amount: 100 }, trade("buy", 100)]);
  const data = history("2026-01-01", "2026-01-31", date => date === "2026-01-31" ? 110 : 100);
  data.prices = data.prices.filter(point => point.date < "2026-01-10" || point.date > "2026-01-25");
  const m = calculateAnnualSummary({ book: input, year: 2026, histories: { AAPL: data }, now: NOW });
  assert.equal(m.openingValue, 100); assert.equal(m.closingValue, 110); assert.equal(m.gain, 10);
  assert.equal(m.months[0].gain, null); assert.equal(m.return, null);
});

test("opening positions start at market value while full cash-only years stay complete", () => {
  const input = book("2026-01-01", [{ type: "opening_cash", amount: 20 }],
    [{ kind: "position", ticker: "AAPL", currency: "EUR", shares: 1, averageCost: 100 }]);
  const m = calculateAnnualSummary({ book: input, year: 2026, histories: { AAPL: history("2026-01-01", "2026-01-31", date => date === "2026-01-31" ? 160 : 150) }, now: NOW });
  assert.equal(m.openingValue, 170); assert.equal(m.closingValue, 180); assert.equal(m.gain, 10);
  assert.equal(m.unrealizedOpening, 50); assert.equal(m.unrealizedClosing, 60); assert.equal(m.unrealizedChange, 10);
  const cash = book("2025-01-01", [{ type: "opening_cash", amount: 100 }]);
  const full = calculateAnnualSummary({ book: cash, year: 2025, histories: {}, now: NOW });
  assert.equal(full.completeYear, true); assert.equal(full.months.length, 12);
  assert.equal(full.openingValue, 100); assert.equal(full.closingValue, 100); assert.equal(full.gain, 0); close(full.return, 0);
  // A later acquisition with unsupported actions cannot poison an earlier
  // cash-only year; it remains blocked once that position actually exists.
  const later = book("2025-01-01", [{ type: "opening_cash", amount: 100 }, trade("buy", 100, { date: "2026-01-01" })]);
  const bad = { AAPL: { ...history("2026-01-01", "2026-01-31"), splitsComplete: false } };
  assert.equal(calculateAnnualSummary({ book: later, year: 2025, histories: bad, now: NOW }).closingValue, 100);
  assert.equal(calculateAnnualSummary({ book: later, year: 2026, histories: bad, now: NOW }).closingValue, null);
});

test("invalid years and incomplete calendar days are explicit, including Tallinn before UTC midnight", () => {
  const input = book("2026-01-01");
  for (const year of ["2026", 2026.5, 1900, 2027, NaN]) assert(calculateAnnualSummary({ book: input, year, now: NOW }).error);
  const late = Date.parse("2026-12-31T22:30:00Z");
  const m = calculateAnnualSummary({ book: input, year: 2026, histories: {}, now: late });
  assert.equal(m.to, "2026-12-30"); assert.equal(m.completeYear, false);
  assert(calculateAnnualSummary({ book: input, year: 2027, histories: {}, now: late }).error);
  const fresh = book("2026-02-01", [], [], NOW);
  assert.match(calculateAnnualSummary({ book: fresh, year: 2026, now: NOW }).error, /completed tracking days/);
  const loading = calculateAnnualSummary({ book: input, year: 2026, now: NOW });
  assert.equal(loading.historyReady, false); assert.equal(loading.closingValue, null); assert.equal(loading.deposits, 0);
});
