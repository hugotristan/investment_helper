import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSecCompanyFacts } from "../js/analysis/fundamentals.js";
import { buildTickerIndex, createSecFetcher, generateFundamentalsSnapshot, mergeConfirmedEarnings, SecFetchError } from "../scripts/update-fundamentals.mjs";

const RETRIEVED = "2026-10-05T16:00:00.000Z";
const NOW = Date.parse(RETRIEVED);

function annual(value, year = 2025, overrides = {}) {
  return { start: `${year}-01-01`, end: `${year}-12-31`, val: value,
    accn: "0000123456-26-000001", filed: "2026-02-15", form: "10-K", fy: 2025, ...overrides };
}

function fixture() {
  const rows = {
    RevenueFromContractWithCustomerExcludingAssessedTax: [annual(120), annual(100, 2024)],
    NetIncomeLoss: [annual(30), annual(20, 2024)],
    NetCashProvidedByUsedInOperatingActivities: [annual(60), annual(40, 2024)],
    PaymentsToAcquirePropertyPlantAndEquipment: [annual(10), annual(8, 2024)],
    EarningsPerShareDiluted: [annual(3), annual(2, 2024)],
    EarningsPerShareBasic: [annual(3.1), annual(2.1, 2024)],
    DebtCurrent: [annual(20, 2025, { start: undefined })],
    LongTermDebtNoncurrent: [annual(30, 2025, { start: undefined })],
    Liabilities: [annual(999, 2025, { start: undefined })]
  };
  return { cik: 123456, entityName: "Example Company", facts: { "us-gaap": Object.fromEntries(Object.entries(rows)
    .map(([tag, facts]) => [tag, { units: { [tag.startsWith("EarningsPerShare") ? "USD/shares" : "USD"]: facts } }])) } };
}

function normalized(facts = fixture()) { return normalizeSecCompanyFacts(facts, { ticker: "ACME", retrievedAt: RETRIEVED }); }

test("annual metrics, free cash flow, same-currency growth, EPS and per-metric SEC provenance are normalized", () => {
  const record = normalized();
  assert.equal(record.available, true);
  assert.equal(record.periodEnd, "2025-12-31");
  assert.equal(record.currency, "USD");
  assert.equal(record.fiscalYear, null);
  assert.equal(record.metrics.revenue, 120);
  assert.equal(record.metrics.freeCashFlow, 50);
  assert.equal(record.metrics.totalDebt, 50);
  assert.equal(record.metrics.dilutedEPS, 3);
  assert(Math.abs(record.metrics.revenueGrowth - 0.2) < 1e-10);
  assert.equal(record.metrics.netIncomeGrowth, 0.5);
  assert.equal(record.metricSources.freeCashFlow.length, 2);
  assert.equal(record.metricSources.freeCashFlowGrowth.length, 4);
  assert.deepEqual(record.metricSources.revenueGrowth.map((source) => source.end), ["2025-12-31", "2024-12-31"]);
  const source = record.metricSources.dilutedEPS[0];
  assert.equal(source.unit, "USD/shares");
  assert.equal(source.end, record.periodEnd);
  assert.equal(source.filed, "2026-02-15");
  assert.match(source.url, /^https:\/\/www.sec.gov\/Archives\/edgar\/data\/123456\/000012345626000001\/0000123456-26-000001-index.html$/);
});

test("selection uses actual annual period and latest restatement, excluding quarterly and irregular durations", () => {
  const facts = fixture();
  const revenue = facts.facts["us-gaap"].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD;
  revenue.push(annual(110, 2024, { filed: "2026-03-01", form: "10-K/A", accn: "0000123456-26-000002", fy: 2025 }));
  revenue.push(annual(999, 2026, { start: "2026-01-01", end: "2026-06-30", filed: "2026-07-01", form: "10-Q" }));
  revenue.push(annual(888, 2025, { start: "2025-04-01", filed: "2026-04-01" }));
  const record = normalized(facts);
  assert.equal(record.periodEnd, "2025-12-31");
  assert.equal(record.metrics.revenue, 120);
  assert(Math.abs(record.metrics.revenueGrowth - (120 / 110 - 1)) < 1e-10);
  assert.equal(record.metricSources.revenueGrowth[1].filed, "2026-03-01");
});

test("missing concepts and different currencies remain null without substituting liabilities for debt", () => {
  const facts = fixture();
  delete facts.facts["us-gaap"].PaymentsToAcquirePropertyPlantAndEquipment;
  delete facts.facts["us-gaap"].DebtCurrent;
  facts.facts["us-gaap"].NetIncomeLoss.units = { EUR: [annual(30), annual(20, 2024)] };
  facts.facts["us-gaap"].EarningsPerShareDiluted.units = { "EUR/shares": [annual(3)] };
  const record = normalized(facts);
  for (const metric of ["capitalExpenditures", "freeCashFlow", "freeCashFlowGrowth", "totalDebt", "netIncome", "netIncomeGrowth", "dilutedEPS"]) {
    assert.equal(record.metrics[metric], null);
    assert.deepEqual(record.metricSources[metric], []);
  }
  assert.equal(record.metrics.revenue, 120);
});

test("free cash flow requires identical cash-flow and capex accounting periods", () => {
  const facts = fixture();
  facts.facts["us-gaap"].PaymentsToAcquirePropertyPlantAndEquipment.units.USD[0].start = "2025-01-15";
  const record = normalized(facts);
  assert.equal(record.metrics.capitalExpenditures, 10);
  assert.equal(record.metrics.operatingCashFlow, 60);
  assert.equal(record.metrics.freeCashFlow, null);
  assert.equal(record.metrics.freeCashFlowGrowth, null);
});

