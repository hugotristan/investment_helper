import test from "node:test";
import assert from "node:assert/strict";
import { createPortfolioBook, normalizeTransaction, validatePortfolioBook, projectPortfolioBook, portfolioToday } from "../js/analysis/portfolio-ledger.js";

const NOW = "2026-10-09";
const START = "2026-10-01";
const position = (overrides = {}) => ({ id: "original-position", kind: "position", ticker: "AAPL", label: "Apple", shares: 2, averageCost: 100, currency: "USD", ...overrides });
const manual = (overrides = {}) => ({ id: "old-amount", kind: "manual", ticker: "AAPL", label: "Original amount", amount: 800, status: "up", currency: "EUR", ...overrides });
const trade = (overrides = {}) => ({ id: "trade-1", type: "buy", date: START, currency: "USD", ticker: "AAPL", quantity: 1, price: 100, ...overrides });
const cashEntry = (overrides = {}) => ({ id: "cash-1", type: "deposit", date: START, currency: "USD", amount: 1000, ...overrides });
function book(holdings = [], transactions = []) {
  return { ...createPortfolioBook({ holdings, legacyPortfolioInput: "AAPL: 800 EUR \n untouched", baseCurrency: "EUR", startDate: START, now: NOW }), transactions };
}
function validated(input) {
  const result = validatePortfolioBook(input, { now: NOW });
  assert.equal(result.ok, true, result.error);
  return result.book;
}
function invalid(input, pattern) {
  const result = validatePortfolioBook(input, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.book, null);
  if (pattern) assert.match(result.error, pattern);
}

test("portfolio calendar uses Tallinn including midnight and preserves injected calendar days", () => {
  assert.equal(portfolioToday("2026-10-08T22:30:00Z"), "2026-10-09");
  assert.equal(portfolioToday("2026-01-01T22:30:00Z"), "2026-01-02");
  assert.equal(portfolioToday(new Date("2026-07-01T21:30:00Z")), "2026-07-02");
  assert.equal(portfolioToday("2024-02-29"), "2024-02-29");
  assert.throws(() => portfolioToday("2026-02-29"), TypeError);
  assert.throws(() => portfolioToday("not a date"), TypeError);
});

test("migration preserves source, manual amount, original IDs and opening basis without inventing cash or buys", () => {
  const holdings = [position(), manual()];
  const original = structuredClone(holdings);
  const input = book(holdings);
  const projection = projectPortfolioBook(input);
  assert.deepEqual(projection.holdings, holdings);
  assert.deepEqual(projection.cash, []);
  assert.deepEqual(input.transactions, []);
  assert.equal(input.legacyPortfolioInput, "AAPL: 800 EUR \n untouched");
  assert.deepEqual(holdings, original);
  assert.match(projection.warnings[0], /legacy/);
  projection.holdings[0].shares = 55;
  assert.equal(input.openingHoldings[0].shares, 2);
  const missingId = position({ id: null });
  assert.equal(book([missingId]).openingHoldings[0].id, "opening:0");
  assert.equal(missingId.id, null);
});

test("trade normalization derives amount, canonicalizes form values and permits zero price", () => {
  const input = trade({ ticker: " aapl ", currency: " usd ", quantity: "2.5", price: "10", fee: "1.25", amount: 99999 });
  const result = normalizeTransaction(input, { startDate: START, now: NOW });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.transaction, { id: "trade-1", type: "buy", date: START, currency: "USD", ticker: "AAPL", quantity: 2.5, price: 10, amount: 25, fee: 1.25 });
  assert.equal(input.amount, 99999);
  assert.equal(normalizeTransaction(trade({ price: 0 }), { startDate: START, now: NOW }).ok, true);
  assert.equal(validated(book([], [trade({ amount: -5 })])).transactions[0].amount, 100);
});

