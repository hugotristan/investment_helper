import test from "node:test";
import assert from "node:assert/strict";
import { normalizePortfolioOrganization, removePortfolioGroup, setPositionOrganization } from "../js/analysis/portfolio-organization.js";
import { createPortfolioBook, validatePortfolioBook, projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { serializePortfolioBackup, parsePortfolioBackup } from "../js/data/portfolio-book-store.js";

const NOW = "2026-10-09";
const org = { groups: [{ id: "core", name: "Long-term" }], positions: [
  { ticker: "MSFT", currency: "USD", groupId: "core", note: "Review after earnings.\nKeep <text> as written." }
] };

test("organization survives validation and backup without altering financial records, while older books stay unchanged", () => {
  const book = createPortfolioBook({ startDate: "2026-10-01", now: NOW, holdings: [
    { id: "msft", kind: "position", ticker: "MSFT", label: "Microsoft", currency: "USD", shares: 2, averageCost: 300 }
  ] });
  assert.deepEqual(validatePortfolioBook(book, { now: NOW }).book, book);
  const projection = projectPortfolioBook(book);
  const annotated = { ...book, organization: structuredClone(org) };
  const restored = parsePortfolioBackup(serializePortfolioBackup(annotated, { now: NOW }), { now: NOW });
  assert.equal(restored.ok, true, restored.error);
  assert.deepEqual(restored.book, annotated);
  assert.deepEqual(projectPortfolioBook(restored.book), projection);
  assert.equal(Object.hasOwn(book, "organization"), false);
});

test("assigning and removing groups preserves notes, exact currencies and source records", () => {
  const before = structuredClone(org);
  const changed = setPositionOrganization(org, { ticker: "MSFT", currency: "EUR" }, { groupId: "core", note: "Different listing." });
  assert.equal(changed.positions.length, 2);
  const removed = removePortfolioGroup(changed, "core");
  assert.equal(removed.groups.length, 0);
  assert(removed.positions.every((entry) => entry.groupId === null));
  assert.equal(removed.positions[0].note, org.positions[0].note);
  assert.equal(setPositionOrganization(removed, { ticker: "MSFT", currency: "EUR" }, { groupId: null, note: "" }).positions.length, 1);
  assert.deepEqual(org, before);
});

test("annotation boundaries reject dangling groups, duplicate identities, oversized notes and unrelated data", () => {
  for (const mutate of [
    (value) => { value.groups.push({ id: "second", name: "long-term" }); },
    (value) => { value.groups.push({ id: "core", name: "Other" }); },
    (value) => { value.positions[0].groupId = "missing"; },
    (value) => { value.positions.push({ ...value.positions[0] }); },
    (value) => { value.positions[0].note = "x".repeat(2001); },
    (value) => { value.positions[0].ticker = "BTC-USD"; },
    (value) => { value.positions[0].cashAmount = 999; },
    (value) => { value.password = "unrelated"; }
  ]) {
    const value = structuredClone(org); mutate(value);
    assert.throws(() => normalizePortfolioOrganization(value), TypeError);
    const book = { ...createPortfolioBook({ now: NOW }), organization: value };
    assert.equal(validatePortfolioBook(book, { now: NOW }).ok, false);
  }
});
