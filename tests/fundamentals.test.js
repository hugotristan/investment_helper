import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { normalizeSecCompanyFacts } from "../js/analysis/fundamentals.js";
import { normalizeYahooFinancials } from "../js/analysis/yahoo-fundamentals.js";
import { YahooFetchError } from "../scripts/yahoo-fundamentals.mjs";
import { buildTickerIndex, createSecFetcher, generateFundamentalsSnapshot, main, mergeConfirmedEarnings,
  resolveTickerIndex, SEC_TICKER_INDEX_URL, SecFetchError } from "../scripts/update-fundamentals.mjs";

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
  const previous = { byTicker: { BAD: { ...normalized({ ...fixture(), cik: 999 }), ticker: "BAD", retrievedAt: "2026-09-01T00:00:00.000Z" } } };
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

function verifiedIndex(companyTickers = { 0: { ticker: "ACME", cik_str: 123456, title: "Example Company" } }, verifiedAt = RETRIEVED) {
  return { schemaVersion: 1, sourceUrl: SEC_TICKER_INDEX_URL, verifiedAt, companyTickers };
}

test("ticker resolution keeps verified cache and previous mappings when live rows are malformed", () => {
  const previous = { byTicker: { SAVED: { ...normalized(), ticker: "SAVED" } } };
  const resolved = resolveTickerIndex({ live: {
    0: { ticker: "ACME", cik_str: "invalid" }, 1: { ticker: "NEW", cik_str: 999, title: "Verified live issuer" }
  }, fallback: verifiedIndex(), previous, now: NOW });
  const mappings = buildTickerIndex(resolved.companyTickers);
  assert.equal(mappings.get("ACME").cik, "123456");
  assert.equal(mappings.get("SAVED").cik, "123456");
  assert.equal(mappings.get("NEW").cik, "999");
  assert.equal(resolved.indexStatus, "live");
  assert.match(resolved.indexSource, /Verified SEC snapshot/);
  assert.match(resolved.indexSource, /Previous SEC records/);
  assert.match(resolved.indexError, /Malformed/);
  assert.equal(buildTickerIndex({ 0: { ticker: "BAD NAME", cik_str: 1 }, 1: { ticker: "ZERO", cik_str: "0000" },
    2: { ticker: "LONG", cik_str: "12345678901" } }).size, 0);
});

test("cached ticker mappings require genuine source metadata and a bounded verification age", () => {
  assert.equal(resolveTickerIndex({ fallback: verifiedIndex(), now: NOW + 30 * 86400000 }).indexStatus, "fallback");
  for (const fallback of [
    verifiedIndex({}, RETRIEVED), { ...verifiedIndex(), schemaVersion: 2 },
    { ...verifiedIndex(), sourceUrl: "https://example.com/tickers.json" },
    verifiedIndex(undefined, new Date(NOW + 1).toISOString())
  ]) assert.equal(resolveTickerIndex({ fallback, now: NOW }).indexStatus, "unavailable");
  assert.equal(resolveTickerIndex({ fallback: verifiedIndex(), now: NOW + 30 * 86400000 + 1 }).indexStatus, "unavailable");
  const staleProof = { ...normalized(), retrievedAt: RETRIEVED,
    tickerMapping: { cik: "123456", sourceUrl: SEC_TICKER_INDEX_URL, verifiedAt: "2026-08-01T00:00:00.000Z" } };
  assert.equal(resolveTickerIndex({ previous: { byTicker: { ACME: staleProof } }, now: NOW }).indexStatus, "unavailable");
});

test("a ticker-index error cannot globally block companyfacts when verified mappings exist", async () => {
  let calls = 0;
  const snapshot = await generateFundamentalsSnapshot({ tickers: ["ACME"], companyTickers: verifiedIndex().companyTickers,
    providerError: new SecFetchError("Ticker index denied", 403), retrievedAt: RETRIEVED,
    fetchFacts: async () => { calls += 1; return fixture(); } });
  assert.equal(calls, 1);
  assert.equal(snapshot.providerStatus, "available");
  assert.equal(snapshot.byTicker.ACME.metrics.revenue, 120);
});