test("buy fees enter weighted basis; a sale preserves remaining average and cash is explicit", () => {
  const input = validated(book([position()], [
    trade({ id: "buy", quantity: 2, price: 120, fee: 4 }),
    trade({ id: "sell", type: "sell", date: "2026-10-02", quantity: 1, price: 140, fee: 3 })
  ]));
  const projection = projectPortfolioBook(input);
  assert.equal(projection.holdings[0].id, "original-position");
  assert.equal(projection.holdings[0].shares, 3);
  assert.equal(projection.holdings[0].averageCost, 111);
  assert.deepEqual(projection.cash, [{ currency: "USD", amount: -107 }]);
  assert.match(projection.warnings[0], /actual converted cash amounts/);
  assert.deepEqual(projection.reportingCash, { currency: "EUR", amount: null, knownAmount: 0, complete: false, missingTransactionIds: ["buy", "sell"] });
  assert.equal(Object.hasOwn(projection, "return"), false);
});

test("cash entries, dividends and fees stay separated by exact currency", () => {
  const input = validated(book([], [
    cashEntry({ id: "usd-start", type: "opening_cash", amount: 1000 }),
    cashEntry({ id: "eur-deposit", currency: "EUR", amount: 300 }),
    trade({ id: "usd-buy", quantity: 2, price: 100, fee: 2 }),
    trade({ id: "eur-buy", currency: "EUR", price: 50 }),
    cashEntry({ id: "dividend", type: "dividend", ticker: "AAPL", amount: 8 }),
    cashEntry({ id: "withdrawal", type: "withdrawal", amount: 20 }),
    cashEntry({ id: "fee", type: "fee", amount: 3 })
  ]));
  const projection = projectPortfolioBook(input);
  assert.deepEqual(projection.cash, [{ currency: "EUR", amount: 250 }, { currency: "USD", amount: 783 }]);
  assert.equal(projection.holdings.length, 2);
  assert.equal(projection.holdings[0].id, "ledger:AAPL:USD");
  assert.equal(projection.holdings[1].id, "ledger:AAPL:EUR");
  invalid(book([position()], [trade({ type: "sell", currency: "EUR" })]), /more AAPL shares/);
});

test("manual migration holdings do not turn into shares when their ticker is purchased", () => {
  const input = validated(book([manual({ currency: "USD" })], [trade()]));
  const projection = projectPortfolioBook(input);
  assert.equal(projection.holdings.length, 2);
  assert.equal(projection.holdings[0].kind, "position");
  assert.equal(projection.holdings[0].shares, 1);
  assert.deepEqual(projection.holdings[1], manual({ currency: "USD" }));
  invalid(book([manual({ currency: "USD" })], [trade({ type: "sell" })]), /more AAPL shares/);
});

test("chronological ordering is stable on equal days and rejects an oversell after edits or deletion", () => {
  const buy = trade({ id: "buy", date: "2026-10-02", quantity: 3 });
  const sale = trade({ id: "sale", type: "sell", date: "2026-10-03", quantity: 2 });
  assert.equal(projectPortfolioBook(validated(book([], [sale, buy]))).holdings[0].shares, 1);
  invalid(book([], [sale]), /more AAPL shares/);
  invalid(book([], [sale, { ...buy, quantity: 1 }]), /more AAPL shares/);
  invalid(book([], [{ ...sale, date: buy.date }, buy]), /more AAPL shares/);
  assert.equal(validatePortfolioBook(book([], [buy, { ...sale, date: buy.date }]), { now: NOW }).ok, true);
});

test("fully sold positions disappear and later purchases retain the stable opening ID", () => {
  const sale = trade({ id: "sale", type: "sell", quantity: 2 });
  assert.deepEqual(projectPortfolioBook(validated(book([position()], [sale]))).holdings, []);
  const rebuy = trade({ id: "rebuy", date: "2026-10-02", price: 50 });
  const holding = projectPortfolioBook(validated(book([position()], [sale, rebuy]))).holdings[0];
  assert.equal(holding.id, "original-position");
  assert.equal(holding.averageCost, 50);
  assert.equal(holding.shares, 1);
});

