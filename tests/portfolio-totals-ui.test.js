import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createPortfolioBook } from "../js/analysis/portfolio-ledger.js";

const nodes = new Map();
const node = (id) => {
  if (!nodes.has(id)) nodes.set(id, { innerHTML: "" });
  return nodes.get(id);
};
globalThis.document = { getElementById: node, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem() { throw new Error("Rendering must not write saved data"); } };
globalThis.window = { setTimeout, clearTimeout };
const { buildPortfolioReview, renderPortfolioReview } = await import("../js/features/portfolio.js");
const { setActivePortfolioBook } = await import("../js/portfolio-state.js");
const NOW = Date.parse("2026-10-09T12:05:00Z");
const FX = { schemaVersion: 1, available: true, base: "USD", quote: "EUR", rate: 0.9, date: "2026-10-09",
  source: "ECB reference rate via Frankfurter", sourceUrl: "https://api.frankfurter.dev/v2/providers/ecb/rate/usd/eur",
  retrievedAt: "2026-10-09T12:00:00Z" };
const money = (value) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(value);
const valueFor = (label) => node("portfolioTotals").innerHTML.match(new RegExp(`<span>${label}</span><strong>([^<]+)</strong>`))?.[1];

beforeEach(() => { setActivePortfolioBook(null); node("portfolioTotals").innerHTML = ""; });

function bookWithTransactions(transactions) {
  return { ...createPortfolioBook({ holdings: [], baseCurrency: "EUR", startDate: "2026-10-01", now: NOW }), transactions };
}
function funding(amount = 10000) {
  return { id: "deposit", type: "deposit", date: "2026-10-01", currency: "EUR", amount, cashCurrency: "EUR", cashAmount: amount };
}
function trade(id, ticker, currency, quantity, price, cashAmount, fee = 0) {
  return { id, type: "buy", date: "2026-10-02", ticker, currency, quantity, price, amount: quantity * price,
    fee, cashCurrency: "EUR", cashAmount };
}
function quote(ticker, currency, price) {
  return { ticker, currency, latest: price, score: 70, source: "Fixture prices", dataQuality: { eligible: true, asOf: "2026-10-08T16:00:00Z" },
    quote: { ticker, currency, price, quoteTime: "2026-10-09T12:00:00Z" } };
}

test("top figures combine EUR/USD holdings with EUR cash without double-counting purchases", () => {
  const book = bookWithTransactions([funding(), trade("etf", "VWCE.DE", "EUR", 10, 500, 5000), trade("stock", "MSFT", "USD", 2, 1000, 1800, 5)]);
  setActivePortfolioBook(book);
  const before = structuredClone(book);
  const review = buildPortfolioReview([quote("VWCE.DE", "EUR", 510), quote("MSFT", "USD", 1050)], { available: false });
  renderPortfolioReview(review, "fixture", { exchangeRate: FX, now: NOW });
  assert.equal(valueFor("Money put in"), money(10000));
  assert.equal(valueFor("Total value"), money(10190)); // 5100 + 2100 * 0.9 + 3200 cash
  assert.match(node("portfolioTotals").innerHTML, /includes holdings and cash/);
  assert.doesNotMatch(node("portfolioTotals").innerHTML, /USD|\(€|Unavailable/);
  assert.deepEqual(book, before);
  assert.equal(review.holdings.find((h) => h.ticker === "MSFT").gain, 95);
});

test("cash-only portfolios update top figures even with no holding cards", () => {
  setActivePortfolioBook(bookWithTransactions([funding(500)]));
  const review = buildPortfolioReview([], { available: false });
  renderPortfolioReview(review, "fixture", { exchangeRate: null, now: NOW });
  assert.equal(valueFor("Money put in"), money(500));
  assert.equal(valueFor("Total value"), money(500));
});

test("missing prices or FX cannot turn known values into a full portfolio total", () => {
  setActivePortfolioBook(bookWithTransactions([funding(500), trade("stock", "MSFT", "USD", 1, 100, 90)]));
  renderPortfolioReview(buildPortfolioReview([], { available: false }), "fixture", { exchangeRate: FX, now: NOW });
  assert.equal(valueFor("Money put in"), money(500));
  assert.equal(valueFor("Total value"), "Unavailable");
  renderPortfolioReview(buildPortfolioReview([quote("MSFT", "USD", 110)], { available: false }), "fixture", { exchangeRate: null, now: NOW });
  assert.equal(valueFor("Total value"), "Unavailable");
  assert.match(node("portfolioTotals").innerHTML, /rate|EUR/);
});

test("missing funding is visible instead of implying that negative cash is actual net worth", () => {
  setActivePortfolioBook(bookWithTransactions([trade("stock", "MSFT", "USD", 1, 100, 90)]));
  renderPortfolioReview(buildPortfolioReview([quote("MSFT", "USD", 110)], { available: false }), "fixture", { exchangeRate: FX, now: NOW });
  assert.equal(valueFor("Total value"), "Unavailable");
  assert.match(node("portfolioTotals").innerHTML, /funding|negative/);
});

test("before setup the top figures do not pretend funding or cash are known", () => {
  renderPortfolioReview({ holdings: [], groups: [], concentrationNotes: [] }, "fixture", { exchangeRate: FX, now: NOW });
  assert.equal(valueFor("Money put in"), "Unavailable");
  assert.equal(valueFor("Total value"), "Unavailable");
});