test("changed issuer mappings never retain another issuer's old financial figures", async () => {
  const snapshot = await generateFundamentalsSnapshot({ tickers: ["ACME"], previous: { byTicker: { ACME: normalized() } },
    companyTickers: { 0: { ticker: "ACME", cik_str: 999 } }, retrievedAt: RETRIEVED,
    fetchFacts: async () => { throw new SecFetchError("Facts unavailable", 503); } });
  assert.equal(snapshot.byTicker.ACME.available, false);
  assert.equal(snapshot.byTicker.ACME.cik, "999");
  assert.equal(snapshot.byTicker.ACME.metrics.revenue, null);
  assert.equal(snapshot.byTicker.ACME.retrievedAt, null);
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "investment-helper-sec-"));
  assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}investment-helper-sec-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("CLI falls back after live-index403, fetches real provider data, and reports independent diagnostics", async (t) => {
  const directory = await temporaryDirectory(t);
  const output = join(directory, "fundamentals.json");
  const tickerIndex = join(directory, "sec-tickers.json");
  const savedIndex = JSON.stringify(verifiedIndex());
  await writeFile(tickerIndex, savedIndex);
  const urls = [];
  const snapshot = await main(["--output", output, "--ticker-index", tickerIndex, "--calendar", join(directory, "none.json"), "--tickers", "ACME"], {
    now: () => NOW, fetchYahooFacts: async () => { throw new Error("SEC data should be preferred."); }, fetchSec: async (url) => {
      urls.push(url);
      if (url === SEC_TICKER_INDEX_URL) throw new SecFetchError("SEC request returned HTTP 403.", 403);
      return fixture();
    }
  });
  assert.deepEqual(urls, [SEC_TICKER_INDEX_URL, "https://data.sec.gov/api/xbrl/companyfacts/CIK0000123456.json"]);
  assert.equal(snapshot.indexStatus, "fallback");
  assert.match(snapshot.indexError, /403/);
  assert.equal(snapshot.indexVerifiedAt, RETRIEVED);
  assert.equal(snapshot.providerStatus, "available");
  assert.equal(snapshot.failures.length, 0);
  assert.equal(snapshot.byTicker.ACME.metrics.revenue, 120);
  assert.equal(snapshot.byTicker.ACME.tickerMapping.verifiedAt, RETRIEVED);
  assert.equal(await readFile(tickerIndex, "utf8"), savedIndex);
  assert.equal(JSON.parse(await readFile(output, "utf8")).byTicker.ACME.available, true);
});

test("CLI leaves valid cached mappings and financial acquisition dates intact on malformed live data and facts failures", async (t) => {
  const directory = await temporaryDirectory(t);
  const output = join(directory, "fundamentals.json");
  const tickerIndex = join(directory, "sec-tickers.json");
  const cached = verifiedIndex(undefined, "2026-10-01T16:00:00.000Z");
  const savedIndex = JSON.stringify(cached);
  const previousRecord = { ...normalized(), retrievedAt: "2026-10-02T16:00:00.000Z" };
  await writeFile(tickerIndex, savedIndex);
  await writeFile(output, JSON.stringify({ byTicker: { ACME: previousRecord } }));
  const snapshot = await main(["--output", output, "--ticker-index", tickerIndex, "--calendar", join(directory, "none.json"), "--tickers", "ACME"], {
    now: () => NOW, fetchYahooFacts: async () => { throw new YahooFetchError("Yahoo unavailable", 503); }, fetchSec: async (url) => {
      if (url === SEC_TICKER_INDEX_URL) return { 0: { ticker: "ACME", cik_str: "bad" } };
      throw new SecFetchError("Company facts unavailable", 503);
    }
  });
  assert.equal(snapshot.indexStatus, "fallback");
  assert.equal(snapshot.providerStatus, "unavailable");
  assert.match(snapshot.indexError, /no valid/);
  assert.equal(snapshot.byTicker.ACME.retrievedAt, previousRecord.retrievedAt);
  assert.equal(snapshot.byTicker.ACME.metrics.revenue, 120);
  assert.equal(await readFile(tickerIndex, "utf8"), savedIndex);
});

function yahooFixture(ticker = "ACME") {
  return { timeseries: { result: [{
    meta: { symbol: [ticker], type: ["annualTotalRevenue"] },
    annualTotalRevenue: [
      { asOfDate: "2025-12-31", periodType: "12M", currencyCode: "USD", reportedValue: { raw: 200 } },
      { asOfDate: "2024-12-31", periodType: "12M", currencyCode: "USD", reportedValue: { raw: 160 } }
    ]
  }] } };
}

