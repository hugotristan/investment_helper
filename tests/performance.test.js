import assert from "node:assert/strict";
import { test } from "node:test";
import { RECOMMENDATION_STORE_KEY } from "../js/data/recommendation-store.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 5, 16);
const NativeDate = Date;

function pending(sessions) {
  return { status: "pending", reason: "Later settled sessions needed", sessions, observedSessions: 0,
    asOf: null, observedAt: null, stockPrice: null, benchmarkPrice: null,
    stockReturn: null, benchmarkReturn: null, excessReturn: null };
}

function recordedEntry() {
  return { id: "ACME|2026-09-05", ticker: "ACME", name: "Acme", recordedDate: "2026-09-05",
    recordedAt: "2026-09-05T16:00:00.000Z", currency: "USD", score: 76,
    baseline: { price: 100, asOf: "2026-09-04T16:00:00.000Z", currency: "USD" },
    benchmark: { ticker: "SPY", price: 200, asOf: "2026-09-04T16:00:00.000Z", currency: "USD" },
    signal: "Buy signal", horizon: "1 to 4 weeks", invalidation: 90,
    evidence: [{ title: "Original company evidence", link: "https://example.com/company",
      source: "Example", pubDate: "2026-09-04T12:00:00.000Z", directTickers: ["ACME"] }],
    reasons: ["Original reason"], risks: ["Original risk"], outcomes: { "5": pending(5), "21": pending(21) } };
}

function cachedHistory(ticker) {
  const baseline = ticker === "SPY" ? 200 : 100;
  const prices = [];
  let time = Date.UTC(2026, 8, 4, 16);
  while (prices.length < 200) {
    if (![0, 6].includes(new Date(time).getUTCDay())) prices.unshift({ date: new Date(time), close: baseline });
    time -= DAY;
  }
  for (let index = 1; index <= 5; index += 1) {
    prices.push({ date: new Date(Date.UTC(2026, 8, 6 + index, 16)), close: baseline + index * 2 });
  }
  prices.push({ date: new Date(Date.UTC(2026, 9, 2, 16)), close: baseline + 12 });
  return { ticker, source: "Fixture daily prices", currency: "USD", prices };
}

function browserFixture(t, entries, { failObjectUrl = false } = {}) {
  const values = new Map([
    [RECOMMENDATION_STORE_KEY, JSON.stringify({ schemaVersion: 1, entries })],
    ["today-invest-model-state", JSON.stringify({ holdings: [], tickerInput: "ACME, SPY" })]
  ]);
  const writes = [];
  const nodes = new Map();
  const downloads = [];
  const objectUrls = [];
  const revoked = [];
  const timers = [];

  function node() {
    return { innerHTML: "", textContent: "", hidden: false, disabled: false, listeners: new Map(),
      addEventListener(type, callback) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), callback]);
      },
      click() { for (const callback of this.listeners.get("click") || []) callback({ currentTarget: this }); } };
  }
  for (const id of ["exportRecommendations", "performanceSummary", "performanceStatus", "performanceEmpty", "performanceTable"]) nodes.set(id, node());

  function replaceGlobal(name, value) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  replaceGlobal("Date", FixedDate);
  replaceGlobal("localStorage", { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { writes.push([key, value]); values.set(key, value); } });
  replaceGlobal("document", {
    getElementById: (id) => nodes.get(id) || null,
    querySelectorAll: () => [],
    createElement(tag) {
      assert.equal(tag, "a");
      const link = { attached: false, href: "", download: "",
        click() { assert.equal(this.attached, true); downloads.push({ href: this.href, filename: this.download, link: this }); },
        remove() { this.attached = false; } };
      return link;
    },
    body: { append(link) { link.attached = true; } }
  });
  // Capture only the export's delayed revocation; no real timer survives a test.
  replaceGlobal("setTimeout", (callback, delay) => { timers.push({ callback, delay }); return timers.length; });
  t.mock.method(URL, "createObjectURL", (blob) => {
    assert.ok(blob instanceof Blob);
    objectUrls.push({ blob, url: `blob:performance-test/${objectUrls.length + 1}` });
    if (failObjectUrl) throw new Error("Object URL unavailable");
    return objectUrls.at(-1).url;
  });
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  return { values, writes, nodes, downloads, objectUrls, revoked, timers };
}