test("duplicate lots combine weighted opening basis while the source lots stay untouched", () => {
  const input = book([position(), position({ id: "second-lot", shares: 3, averageCost: 200 })]);
  const before = structuredClone(input);
  const projection = projectPortfolioBook(validated(input));
  assert.equal(projection.holdings[0].shares, 5);
  assert.equal(projection.holdings[0].averageCost, 160);
  assert.equal(projection.holdings[0].id, "original-position");
  assert.deepEqual(input, before);
  invalid(book([manual({ id: "ledger:AAPL:USD" })], [trade()]), /conflicts/);
});

test("opening cash is nonnegative, exactly on the start date and unique per currency", () => {
  assert.deepEqual(projectPortfolioBook(validated(book([], [cashEntry({ type: "opening_cash", amount: 0 })]))).cash, [{ currency: "USD", amount: 0 }]);
  invalid(book([], [cashEntry({ type: "opening_cash", amount: -1 })]), /zero or positive/);
  invalid(book([], [cashEntry({ type: "opening_cash", date: "2026-10-02" })]), /start date/);
  invalid(book([], [cashEntry({ type: "opening_cash" }), cashEntry({ id: "cash-2", type: "opening_cash" })]), /one opening cash/);
});

test("real calendar dates, Tallinn future gates and timestamp chronology reject malformed restores", () => {
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-01", "2026-09-30", "2026-10-10"]) {
    invalid(book([], [trade({ date })]), /date/);
  }
  const futureStart = book(); futureStart.settings.startDate = "2026-10-10";
  invalid(futureStart, /future/);
  const futureTime = book(); futureTime.updatedAt = "2026-10-10T00:00:00Z";
  invalid(futureTime, /future/);
  const wrongOrder = book(); wrongOrder.createdAt = "2026-10-09T01:00:00Z";
  invalid(wrongOrder, /precede/);
  const fakeCalendar = book(); fakeCalendar.createdAt = "2026-02-30T00:00:00Z";
  invalid(fakeCalendar, /invalid/);
  assert.equal(normalizeTransaction(trade({ date: NOW }), { startDate: START, now: "2026-10-08T22:30:00Z" }).ok, true);
});

test("strict restore schema rejects unrelated payload, unsupported currencies, crypto and duplicate IDs", () => {
  for (const mutate of [
    (input) => { input.accountPassword = "secret"; },
    (input) => { input.settings.unrelated = "secret"; },
    (input) => { input.openingHoldings[0].unrelated = "secret"; },
    (input) => { input.transactions[0].unrelated = "secret"; },
    (input) => { input.schemaVersion = 2; },
    (input) => { input.id = "another-account"; },
    (input) => { input.settings.baseCurrency = "NOK"; },
    (input) => { input.transactions[0].currency = "usd"; },
    (input) => { input.transactions[0].ticker = "BTC-USD"; },
    (input) => { input.transactions[0].ticker = "ETH"; },
    (input) => { input.transactions[0].ticker = "^VIX"; },
    (input) => { input.transactions[0].id = input.openingHoldings[0].id; },
    (input) => { input.transactions[0].quantity = "1"; }
  ]) {
    const input = book([position()], [trade()]); mutate(input); invalid(input);
  }
  invalid(book([], [cashEntry({ ticker: "AAPL" })]), /does not apply/);
  assert.throws(() => createPortfolioBook({ holdings: [position({ kind: "other" })], now: NOW }), TypeError);
});

