import assert from "node:assert/strict";
import { test } from "node:test";
import { renderFundamentals } from "../js/features/fundamentals.js";

const NOW = Date.UTC(2026, 9, 5, 12);
const DAY = 24 * 60 * 60 * 1000;
const end = "2025-06-30";

function source(unit = "USD", overrides = {}) {
  return { tag: "AnnualFact", unit, start: "2024-07-01", end, filed: "2025-09-01", accession: "0000000001-25-000001",
    url: "https://www.sec.gov/Archives/edgar/data/1/annual.htm", ...overrides };
}

function record(overrides = {}) {
  const metrics = { revenue: 1000000000, netIncome: 200000000, operatingCashFlow: 300000000, freeCashFlow: 200000000,
    totalDebt: 500000000, revenueGrowth: 0.15, dilutedEPS: 5, basicEPS: 6 };
  const metricSources = Object.fromEntries(Object.keys(metrics).map((key) => [key, [source(key.endsWith("EPS") ? "USD/shares" : "USD")]]));
  return { ticker: "ACME", companyName: "Acme Example", available: true, currency: "USD", periodEnd: end, fiscalYear: 2025,
    retrievedAt: new Date(NOW - DAY).toISOString(), metrics, metricSources, earnings: null, ...overrides };
}

function snapshot(company = record()) {
  return { schemaVersion: 1, provider: "SEC companyfacts", generatedAt: new Date(NOW).toISOString(), byTicker: { ACME: company } };
}

function item(overrides = {}) {
  return { ticker: "ACME", quote: { price: 100, currency: "USD", quoteTime: new Date(NOW - DAY) }, ...overrides };
}

test("published filing metrics retain currency, periods, dates, and derived annual valuation", async () => {
  const html = await renderFundamentals(item(), snapshot(), { now: NOW });
  for (const label of ["Annual revenue", "Annual net profit", "Operating cash flow", "Free cash flow", "Reported debt", "Annual revenue growth"]) assert.ok(html.includes(label));
  assert.match(html, /\+15\.0%/);
  assert.match(html, /FY 2025/);
  assert.match(html, /Period ended/);
  assert.match(html, /Filed/);
  assert.match(html, /USD/);
  assert.match(html, /20\.0×/);
  assert.match(html, /diluted/);
  assert.match(html, /annual earnings, not trailing twelve months/);
  assert.match(html, /Later share splits may require EPS adjustment/);
  assert.match(html, /<details class="fundamentals-provenance">/);
  assert.doesNotMatch(html, /<details[^>]* open/);
});

test("EPS basis must be annual and currency-matched, and nonpositive earnings have no meaningful P/E", async () => {
  const base = record();
  const mismatched = await renderFundamentals(item({ quote: { price: 100, currency: "EUR", quoteTime: NOW - DAY } }), snapshot(base), { now: NOW });
  assert.match(mismatched, /does not match annual EPS currency USD/);
  assert.doesNotMatch(mismatched, /20\.0×/);
  const pence = record({ metricSources: { ...base.metricSources, dilutedEPS: [source("GBP/shares")] } });
  const penceHtml = await renderFundamentals(item({ quote: { price: 100, currency: "GBp", quoteTime: NOW - DAY } }), snapshot(pence), { now: NOW });
  assert.match(penceHtml, /GBp does not match annual EPS currency GBP/);
  const quarterly = record({ metricSources: { dilutedEPS: [source("USD/shares", { start: "2025-04-01" })] } });
  assert.match(await renderFundamentals(item(), snapshot(quarterly), { now: NOW }), /No matching annual share-based filing fact/);
  const negative = record({ metrics: { ...base.metrics, dilutedEPS: -2 } });
  assert.match(await renderFundamentals(item(), snapshot(negative), { now: NOW }), /Not meaningful/);
  const basicOnly = record({ metrics: { ...base.metrics, dilutedEPS: null } });
  assert.match(await renderFundamentals(item(), snapshot(basicOnly), { now: NOW }), /16\.7×/);
});

