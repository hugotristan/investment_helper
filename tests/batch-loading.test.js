import test from "node:test";
import assert from "node:assert/strict";
import { mapBatch, retryTransient } from "../js/shared/batch.js";
import { initializeLoadingDiagnostics } from "../js/features/loading-diagnostics.js";

test("bounded batch isolates ticker failure and preserves order", async () => {
  let active = 0, maximum = 0;
  const result = await mapBatch(["MSFT", "VICR", "AAPL", "NVDA"], async ticker => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    if (ticker === "VICR") throw new Error("Primary provider missing ticker");
    return ticker;
  }, { concurrency: 2 });
  assert.equal(maximum, 2);
  assert.deepEqual(result.map(row => row.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.equal(result[3].value, "NVDA");
});

test("transient retries back off and permanent failures do not retry", async () => {
  let attempts = 0; const waits = [];
  const value = await retryTransient(async () => { if (++attempts < 3) throw { transient: true }; return "ok"; },
    { attempts: 3, wait: async ms => waits.push(ms), retryable: error => error.transient });
  assert.equal(value, "ok"); assert.deepEqual(waits, [250, 500]);
  attempts = 0;
  await assert.rejects(retryTransient(async () => { attempts++; throw new Error("Unsupported ETF"); }));
  assert.equal(attempts, 1);
});

test("website checks all pages while portfolio/watchlist and metrics finish independently of price failure", async t => {
  class Element {
    children = []; value = "2"; textContent = ""; hidden = true; events = {};
    appendChild(element) { this.children.push(element); }
    replaceChildren() { this.children = []; }
    addEventListener(name, callback) { this.events[name] = callback; }
  }
  const nodes = Object.fromEntries(["loadingDiagnostics", "loadingComponents", "loadingTickerResults", "loadingRefresh", "loadingBatchSize", "loadingConcurrency"].map(id => [id, new Element()]));
  nodes.loadingBatchSize.value = "10";
  const doc = { documentElement: { dataset: { cloudMode: "sites" } }, getElementById: id => nodes[id], createElement: () => new Element() };
  const original = globalThis.document; globalThis.document = doc; t.after(() => { globalThis.document = original; });
  const visits = [];
  const feature = initializeLoadingDiagnostics({ document: doc, window: { location: { hash: "#portfolio" }, addEventListener() {} }, session: { subscribe() {} },
    fetchImpl: async url => {
      const query = new URL(url, "https://example.test").searchParams, component = query.get("component"), offset = Number(query.get("offset"));
      visits.push([component, offset]);
      if (component === "prices") return new Response("Unavailable", { status: 400 });
      const values = Array.from({ length: offset === 20 ? 5 : 10 }, (_, i) => ({ ticker: `S${offset + i}`, status: "available", latestSuccessfulUpdateAt: "2026-11-11T10:00:00Z" }));
      return Response.json({ userId: "owner", portfolio: { status: "available", savedAt: "2026-11-12T10:00:00Z" }, watchlist: { status: "available", savedAt: "2026-11-12T10:00:00Z" },
        financialMetrics: { status: "available", companies: values }, pagination: { totalTickers: 25, nextOffset: offset === 20 ? null : offset + 10, listRevision: "1:1" } });
    } });
  await feature.refresh();
  assert.deepEqual(visits.filter(([name]) => name === "financialMetrics").map(([, offset]) => offset), [0, 10, 20]);
  const text = nodes.loadingComponents.children.map(node => node.textContent).join(" ");
  assert.match(text, /Portfolio: available · saved/);
  assert.match(text, /Watchlist: available · saved/);
  assert.match(text, /Prices: check incomplete/);
  assert.match(text, /Financial metrics: checked 25\/25/);
});
