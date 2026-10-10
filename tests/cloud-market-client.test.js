import test from "node:test";
import assert from "node:assert/strict";
import { loadStockHistory } from "../js/data/stock-history.js";
import { loadQuoteSnapshots } from "../js/data/market.js";

const now = Date.now();
const closeDate = new Date(now - 2 * 86400000).toISOString();
const quoteDate = new Date(now - 60000).toISOString();
function history(ticker, price) {
  return { ticker, currency: "USD", instrumentType: "EQUITY", source: "Yahoo Finance chart",
    prices: [{ date: closeDate, close: price }], historyAsOf: closeDate, splits: [], splitsComplete: true,
    quote: { ticker, currency: "USD", price, quoteTime: price === 100 ? quoteDate : new Date(now - 30000).toISOString(), source: "Yahoo Finance quote" } };
}
function snapshot(ticker) {
  return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), byTicker: { [ticker]: {
    ...history(ticker, 100), source: "Yahoo Finance published snapshot" } } };
}
async function cloudFetch(fetchImpl, action) {
  const savedFetch = globalThis.fetch;
  const savedDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: { cloudMode: "sites" } } };
  globalThis.fetch = fetchImpl;
  try { return await action(); }
  finally { globalThis.fetch = savedFetch; globalThis.document = savedDocument; }
}

test("Sites refreshes history through its Worker despite a recent bundled snapshot", async () => {
  const calls = [];
  const value = await cloudFetch(async (url, options) => {
    calls.push({ url: String(url), credentials: options.credentials });
    return Response.json(history("CLOUDONE", 120));
  }, () => loadStockHistory("CLOUDONE", { snapshot: snapshot("CLOUDONE"), now, storage: null }));
  assert.equal(value.quote.price, 120);
  assert.deepEqual(calls, [{ url: "/api/market/history?ticker=CLOUDONE", credentials: "same-origin" }]);
});

test("Sites quotes use new Worker prices instead of a bundled published quote", async () => {
  const calls = [];
  const result = await cloudFetch(async (url) => {
    calls.push(String(url));
    return Response.json(String(url).includes("prices.json") ? snapshot("CLOUDTWO") : history("CLOUDTWO", 140));
  }, () => loadQuoteSnapshots(["CLOUDTWO"]));
  assert.equal(result.byTicker.get("CLOUDTWO").price, 140);
  assert.ok(calls.includes("/api/market/history?ticker=CLOUDTWO"));
  assert.equal(calls.some((url) => /allorigins|query1\.finance/.test(url)), false);
});

test("Sites keeps genuine dated published history during a Worker outage", async () => {
  const calls = [];
  const value = await cloudFetch(async (url) => { calls.push(String(url)); return new Response("Unavailable", { status: 503 }); },
    () => loadStockHistory("CLOUDTHREE", { snapshot: snapshot("CLOUDTHREE"), now, storage: null }));
  assert.equal(value.quote.price, 100);
  assert.equal(value.historyAsOf, closeDate);
  assert.equal(value.quote.quoteTime.toISOString(), quoteDate);
  assert.deepEqual(calls, ["/api/market/history?ticker=CLOUDTHREE"]);
});

test("Sites waits for Worker fallback for current and historical ECB rates while preserving their dates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const pending = [];
  const date = closeDate.slice(0, 10);
  const retrievedAt = new Date(now).toISOString();
  await cloudFetch((url, { signal }) => new Promise((resolve, reject) => {
    calls.push(String(url));
    signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
    pending.push(() => resolve(Response.json(String(url) === "/api/exchange-rate" ? {
      schemaVersion: 1, available: true, base: "USD", quote: "EUR", rate: 0.9, date,
      source: "ECB reference rate via Frankfurter", sourceUrl: "https://api.frankfurter.dev/v2/providers/ecb/rate/usd/eur",
      retrievedAt
    } : {
      schemaVersion: 1, source: "ECB reference rates via Frankfurter",
      sourceUrl: "https://api.frankfurter.dev/v2/providers/ecb/rates", generatedAt: retrievedAt,
      byCurrency: { USD: [{ date, rate: 0.9 }] }
    })));
  }), async () => {
    const { loadExchangeRate } = await import("../js/data/exchange-rate.js?cloud-client-test");
    const { loadPortfolioFx } = await import("../js/data/portfolio-history.js?cloud-client-test");
    const requests = Promise.all([loadExchangeRate(), loadPortfolioFx()]);
    // A provider timeout followed by the Worker's fallback can outlast a static-file request.
    t.mock.timers.tick(9000);
    pending.forEach((complete) => complete());
    const [current, historical] = await requests;
    assert.equal(current.rate, 0.9);
    assert.equal(current.date, date);
    assert.equal(current.retrievedAt, retrievedAt);
    assert.deepEqual(historical.byCurrency.USD[0], { date, rate: 0.9 });
    assert.equal(historical.generatedAt, retrievedAt);
  });
  assert.deepEqual(calls, ["/api/exchange-rate", "/api/portfolio-fx"]);
});