test("retrieval age is stale at ten days without relabeling retained facts as newly fetched", async () => {
  const old = record({ retrievedAt: new Date(NOW - 10 * DAY).toISOString() });
  const html = await renderFundamentals(item(), snapshot(old), { now: NOW });
  assert.match(html, /Snapshot stale or undated/);
  assert.match(html, /Refresh is needed/);
  assert.equal(old.retrievedAt, new Date(NOW - 10 * DAY).toISOString());
  const recent = record({ retrievedAt: new Date(NOW - 10 * DAY + 1).toISOString() });
  assert.doesNotMatch(await renderFundamentals(item(), snapshot(recent), { now: NOW }), /Snapshot stale or undated/);
  const staleQuote = item({ quote: { price: 100, currency: "USD", quoteTime: NOW - 8 * DAY } });
  assert.match(await renderFundamentals(staleQuote, snapshot(), { now: NOW }), /recent real quote/);
});

test("unavailable filings preserve independent sourced earnings and do not substitute zeroes", async () => {
  const earnings = { date: "2026-10-20", status: "confirmed", source: "Company IR", sourceUrl: "https://example.com/ir" };
  const missing = record({ available: false, reason: "SEC request unavailable", earnings });
  const html = await renderFundamentals(item(), snapshot(missing), { now: NOW });
  assert.match(html, /SEC request unavailable/);
  assert.match(html, /confirmed/);
  assert.match(html, /https:\/\/example.com\/ir/);
  assert.doesNotMatch(html, /Annual revenue/);
  const unknown = await renderFundamentals(item(), { byTicker: {} }, { now: NOW });
  assert.match(unknown, /Unverified/);
  assert.match(unknown, /Nasdaq earnings calendar · external verification/);
  assert.doesNotMatch(unknown, /2026-10-20/);
  const unavailableMetric = record(); unavailableMetric.metrics.netIncome = null;
  assert.match(await renderFundamentals(item(), snapshot(unavailableMetric), { now: NOW }), /Annual net profit<\/span><strong>Unavailable/);
});

test("earnings dates require valid future dates, supported status, and safe attributed links", async () => {
  for (const earnings of [
    { date: "2026-09-01", status: "confirmed", sourceUrl: "https://example.com/ir" },
    { date: "2026-10-32", status: "confirmed", sourceUrl: "https://example.com/ir" },
    { date: "2026-10-20", status: "rumored", sourceUrl: "https://example.com/ir" },
    { date: "2026-10-20", status: "confirmed", sourceUrl: "javascript:alert(1)" }
  ]) {
    assert.match(await renderFundamentals(item(), snapshot(record({ earnings })), { now: NOW }), /Unverified/);
  }
  const estimated = { date: "2026-10-20", status: "estimated", source: "External calendar", sourceUrl: "https://example.com/calendar" };
  assert.match(await renderFundamentals(item(), snapshot(record({ earnings: estimated })), { now: NOW }), /Estimated timing; verify with investor relations/);
});

test("ETF fundamentals are not applicable, and provenance cannot inject HTML or unsafe links", async () => {
  assert.match(await renderFundamentals({ ticker: "SPY" }, undefined, { now: NOW }), /Not applicable to an ETF or fund/);
  assert.match(await renderFundamentals({ ticker: "NEWETF", instrumentType: "ETF" }, undefined, { now: NOW }), /Not applicable to an ETF or fund/);
  const malicious = record({ reason: "<script>alert(1)</script>", metricSources: { revenue: [source("USD", { tag: "<img>", url: "javascript:alert(1)" })] } });
  const html = await renderFundamentals(item(), snapshot(malicious), { now: NOW });
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test("snapshot client requests the site-relative asset once and returns honest failure states", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let count = 0;
  globalThis.fetch = async (url) => {
    count += 1;
    assert.equal(new URL(url).href, new URL("../data/fundamentals.json", import.meta.url).href);
    return new Response(JSON.stringify(snapshot()));
  };
  const success = await import("../js/data/fundamentals.js?ui-success");
  const [first, second] = await Promise.all([success.loadFundamentalsSnapshot(), success.loadFundamentalsSnapshot()]);
  assert.equal(count, 1);
  assert.equal(first, second);
  assert.equal(first.byTicker.ACME.available, true);
  globalThis.fetch = async () => new Response("Access denied", { status: 403 });
  const forbidden = await import("../js/data/fundamentals.js?ui-forbidden");
  const unavailable = await forbidden.loadFundamentalsSnapshot();
  assert.deepEqual(unavailable.byTicker, {});
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /not estimated/);
  globalThis.fetch = async () => new Response(JSON.stringify({ schemaVersion: 9, byTicker: [] }));
  const malformed = await import("../js/data/fundamentals.js?ui-malformed");
  assert.equal((await malformed.loadFundamentalsSnapshot()).available, false);
});
