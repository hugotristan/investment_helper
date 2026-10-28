import test from "node:test";
import assert from "node:assert/strict";
import { createRetirementReportController } from "../js/features/report-retirement.js";
import { createPortfolioBook, projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
const NOW = Date.parse("2026-10-12T12:00:00Z");

function fixture() {
  let book = createPortfolioBook({ now: NOW, startDate: "2026-10-01", holdings: [] });
  book.transactions = [{ id: "fund", type: "deposit", date: "2026-10-01", currency: "EUR", amount: 1000 }];
  const nodes = new Map(), writes = [], exports = [];
  const node = id => { const key = `reportRetirement${id}`; if (!nodes.has(key)) nodes.set(key, { value: "", textContent: "", innerHTML: "", hidden: false, disabled: false, handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; }, querySelectorAll: () => [...nodes.values()] }); return nodes.get(key); };
  const doc = { documentElement: { dataset: { privateBlocked: "false" } }, getElementById: id => node(id.replace("reportRetirement", "")) };
  const controller = createRetirementReportController({ document: doc, window: null, session: null, readBook: () => book, now: () => NOW,
    save: async (scenario, revision) => { assert.equal(revision, book.updatedAt); writes.push(scenario); book = { ...book, retirementScenario: scenario, updatedAt: new Date(Date.parse(book.updatedAt) + 1).toISOString() }; controller.updateHoldings([]); return true; },
    download: (...args) => exports.push(args) });
  controller.initialize(); controller.updateHoldings([]);
  const fill = () => { for (const [id, value] of Object.entries({ Month: "2027-10", Contribution: "100", Return: "0", Inflation: "0", Withdrawal: "100", Years: "1" })) node(id).value = value;
    node("Form").handlers.input(); };
  return { controller, node, doc, writes, exports, fill, get book() { return book; }, set book(value) { book = value; } };
}

test("preview never writes accounting; save, stale drafts, CSV and remove follow the portfolio revision", async () => {
  const f = fixture(), before = projectPortfolioBook(f.book);
  f.fill(); assert.equal(f.controller.calculatePreview(), true); assert.equal(f.writes.length, 0);
  assert.equal(f.controller.current.retirementValue, 2200); assert.match(f.node("Body").innerHTML, /Unsaved preview/);
  assert.equal(await f.controller.persist(), true); assert.equal(f.writes.length, 1);
  assert.deepEqual(projectPortfolioBook(f.book), before); assert.match(f.node("Body").innerHTML, /Saved assumptions/);
  f.node("Export").handlers.click(); assert.equal(f.exports.length, 1); assert.equal(f.exports[0][2].length, 25);
  assert.equal(f.exports[0][2][0][11], 1000); assert.equal(f.exports[0][2][0][12], "2027-10");
  f.fill(); f.book = { ...f.book, updatedAt: new Date(NOW + 2).toISOString() }; f.controller.updateHoldings([]);
  assert.equal(await f.controller.persist(), false); assert.equal(f.writes.length, 1); assert.match(f.node("Status").textContent, /changed/);
  f.node("Reload").handlers.click(); assert.equal(await f.controller.persist(true), true);
  assert.equal(f.book.retirementScenario, null); assert.equal(f.controller.current, null);
  assert.deepEqual(projectPortfolioBook(f.book), before);
});

test("comma-decimal scenario amounts and negative percentages save as validated numbers", async () => {
  const f = fixture(); f.fill();
  for (const [id, value] of Object.entries({ Contribution: "100,50", Return: "-2,5", Inflation: "1,25", Withdrawal: "75,25" })) f.node(id).value = value;
  f.node("Form").handlers.input();
  assert.equal(f.controller.calculatePreview(), true);
  assert.equal(await f.controller.persist(), true);
  assert.deepEqual([f.writes[0].monthlyContribution, f.writes[0].annualReturnPercent,
    f.writes[0].annualInflationPercent, f.writes[0].monthlyWithdrawal], [100.5, -2.5, 1.25, 75.25]);
});

test("missing valuation blocks projections; refresh preserves typed drafts and locking clears private data and exports", () => {
  const f = fixture(); f.fill(); f.node("Contribution").value = "200";
  f.controller.updateHoldings(null); assert.equal(f.controller.calculatePreview(), false);
  assert.equal(f.controller.current, null); assert.equal(f.node("Export").disabled, true);
  assert.equal(f.node("Contribution").value, "200");
  f.controller.updateHoldings([]); assert.equal(f.node("Contribution").value, "200");
  assert.equal(f.controller.calculatePreview(), true); assert.equal(f.controller.current.retirementValue, 3400);
  f.doc.documentElement.dataset.privateBlocked = "true"; f.controller.render();
  assert.equal(f.controller.current, null); assert.equal(f.node("Editor").hidden, true);
  assert.equal(f.node("Month").value, ""); assert.equal(f.node("Contribution").value, "");
  assert.doesNotMatch(f.node("Body").innerHTML, /3,400|2027-10/);
  f.node("Export").handlers.click(); assert.equal(f.exports.length, 0);
});
