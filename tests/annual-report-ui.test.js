import test from "node:test";
import assert from "node:assert/strict";
import { createAnnualReportController } from "../js/features/report-annual.js";
import { createPortfolioBook } from "../js/analysis/portfolio-ledger.js";
const NOW = Date.parse("2026-02-01T12:00:00Z");
function fixture() {
  let book = createPortfolioBook({ now: NOW, startDate: "2025-01-01", holdings: [] });
  book.transactions = [{ id: "open", type: "opening_cash", date: "2025-01-01", currency: "EUR", amount: 100 },
    { id: "deposit", type: "deposit", date: "2026-01-10", currency: "EUR", amount: 50 }];
  const nodes = new Map(), exports = [], win = { location: { hash: "#report-annual" }, addEventListener() {} };
  const node = id => { const key = `reportAnnual${id}`; if (!nodes.has(key)) nodes.set(key, { value: "", innerHTML: "", disabled: false, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } }); return nodes.get(key); };
  const doc = { documentElement: { dataset: { privateBlocked: "false" } }, getElementById: id => node(id.replace("reportAnnual", "")) };
  const controller = createAnnualReportController({ document: doc, window: win, session: null, readBook: () => book,
    subscribe: () => () => {}, now: () => NOW, download: (...args) => exports.push(args) });
  controller.initialize();
  const load = () => controller.acceptInputs({ startDate: "2026-01-20", endDate: "2026-01-21" }, { book, histories: {}, fxHistory: null });
  return { controller, node, doc, win, load, exports, get book() { return book; }, set book(value) { book = value; } };
}

test("year selection ignores performance-page filters and exports scoped summary plus every month without writes", () => {
  const f = fixture(), before = structuredClone(f.book);
  assert.equal(f.controller.current.historyReady, false); assert.match(f.node("Body").innerHTML, /Loading price/);
  f.load(); assert.equal(f.controller.current.year, 2026); assert.equal(f.controller.current.from, "2026-01-01");
  assert.equal(f.controller.current.closingValue, 150); assert.match(f.node("Body").innerHTML, /Year to date/);
  f.node("Export").handlers.click(); assert.equal(f.exports[0][0], "annual-summary-2026.csv");
  assert.equal(f.exports[0][2].length, 2); assert.equal(f.exports[0][2][0][0], "Summary");
  assert.equal(f.exports[0][2][0][8], 50); assert.equal(f.exports[0][2][1][5], "2026-01");
  f.node("Year").value = "2025"; f.node("Year").handlers.change();
  assert.equal(f.controller.current.completeYear, true); assert.equal(f.controller.current.closingValue, 100);
  f.node("Export").handlers.click(); assert.equal(f.exports[1][2].length, 13);
  assert.equal(f.exports[1][2][0][11], 100); assert.equal(f.exports[1][2][0][8], 0);
  assert.deepEqual(f.book, before);
  f.win.location.hash = "#portfolio"; f.controller.render(); assert.equal(f.controller.current, null);
  f.win.location.hash = "#report-annual"; f.controller.render(); assert.equal(f.controller.current.year, 2025);
});

test("history failures, stale replies and locking preserve activity and clear private reports/export", () => {
  const f = fixture();
  f.controller.acceptInputs({ reasons: ["History request failed"] }, null);
  assert.doesNotMatch(f.node("Body").innerHTML, /Loading price/);
  assert.match(f.node("Body").innerHTML, /could not be loaded/); assert.equal(f.controller.current.deposits, 50);
  f.load(); const old = f.book;
  f.book = { ...f.book, updatedAt: new Date(NOW + 1).toISOString() };
  f.controller.acceptInputs({}, { book: old, histories: {}, fxHistory: null });
  assert.equal(f.controller.current.historyReady, false); assert.equal(f.controller.current.closingValue, null);
  f.load(); f.doc.documentElement.dataset.privateBlocked = "true"; f.controller.render();
  assert.equal(f.controller.current, null); assert.equal(f.node("Year").innerHTML, "");
  assert.equal(f.node("Export").disabled, true); assert.doesNotMatch(f.node("Body").innerHTML, /150|2026-01/);
  f.load(); f.node("Export").handlers.click(); assert.equal(f.exports.length, 0);
});
