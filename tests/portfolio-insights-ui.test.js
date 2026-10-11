import test from "node:test";
import assert from "node:assert/strict";
import { createPortfolioInsightsController } from "../js/features/analyst.js";

function fixture({ failClipboard = false, load } = {}) {
  const ids = ["insightsPanel", "insightsRefresh", "insightsPrepare", "insightsCopy", "insightsIncludeNotes", "insightsExportQuestion", "insightsSummary", "insightsSummaryLabel", "insightsChatGPTLink", "insightsExportStatus", "insightsBody", "insightsLimits", "insightsStatus"];
  const nodes = new Map(ids.map((id) => [id, { value: "", checked: false, hidden: false, disabled: false, textContent: "", innerHTML: "", handlers: {},
    addEventListener(event, fn) { this.handlers[event] = fn; }, setAttribute() {}, focus() { this.focused = true; }, select() { this.selected = true; } }]));
  const doc = { documentElement: { dataset: {} }, getElementById: (id) => nodes.get(id), querySelectorAll: () => [] };
  let listener; const copied = [], calls = [];
  const evidence = { generatedAt: "2026-10-11T12:00:00Z", portfolioRevision: 1, facts: [], sources: [], limitations: ["<script>untrusted label</script>"], notes: [] };
  const controller = createPortfolioInsightsController({ document: doc, window: { location: { hash: "#dashboard" }, addEventListener() {} },
    session: { subscribe(fn) { listener = fn; } }, client: { isCloud: true, context: async (notes) => {
      calls.push(notes); return load ? load(notes) : { ...evidence, notes: notes ? [{ ticker: "MSFT", currency: "USD", text: "PRIVATE POSITION NOTE" }] : [] };
    } }, clipboard: { async writeText(text) { if (failClipboard) throw new Error("Permission denied"); copied.push(text); } } });
  controller.initialize();
  return { controller, nodes, calls, copied, evidence, doc, notify: (value) => listener(value) };
}

test("summary review/copy is explicit, note selection clears it, and browser clipboard failure permits manual copying", async () => {
  const f = fixture();
  await f.controller.refresh();
  assert.deepEqual(f.copied, []);
  assert.equal(f.nodes.get("insightsCopy").disabled, true);
  assert.doesNotMatch(f.nodes.get("insightsLimits").innerHTML, /<script>/);
  await f.controller.refresh({ summary: true });
  assert.equal(f.nodes.get("insightsSummary").hidden, false);
  assert.doesNotMatch(f.nodes.get("insightsSummary").value, /PRIVATE POSITION NOTE/);
  await f.controller.copy();
  assert.equal(f.copied.length, 1);
  f.nodes.get("insightsIncludeNotes").checked = true;
  f.nodes.get("insightsIncludeNotes").handlers.change();
  assert.equal(f.nodes.get("insightsSummary").value, "");
  assert.equal(f.nodes.get("insightsCopy").disabled, true);
  await f.controller.refresh({ summary: true });
  assert.match(f.nodes.get("insightsSummary").value, /PRIVATE POSITION NOTE/);
  f.nodes.get("insightsExportQuestion").handlers.input();
  assert.equal(f.nodes.get("insightsSummary").hidden, true);
  const fallback = fixture({ failClipboard: true });
  await fallback.controller.refresh({ summary: true }); await fallback.controller.copy();
  assert.equal(fallback.nodes.get("insightsSummary").selected, true);
  assert.match(fallback.nodes.get("insightsExportStatus").textContent, /copy it manually/);
});

test("a late context response cannot restore private insights or summary after the account is locked", async () => {
  let resolve;
  const f = fixture({ load: () => new Promise((done) => { resolve = done; }) });
  const loading = f.controller.refresh({ summary: true });
  f.doc.documentElement.dataset.privateBlocked = "true";
  f.notify({ errorCode: "UNAUTHORIZED", message: "Unlock again" });
  resolve(f.evidence); await loading;
  assert.equal(f.nodes.get("insightsSummary").value, "");
  assert.equal(f.nodes.get("insightsCopy").disabled, true);
  assert.match(f.nodes.get("insightsBody").textContent, /Unlock/);
  assert.equal(f.nodes.get("insightsLimits").innerHTML, "");
});

test("a changed portfolio clears a prepared summary so stale figures cannot be copied", async () => {
  const f = fixture();
  await f.controller.refresh({ summary: true });
  f.controller.invalidate();
  await f.controller.copy();
  assert.equal(f.nodes.get("insightsSummary").value, "");
  assert.equal(f.nodes.get("insightsCopy").disabled, true);
  assert.deepEqual(f.copied, []);
});
