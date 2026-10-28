import test from "node:test";
import assert from "node:assert/strict";
import { createDividendReportController } from "../js/features/report-dividends.js";
import { createPortfolioBook, projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { EXCHANGE_RATE_SOURCE, EXCHANGE_RATE_SOURCE_URL } from "../js/data/exchange-rate.js";
const NOW = Date.parse("2026-10-11T12:00:00Z");
const rate = { schemaVersion: 1, base: "USD", quote: "EUR", rate: 0.9, date: "2026-10-09", retrievedAt: new Date(NOW).toISOString(), source: EXCHANGE_RATE_SOURCE, sourceUrl: EXCHANGE_RATE_SOURCE_URL };

function fixture(extra = {}) {
  let book = createPortfolioBook({ now: NOW, holdings: [{ kind: "position", ticker: "MSFT", currency: "USD", shares: 2, averageCost: 100 }] });
  const nodes = new Map(), exports = [], writes = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, { value: "", innerHTML: "", textContent: "", hidden: false, disabled: false, handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; }, querySelectorAll: () => [...nodes.values()] }); return nodes.get(id); };
  const doc = { documentElement: { dataset: { privateBlocked: "false" } }, getElementById: node };
  const controller = createDividendReportController({ document: doc, window: null, session: null, readBook: () => book,
    readRate: () => rate, loadRate: async () => rate, loadFx: async () => null, now: () => NOW,
    save: async (assumptions, revision) => { assert.equal(revision, book.updatedAt); writes.push(assumptions); book = { ...book, dividendAssumptions: assumptions, updatedAt: new Date(Date.parse(book.updatedAt) + 1).toISOString() }; return true; },
    download: (...args) => exports.push(args), ...extra });
  controller.initialize();
  const fill = () => { node("reportDividendAmount").value = "0,75"; node("reportDividendDate").value = "2026-10-31"; node("reportDividendForm").handlers.input(); };
  return { controller, node, doc, exports, writes, fill, get book() { return book; }, set book(value) { book = value; } };
}

test("forecast editing saves only assumptions, exports all events and rejects stale drafts", async () => {
  const f = fixture(), before = projectPortfolioBook(f.book);
  f.fill(); assert.equal(await f.controller.persist(), true);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(projectPortfolioBook(f.book), before);
  assert.equal(f.controller.current.rows.length, 4);
  assert.match(f.node("reportDividendBody").innerHTML, /€5.40/);
  assert.doesNotMatch(f.node("reportDividendBody").innerHTML, /EUR unavailable/);
  f.node("reportDividendExport").handlers.click(); assert.equal(f.exports[0][2].length, 4);
  f.fill(); f.book = { ...f.book, updatedAt: new Date(NOW + 2).toISOString() }; f.controller.render();
  assert.equal(await f.controller.persist(), false); assert.equal(f.writes.length, 1);
  assert.match(f.node("reportDividendStatus").textContent, /changed/);
  f.node("reportDividendReload").handlers.click();
  assert.equal(await f.controller.persist(true), true); assert.deepEqual(f.book.dividendAssumptions, []);
});

test("locking clears private forecasts and drafts; a late FX reply cannot restore or export them", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ loadRate: () => pending }); f.fill();
  assert.equal(await f.controller.persist(), true);
  f.doc.documentElement.dataset.privateBlocked = "true"; f.controller.render();
  finish(rate); await pending; await Promise.resolve();
  assert.equal(f.controller.current, null);
  assert.equal(f.node("reportDividendExport").disabled, true);
  assert.equal(f.node("reportDividendEditor").hidden, true);
  assert.equal(f.node("reportDividendPosition").innerHTML, "");
  assert.equal(f.node("reportDividendAmount").value, "");
  assert.doesNotMatch(f.node("reportDividendBody").innerHTML, /MSFT|5.40/);
  f.node("reportDividendExport").handlers.click(); assert.equal(f.exports.length, 0);
});

test("editing a recurring amount keeps the original month-end payment anchor", async () => {
  const f = fixture({ now: () => Date.parse("2027-02-10T12:00:00Z") });
  f.book = { ...f.book, dividendAssumptions: [{ ticker: "MSFT", currency: "USD", amountPerShare: 0.75,
    firstPaymentDate: "2026-01-31", frequency: "monthly" }] };
  f.controller.render({ force: true });
  assert.equal(f.node("reportDividendDate").value, "2027-02-28");
  f.node("reportDividendAmount").value = "1";
  assert.equal(await f.controller.persist(), true);
  assert.equal(f.book.dividendAssumptions[0].firstPaymentDate, "2026-01-31");
  assert.deepEqual(f.controller.current.rows.slice(0, 3).map(row => row.date), ["2027-02-28", "2027-03-31", "2027-04-30"]);
  // A quantity-free opening position still lets its old assumption be removed.
  f.book = { ...f.book, openingHoldings: [{ id: "opening:0", label: "MSFT", kind: "manual", ticker: "MSFT", currency: "USD", amount: 100, status: "unknown" }] };
  f.controller.render({ force: true });
  assert.equal(f.node("reportDividendSave").disabled, true);
  assert.equal(f.node("reportDividendRemove").disabled, false);
  assert.equal(await f.controller.persist(true), true);
  assert.deepEqual(f.book.dividendAssumptions, []);
});