test("numeric validation blocks invalid entries, overflow and excessive collections/text", () => {
  for (const overrides of [{ quantity: 0 }, { quantity: -1 }, { quantity: Infinity }, { price: -1 }, { price: NaN }, { fee: -1 }, { quantity: 1e308, price: 2 }]) invalid(book([], [trade(overrides)]));
  invalid(book([], [cashEntry({ amount: 1e308 }), cashEntry({ id: "cash-2", amount: 1e308 })]), /supported number range/);
  assert.throws(() => book([position({ shares: 1e308, averageCost: 2 })]), /supported number range/);
  invalid(book([], [trade({ note: "x".repeat(501) })]), /500/);
  invalid(book([], [trade({ id: "x".repeat(121) })]), /120/);
  invalid(book([], [cashEntry({ type: "dividend", ticker: "AAPL", amount: 0 })]), /positive/);
  const many = book(); many.transactions = Array.from({ length: 10001 }, (_, index) => cashEntry({ id: `cash-${index}` }));
  invalid(many, /10,000/);
  assert.throws(() => createPortfolioBook({ holdings: Array.from({ length: 501 }, (_, index) => position({ id: `position-${index}` })), now: NOW }), /500/);
  const longSource = book(); longSource.legacyPortfolioInput = "x".repeat(1000001); invalid(longSource, /1,000,000/);
});

test("decimal rounding permits selling the exact accumulated quantity without allowing a short", () => {
  const input = book([], [trade({ id: "a", quantity: 0.1 }), trade({ id: "b", quantity: 0.2 }), trade({ id: "c", type: "sell", quantity: 0.3 })]);
  assert.deepEqual(projectPortfolioBook(validated(input)).holdings, []);
  input.transactions[2].quantity = 0.300001;
  invalid(input, /more AAPL shares/);
});

test("validation and projection do not mutate caller-owned records or depend on current clock", () => {
  const input = book([position()], [trade({ amount: 800 })]);
  const before = structuredClone(input);
  const checked = validated(input);
  assert.equal(checked.transactions[0].amount, 100);
  assert.equal(checked.transactions[0].fee, 0);
  projectPortfolioBook(input);
  assert.deepEqual(input, before);
  checked.settings.baseCurrency = "USD";
  checked.transactions[0].quantity = 10;
  assert.deepEqual(input, before);
  const future = book([position()], [trade({ date: "2040-01-01" })]);
  assert.equal(projectPortfolioBook(future).holdings[0].shares, 3);
  invalid(future, /future/);
});

test("revision timestamps allow one second of monotonic clock skew without weakening future date gates", () => {
  const now = "2026-10-09T09:00:00.000Z";
  const input = createPortfolioBook({ startDate: START, now });
  input.updatedAt = "2026-10-09T09:00:00.001Z";
  assert.equal(validatePortfolioBook(input, { now }).ok, true);
  input.updatedAt = "2026-10-09T09:00:01.000Z";
  assert.equal(validatePortfolioBook(input, { now }).ok, true);
  input.updatedAt = "2026-10-09T09:00:01.001Z";
  assert.equal(validatePortfolioBook(input, { now }).ok, false);
  input.updatedAt = now;
  input.transactions = [trade({ date: "2026-10-10" })];
  assert.equal(validatePortfolioBook(input, { now }).ok, false);
});

test("reporting cash follows actual settlement while native positions keep their own currencies and basis", () => {
  const input = validated(book([], [
    cashEntry({ id: "eur-deposit", currency: "EUR", amount: 10000 }),
    trade({ id: "eur-buy", currency: "EUR", quantity: 50, price: 100, cashCurrency: "EUR", cashAmount: 5000 }),
    trade({ id: "usd-buy", quantity: 10, price: 200, cashCurrency: "EUR", cashAmount: 1800 })
  ]));
  const projection = projectPortfolioBook(input);
  assert.deepEqual(projection.cash, [{ currency: "EUR", amount: 3200 }]);
  assert.deepEqual(projection.reportingCash, { currency: "EUR", amount: 3200, knownAmount: 3200, complete: true, missingTransactionIds: [] });
  assert.deepEqual(projection.holdings.map(({ currency, shares, averageCost }) => ({ currency, shares, averageCost })), [
    { currency: "EUR", shares: 50, averageCost: 100 }, { currency: "USD", shares: 10, averageCost: 200 }
  ]);
  assert.deepEqual(projection.warnings, []);
  assert.equal(input.transactions[2].amount, 2000);
  assert.equal(input.transactions[2].cashAmount, 1800);
});

