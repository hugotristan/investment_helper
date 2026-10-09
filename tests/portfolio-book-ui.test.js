import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createPortfolioBook, projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { serializePortfolioBackup } from "../js/data/portfolio-book-store.js";

const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", innerHTML: "", hidden: false, disabled: false,
    open: false, dataset: {}, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; }, setAttribute() {}, focus() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, reset() {
      if (id === "transactionForm") {
        for (const field of ["Id", "Ticker", "Quantity", "Price", "Amount", "Note"]) node(`transaction${field}`).value = "";
        node("transactionType").value = "buy";
        node("transactionFee").value = "0";
      }
    } });
  return nodes.get(id);
}
const documentClicks = [];
const doc = { getElementById: node, addEventListener(type, callback) { if (type === "click") documentClicks.push(callback); }, querySelectorAll: () => [] };
globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { setTimeout, clearTimeout };
const { createPortfolioBookController } = await import("../js/features/portfolio-book.js");
const { setActivePortfolioBook } = await import("../js/portfolio-state.js");
const { getPortfolioHoldings } = await import("../js/features/portfolio.js");
const { bindPortfolioEvents, configurePortfolioEditor } = await import("../js/features/portfolio-editor.js");
const { state } = await import("../js/storage.js");
const timestamp = Date.parse("2026-10-09T10:00:00Z");
const holding = { id: "opening-aapl", kind: "position", ticker: "AAPL", label: "Apple", shares: 10, averageCost: 100, currency: "USD" };
function book() { return createPortfolioBook({ holdings: [holding], baseCurrency: "EUR", startDate: "2026-10-01", now: timestamp }); }

beforeEach(() => {
  nodes.clear();
  documentClicks.length = 0;
  setActivePortfolioBook(null);
  configurePortfolioEditor(null);
  state.holdings = [{ ...holding }];
  state.myPortfolioInput = "AAPL | Apple | 1000 | up";
  node("portfolioSetupCurrency").value = "EUR";
  node("portfolioSetupDate").value = "2026-10-01";
});

function fixture(initial = null, options = {}) {
  let stored = initial;
  let writes = 0;
  let changes = 0;
  let ids = 0;
  let checked = [];
  let exported = null;
  const store = { async read() { if (options.readError) throw options.readError; return stored; },
    async write(value, { expectedUpdatedAt }) {
      if (options.write) await options.write(value);
      if (options.writeError) throw options.writeError;
      if ((stored?.updatedAt ?? null) !== expectedUpdatedAt) { const error = new Error("Portfolio changed in another tab."); error.code = "CONFLICT"; throw error; }
      stored = structuredClone(value);
      writes++;
      return stored;
    } };
  const controller = createPortfolioBookController({ store, document: doc, now: () => timestamp, uuid: () => `tx-${++ids}`,
    validateTicker: async (ticker) => { checked.push(ticker); return options.validity || "valid"; }, subscribe: false,
    onChange: () => { changes++; }, download: (serialized) => { exported = serialized; } });
  return { controller, store, get stored() { return stored; }, set stored(value) { stored = value; },
    get writes() { return writes; }, get changes() { return changes; }, get checked() { return checked; }, get exported() { return exported; } };
}

function fill(controller, values) {
  controller.openTransactionEditor(values.id || null);
  for (const [key, value] of Object.entries({ type: "buy", date: "2026-10-09", ticker: "AAPL", currency: "USD", quantity: "2", price: "150", fee: "1", ...values })) {
    node(`transaction${key[0].toUpperCase()}${key.slice(1)}`).value = value;
  }
}

test("setup preserves current holdings and legacy source without changing localStorage snapshot", async () => {
  const f = fixture();
  const previous = structuredClone(state.holdings);
  await f.controller.initialize();
  assert.equal(node("portfolioSetup").hidden, false);
  await f.controller.setup();
  assert.equal(f.writes, 1);
  assert.deepEqual(f.stored.openingHoldings, previous);
  assert.deepEqual(state.holdings, previous);
  assert.equal(f.stored.legacyPortfolioInput, state.myPortfolioInput);
  assert.equal(f.stored.settings.baseCurrency, "EUR");
  assert.equal(node("portfolioSetup").hidden, true);
  assert.equal(node("openHoldingEditor").textContent, "Record transaction");
});

test("storage read failure never offers setup to overwrite an unreadable portfolio", async () => {
  const f = fixture(null, { readError: new Error("Storage blocked") });
  assert.equal(await f.controller.initialize(), false);
  assert.equal(node("portfolioSetup").hidden, true);
  assert.match(node("portfolioBookStatus").textContent, /Storage blocked/);
  await f.controller.setup();
  assert.equal(f.writes, 0);
  assert.deepEqual(getPortfolioHoldings(), state.holdings);
});