test("growth rejects missing or non-positive baselines and materially different annual durations", () => {
  const facts = fixture();
  facts.facts["us-gaap"].NetIncomeLoss.units.USD[1].val = -20;
  facts.facts["us-gaap"].NetCashProvidedByUsedInOperatingActivities.units.USD[1].val = 0;
  facts.facts["us-gaap"].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD[1].start = "2024-01-25";
  const record = normalized(facts);
  assert.equal(record.metrics.netIncomeGrowth, null);
  assert.equal(record.metrics.operatingCashFlowGrowth, null);
  assert.equal(record.metrics.revenueGrowth, null);
});

test("ticker mapping and snapshot generation deduplicate issuers while preserving old acquisition dates on failure", async () => {
  const companyTickers = { 0: { ticker: "ACME", cik_str: 123456 }, 1: { ticker: "ACME-B", cik_str: 123456 }, 2: { ticker: "BAD", cik_str: 999 } };
  assert.equal(buildTickerIndex(companyTickers).get("ACME-B").cik, "123456");
  const previous = { byTicker: { BAD: { ...normalized(), ticker: "BAD", retrievedAt: "2026-09-01T00:00:00.000Z" } } };
  const calls = [];
  const snapshot = await generateFundamentalsSnapshot({ tickers: ["ACME", "ACME-B", "BAD", "SPY"], companyTickers, previous,
    retrievedAt: RETRIEVED, fetchFacts: async (cik) => { calls.push(cik); if (cik === "999") throw new SecFetchError("Unavailable", 503); return fixture(); } });
  assert.deepEqual(calls, ["123456", "999"]);
  assert.equal(snapshot.byTicker["ACME-B"].metrics.revenue, 120);
  assert.equal(snapshot.byTicker.BAD.retrievedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(snapshot.byTicker.SPY.status, "not_covered");
  assert.equal(snapshot.byTicker.SPY.metrics.revenue, null);
});

test("two issuer access denials stop the provider loop and preserve earlier snapshots", async () => {
  const companyTickers = Object.fromEntries(["ONE", "TWO", "THREE"].map((ticker, index) => [index, { ticker, cik_str: index + 1 }]));
  const calls = [];
  const snapshot = await generateFundamentalsSnapshot({ tickers: ["ONE", "TWO", "THREE"], companyTickers, retrievedAt: RETRIEVED,
    fetchFacts: async (cik) => { calls.push(cik); throw new SecFetchError("Denied", 403); } });
  assert.deepEqual(calls, ["1", "2"]);
  assert.equal(snapshot.byTicker.THREE.available, false);
  assert.equal(snapshot.byTicker.THREE.retrievedAt, null);
  assert.equal(snapshot.providerStatus, "unavailable");
});

test("mismatched issuer responses remain unavailable rather than attributing another company's figures", async () => {
  const snapshot = await generateFundamentalsSnapshot({ tickers: ["OTHER"], companyTickers: { 0: { ticker: "OTHER", cik_str: 999 } },
    retrievedAt: RETRIEVED, fetchFacts: async () => fixture() });
  assert.equal(snapshot.byTicker.OTHER.available, false);
  assert.equal(snapshot.byTicker.OTHER.metrics.revenue, null);
  assert.equal(snapshot.byTicker.OTHER.retrievedAt, null);
  assert.match(snapshot.byTicker.OTHER.reason, /identity did not match/);
});

test("confirmed future issuer calendar entries merge even when SEC indexing is unavailable", async () => {
  const calendar = { byTicker: { ACME: { date: "2026-10-20", status: "confirmed", source: "Issuer investor relations", sourceUrl: "https://example.com/ir/earnings", verifiedAt: RETRIEVED } } };
  const snapshot = await generateFundamentalsSnapshot({ tickers: ["ACME"], providerError: new SecFetchError("Index denied", 403), calendar,
    retrievedAt: RETRIEVED, fetchFacts: async () => { throw new Error("Should not fetch"); } });
  assert.equal(snapshot.byTicker.ACME.available, false);
  assert.equal(snapshot.byTicker.ACME.earnings.date, "2026-10-20");
  assert.equal(snapshot.byTicker.ACME.earnings.status, "confirmed");
  assert.equal(mergeConfirmedEarnings(snapshot.byTicker.ACME, { ...calendar.byTicker.ACME, date: "2026-09-20" }, { now: NOW }).earnings.date, "2026-10-20");
  assert.equal(mergeConfirmedEarnings({ earnings: null }, { ...calendar.byTicker.ACME, status: "estimated" }, { now: NOW }).earnings, null);
  assert.equal(mergeConfirmedEarnings({ earnings: null }, { ...calendar.byTicker.ACME, sourceUrl: "javascript:bad" }, { now: NOW }).earnings, null);
});

test("SEC fetcher identifies the project, paces requests, bounds retries and never retries HTTP403", async () => {
  let clock = 0;
  const waits = [];
  const calls = [];
  const fetchSec = createSecFetcher({ now: () => clock, wait: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response("{}", { status: url.endsWith("denied") ? 403 : 200 }); } });
  await fetchSec("https://www.sec.gov/first");
  await fetchSec("https://www.sec.gov/second");
  await assert.rejects(fetchSec("https://www.sec.gov/denied"), (error) => error.status === 403);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [500, 500]);
  assert.match(calls[0].options.headers["User-Agent"], /github.com\/hugotristan\/investment_helper/);
  let failures = 0;
  const retry = createSecFetcher({ wait: async () => {}, fetchImpl: async () => { failures += 1; return new Response("", { status: 503 }); } });
  await assert.rejects(retry("https://www.sec.gov/failed"), (error) => error.status === 503);
  assert.equal(failures, 2);
});