test("settled totals govern every cashflow direction without counting fees twice", () => {
  const input = validated(book([], [
    cashEntry({ id: "opening", type: "opening_cash", amount: 80, cashCurrency: "EUR", cashAmount: 70 }),
    cashEntry({ id: "deposit", currency: "GBP", amount: 100, cashCurrency: "EUR", cashAmount: 115 }),
    trade({ id: "buy", quantity: 2, price: 100, fee: 2, cashCurrency: "EUR", cashAmount: 180 }),
    trade({ id: "sale", type: "sell", quantity: 1, price: 150, fee: 3, cashCurrency: "EUR", cashAmount: 130 }),
    cashEntry({ id: "dividend", type: "dividend", ticker: "AAPL", amount: 12, cashCurrency: "EUR", cashAmount: 10 }),
    cashEntry({ id: "withdrawal", type: "withdrawal", amount: 25, cashCurrency: "EUR", cashAmount: 22 }),
    cashEntry({ id: "fee", type: "fee", amount: 5, cashCurrency: "EUR", cashAmount: 4 })
  ]));
  const projection = projectPortfolioBook(input);
  assert.deepEqual(projection.cash, [{ currency: "EUR", amount: 119 }]);
  assert.equal(projection.reportingCash.amount, 119);
  assert.equal(projection.reportingCash.complete, true);
  assert.equal(projection.holdings[0].shares, 1);
  assert.equal(projection.holdings[0].averageCost, 101);
  const native = projectPortfolioBook(validated(book([], [trade({ currency: "EUR", fee: 7, cashCurrency: "EUR", cashAmount: 107 })])));
  assert.equal(native.reportingCash.amount, -107);
  assert.equal(native.holdings[0].averageCost, 107);
  assert.match(native.warnings[0], /EUR cash is negative/);
});

test("zero-price trades and zero settled proceeds/opening cash are valid finite cash movements", () => {
  const projection = projectPortfolioBook(validated(book([], [
    cashEntry({ id: "zero-opening", type: "opening_cash", amount: 0, cashCurrency: "EUR", cashAmount: 0 }),
    trade({ id: "free-buy", price: 0, cashCurrency: "EUR", cashAmount: 0 }),
    trade({ id: "zero-sale", type: "sell", price: 0, cashCurrency: "EUR", cashAmount: 0 })
  ])));
  assert.deepEqual(projection.cash, [{ currency: "EUR", amount: 0 }]);
  assert.deepEqual(projection.reportingCash, { currency: "EUR", amount: 0, knownAmount: 0, complete: true, missingTransactionIds: [] });
  assert.deepEqual(projection.holdings, []);
  const feeOnly = projectPortfolioBook(validated(book([], [trade({ price: 0, quantity: 2, fee: 10, cashCurrency: "EUR", cashAmount: 9 })])));
  assert.equal(feeOnly.reportingCash.amount, -9);
  assert.equal(feeOnly.holdings[0].averageCost, 5);
});

test("legacy foreign cash flows remain readable but cannot claim a reporting balance or negative foreign funding", () => {
  const input = book([], [cashEntry({ currency: "EUR" }), trade({ id: "legacy-usd-buy", quantity: 5, fee: 2 })]);
  const original = structuredClone(input);
  const checked = validated(JSON.parse(JSON.stringify(input)));
  const projection = projectPortfolioBook(checked);
  assert.deepEqual(projection.cash, [{ currency: "EUR", amount: 1000 }, { currency: "USD", amount: -502 }]);
  assert.deepEqual(projection.reportingCash, { currency: "EUR", amount: null, knownAmount: 1000, complete: false, missingTransactionIds: ["legacy-usd-buy"] });
  assert.match(projection.warnings.join(" "), /actual converted cash amounts/);
  assert.doesNotMatch(projection.warnings.join(" "), /USD cash is negative/);
  assert.equal(Object.hasOwn(checked.transactions[1], "cashAmount"), false);
  assert.deepEqual(input, original);
  const empty = projectPortfolioBook(book([position()]));
  assert.deepEqual(empty.reportingCash, { currency: "EUR", amount: 0, knownAmount: 0, complete: true, missingTransactionIds: [] });
});

