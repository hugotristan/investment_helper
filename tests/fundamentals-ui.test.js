import assert from "node:assert/strict";
import { test } from "node:test";
import { renderFundamentals } from "../js/features/fundamentals.js";

const NOW = Date.UTC(2026, 9, 5, 12);
const DAY = 24 * 60 * 60 * 1000;
const end = "2025-06-30";
const dateText = (value) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value));

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

function yahooRecord(overrides = {}) {
  const base = record();
  const metricSources = Object.fromEntries(Object.keys(base.metrics).map((key) => [key, [{
    provider: "Yahoo Finance", tag: `annual${key}`, unit: key.endsWith("EPS") ? "USD/shares" : "USD",
    periodType: "12M", start: null, end, filed: null, accession: null,
    url: "https://finance.yahoo.com/quote/ACME/financials/"
  }]]));
  return { ...base, provider: "Yahoo Finance", periodType: "12M", cik: null, fiscalYear: null,
    retrievedAt: new Date(NOW).toISOString(), reason: "Annual provider data from Yahoo Finance.", metricSources, ...overrides };
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

test("Yahoo values identify provider periods and sources without invented SEC filing or fiscal-year dates", async () => {
  const yahoo = yahooRecord();
  yahoo.metrics.capitalExpenditures = 100000000;
  yahoo.metricSources.capitalExpenditures = [{ ...yahoo.metricSources.revenue[0], tag: "annualCapitalExpenditure",
    value: -100000000, transformation: "Absolute value of the reported capital-expenditure cash outflow. <provider note>" }];
  const before = JSON.stringify(yahoo);
  const html = await renderFundamentals(item(), snapshot(yahoo), { now: NOW });
  assert.match(html, /Yahoo Finance company data/);
  assert.match(html, /Source: Yahoo Finance/);
  assert.match(html, /12-month revenue<\/span><strong>1B USD/);
  assert.ok(html.includes(`Provider 12M period ended ${dateText(end)}`));
  assert.match(html, /Reporting periods &amp; Yahoo Finance sources/);
  assert.match(html, /href="https:\/\/finance.yahoo.com\/quote\/ACME\/financials\/"/);
  assert.doesNotMatch(html, /FY 2025|Filed Date unavailable|SEC filing sources|href="https:\/\/www.sec.gov\/Archives/);
  assert.match(html, /Provider 12-month EPS/);
  assert.match(html, /20\.0×/);
  assert.match(html, /Yahoo Finance diluted EPS for its 12-month reporting period/);
  assert.match(html, /Later share splits may require EPS adjustment/);
  assert.match(html, /Absolute value of the reported capital-expenditure cash outflow\. &lt;provider note&gt;/);
  assert.doesNotMatch(html, /<provider note>/);
  assert.equal(JSON.stringify(yahoo), before);
});

test("Yahoo P/E requires matching known 12M diluted EPS and never substitutes basic or quarterly EPS", async () => {
  const base = yahooRecord();
  for (const company of [
    yahooRecord({ periodType: "3M" }),
    yahooRecord({ metrics: { ...base.metrics, dilutedEPS: null } }),
    yahooRecord({ metricSources: { ...base.metricSources, dilutedEPS: [{ ...base.metricSources.dilutedEPS[0], periodType: "3M" }] } }),
    yahooRecord({ metricSources: { ...base.metricSources, dilutedEPS: [{ ...base.metricSources.dilutedEPS[0], provider: "Unknown" }] } }),
    yahooRecord({ metricSources: { ...base.metricSources, dilutedEPS: [{ ...base.metricSources.dilutedEPS[0], unit: "EUR/shares" }] } }),
    yahooRecord({ metricSources: { ...base.metricSources, dilutedEPS: [{ ...base.metricSources.dilutedEPS[0], end: "2025-12-31" }] } }),
    yahooRecord({ periodEnd: "2027-06-30", metricSources: { ...base.metricSources, dilutedEPS: [{ ...base.metricSources.dilutedEPS[0], end: "2027-06-30" }] } })
  ]) {
    const html = await renderFundamentals(item(), snapshot(company), { now: NOW });
    assert.match(html, /No matching provider 12M diluted EPS fact/);
    assert.doesNotMatch(html, /20\.0×|16\.7×/);
  }
  const mismatched = await renderFundamentals(item({ quote: { price: 100, currency: "EUR", quoteTime: NOW - DAY } }), snapshot(base), { now: NOW });
  assert.match(mismatched, /does not match annual EPS currency USD/);
  assert.doesNotMatch(mismatched, /20\.0×/);
  const loss = yahooRecord({ metrics: { ...base.metrics, dilutedEPS: -2 } });
  assert.match(await renderFundamentals(item(), snapshot(loss), { now: NOW }), /Not meaningful/);
});

test("successful Yahoo fallback displays fresh metrics while SEC failures remain a separate diagnostic", async () => {
  const data = { ...snapshot(yahooRecord({ fallbackReason: "SEC request returned HTTP 403." })),
    provider: "SEC companyfacts + Yahoo Finance", providerStatus: "available", failures: [],
    secProviderStatus: "unavailable", secFailures: [{ ticker: "ACME", reason: "SEC request returned HTTP 403.", status: 403 }],
    secSuccessfulRequests: 0, yahooSuccessfulRequests: 1, successfulRequests: 1 };
  const before = JSON.stringify(data);
  const html = await renderFundamentals(item(), data, { now: NOW });
  assert.match(html, /Yahoo Finance company data/);
  assert.match(html, /12-month revenue<\/span><strong>1B USD/);
  assert.match(html, /SEC source warning: ACME: SEC request returned HTTP 403/);
  assert.match(html, /Displayed financial values come from Yahoo Finance/);
  assert.doesNotMatch(html, /Retained company data|company fundamentals refresh failed|SEC filing refresh failed/);
  assert.ok(html.indexOf('class="fundamentals-grid"') < html.indexOf("SEC source warning"));
  assert.equal(JSON.stringify(data), before);
});

test("retained Yahoo values keep their original dates and report the latest provider errors", async () => {
  const data = { ...snapshot(yahooRecord({ retrievedAt: new Date(NOW - DAY).toISOString(), fallbackReason: "Old SEC HTTP 403 error" })),
    providerStatus: "unavailable", failures: [{ ticker: "ACME", reason: "Yahoo request returned HTTP 503." }],
    secProviderStatus: "unavailable", secFailures: [{ ticker: "ACME", reason: "SEC request returned HTTP 429." }] };
  const html = await renderFundamentals(item(), data, { now: NOW });
  assert.match(html, /Retained company data/);
  assert.match(html, /company fundamentals refresh failed/);
  assert.match(html, /Yahoo request returned HTTP 503/);
  assert.match(html, /SEC source warning: ACME: SEC request returned HTTP 429/);
  assert.doesNotMatch(html, /Old SEC HTTP 403 error/);
  assert.ok(html.includes(`retained figures retrieved ${dateText(NOW - DAY)}`));
  assert.match(html, /12-month revenue<\/span><strong>1B USD/);
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

test("failed filing refreshes are visible immediately while retained values keep their original retrieval date", async () => {
  const retained = record();
  const data = { ...snapshot(retained), providerStatus: "partial", successfulRequests: 1,
    failures: [{ ticker: "ACME", reason: "SEC request returned HTTP 403.", status: 403 }] };
  const before = JSON.stringify(data);
  const html = await renderFundamentals(item(), data, { now: NOW });
  assert.match(html, /Provider warning/);
  assert.match(html, /latest SEC filing refresh partially failed/);
  assert.match(html, /ACME: SEC request returned HTTP 403/);
  assert.ok(html.includes(`Last update attempt: ${dateText(NOW)}`));
  assert.ok(html.includes(`retained figures retrieved ${dateText(NOW - DAY)}`));
  assert.ok(html.includes(`Data retrieved ${dateText(NOW - DAY)}`));
  assert.match(html, /Retained company data/);
  assert.doesNotMatch(html, /Snapshot stale or undated/);
  assert.match(html, /Annual revenue<\/span><strong>1B USD/);
  assert.equal(JSON.stringify(data), before);
});

test("issuer lookup fallback is distinct from a successful company-facts refresh", async () => {
  const data = { ...snapshot(), providerStatus: "available", successfulRequests: 1, failures: [],
    indexStatus: "fallback", indexSource: "Verified SEC snapshot", indexError: "Ticker index returned HTTP 403.",
    indexVerifiedAt: "2026-10-02T12:00:00.000Z" };
  const html = await renderFundamentals(item(), data, { now: NOW });
  assert.ok(html.includes(`Live issuer lookup is unavailable; using Verified SEC snapshot verified ${dateText(data.indexVerifiedAt)}`));
  assert.match(html, /Lookup error: Ticker index returned HTTP 403/);
  assert.ok(html.includes(`Last update attempt: ${dateText(NOW)}`));
  assert.match(html, /Reported company data/);
  assert.doesNotMatch(html, /filing refresh failed|filing refresh partially failed|Retained company data/);
  assert.match(html, /Annual revenue<\/span><strong>1B USD/);
});

test("partial failures for other issuers do not label freshly retrieved figures as retained", async () => {
  const data = { ...snapshot(), providerStatus: "partial",
    failures: [{ ticker: "OTHER", reason: "SEC request timed out." }] };
  const html = await renderFundamentals(item(), data, { now: NOW });
  assert.match(html, /OTHER: SEC request timed out/);
  assert.match(html, /Reported company data/);
  assert.doesNotMatch(html, /Retained company data|Showing retained figures/);
});

test("issuer lookup warnings preserve usable live mapping status", async () => {
  const data = { ...snapshot(), providerStatus: "available", failures: [], indexStatus: "live",
    indexSource: "SEC live ticker index", indexVerifiedAt: new Date(NOW).toISOString(),
    indexError: "Malformed live ticker mappings were ignored." };
  const html = await renderFundamentals(item(), data, { now: NOW });
  assert.match(html, /Issuer lookup returned usable live mappings with a warning/);
  assert.ok(html.includes(`Source: SEC live ticker index verified ${dateText(NOW)}`));
  assert.match(html, /Malformed live ticker mappings were ignored/);
  assert.doesNotMatch(html, /Live issuer lookup is unavailable|no usable saved mapping was found/);
});

test("unavailable provider diagnostics remain visible and escaped alongside unsupported data", async () => {
  const missing = record({ available: false, reason: "No usable SEC facts." });
  const data = { ...snapshot(missing), providerStatus: "unavailable",
    failures: [{ ticker: "ACME", reason: "<script>issuer denied</script>" }],
    indexStatus: "unavailable", indexError: "<img src=x onerror=alert(1)>", indexSource: null };
  const html = await renderFundamentals(item(), data, { now: NOW });
  assert.match(html, /latest SEC filing refresh failed/);
  assert.match(html, /no usable saved mapping was found/);
  assert.match(html, /&lt;script&gt;issuer denied&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /No usable SEC facts/);
  assert.doesNotMatch(html, /<script>|<img |Annual revenue/);
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
    return new Response(JSON.stringify({ ...snapshot(), providerStatus: "partial",
      failures: [{ ticker: "ACME", reason: "SEC request returned HTTP 403." }],
      indexStatus: "fallback", indexSource: "Verified SEC snapshot", indexError: "Index denied" }));
  };
  const success = await import("../js/data/fundamentals.js?ui-success");
  const [first, second] = await Promise.all([success.loadFundamentalsSnapshot(), success.loadFundamentalsSnapshot()]);
  assert.equal(count, 1);
  assert.equal(first, second);
  assert.equal(first.byTicker.ACME.available, true);
  assert.equal(first.providerStatus, "partial");
  assert.equal(first.failures[0].reason, "SEC request returned HTTP 403.");
  assert.equal(first.indexStatus, "fallback");
  assert.equal(first.indexError, "Index denied");
  globalThis.fetch = async () => new Response("Access denied", { status: 403 });
  const forbidden = await import("../js/data/fundamentals.js?ui-forbidden");
  const unavailable = await forbidden.loadFundamentalsSnapshot();
  assert.deepEqual(unavailable.byTicker, {});
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.snapshotStatus, "unavailable");
  assert.equal(unavailable.providerStatus, "unknown");
  assert.match(unavailable.reason, /HTTP 403/);
  assert.match(unavailable.reason, /not estimated/);
  globalThis.fetch = async () => new Response(JSON.stringify({ schemaVersion: 9, byTicker: [] }));
  const malformed = await import("../js/data/fundamentals.js?ui-malformed");
  assert.equal((await malformed.loadFundamentalsSnapshot()).available, false);
});

test("snapshot client preserves Yahoo provenance and independent SEC diagnostics", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const data = { ...snapshot(yahooRecord({ fallbackReason: "SEC access denied" })), providerStatus: "available", failures: [],
    secProviderStatus: "unavailable", secFailures: [{ ticker: "ACME", reason: "SEC request returned HTTP 403.", status: 403 }],
    yahooSuccessfulRequests: 1 };
  let count = 0;
  globalThis.fetch = async () => { count += 1; return Response.json(data); };
  const client = await import("../js/data/fundamentals.js?ui-yahoo-provenance");
  const [first, second] = await Promise.all([client.loadFundamentalsSnapshot(), client.loadFundamentalsSnapshot()]);
  assert.equal(count, 1);
  assert.equal(first, second);
  assert.deepEqual(first, data);
  assert.equal(first.byTicker.ACME.metricSources.revenue[0].filed, null);
  assert.equal(first.byTicker.ACME.metricSources.dilutedEPS[0].periodType, "12M");
});
