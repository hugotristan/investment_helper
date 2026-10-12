import test from "node:test";
import assert from "node:assert/strict";
import { dividendForecast } from "../js/analysis/dividend-forecast.js";
import { normalizeDividendAssumptions, nextDividendDate } from "../js/analysis/dividend-assumptions.js";
import { createPortfolioBook, validatePortfolioBook, projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { serializePortfolioBackup, parsePortfolioBackup } from "../js/data/portfolio-book-store.js";
import { EXCHANGE_RATE_SOURCE, EXCHANGE_RATE_SOURCE_URL } from "../js/data/exchange-rate.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const rate = { schemaVersion: 1, base: "USD", quote: "EUR", rate: 0.9, date: "2026-10-09", retrievedAt: new Date(NOW).toISOString(), source: EXCHANGE_RATE_SOURCE, sourceUrl: EXCHANGE_RATE_SOURCE_URL };
const plan = (extra = {}) => ({ ticker: "MSFT", currency: "USD", amountPerShare: 0.75, firstPaymentDate: "2026-10-31", frequency: "quarterly", ...extra });
function book() {
  return createPortfolioBook({ now: NOW, startDate: "2026-10-01", holdings: [
    { kind: "position", ticker: "MSFT", currency: "USD", label: "Microsoft", shares: 2, averageCost: 100 },
    { kind: "position", ticker: "VOW.DE", currency: "EUR", label: "Volkswagen", shares: 3, averageCost: 100 },
    { kind: "position", ticker: "VWCE.DE", currency: "EUR", label: "Vanguard", shares: 8, averageCost: 100 },
  ] });
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("forecast reconciles gross per-share payments, monthly EUR totals and source dates without affecting cash", () => {
  const original = book(), projection = projectPortfolioBook(original);
  const input = { ...original, dividendAssumptions: [plan(), plan({ ticker: "VOW.DE", currency: "EUR", amountPerShare: 1, frequency: "monthly" })] };
  const copy = structuredClone(input), result = dividendForecast(input, { now: NOW, exchangeRate: rate });
  assert.equal(result.from, "2026-10-11"); assert.equal(result.to, "2027-10-10");
  assert.equal(result.covered, 2); assert.deepEqual(result.accumulating, ["VWCE.DE"]);
  assert.deepEqual(result.missing, []);
  assert.equal(result.rows.length, 16);
  close(result.total, 41.4);
  close(result.months.reduce((sum, month) => sum + month.value, 0), result.total);
  assert.deepEqual(result.rows.filter(row => row.ticker === "MSFT").map(row => row.date), ["2026-10-31", "2027-01-31", "2027-04-30", "2027-07-31"]);
  assert.equal(result.rows[0].fxDate, "2026-10-09");
  assert.deepEqual(projectPortfolioBook(input), projection);
  assert.deepEqual(input, copy);
});

test("recurring month-end and leap-day payments roll forward from their original calendar anchor", () => {
  const monthly = plan({ firstPaymentDate: "2028-01-31", frequency: "monthly" });
  assert.equal(nextDividendDate(monthly, "2028-02-01"), "2028-02-29");
  const input = createPortfolioBook({ now: "2028-02-01", holdings: [{ kind: "position", ticker: "MSFT", currency: "USD", shares: 0.5, averageCost: 100 }] });
  input.dividendAssumptions = [monthly];
  const result = dividendForecast(input, { now: "2028-02-01" });
  assert.deepEqual(result.rows.slice(0, 4).map(row => row.date), ["2028-02-29", "2028-03-31", "2028-04-30", "2028-05-31"]);
  close(result.rows[0].native, 0.375);
  assert.equal(result.total, null);
  assert.equal(result.months[0].value, null);
});

test("unentered, explicitly zero, expired and unheld assumptions stay distinct; missing FX never becomes zero", () => {
  const input = book();
  input.dividendAssumptions = [plan(), plan({ ticker: "AMZN", frequency: "none", amountPerShare: 0, firstPaymentDate: null })];
  const result = dividendForecast(input, { now: NOW, exchangeRate: { ...rate, date: "2026-01-01" } });
  assert.equal(result.total, null);
  assert.deepEqual(result.missing, ["VOW.DE (EUR)"]);
  assert.equal(result.unheld[0].ticker, "AMZN");
  assert.equal(result.rows[0].eur, null);
  assert.equal(result.months.find(month => month.month === "2026-11").value, 0);
  input.dividendAssumptions = [plan({ frequency: "none", amountPerShare: 0, firstPaymentDate: null }), plan({ ticker: "VOW.DE", currency: "EUR", frequency: "once", firstPaymentDate: "2026-10-01" })];
  const expired = dividendForecast(input, { now: NOW });
  assert.deepEqual(expired.noDividend, ["MSFT"]); assert.deepEqual(expired.inactive, ["VOW.DE (EUR)"]);
  assert.equal(expired.rows.length, 0); assert.equal(expired.total, 0);
});

test("assumptions survive validation and backup with old books unchanged and financial projections identical", () => {
  const original = book();
  assert.deepEqual(validatePortfolioBook(original, { now: NOW }).book, original);
  const input = { ...original, dividendAssumptions: [plan()] };
  const restored = parsePortfolioBackup(serializePortfolioBackup(input, { now: NOW }), { now: NOW });
  assert.equal(restored.ok, true, restored.error); assert.deepEqual(restored.book, input);
  assert.deepEqual(projectPortfolioBook(restored.book), projectPortfolioBook(original));
});

test("assumption boundaries reject duplicates, invalid dates, nonfinite amounts, unsupported fields and accumulating ETF payments", () => {
  for (const assumptions of [
    [plan(), plan()], [plan({ firstPaymentDate: "2026-02-30" })], [plan({ amountPerShare: NaN })], [plan({ amountPerShare: -1 })],
    [plan({ amountPerShare: "1" })], [plan({ frequency: "weekly" })], [plan({ cashAmount: 100 })], [plan({ ticker: "BTC-USD" })],
    [plan({ ticker: "VWCE.DE", currency: "EUR" })], [plan({ frequency: "none" })], Array.from({ length: 501 }, () => plan()),
  ]) {
    assert.throws(() => normalizeDividendAssumptions(assumptions), TypeError);
    assert.equal(validatePortfolioBook({ ...book(), dividendAssumptions: assumptions }, { now: NOW }).ok, false);
  }
});