test("offsetting legacy native amounts still need the actual dated conversions", () => {
  const projection = projectPortfolioBook(validated(book([], [
    trade({ id: "old-buy", date: "2026-10-02" }),
    trade({ id: "old-sale", type: "sell", date: "2026-10-03" })
  ])));
  assert.deepEqual(projection.cash, [{ currency: "USD", amount: 0 }]);
  assert.equal(projection.reportingCash.complete, false);
  assert.equal(projection.reportingCash.amount, null);
  assert.deepEqual(projection.reportingCash.missingTransactionIds, ["old-buy", "old-sale"]);
  const partial = projectPortfolioBook(validated(book([position()], [
    trade({ id: "eur-buy", currency: "EUR" }),
    trade({ id: "legacy-usd-sale", type: "sell" })
  ])));
  assert.equal(partial.reportingCash.knownAmount, -100);
  assert.equal(partial.reportingCash.amount, null);
  assert.doesNotMatch(partial.warnings.join(" "), /cash is negative/);
});

test("settlement normalization requires a complete finite pair and the configured reporting currency", () => {
  const normalized = normalizeTransaction(trade({ cashCurrency: " eur ", cashAmount: "180.50" }), { startDate: START, now: NOW, baseCurrency: "EUR" });
  assert.equal(normalized.ok, true, normalized.error);
  assert.equal(normalized.transaction.cashCurrency, "EUR");
  assert.equal(normalized.transaction.cashAmount, 180.5);
  for (const overrides of [
    { cashCurrency: "EUR" }, { cashAmount: 100 }, { cashCurrency: "EUR", cashAmount: undefined },
    { cashCurrency: "EUR", cashAmount: null }, { cashCurrency: "NOK", cashAmount: 100 },
    { cashCurrency: "EUR", cashAmount: -1 }, { cashCurrency: "EUR", cashAmount: Infinity },
    { cashCurrency: "EUR", cashAmount: NaN }, { cashCurrency: "USD", cashAmount: 100 }
  ]) {
    assert.equal(normalizeTransaction(trade(overrides), { startDate: START, now: NOW, baseCurrency: "EUR" }).ok, false);
    invalid(book([], [trade(overrides)]));
  }
  invalid(book([], [trade({ cashCurrency: "eur", cashAmount: 100 })]), /supported currency/);
  invalid(book([], [trade({ cashCurrency: "EUR", cashAmount: "100" })]), /finite/);
  const overflow = book([], [
    cashEntry({ id: "first", cashCurrency: "EUR", cashAmount: 1e308 }),
    cashEntry({ id: "second", cashCurrency: "EUR", cashAmount: 1e308 })
  ]);
  invalid(overflow, /supported number range/);
});

test("editing settlement or deleting entries rebuilds cash without altering native share basis", () => {
  const input = book([], [
    cashEntry({ currency: "EUR" }),
    trade({ id: "purchase", quantity: 2, price: 250, cashCurrency: "EUR", cashAmount: 450 })
  ]);
  assert.equal(projectPortfolioBook(validated(input)).reportingCash.amount, 550);
  const edited = structuredClone(input); edited.transactions[1].cashAmount = 400;
  const projection = projectPortfolioBook(validated(edited));
  assert.equal(projection.reportingCash.amount, 600);
  assert.equal(projection.holdings[0].averageCost, 250);
  const deletedPurchase = structuredClone(input); deletedPurchase.transactions.pop();
  assert.equal(projectPortfolioBook(validated(deletedPurchase)).reportingCash.amount, 1000);
  assert.deepEqual(projectPortfolioBook(deletedPurchase).holdings, []);
  const deletedFunding = structuredClone(input); deletedFunding.transactions.shift();
  assert.equal(projectPortfolioBook(validated(deletedFunding)).reportingCash.amount, -450);
  assert.match(projectPortfolioBook(deletedFunding).warnings[0], /EUR cash is negative/);
  const missingSettlement = structuredClone(input);
  delete missingSettlement.transactions[1].cashCurrency; delete missingSettlement.transactions[1].cashAmount;
  assert.equal(projectPortfolioBook(validated(missingSettlement)).reportingCash.complete, false);
  assert.equal(input.transactions[1].cashAmount, 450);
});