test("SEC403 falls back to usable dated Yahoo data without mislabeling the refresh as failed", async () => {
  const snapshot = await generateFundamentalsSnapshot({ tickers: ["ACME"], companyTickers: verifiedIndex().companyTickers,
    retrievedAt: RETRIEVED, fetchFacts: async () => { throw new SecFetchError("SEC denied", 403); },
    fetchYahooFacts: async (ticker) => yahooFixture(ticker) });
  assert.equal(snapshot.providerStatus, "available");
  assert.equal(snapshot.secProviderStatus, "unavailable");
  assert.equal(snapshot.secFailures.length, 1);
  assert.equal(snapshot.failures.length, 0);
  assert.equal(snapshot.secSuccessfulRequests, 0);
  assert.equal(snapshot.yahooSuccessfulRequests, 1);
  assert.equal(snapshot.successfulRequests, 1);
  const record = snapshot.byTicker.ACME;
  assert.equal(record.provider, "Yahoo Finance");
  assert.equal(record.cik, null);
  assert.equal(record.retrievedAt, RETRIEVED);
  assert.equal(record.metrics.revenue, 200);
  assert.equal(record.metricSources.revenue[0].filed, null);
  assert.equal(record.tickerMapping.cik, "123456");
  assert.match(record.fallbackReason, /SEC denied/);
});

test("SEC's two-issuer circuit does not suppress Yahoo attempts for later stocks", async () => {
  const tickers = ["ONE", "TWO", "THREE"];
  const companyTickers = Object.fromEntries(tickers.map((ticker, index) => [index, { ticker, cik_str: index + 1 }]));
  const secCalls = [];
  const yahooCalls = [];
  const snapshot = await generateFundamentalsSnapshot({ tickers, companyTickers, retrievedAt: RETRIEVED,
    fetchFacts: async (cik) => { secCalls.push(cik); throw new SecFetchError("Denied", 403); },
    fetchYahooFacts: async (ticker) => { yahooCalls.push(ticker); return yahooFixture(ticker); } });
  assert.deepEqual(secCalls, ["1", "2"]);
  assert.deepEqual(yahooCalls, tickers);
  assert.equal(snapshot.providerStatus, "available");
  assert.equal(snapshot.secFailures.length, 3);
  assert.equal(snapshot.failures.length, 0);
  assert.equal(snapshot.yahooSuccessfulRequests, 3);
});

test("missing SEC mappings and unsupported annual SEC facts can still use Yahoo", async () => {
  const unknown = await generateFundamentalsSnapshot({ tickers: ["ACME"], providerError: new SecFetchError("Index denied", 403),
    retrievedAt: RETRIEVED, fetchFacts: async () => { throw new Error("No CIK is available."); },
    fetchYahooFacts: async (ticker) => yahooFixture(ticker) });
  assert.equal(unknown.byTicker.ACME.available, true);
  assert.equal(unknown.byTicker.ACME.provider, "Yahoo Finance");
  assert.equal(unknown.providerStatus, "available");
  const unsupported = await generateFundamentalsSnapshot({ tickers: ["ACME"], companyTickers: verifiedIndex().companyTickers,
    retrievedAt: RETRIEVED, fetchFacts: async () => ({ cik: 123456, entityName: "Example Company", facts: {} }),
    fetchYahooFacts: async (ticker) => yahooFixture(ticker) });
  assert.equal(unsupported.byTicker.ACME.metrics.revenue, 200);
  assert.equal(unsupported.secSuccessfulRequests, 0);
  assert.equal(unsupported.yahooSuccessfulRequests, 1);
  assert.match(unsupported.secFailures[0].reason, /No supported annual/);
});

test("SEC stays preferred when its validated annual financials are usable", async () => {
  let yahooCalls = 0;
  const snapshot = await generateFundamentalsSnapshot({ tickers: ["ACME"], companyTickers: verifiedIndex().companyTickers,
    retrievedAt: RETRIEVED, fetchFacts: async () => fixture(),
    fetchYahooFacts: async () => { yahooCalls += 1; return yahooFixture(); } });
  assert.equal(yahooCalls, 0);
  assert.equal(snapshot.byTicker.ACME.provider, "SEC companyfacts");
  assert.equal(snapshot.byTicker.ACME.metrics.revenue, 120);
  assert.equal(snapshot.secSuccessfulRequests, 1);
  assert.equal(snapshot.yahooSuccessfulRequests, 0);
  assert.equal(snapshot.secProviderStatus, "available");
  assert.equal(snapshot.secFailures.length, 0);
});