test("trades update ledger holdings only after the storage commit", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const f = fixture(book(), { write: () => wait });
  await f.controller.initialize();
  fill(f.controller, {});
  const pending = f.controller.saveTransaction();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getPortfolioHoldings()[0].shares, 10);
  assert.equal(f.controller.book.transactions.length, 0);
  release();
  assert.equal(await pending, true);
  assert.equal(getPortfolioHoldings()[0].shares, 12);
  assert.equal(getPortfolioHoldings()[0].averageCost, 1301 / 12);
  assert.deepEqual(projectPortfolioBook(f.stored).cash, [{ currency: "USD", amount: -301 }]);
  assert.match(node("portfolioCashSummary").innerHTML, /negative/);
});

test("a failed save preserves holdings, original book, and typed transaction", async () => {
  const f = fixture(book(), { writeError: new Error("Storage full") });
  await f.controller.initialize();
  fill(f.controller, {});
  assert.equal(await f.controller.saveTransaction(), false);
  assert.equal(getPortfolioHoldings()[0].shares, 10);
  assert.equal(f.controller.book.transactions.length, 0);
  assert.equal(node("transactionQuantity").value, "2");
  assert.match(node("transactionMessage").textContent, /Storage full/);
  assert.equal(f.changes, 0);
});

test("new tickers need stock/ETF validation; nonsense cannot be persisted", async () => {
  const f = fixture(book(), { validity: "invalid" });
  await f.controller.initialize();
  fill(f.controller, { ticker: "XXXXXXXXXX" });
  assert.equal(await f.controller.saveTransaction(), false);
  assert.deepEqual(f.checked, ["XXXXXXXXXX"]);
  assert.equal(f.writes, 0);
  assert.match(node("transactionMessage").textContent, /Ticker not found/);
});

test("cash and dividend forms ignore stale hidden trade fields", async () => {
  const f = fixture(book());
  await f.controller.initialize();
  fill(f.controller, { type: "deposit", amount: "1000" });
  assert.equal(await f.controller.saveTransaction(), true);
  assert.deepEqual(f.stored.transactions[0], { id: "tx-1", type: "deposit", date: "2026-10-09", currency: "USD", note: "", amount: 1000 });
  fill(f.controller, { type: "dividend", amount: "10" });
  assert.equal(await f.controller.saveTransaction(), true);
  assert.equal(f.stored.transactions[1].ticker, "AAPL");
  assert.deepEqual(projectPortfolioBook(f.stored).cash, [{ currency: "USD", amount: 1010 }]);
});

test("overselling and deleting a purchase required by a later sale fail atomically", async () => {
  const f = fixture(book());
  await f.controller.initialize();
  fill(f.controller, { type: "sell", quantity: "11" });
  assert.equal(await f.controller.saveTransaction(), false);
  assert.equal(f.writes, 0);
  fill(f.controller, { quantity: "2" });
  assert.equal(await f.controller.saveTransaction(), true);
  fill(f.controller, { type: "sell", quantity: "12" });
  assert.equal(await f.controller.saveTransaction(), true);
  assert.equal(getPortfolioHoldings().length, 0);
  await f.controller.removeTransaction("tx-2");
  assert.equal(f.stored.transactions.length, 2); // confirmation first
  assert.equal(await f.controller.removeTransaction("tx-2"), false);
  assert.equal(f.stored.transactions.length, 2);
  assert.match(node("transactionMessage").textContent, /Cannot sell more/);
});

test("opening-position corrections must support every recorded sale", async () => {
  const f = fixture(book());
  await f.controller.initialize();
  fill(f.controller, { type: "sell", quantity: "8" });
  await f.controller.saveTransaction();
  const revision = f.controller.book.updatedAt;
  await assert.rejects(f.controller.writeOpeningHoldings([{ ...holding, shares: 5 }], revision), /Cannot sell more/);
  assert.equal(f.stored.openingHoldings[0].shares, 10);
  await f.controller.writeOpeningHoldings([{ ...holding, shares: 12 }], revision);
  assert.equal(getPortfolioHoldings()[0].shares, 4);
});

test("editing replaces a transaction and does not append a duplicate", async () => {
  const f = fixture(book());
  await f.controller.initialize();
  fill(f.controller, {});
  await f.controller.saveTransaction();
  fill(f.controller, { id: "tx-1", quantity: "3" });
  assert.equal(await f.controller.saveTransaction(), true);
  assert.equal(f.stored.transactions.length, 1);
  assert.equal(getPortfolioHoldings()[0].shares, 13);
});

test("restore requires a valid preview and explicit action, including a fresh browser", async () => {
  const f = fixture();
  await f.controller.initialize();
  const serialized = serializePortfolioBackup(book(), { now: timestamp });
  await f.controller.importBackup({ size: serialized.length, text: async () => serialized });
  assert.equal(f.writes, 0);
  assert.equal(node("portfolioRestore").hidden, false);
  assert.match(node("portfolioBackupPreview").textContent, /1 opening positions/);
  await f.controller.restoreBackup();
  assert.equal(f.writes, 1);
  assert.equal(f.controller.book.openingHoldings.length, 1);
  assert.equal(node("portfolioRestore").hidden, true);
  assert.equal(f.stored.updatedAt, "2026-10-09T10:00:00.001Z");
});