test("read-only Performance renders preserve storage and export the journal plus observed outcomes", async (t) => {
  const original = recordedEntry();
  const fixture = browserFixture(t, [original]);
  const before = [...fixture.values.entries()];
  const { initializePerformance, renderPerformance } = await import("../js/features/performance.js");
  const { state } = await import("../js/storage.js");
  const stateBefore = JSON.stringify(state);
  initializePerformance();
  initializePerformance();
  const button = fixture.nodes.get("exportRecommendations");
  assert.equal(button.listeners.get("click").length, 1, "initialization binds the real callback once");
  assert.equal(button.disabled, false);
  assert.equal(fixture.nodes.get("performanceEmpty").hidden, true);

  const cached = [cachedHistory("ACME"), cachedHistory("SPY")];
  const cachedBefore = JSON.stringify(cached);
  renderPerformance(cached);
  assert.match(fixture.nodes.get("performanceTable").innerHTML, /Original company evidence/);
  assert.deepEqual([...fixture.values.entries()], before);
  assert.equal(JSON.stringify(state), stateBefore);
  assert.equal(JSON.stringify(cached), cachedBefore);
  assert.deepEqual(fixture.writes, [], "cached observation must never persist a new record or outcome");

  button.click();
  assert.equal(fixture.objectUrls.length, 1);
  assert.equal(fixture.objectUrls[0].blob.type, "application/json");
  const exported = JSON.parse(await fixture.objectUrls[0].blob.text());
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.exportedAt, "2026-10-05T16:00:00.000Z");
  assert.deepEqual(exported.journal, { schemaVersion: 1, entries: [original] });
  assert.equal(exported.journal.entries[0].outcomes["5"].status, "pending");
  const observed = exported.observedReport.entries[0];
  assert.equal(observed.outcomes["5"].status, "matured");
  assert.ok(Math.abs(observed.outcomes["5"].stockReturn - .1) < 1e-10);
  assert.ok(Math.abs(observed.outcomes["5"].benchmarkReturn - .05) < 1e-10);
  assert.ok(Math.abs(observed.outcomes["5"].excessReturn - .05) < 1e-10);
  assert.equal(observed.outcomes["21"].status, "pending");
  assert.equal(exported.observedReport.summary.matured5, 1);
  for (const field of ["recordedAt", "baseline", "benchmark", "signal", "score", "evidence", "reasons", "risks"]) {
    assert.deepEqual(observed[field], original[field], `${field} remains frozen in the observed report`);
  }
  assert.match(exported.method, /fees, dividends, and FX excluded/);
  assert.equal(fixture.downloads.length, 1);
  assert.equal(fixture.downloads[0].href, fixture.objectUrls[0].url);
  assert.equal(fixture.downloads[0].filename, "investment-helper-recommendations-2026-10-05.json");
  assert.equal(fixture.downloads[0].link.attached, false, "temporary download link is removed after clicking");
  assert.deepEqual(fixture.revoked, []);
  assert.equal(fixture.timers.length, 1);
  assert.equal(fixture.timers[0].delay, 1000);
  fixture.timers[0].callback();
  assert.deepEqual(fixture.revoked, [fixture.objectUrls[0].url]);
  assert.deepEqual([...fixture.values.entries()], before);
  assert.equal(JSON.stringify(state), stateBefore);
  assert.deepEqual(fixture.writes, []);
});

test("empty journals disable export and the bound callback creates no download", async (t) => {
  const fixture = browserFixture(t, []);
  const { initializePerformance } = await import("../js/features/performance.js");
  initializePerformance();
  const button = fixture.nodes.get("exportRecommendations");
  assert.equal(button.disabled, true);
  assert.equal(fixture.nodes.get("performanceEmpty").hidden, false);
  assert.equal(fixture.nodes.get("performanceTable").innerHTML, "");
  button.click();
  assert.deepEqual(fixture.downloads, []);
  assert.deepEqual(fixture.objectUrls, []);
  assert.deepEqual(fixture.timers, []);
  assert.deepEqual(fixture.writes, []);
});

test("failed exports report the error while leaving saved records unchanged", async (t) => {
  const fixture = browserFixture(t, [recordedEntry()], { failObjectUrl: true });
  const before = [...fixture.values.entries()];
  const { initializePerformance } = await import("../js/features/performance.js");
  initializePerformance();
  fixture.nodes.get("exportRecommendations").click();
  assert.match(fixture.nodes.get("performanceStatus").textContent, /could not be exported/);
  assert.deepEqual(fixture.downloads, []);
  assert.deepEqual(fixture.timers, []);
  assert.deepEqual(fixture.revoked, []);
  assert.deepEqual([...fixture.values.entries()], before);
  assert.deepEqual(fixture.writes, []);
});
