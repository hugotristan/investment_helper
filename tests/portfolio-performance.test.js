import test from "node:test";
import assert from "node:assert/strict";
import { calculatePortfolioPerformance } from "../js/analysis/portfolio-performance.js";
import { createPortfolioBook, normalizeTransaction, projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { PORTFOLIO_FX_SOURCE, PORTFOLIO_FX_SOURCE_URL } from "../js/data/portfolio-history.js";

const SOURCE = "Yahoo Finance published snapshot";
const NEXT = "2026-02-01";
const days = (start, end) => {
  const result = [];
  for (let stamp = Date.parse(start); stamp <= Date.parse(end); stamp += 86400000) result.push(new Date(stamp).toISOString().slice(0, 10));
  return result;
};
function book(start = "2026-01-01", transactions = [], holdings = [], now = NEXT) {
  const value = createPortfolioBook({ startDate: start, baseCurrency: "EUR", holdings, now });
  value.transactions = transactions.map((input, index) => {
    const normalized = normalizeTransaction({ id: `transaction-${index}`, date: start, currency: "EUR", ...input },
      { startDate: start, baseCurrency: "EUR", now });
    assert.equal(normalized.ok, true, normalized.error);
    return normalized.transaction;
  });
  return value;
}
const deposit = (amount, overrides = {}) => ({ type: "deposit", amount, ...overrides });
const openingCash = (amount, overrides = {}) => ({ type: "opening_cash", amount, ...overrides });
const trade = (type, quantity, price, overrides = {}) => ({ type, quantity, price, ticker: "VWCE.DE", ...overrides });
const opening = (overrides = {}) => ({ kind: "position", id: "opening-1", ticker: "VWCE.DE", label: "VWCE",
  currency: "EUR", shares: 1, averageCost: 100, ...overrides });
function history(ticker, currency, start = "2026-01-01", end = "2026-01-31", close = 100, extra = {}) {
  return { ticker, currency, source: SOURCE, splits: [], splitsComplete: true,
    prices: days(start, end).map((date, index) => ({ date, close: typeof close === "function" ? close(date, index) : close })), ...extra };
}
function fx(start = "2026-01-01", end = "2026-01-31", rate = 0.9, now = NEXT) {
  return { schemaVersion: 1, source: PORTFOLIO_FX_SOURCE, sourceUrl: PORTFOLIO_FX_SOURCE_URL,
    generatedAt: `${now}T00:00:00Z`, byCurrency: { USD: days(start, end).map((date, index) => ({ date, rate: typeof rate === "function" ? rate(date, index) : rate })) } };
}
function run(input, overrides = {}) {
  return calculatePortfolioPerformance({ book: input, now: NEXT,
    histories: { "VWCE.DE": history("VWCE.DE", "EUR"), SPY: history("SPY", "EUR") }, ...overrides });
}
function close(actual, expected, tolerance = 1e-10) {
  assert.ok(typeof actual === "number" && Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`);
}

test("EUR settlements determine foreign basis, partial-sale gains, and cash once", () => {
  const input = book("2026-01-01", [
    deposit(10000),
    trade("buy", 2, 1000, { ticker: "MSFT", currency: "USD", date: "2026-01-02", cashCurrency: "EUR", cashAmount: 1800 }),
    trade("sell", 1, 1200, { ticker: "MSFT", currency: "USD", date: "2026-01-03", cashCurrency: "EUR", cashAmount: 1100 }),
    { type: "dividend", ticker: "MSFT", amount: 10, currency: "USD", date: "2026-01-04", cashCurrency: "EUR", cashAmount: 10 },
    { type: "fee", amount: 3, currency: "USD", date: "2026-01-05", cashCurrency: "EUR", cashAmount: 3 }
  ]);
  const result = run(input, { fxHistory: fx(), histories: { MSFT: history("MSFT", "USD", undefined, undefined, 1050), SPY: history("SPY", "EUR") } });
  assert.equal(result.summary.currentValue, 10252);
  assert.equal(result.summary.realizedGain, 200);
  assert.equal(result.summary.unrealizedGain, 45);
  assert.equal(result.summary.income, 10);
  assert.equal(result.summary.fees, 3);
  assert.equal(result.summary.netContributions, 10000);
  assert.equal(result.summary.totalGain, 252);
  assert.deepEqual(result.holdings[0], { ticker: "MSFT", currency: "USD", shares: 1, costBasis: 900, realizedGain: 200, currentValue: 945, unrealizedGain: 45 });
  assert.equal(projectPortfolioBook(input).reportingCash.amount, 9307);
});

test("weighted-average EUR cost is disposed proportionally; embedded sale fees are not charged twice", () => {
  const input = book("2026-01-01", [deposit(1000), trade("buy", 2, 100),
    trade("buy", 2, 150, { date: "2026-01-02" }), trade("sell", 1, 200, { date: "2026-01-03", fee: 5 })]);
  const result = run(input, { histories: { "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 180) } });
  assert.equal(result.holdings[0].costBasis, 375);
  assert.equal(result.holdings[0].realizedGain, 70);
  assert.equal(result.holdings[0].unrealizedGain, 165);
  assert.equal(result.summary.fees, 5);
  assert.equal(result.summary.totalGain, 235);
  assert.equal(result.summary.currentValue, 1235);
});

test("a fully sold holding keeps its realized gain with zero residual basis", () => {
  const result = run(book("2026-01-01", [deposit(1000), trade("buy", 1, 100),
    trade("sell", 1, 120, { date: "2026-01-03", fee: 2 })]));
  assert.equal(result.holdings.length, 1);
  assert.equal(result.holdings[0].shares, 0);
  assert.equal(result.holdings[0].costBasis, 0);
  assert.equal(result.summary.currentValue, 1018);
  assert.equal(result.summary.realizedGain, 18);
  assert.equal(result.summary.unrealizedGain, 0);
  assert.equal(result.summary.totalGain, 18);
});

test("validated on-demand stock histories support valuation and preserve the corporate-action gate", () => {
  const input = book("2026-01-01", [deposit(1000), trade("buy", 1, 100)]);
  for (const source of ["Yahoo Finance chart", "Yahoo Finance via CORS relay"]) {
    const loaded = history("VWCE.DE", "EUR", undefined, undefined, 120, { source });
    const result = run(input, { histories: { "VWCE.DE": loaded } });
    assert.equal(result.summary.currentValue, 1020);
    assert.equal(result.summary.unrealizedGain, 20);
    const blocked = run(input, { histories: { "VWCE.DE": { ...loaded, splitsComplete: false } } });
    assert.equal(blocked.summary.currentValue, null);
    assert.match(blocked.reasons.join(" "), /split history is incomplete|corporate actions/);
  }
  const fabricated = run(input, { histories: { "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 120, { source: "arbitrary" }) } });
  assert.equal(fabricated.summary.currentValue, null);
});

test("a large month-end deposit increases value and funding, not profit or return", () => {
  const input = book("2026-01-01", [openingCash(100), trade("buy", 1, 100), deposit(10000, { date: "2026-01-31" })]);
  const result = run(input, { histories: { "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 110), SPY: history("SPY", "EUR") } });
  assert.equal(result.summary.currentValue, 10110);
  assert.equal(result.summary.selectedPeriodGain, 10);
  assert.equal(result.summary.netContributions, 10100);
  assert.equal(result.months[0].gain, 10);
  assert.equal(result.months[0].netFlow, 10000);
  close(result.months[0].return, 0.1);
  close(result.summary.return, 0.1);
});

test("Modified Dietz matches the primary GIPS end-of-day cash-flow oracle", () => {
  const now = "2026-07-01";
  const input = book("2026-05-31", [openingCash(100000), trade("buy", 1, 50000, { date: "2026-06-01" }),
    { type: "withdrawal", amount: 2000, date: "2026-06-06" }, deposit(20000, { date: "2026-06-11" })], [], now);
  const result = run(input, { now, histories: {
    "VWCE.DE": history("VWCE.DE", "EUR", "2026-05-31", "2026-06-30", (date) => date === "2026-06-30" ? 67000 : 50000),
    SPY: history("SPY", "EUR", "2026-05-31", "2026-06-30")
  } });
  const june = result.months.find(({ month }) => month === "2026-06");
  assert.equal(june.startValue, 100000);
  assert.equal(june.endValue, 135000);
  assert.equal(june.netFlow, 18000);
  assert.equal(june.gain, 17000);
  close(june.return, 17000 / (100000 - 2000 * 24 / 30 + 20000 * 19 / 30));
  assert.match(result.methodology.returnMethod, /approximate/);
  assert.equal(result.methodology.cashFlowTiming, "end-of-day");
});

test("monthly gains link geometrically rather than adding percentages", () => {
  const now = "2026-03-01";
  const input = book("2026-01-01", [openingCash(100), trade("buy", 1, 100)], [], now);
  const result = run(input, { now, histories: {
    "VWCE.DE": history("VWCE.DE", "EUR", "2026-01-01", "2026-02-28", (date) => date <= "2026-01-31" ? 110 : 121),
    SPY: history("SPY", "EUR", "2026-01-01", "2026-02-28")
  } });
  close(result.months[0].return, 0.1); close(result.months[1].return, 0.1);
  close(result.summary.return, 0.21);
});

test("actual historical EUR charge survives reference FX changes", () => {
  const input = book("2026-01-01", [deposit(1000), trade("buy", 1, 350, {
    ticker: "MSFT", currency: "USD", fee: 5, cashCurrency: "EUR", cashAmount: 300 })]);
  const result = run(input, { fxHistory: fx(undefined, undefined, (date) => date === "2026-01-31" ? 0.95 : 0.8),
    histories: { MSFT: history("MSFT", "USD", undefined, undefined, 360), SPY: history("SPY", "EUR") } });
  assert.equal(result.holdings[0].costBasis, 300);
  assert.equal(result.holdings[0].currentValue, 342);
  assert.equal(result.summary.unrealizedGain, 42);
  assert.equal(result.summary.currentValue, 1042);
  assert.equal(result.methodology.feesEstimated, true);
  close(result.summary.fees, 300 * 5 / 355);
});

test("dividends and explicit account fees affect growth without becoming contributions", () => {
  const result = run(book("2026-01-01", [openingCash(100), { type: "dividend", ticker: "VWCE.DE", amount: 10 }, { type: "fee", amount: 3 }]));
  assert.equal(result.summary.currentValue, 107);
  assert.equal(result.summary.netContributions, 100);
  assert.equal(result.summary.selectedPeriodGain, 7);
  assert.equal(result.summary.totalGain, 7);
  close(result.summary.return, 0.07);
});

test("cash withdrawals change funding while preserving the return earned", () => {
  const input = book("2026-01-01", [openingCash(200), trade("buy", 1, 100), { type: "withdrawal", amount: 50, date: "2026-01-31" }]);
  const result = run(input, { histories: { "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 120) } });
  assert.equal(result.summary.currentValue, 170);
  assert.equal(result.summary.netContributions, 150);
  assert.equal(result.summary.selectedPeriodGain, 20);
  close(result.summary.return, 0.1);
});

test("opening cost gains and tracking-market growth are distinct; foreign opening basis is an estimate", () => {
  const input = book("2026-01-01", [], [opening({ ticker: "MSFT", currency: "USD", shares: 2, averageCost: 100 })]);
  const result = run(input, { fxHistory: fx(undefined, undefined, (date) => date === "2026-01-31" ? 0.95 : 0.9), histories: {
    MSFT: history("MSFT", "USD", undefined, undefined, 120), SPY: history("SPY", "EUR")
  } });
  assert.equal(result.summary.openingValue, 216);
  assert.equal(result.holdings[0].costBasis, 180);
  assert.equal(result.summary.currentValue, 228);
  assert.equal(result.summary.totalGain, 48);
  assert.equal(result.summary.selectedPeriodGain, 12);
  assert.equal(result.summary.netContributions, 0);
  assert.equal(result.methodology.openingCostEstimated, true);
  assert.ok(result.reasons.some((value) => /estimated start-date/.test(value)));
});

test("weekend valuations carry recent observations without a future quote or FX rate", () => {
  const now = "2026-01-12"; // Monday; reporting ends on Sunday.
  const input = book("2026-01-09", [deposit(1000), trade("buy", 1, 100, { ticker: "MSFT", currency: "USD", cashCurrency: "EUR", cashAmount: 90 })], [], now);
  const result = run(input, { now, fxHistory: fx("2026-01-09", "2026-01-12", (date) => date === "2026-01-12" ? 0.1 : 0.9, now), histories: {
    MSFT: history("MSFT", "USD", "2026-01-09", "2026-01-12", (date) => date === "2026-01-12" ? 999 : 110,
      { prices: [{ date: "2026-01-09", close: 110 }, { date: "2026-01-12", close: 999 }] }),
    SPY: history("SPY", "EUR", "2026-01-09", "2026-01-09")
  } });
  assert.equal(result.endDate, "2026-01-11");
  assert.equal(result.holdings[0].currentValue, 99);
  assert.equal(result.summary.currentValue, 1009);
  assert.equal(result.series.at(-1).value, 1009);
});

test("missing initial history never moves the baseline to the first available price", () => {
  const result = run(book("2026-01-01", [], [opening()]), { histories: {
    "VWCE.DE": history("VWCE.DE", "EUR", "2026-01-10", "2026-01-31", 120), SPY: history("SPY", "EUR")
  } });
  assert.equal(result.startDate, "2026-01-01");
  assert.equal(result.summary.currentValue, 120);
  assert.equal(result.summary.openingValue, null);
  assert.equal(result.summary.return, null);
  assert.equal(result.months[0].return, null);
  assert.equal(result.series[0].value, null);
  assert.equal(result.series.at(-1).return, null);
  assert.ok(result.reasons.some((value) => /whole reporting period/.test(value)));
});

test("a gap beyond seven days remains visible and invalidates the monthly return", () => {
  const result = run(book("2026-01-01", [], [opening()]), { histories: { "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 100,
    { prices: [{ date: "2026-01-01", close: 100 }, { date: "2026-01-20", close: 110 }, { date: "2026-01-31", close: 120 }] }) } });
  assert.equal(result.summary.currentValue, 120);
  assert.equal(result.series.find(({ date }) => date === "2026-01-09").value, null);
  assert.equal(result.summary.return, null);
  assert.equal(result.months[0].gain, null);
});

test("missing historical FX and legacy missing EUR settlements never use the current rate", () => {
  const input = book("2026-01-01", [deposit(1000), trade("buy", 1, 100, { ticker: "MSFT", currency: "USD", cashCurrency: "EUR", cashAmount: 90 })]);
  const histories = { MSFT: history("MSFT", "USD", undefined, undefined, 110) };
  const missingRate = run(input, { histories, fxHistory: fx("2026-01-10") });
  assert.equal(missingRate.holdings[0].costBasis, 90);
  assert.equal(missingRate.summary.currentValue, 1009);
  assert.equal(missingRate.summary.return, null);
  const legacy = run(book("2026-01-01", [deposit(1000), trade("buy", 1, 100, { ticker: "MSFT", currency: "USD" })]), { histories, fxHistory: fx() });
  assert.equal(legacy.summary.currentValue, null);
  assert.equal(legacy.holdings[0].costBasis, null);
  assert.equal(legacy.summary.totalGain, null);
  assert.ok(legacy.reasons.some((value) => /actual converted cash/.test(value)));
});

test("negative funding history cannot be repaired retroactively by a later deposit", () => {
  const result = run(book("2026-01-01", [trade("buy", 1, 100), deposit(200, { date: "2026-01-10" })]));
  assert.equal(result.summary.currentValue, 200);
  assert.equal(result.summary.return, null);
  assert.equal(result.series[0].value, null);
  assert.ok(result.reasons.some((value) => /Funding history may be incomplete/.test(value)));
  const tiny = run(book("2026-01-01", [deposit(10.01), trade("buy", 1, 10), { type: "fee", amount: 0.01 }]));
  assert.ok(tiny.summary.currentValue !== null);
  assert.ok(!tiny.reasons.some((value) => /Funding history may be incomplete/.test(value)));
});

test("split-adjusted history cannot value unadjusted quantities, including sold-out positions", () => {
  const input = book("2026-01-01", [deposit(1000), trade("buy", 1, 100), trade("sell", 1, 60, { date: "2026-01-20" })]);
  const result = run(input, { histories: { "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 60,
    { splits: [{ date: "2026-01-10", numerator: 2, denominator: 1 }] }) } });
  assert.equal(result.summary.currentValue, null);
  assert.equal(result.summary.realizedGain, null);
  assert.equal(result.summary.totalGain, null);
  assert.ok(result.reasons.some((value) => /corporate actions/.test(value)));
  const futureToWindow = run(book("2026-01-01", [], [opening()]), { to: "2026-01-05", histories: {
    "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 60, { splits: [{ date: "2026-01-10", numerator: 2, denominator: 1 }] })
  } });
  assert.equal(futureToWindow.summary.currentValue, null);
  assert.ok(futureToWindow.reasons.some((value) => /split after acquisition/.test(value)));
});

test("a split before acquisition is safe; unknown split metadata is not assumed complete", () => {
  const input = book("2026-01-01", [deposit(1000), trade("buy", 1, 100, { date: "2026-01-15" })]);
  const known = run(input, { histories: { "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 110,
    { splits: [{ date: "2026-01-10", numerator: 2, denominator: 1 }] }) } });
  assert.equal(known.summary.currentValue, 1010);
  const unknown = run(input, { histories: { "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 110, { splitsComplete: false }) } });
  assert.equal(unknown.summary.currentValue, null);
  assert.equal(unknown.summary.totalGain, null);
});

test("initial no-exposure months remain visible while returns and benchmark anchor to funding", () => {
  const now = "2026-03-01";
  const input = book("2026-01-01", [deposit(100), trade("buy", 1, 100)].map((entry) => ({ ...entry, date: "2026-02-01" })), [], now);
  const result = run(input, { now, histories: { "VWCE.DE": history("VWCE.DE", "EUR", "2026-02-01", "2026-02-28", 110),
    SPY: history("SPY", "EUR", "2026-02-01", "2026-02-28", (date) => date === "2026-02-01" ? 100 : 110) } });
  assert.equal(result.months[0].status, "no-exposure");
  assert.equal(result.months[0].return, null);
  assert.equal(result.returnStartDate, "2026-02-01");
  assert.equal(result.comparisonStartDate, "2026-02-01");
  close(result.summary.return, 10 / (100 * 27 / 28));
  close(result.summary.benchmarkReturn, 0.1);
  assert.ok(!result.reasons.some((value) => /SPY daily price/.test(value)));
});

test("zero-exposure funding on a month-end does not invalidate a later invested month", () => {
  const now = "2026-03-01";
  const input = book("2026-01-01", [deposit(100), trade("buy", 1, 100)].map((entry) => ({ ...entry, date: "2026-01-31" })), [], now);
  const result = run(input, { now, histories: { "VWCE.DE": history("VWCE.DE", "EUR", "2026-01-31", "2026-02-28", (date) => date === "2026-01-31" ? 100 : 110),
    SPY: history("SPY", "EUR", "2026-01-31", "2026-02-28") } });
  assert.equal(result.months[0].status, "no-exposure");
  close(result.summary.return, 0.1);
});

test("selected periods use the same preceding-close boundary as the benchmark", () => {
  const input = book("2026-01-01", [], [opening()]);
  const prices = history("VWCE.DE", "EUR", undefined, undefined, (date) => date < "2026-01-10" ? 110 : 120);
  const result = run(input, { from: "2026-01-10", to: "2026-01-10", benchmark: "VWCE.DE", histories: { "VWCE.DE": prices } });
  close(result.summary.return, 120 / 110 - 1);
  close(result.summary.benchmarkReturn, 120 / 110 - 1);
  close(result.summary.excessReturn, 0);
  assert.equal(result.summary.selectedPeriodGain, 10);
  assert.equal(result.summary.totalGain, 20);
});

test("cash-only books work, but unsupported manual values and nonpositive capital do not invent returns", () => {
  const cashOnly = run(book("2026-01-01", [openingCash(500)]), { histories: {} });
  assert.equal(cashOnly.summary.currentValue, 500);
  assert.equal(cashOnly.summary.totalGain, 0);
  assert.equal(cashOnly.summary.return, 0);
  const empty = run(book());
  assert.equal(empty.summary.currentValue, 0);
  assert.equal(empty.summary.return, null);
  assert.equal(empty.months[0].status, "no-exposure");
  const manual = run(book("2026-01-01", [], [{ id: "manual", kind: "manual", ticker: "VWCE.DE", label: "VWCE", currency: "EUR", amount: 500, status: "up" }]));
  assert.equal(manual.summary.currentValue, null);
  assert.equal(manual.summary.totalGain, null);
  assert.ok(manual.reasons.some((value) => /Amount-only/.test(value)));
});

test("same-day ledger ordering is preserved and input values are never changed", () => {
  const input = book("2026-01-01", [deposit(1000), trade("buy", 1, 100), trade("sell", 1, 120), trade("buy", 1, 200)]);
  const args = { book: input, histories: { "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 210) }, fxHistory: fx(), now: NEXT };
  const copy = structuredClone(args);
  const result = calculatePortfolioPerformance(args);
  assert.equal(result.holdings[0].costBasis, 200);
  assert.equal(result.holdings[0].realizedGain, 20);
  assert.equal(result.summary.totalGain, 30);
  assert.deepEqual(args, copy);
});

test("today's incomplete bars, generated prices, and numeric overflow are unavailable", () => {
  const input = book("2026-01-01", [], [opening({ shares: 2, averageCost: 1 })]);
  const result = run(input, { histories: { "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 1e308) } });
  assert.equal(result.summary.currentValue, null);
  assert.equal(result.summary.unrealizedGain, null);
  const samples = run(input, { histories: { "VWCE.DE": history("VWCE.DE", "EUR", undefined, undefined, 100, { source: "sample" }) } });
  assert.equal(samples.summary.currentValue, null);
  const todayOnly = run(input, { histories: { "VWCE.DE": history("VWCE.DE", "EUR", "2026-02-01", "2026-02-01") } });
  assert.equal(todayOnly.summary.currentValue, null);
  assert.equal(todayOnly.endDate, "2026-01-31");
});

test("invalid dates or books return reasons without publishing fabricated amounts", () => {
  for (const overrides of [{ now: "bad" }, { from: "2026-02-30" }, { to: "2026-01-00" }, { from: "2026-02-02" }]) {
    const result = run(book(), overrides);
    assert.equal(result.summary.currentValue, null);
    assert.ok(result.reasons.length > 0);
  }
  const missing = calculatePortfolioPerformance({ now: NEXT });
  assert.equal(missing.summary.currentValue, null);
  assert.ok(missing.reasons.length > 0);
});

test("Tallinn midnight does not make an unfinished UTC publisher day available", () => {
  const now = "2026-01-31T22:30:00Z"; // February 1 in Tallinn, still January 31 UTC.
  const input = book("2026-01-01", [], [opening()], now);
  const result = run(input, { now });
  assert.equal(result.endDate, "2026-01-30");
  assert.equal(result.series.at(-1).date, "2026-01-30");
});

test("a last-day funded purchase with fees has no valid end-of-day capital denominator", () => {
  const now = "2026-03-01";
  const input = book("2026-01-01", [deposit(101), trade("buy", 1, 100, { fee: 1 })]
    .map((entry) => ({ ...entry, date: "2026-01-31" })), [], now);
  const result = run(input, { now, histories: { "VWCE.DE": history("VWCE.DE", "EUR", "2026-01-31", "2026-02-28", 110) } });
  assert.equal(result.months[0].return, null);
  assert.equal(result.months[0].status, "unavailable");
  assert.equal(result.summary.return, null);
  assert.ok(result.reasons.some((value) => /positive invested-capital denominator/.test(value)));
});