test("invalid and oversized backup files cannot replace saved data", async () => {
  const f = fixture(book());
  await f.controller.initialize();
  await f.controller.importBackup({ size: 8, text: async () => "invalid" });
  assert.equal(f.controller.pendingBackup, null);
  assert.equal(node("portfolioRestore").hidden, true);
  assert.equal(await f.controller.restoreBackup(), false);
  let read = false;
  await f.controller.importBackup({ size: 6 * 1024 * 1024, text: async () => { read = true; return ""; } });
  assert.equal(read, false);
  assert.equal(f.writes, 0);
});

test("a change after a restore preview blocks replacement and requires another preview", async () => {
  const f = fixture(book());
  await f.controller.initialize();
  const serialized = serializePortfolioBackup(book(), { now: timestamp });
  await f.controller.importBackup({ size: serialized.length, text: async () => serialized });
  fill(f.controller, { type: "deposit", amount: "100" });
  await f.controller.saveTransaction();
  assert.equal(await f.controller.restoreBackup(), false);
  assert.equal(f.stored.transactions.length, 1);
  assert.match(node("portfolioBackupPreview").textContent, /changed after/);
});

test("export contains only portfolio data and reads the latest committed version", async () => {
  const f = fixture(book());
  await f.controller.initialize();
  state.tickerInput = "PRIVATE-WATCHLIST";
  state.learningHistory = [{ private: "news" }];
  await f.controller.exportBackup();
  const exported = JSON.parse(f.exported);
  assert.equal(exported.app, "investment-helper");
  assert.equal(exported.portfolio.openingHoldings[0].ticker, "AAPL");
  assert(!f.exported.includes("PRIVATE-WATCHLIST"));
  assert(!f.exported.includes("learningHistory"));
});

test("a stale tab cannot overwrite a newer revision or reuse its old form", async () => {
  const f = fixture(book());
  await f.controller.initialize();
  fill(f.controller, {});
  f.stored = { ...f.stored, updatedAt: "2026-10-09T10:00:00.100Z" };
  assert.equal(await f.controller.saveTransaction(), false);
  assert.equal(f.writes, 0);
  assert.match(node("portfolioBookStatus").textContent, /Another tab/);
  await f.controller.refreshFromStorage();
  assert.equal(node("transactionQuantity").value, "2");
  assert.equal(await f.controller.saveTransaction(), false);
  assert.match(node("transactionMessage").textContent, /Cancel and reopen/);
});

test("reporting currency stays editable but start date is fixed after transactions", async () => {
  const f = fixture(book());
  await f.controller.initialize();
  fill(f.controller, { type: "deposit", amount: "100" });
  await f.controller.saveTransaction();
  node("portfolioStartDate").value = "2026-10-02";
  assert.equal(await f.controller.saveSettings(), false);
  assert.equal(f.stored.settings.startDate, "2026-10-01");
  node("portfolioStartDate").value = "2026-10-01";
  node("portfolioBaseCurrency").value = "USD";
  assert.equal(await f.controller.saveSettings(), true);
  assert.equal(f.stored.settings.baseCurrency, "USD");
  assert.equal(f.stored.transactions[0].currency, "USD");
});

test("the existing holding editor saves opening positions after a transaction, with removal and Undo", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ chart: { result: [{ meta: { symbol: "MSFT", instrumentType: "EQUITY", regularMarketPrice: 400 } }] } });
  const f = fixture(book());
  await f.controller.initialize();
  bindPortfolioEvents(() => {});
  fill(f.controller, { type: "deposit", amount: "100" });
  await f.controller.saveTransaction();
  for (const [field, value] of [["Ticker", "MSFT"], ["Label", "Microsoft"], ["Shares", "3"], ["Cost", "200"], ["Currency", "USD"]]) node(`holding${field}`).value = value;
  await node("holdingForm").listeners.submit({ preventDefault() {} });
  assert.equal(f.stored.openingHoldings.length, 2);
  assert.equal(getPortfolioHoldings().find((h) => h.ticker === "MSFT").shares, 3);
  assert.equal(state.holdings.length, 1);
  const added = f.stored.openingHoldings.find((h) => h.ticker === "MSFT");
  const click = async (dataset) => {
    const button = { dataset };
    for (const callback of documentClicks) callback({ target: { closest: (selector) => selector.includes("data-remove-holding") ? button : null } });
    await new Promise((resolve) => setImmediate(resolve));
  };
  await click({ removeHolding: added.id });
  assert.equal(f.stored.openingHoldings.length, 1);
  await click({ undoHolding: "" });
  assert.equal(f.stored.openingHoldings.length, 2);
  assert.equal(f.stored.openingHoldings.find((h) => h.ticker === "MSFT").id, added.id);
});