test("failed Yahoo fallback retains the original Yahoo acquisition date and independent mapping proof", async () => {
  const originalDate = "2026-10-01T16:00:00.000Z";
  const previousRecord = normalizeYahooFinancials(yahooFixture(), { ticker: "ACME", retrievedAt: originalDate });
  const companyTickers = resolveTickerIndex({ fallback: verifiedIndex(), now: NOW }).companyTickers;
  const snapshot = await generateFundamentalsSnapshot({ tickers: ["ACME"], previous: { byTicker: { ACME: previousRecord } },
    companyTickers, retrievedAt: RETRIEVED, fetchFacts: async () => { throw new SecFetchError("SEC denied", 403); },
    fetchYahooFacts: async () => { throw new YahooFetchError("Yahoo unavailable", 503); } });
  assert.equal(snapshot.providerStatus, "unavailable");
  assert.equal(snapshot.byTicker.ACME.provider, "Yahoo Finance");
  assert.equal(snapshot.byTicker.ACME.cik, null);
  assert.equal(snapshot.byTicker.ACME.retrievedAt, originalDate);
  assert.equal(snapshot.byTicker.ACME.metrics.revenue, 200);
  assert.match(snapshot.failures[0].reason, /Yahoo unavailable/);
  const resolved = resolveTickerIndex({ previous: snapshot, now: NOW + 86400000 });
  assert.equal(buildTickerIndex(resolved.companyTickers).get("ACME").cik, "123456");
  assert.equal(resolved.indexVerifiedAt, RETRIEVED);
  assert.equal(previousRecord.tickerMapping, undefined);
});

test("neither provider can attribute another issuer or ticker's financials", async () => {
  const snapshot = await generateFundamentalsSnapshot({ tickers: ["ACME"], companyTickers: { 0: { ticker: "ACME", cik_str: 999 } },
    previous: { byTicker: { ACME: normalized() } }, retrievedAt: RETRIEVED, fetchFacts: async () => fixture(),
    fetchYahooFacts: async () => yahooFixture("OTHER") });
  assert.equal(snapshot.byTicker.ACME.available, false);
  assert.equal(snapshot.byTicker.ACME.metrics.revenue, null);
  assert.equal(snapshot.byTicker.ACME.retrievedAt, null);
  assert.match(snapshot.secFailures[0].reason, /identity/);
  assert.equal(snapshot.failures.length, 1);
  assert.equal(snapshot.yahooSuccessfulRequests, 0);
});

test("the overall duration budget gates Yahoo as well as later SEC requests", async () => {
  let clock = NOW;
  const secCalls = [];
  const yahooCalls = [];
  const snapshot = await generateFundamentalsSnapshot({ tickers: ["ONE", "TWO"], retrievedAt: RETRIEVED,
    companyTickers: { 0: { ticker: "ONE", cik_str: 1 }, 1: { ticker: "TWO", cik_str: 2 } },
    maximumDurationMs: 10, now: () => clock,
    fetchFacts: async (cik) => { secCalls.push(cik); clock += 11; throw new SecFetchError("Denied", 403); },
    fetchYahooFacts: async (ticker) => { yahooCalls.push(ticker); return yahooFixture(ticker); } });
  assert.deepEqual(secCalls, ["1"]);
  assert.deepEqual(yahooCalls, []);
  assert.equal(snapshot.failures.length, 2);
  assert.match(snapshot.failures[0].reason, /time budget/);
});

test("CLI uses Yahoo when the SEC index cannot be resolved and writes separate SEC diagnostics", async (t) => {
  const directory = await temporaryDirectory(t);
  const output = join(directory, "fundamentals.json");
  const snapshot = await main(["--output", output, "--ticker-index", join(directory, "none-index.json"),
    "--calendar", join(directory, "none-calendar.json"), "--tickers", "ACME"], {
    now: () => NOW, fetchSec: async () => { throw new SecFetchError("SEC index denied", 403); },
    fetchYahooFacts: async (ticker) => yahooFixture(ticker)
  });
  assert.equal(snapshot.indexStatus, "unavailable");
  assert.equal(snapshot.providerStatus, "available");
  assert.equal(snapshot.secProviderStatus, "unavailable");
  assert.equal(snapshot.failures.length, 0);
  assert.equal(snapshot.secFailures.length, 1);
  assert.equal(JSON.parse(await readFile(output, "utf8")).byTicker.ACME.provider, "Yahoo Finance");
});