test("reporting-currency changes cannot silently reinterpret stored settlement amounts", () => {
  const input = validated(book([], [trade({ cashCurrency: "EUR", cashAmount: 90 })]));
  const roundTrip = validated(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(roundTrip.transactions, input.transactions);
  const changed = structuredClone(input); changed.settings.baseCurrency = "USD";
  invalid(changed, /reporting currency/);
  const legacy = book([], [trade()]); legacy.settings.baseCurrency = "USD";
  const projection = projectPortfolioBook(validated(legacy));
  assert.equal(projection.reportingCash.amount, -100);
  assert.equal(projection.reportingCash.complete, true);
  assert.equal(normalizeTransaction(trade({ cashCurrency: "EUR", cashAmount: 90 }), { startDate: START, now: NOW }).ok, true);
});

test("settled sales reject a native net debit while unpaired legacy sales remain readable", () => {
  const debitSale = trade({ type: "sell", price: 10, fee: 20 });
  const old = projectPortfolioBook(validated(book([position()], [debitSale])));
  assert.deepEqual(old.cash, [{ currency: "USD", amount: -10 }]);
  assert.equal(old.holdings[0].shares, 1);
  for (const cashAmount of [0, 20]) {
    const settled = { ...debitSale, cashCurrency: "EUR", cashAmount };
    invalid(book([position()], [settled]), /fees above gross proceeds/);
    const normalized = normalizeTransaction(settled, { startDate: START, now: NOW, baseCurrency: "EUR" });
    assert.equal(normalized.ok, false);
    assert.match(normalized.error, /fees above gross proceeds/);
  }
  const feeEqualsProceeds = projectPortfolioBook(validated(book([position()], [
    trade({ type: "sell", price: 10, fee: 10, cashCurrency: "EUR", cashAmount: 0 })
  ])));
  assert.equal(feeEqualsProceeds.reportingCash.amount, 0);
  assert.equal(feeEqualsProceeds.holdings[0].shares, 1);
});

test("opening cash is unique by actual settled currency while separate legacy native openings remain readable", () => {
  const eurOpening = cashEntry({ id: "eur-opening", type: "opening_cash", currency: "EUR", amount: 100 });
  const usdOpening = cashEntry({ id: "usd-opening", type: "opening_cash", currency: "USD", amount: 100 });
  invalid(book([], [eurOpening, { ...usdOpening, cashCurrency: "EUR", cashAmount: 90 }]), /one opening cash entry/);
  invalid(book([], [
    { ...usdOpening, cashCurrency: "EUR", cashAmount: 90 },
    cashEntry({ id: "gbp-opening", type: "opening_cash", currency: "GBP", amount: 100, cashCurrency: "EUR", cashAmount: 115 })
  ]), /one opening cash entry/);
  const legacy = projectPortfolioBook(validated(book([], [eurOpening, usdOpening])));
  assert.deepEqual(legacy.cash, [{ currency: "EUR", amount: 100 }, { currency: "USD", amount: 100 }]);
  assert.deepEqual(legacy.reportingCash, { currency: "EUR", amount: null, knownAmount: 100, complete: false, missingTransactionIds: ["usd-opening"] });
  const settled = projectPortfolioBook(validated(book([], [{ ...usdOpening, cashCurrency: "EUR", cashAmount: 90 }])));
  assert.deepEqual(settled.cash, [{ currency: "EUR", amount: 90 }]);
  assert.equal(settled.reportingCash.amount, 90);
});
