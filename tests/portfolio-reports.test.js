import test from "node:test";
import assert from "node:assert/strict";
import { createPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { transactionCash, transactionReport, fundingReport } from "../js/analysis/portfolio-reports.js";
function book() {
  const input = createPortfolioBook({ baseCurrency: "EUR", startDate: "2026-01-01", now: "2026-03-01" });
  input.transactions = [
    { id: "o", type: "opening_cash", date: "2026-01-01", currency: "EUR", amount: 500 },
    { id: "d", type: "deposit", date: "2026-01-02", currency: "EUR", amount: 1000 },
    { id: "b", type: "buy", date: "2026-01-03", ticker: "MSFT", currency: "USD", quantity: 1, price: 300, amount: 300, fee: 2, cashCurrency: "EUR", cashAmount: 280, note: "Old purchase" },
    { id: "w", type: "withdrawal", date: "2026-02-02", currency: "EUR", amount: 100 }
  ];
  return input;
}
test("cash movements use recorded EUR settlements once and keep native fee direction", () => {
  assert.deepEqual(transactionCash(book().transactions[2]), { currency: "EUR", amount: -280, eurAmount: -280 });
  assert.equal(transactionCash({ type: "sell", amount: 200, fee: 5, currency: "EUR" }).eurAmount, 195);
  assert.equal(transactionCash({ type: "buy", amount: 200, fee: 5, currency: "EUR" }).eurAmount, -205);
});
test("funding excludes trades and keeps starting cash separate from deposits", () => {
  const input = book(), copy = structuredClone(input);
  const report = fundingReport(input, { now: "2026-03-01" });
  assert.equal(report.net, 900); assert.equal(report.openingCash, 500);
  assert.deepEqual(report.months.map((row) => [row.month, row.net]), [["2026-01", 1000], ["2026-02", -100]]);
  assert.deepEqual(input, copy);
  assert.equal(fundingReport(input, { from: "2026-02-01", now: "2026-03-01" }).net, -100);
});
test("foreign funding without EUR settlement withholds affected totals instead of inventing EUR amounts", () => {
  const input = book(); input.transactions[1].currency = "USD";
  const report = fundingReport(input, { now: "2026-03-01" });
  assert.equal(report.missing, 1); assert.equal(report.deposits, null); assert.equal(report.net, null); assert.equal(report.withdrawals, 100);
});
test("transaction filters preserve historical records and reject reversed dates", () => {
  assert.equal(transactionReport(book(), { search: "old purchase", now: "2026-03-01" }).rows[0].id, "b");
  assert.equal(transactionReport(book(), { type: "deposit", now: "2026-03-01" }).rows.length, 1);
  assert.match(transactionReport(book(), { from: "2026-02-01", to: "2026-01-01", now: "2026-03-01" }).error, /date range/);
  assert.match(transactionReport(book(), { from: "2026-99-99", now: "2026-03-01" }).error, /date range/);
});
