import test from "node:test";
import assert from "node:assert/strict";
import { calculatePortfolioTotals } from "../js/analysis/portfolio-totals.js";
import { createPortfolioBook, normalizeTransaction, projectPortfolioBook, validatePortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { EXCHANGE_RATE_SOURCE, EXCHANGE_RATE_SOURCE_URL } from "../js/data/exchange-rate.js";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const START = "2026-10-01";
const exchangeRate = { schemaVersion: 1, available: true, base: "USD", quote: "EUR", rate: 0.9,
  date: "2026-10-08", source: EXCHANGE_RATE_SOURCE, sourceUrl: EXCHANGE_RATE_SOURCE_URL, retrievedAt: "2026-10-08T17:00:00.000Z" };
const holding = (overrides = {}) => ({ id: "holding", kind: "position", ticker: "AAPL", currency: "EUR", currentValue: 7800, source: "quote", ...overrides });
const deposit = (overrides = {}) => ({ id: "deposit", type: "deposit", date: START, currency: "EUR", amount: 10000, ...overrides });
const buy = (overrides = {}) => ({ id: "buy", type: "buy", date: START, currency: "EUR", ticker: "AAPL", quantity: 70, price: 100, ...overrides });
function makeBook(entries = [], openingHoldings = [], baseCurrency = "EUR") {
  const book = createPortfolioBook({ holdings: openingHoldings, baseCurrency, startDate: START, now: NOW });
  book.transactions = entries.map((entry) => {
    const result = normalizeTransaction(entry, { startDate: START, now: NOW, baseCurrency });
    assert.equal(result.ok, true, result.error);
    return result.transaction;
  });
  const checked = validatePortfolioBook(book, { now: NOW });
  assert.equal(checked.ok, true, checked.error);
  return checked.book;
}
function calculate(book, holdings = [], options = {}) {
  return calculatePortfolioTotals({ book, holdings, projection: projectPortfolioBook(book), exchangeRate, now: NOW, ...options });
}

test("cash-funded portfolio reports money put in and total market value including cash", () => {
  const book = makeBook([deposit(), buy()]);
  const result = calculate(book, [holding()]);
  assert.deepEqual(result, { contributed: 10000, totalValue: 10800, holdingsValue: 7800, cashValue: 3000,
    contributionComplete: true, valueComplete: true, reasons: [] });
});

test("buys, sales, dividends and fees do not become new money put in", () => {
  const book = makeBook([
    deposit({ type: "opening_cash", amount: 1000 }), deposit({ id: "extra", amount: 500 }),
    buy({ quantity: 2, price: 100, fee: 2 }),
    buy({ id: "sale", type: "sell", quantity: 1, price: 120, fee: 1 }),
    deposit({ id: "dividend", type: "dividend", ticker: "AAPL", amount: 20 }),
    deposit({ id: "fee", type: "fee", amount: 5 }), deposit({ id: "withdrawal", type: "withdrawal", amount: 200 })
  ]);
  const result = calculate(book, [holding({ currentValue: 120 })]);
  assert.equal(result.contributed, 1300);
  assert.equal(result.cashValue, 1232);
  assert.equal(result.totalValue, 1352);
});

test("actual EUR settlements determine historic contributions while current USD holdings use the qualified display rate", () => {
  const book = makeBook([
    deposit({ currency: "USD", amount: 12000, cashCurrency: "EUR", cashAmount: 10000 }),
    buy({ currency: "USD", quantity: 10, price: 200, cashCurrency: "EUR", cashAmount: 1800 }),
    deposit({ id: "withdrawal", type: "withdrawal", currency: "USD", amount: 100, cashCurrency: "EUR", cashAmount: 85 })
  ]);
  const result = calculate(book, [holding({ currency: "USD", currentValue: 2300 })]);
  assert.equal(result.contributed, 9915);
  assert.equal(result.holdingsValue, 2070);
  assert.equal(result.cashValue, 8115);
  assert.equal(result.totalValue, 10185);
  assert.equal(result.valueComplete, true);
});

test("current FX never fills missing historic funding amounts", () => {
  const book = makeBook([deposit({ currency: "USD", amount: 10000 })], [], "USD");
  const result = calculate(book);
  assert.equal(result.contributed, null);
  assert.equal(result.contributionComplete, false);
  assert.equal(result.cashValue, 9000);
  assert.equal(result.totalValue, 9000);
  assert.equal(result.valueComplete, true);
  assert.match(result.reasons.join(" "), /Historical funding/);
});

test("opening holdings leave contributions unknown even when all current values are available", () => {
  const opening = { id: "old", kind: "position", ticker: "AAPL", label: "Apple", currency: "EUR", shares: 5, averageCost: 100 };
  const book = makeBook([deposit({ type: "opening_cash", amount: 3000 })], [opening]);
  const result = calculate(book, [holding({ currentValue: 600 })]);
  assert.equal(result.contributed, null);
  assert.equal(result.contributionComplete, false);
  assert.equal(result.totalValue, 3600);
  assert.equal(result.valueComplete, true);
  assert.match(result.reasons.join(" "), /Funding for opening holdings/);
});

test("manual legacy amounts and missing quotes block a full holdings or portfolio value", () => {
  const book = makeBook([deposit()]);
  for (const row of [holding({ kind: "manual", source: "manual" }), holding({ currentValue: null }),
    holding({ currentValue: NaN }), holding({ currentValue: -100 }), holding({ source: "Sample fallback" })]) {
    const result = calculate(book, [holding({ id: "good", ticker: "MSFT", currentValue: 100 }), row]);
    assert.equal(result.holdingsValue, null);
    assert.equal(result.totalValue, null);
    assert.equal(result.valueComplete, false);
    assert.equal(result.cashValue, 10000);
    assert.equal(result.contributed, 10000);
  }
});

test("stale, missing or future FX blocks USD values but never blocks entirely EUR values", () => {
  const book = makeBook([deposit()]);
  for (const rate of [null, { ...exchangeRate, date: "2026-09-30", retrievedAt: "2026-09-30T17:00:00.000Z" },
    { ...exchangeRate, date: "2026-10-10" }, { ...exchangeRate, rate: Infinity }]) {
    const usd = calculate(book, [holding({ currency: "USD" })], { exchangeRate: rate });
    assert.equal(usd.holdingsValue, null);
    assert.equal(usd.totalValue, null);
    assert.match(usd.reasons.join(" "), /reference rate/);
    assert.equal(calculate(book, [holding()], { exchangeRate: rate }).valueComplete, true);
  }
});

test("incomplete reporting cash never double-counts settled totals or substitutes a known subtotal", () => {
  const book = makeBook([
    deposit(), buy({ id: "settled", currency: "USD", quantity: 5, price: 200, cashCurrency: "EUR", cashAmount: 900 }),
    buy({ id: "legacy", currency: "USD", quantity: 1, price: 100 })
  ]);
  const result = calculate(book, [holding({ currency: "USD", currentValue: 1200 })]);
  assert.equal(result.contributed, 10000);
  assert.equal(result.holdingsValue, 1080);
  assert.equal(result.cashValue, null);
  assert.equal(result.totalValue, null);
  assert.equal(result.valueComplete, false);
  assert.match(result.reasons.join(" "), /actual converted amounts/);
});

test("cash-only portfolios keep an explicit empty holdings list valid, including after all shares are sold", () => {
  const empty = calculate(makeBook());
  assert.equal(empty.contributed, 0);
  assert.equal(empty.totalValue, 0);
  assert.equal(empty.valueComplete, true);
  const book = makeBook([deposit({ amount: 1000 }), buy({ quantity: 1, price: 100 }),
    buy({ id: "sale", type: "sell", quantity: 1, price: 120 })]);
  assert.deepEqual(projectPortfolioBook(book).holdings, []);
  const result = calculate(book, []);
  assert.equal(result.holdingsValue, 0);
  assert.equal(result.cashValue, 1020);
  assert.equal(result.totalValue, 1020);
  assert.equal(result.contributed, 1000);
});

test("negative recorded cash blocks full current value, while net money put in remains signed", () => {
  const unfunded = makeBook([buy()]);
  const result = calculate(unfunded, [holding()]);
  assert.equal(result.cashValue, -7000);
  assert.equal(result.holdingsValue, 7800);
  assert.equal(result.totalValue, null);
  assert.equal(result.valueComplete, false);
  assert.ok(result.reasons.includes("Recorded cash is negative. Add missing funding transactions."));
  const withdrawals = makeBook([deposit({ amount: 100 }), deposit({ id: "withdrawal", type: "withdrawal", amount: 150 }),
    deposit({ id: "dividend", type: "dividend", ticker: "AAPL", amount: 100 })]);
  const signed = calculate(withdrawals);
  assert.equal(signed.contributed, -50);
  assert.equal(signed.contributionComplete, true);
  assert.equal(signed.totalValue, 50);
});

test("unsupported currencies and absent book/cash/holding inputs cannot present a partial full total", () => {
  const book = makeBook([deposit()]);
  assert.equal(calculate(book, [holding({ currency: "GBP" })]).totalValue, null);
  const gbpBook = makeBook([deposit({ currency: "GBP" })], [], "GBP");
  assert.equal(calculate(gbpBook).cashValue, null);
  const noBook = calculatePortfolioTotals({ holdings: [holding()], exchangeRate, now: NOW });
  assert.equal(noBook.contributed, null);
  assert.equal(noBook.holdingsValue, 7800);
  assert.equal(noBook.cashValue, null);
  assert.equal(noBook.totalValue, null);
  assert.equal(calculatePortfolioTotals({ book, projection: projectPortfolioBook(book), now: NOW }).totalValue, null);
  assert.equal(calculatePortfolioTotals().totalValue, null);
});

test("overflow never produces a usable total and calculation leaves all inputs untouched", () => {
  const book = makeBook([deposit()]);
  const holdings = [holding()]; const projection = projectPortfolioBook(book);
  const input = { book, holdings, projection, exchangeRate, now: NOW };
  const original = structuredClone(input);
  calculatePortfolioTotals(input);
  assert.deepEqual(input, original);
  assert.equal(calculate(book, [holding({ currency: "USD", currentValue: 1e308 })], { exchangeRate: { ...exchangeRate, rate: 2 } }).holdingsValue, null);
  const huge = makeBook([deposit({ amount: 1e308 })]);
  const result = calculate(huge, [holding({ currentValue: 1e308 })]);
  assert.equal(result.holdingsValue, 1e308);
  assert.equal(result.cashValue, 1e308);
  assert.equal(result.totalValue, null);
  assert.equal(result.valueComplete, false);
});

test("ordinary cent roundoff is displayed as zero cash without hiding a real one-cent deficit", () => {
  const rounded = makeBook([
    deposit({ amount: 10.01 }), buy({ quantity: 1, price: 10 }),
    deposit({ id: "fee", type: "fee", amount: 0.01 })
  ]);
  const ledgerCash = projectPortfolioBook(rounded).reportingCash.amount;
  assert.ok(ledgerCash < 0 && Math.abs(ledgerCash) < 1e-7);
  const result = calculate(rounded, [holding({ currentValue: 11 })]);
  assert.equal(result.cashValue, 0);
  assert.equal(result.totalValue, 11);
  assert.equal(result.valueComplete, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(projectPortfolioBook(rounded).reportingCash.amount, ledgerCash);
  const deficit = makeBook([
    deposit({ amount: 10 }), buy({ quantity: 1, price: 10 }),
    deposit({ id: "fee", type: "fee", amount: 0.01 })
  ]);
  const material = calculate(deficit, [holding({ currentValue: 11 })]);
  assert.equal(material.cashValue, -0.01);
  assert.equal(material.totalValue, null);
  assert.equal(material.valueComplete, false);
  assert.ok(material.reasons.includes("Recorded cash is negative. Add missing funding transactions."));
});
