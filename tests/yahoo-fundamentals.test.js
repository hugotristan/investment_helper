import test from "node:test";
import assert from "node:assert/strict";
import { normalizeYahooFinancials, YAHOO_ANNUAL_TYPES } from "../js/analysis/yahoo-fundamentals.js";
import { createYahooFetcher, YahooFetchError } from "../scripts/yahoo-fundamentals.mjs";

const RETRIEVED = "2026-10-07T12:00:00.000Z";
const TYPES = {
  annualTotalRevenue: [120, 100], annualNetIncome: [30, 20], annualOperatingCashFlow: [60, 40],
  annualCapitalExpenditure: [-10, -8], annualFreeCashFlow: [50, 32], annualTotalDebt: [45, 40],
  annualDilutedEPS: [3, 2], annualBasicEPS: [3.1, 2.1]
};

function annual(value, date = "2025-12-31", overrides = {}) {
  return { asOfDate: date, periodType: "12M", currencyCode: "USD", reportedValue: { raw: value, fmt: String(value) }, ...overrides };
}

function fixture() {
  return { timeseries: { error: null, result: Object.entries(TYPES).map(([type, values]) => ({
    meta: { symbol: ["ACME"], type: [type] }, [type]: [annual(values[1], "2024-12-31"), annual(values[0])]
  })) } };
}

function rows(json, type) { return json.timeseries.result.find((result) => result.meta.type[0] === type)[type]; }
function normalize(json = fixture(), options = {}) {
  return normalizeYahooFinancials(json, { ticker: "ACME", retrievedAt: RETRIEVED, companyName: "Acme Company", ...options });
}
function response(status = 200, json = fixture(), retryAfter = null) {
  return { ok: status >= 200 && status < 300, status, json: async () => json, headers: { get: () => retryAfter } };
}
function clock() {
  let time = Date.parse(RETRIEVED);
  const delays = [];
  return { now: () => time, wait: async (delay) => { delays.push(delay); time += delay; }, delays };
}

test("annual facts retain provider provenance without invented SEC or fiscal dates", () => {
  const record = normalize();
  assert.equal(record.available, true);
  assert.equal(record.status, "available");
  assert.equal(record.periodType, "12M");
  assert.equal(record.provider, "Yahoo Finance");
  assert.equal(record.companyName, "Acme Company");
  assert.equal(record.currency, "USD");
  assert.equal(record.periodEnd, "2025-12-31");
  assert.equal(record.retrievedAt, RETRIEVED);
  assert.equal(record.cik, null);
  assert.equal(record.fiscalYear, null);
  assert.match(record.reason, /provider period dates may be nominal/);
  assert.equal(record.metrics.revenue, 120);
  assert.equal(record.metrics.netIncome, 30);
  assert.equal(record.metrics.operatingCashFlow, 60);
  assert.equal(record.metrics.freeCashFlow, 50);
  assert.equal(record.metrics.totalDebt, 45);
  assert.equal(record.metrics.dilutedEPS, 3);
  assert.equal(record.metrics.basicEPS, 3.1);
  for (const sources of Object.values(record.metricSources)) {
    for (const source of sources) {
      assert.equal(source.provider, "Yahoo Finance");
      assert.equal(source.periodType, "12M");
      assert.equal(source.start, null);
      assert.equal(source.filed, null);
      assert.equal(source.accession, null);
      assert.equal(typeof source.value, "number");
      assert.match(source.url, /^https:\/\/finance\.yahoo\.com\/quote\/ACME\//);
    }
  }
  assert.equal(record.metricSources.dilutedEPS[0].unit, "USD/shares");
  assert.equal(record.metricSources.basicEPS[0].unit, "USD/shares");
  assert.equal(record.metricSources.revenue[0].unit, "USD");
  assert.match(record.metricSources.totalDebt[0].url, /\/balance-sheet\/$/);
  assert.match(record.metricSources.operatingCashFlow[0].url, /\/cash-flow\/$/);
  assert.match(record.metricSources.revenue[0].url, /\/financials\/$/);
  assert.ok(Math.abs(record.metrics.revenueGrowth - 0.2) < 1e-12);
  assert.equal(record.metrics.netIncomeGrowth, 0.5);
  assert.equal(record.metrics.operatingCashFlowGrowth, 0.5);
  assert.equal(record.metrics.freeCashFlowGrowth, 0.5625);
  assert.deepEqual(record.metricSources.revenueGrowth.map((source) => source.end), ["2025-12-31", "2024-12-31"]);
});

test("negative capital expenditure is an explicit outflow transformation and preserves the raw source", () => {
  const record = normalize();
  assert.equal(record.metrics.capitalExpenditures, 10);
  assert.equal(record.metricSources.capitalExpenditures[0].value, -10);
  assert.match(record.metricSources.capitalExpenditures[0].transformation, /Absolute value.*cash outflow/);
  const positive = fixture();
  rows(positive, "annualCapitalExpenditure")[1] = annual(11);
  const positiveRecord = normalize(positive);
  assert.equal(positiveRecord.metrics.capitalExpenditures, 11);
  assert.equal(positiveRecord.metricSources.capitalExpenditures[0].transformation, undefined);
});

test("issuer and annual concept metadata must match exactly", () => {
  for (const mutate of [
    (meta) => { meta.symbol = ["OTHER"]; },
    (meta) => { meta.symbol = ["ACME", "OTHER"]; },
    (meta) => { meta.symbol = "ACME"; },
    (meta) => { meta.type = ["quarterlyTotalRevenue"]; },
    (meta) => { meta.type = ["annualTotalRevenue", "annualNetIncome"]; },
    (meta) => { delete meta.type; }
  ]) {
    const json = fixture();
    json.timeseries.result.forEach((result) => mutate(result.meta));
    const record = normalize(json);
    assert.equal(record.available, false);
    assert.ok(Object.values(record.metrics).every((value) => value === null));
  }
  for (const json of [null, {}, { timeseries: { error: { code: "Not Found" }, result: [] } }]) {
    assert.equal(normalize(json).available, false);
  }
  assert.equal(normalize(fixture(), { retrievedAt: "invalid" }).retrievedAt, null);
  assert.equal(normalize(fixture(), { ticker: "ACME/OTHER" }).available, false);
});

test("quarterly, future, malformed, untyped and non-finite observations remain unavailable", () => {
  for (const observation of [
    annual(120, "2025-12-31", { periodType: "3M" }),
    annual(120, "2025-12-31", { periodType: "TTM" }),
    annual(120, "2026-12-31"), annual(120, "2025-02-30"),
    annual(120, "2025-12-31", { currencyCode: "usd" }),
    annual(120, "2025-12-31", { currencyCode: "GBp" }),
    annual(120, "2025-12-31", { currencyCode: "ZZZ" }),
    annual(Infinity), annual(NaN), annual("120"),
    annual(120, "2025-12-31", { reportedValue: { fmt: "120B" } }), null
  ]) {
    const json = { timeseries: { result: [{ meta: { symbol: ["ACME"], type: ["annualTotalRevenue"] }, annualTotalRevenue: [observation] }] } };
    assert.equal(normalize(json).available, false);
  }
  const negativeDebt = fixture();
  rows(negativeDebt, "annualTotalDebt")[1] = annual(-1);
  assert.equal(normalize(negativeDebt).metrics.totalDebt, null);
});

test("missing free cash flow or reported debt is never fabricated from adjacent concepts", () => {
  const json = fixture();
  json.timeseries.result = json.timeseries.result.filter((result) => !["annualFreeCashFlow", "annualTotalDebt"].includes(result.meta.type[0]));
  json.timeseries.result.push({ meta: { symbol: ["ACME"], type: ["annualTotalLiabilitiesNetMinorityInterest"] }, annualTotalLiabilitiesNetMinorityInterest: [annual(999)] });
  const record = normalize(json);
  assert.equal(record.metrics.operatingCashFlow, 60);
  assert.equal(record.metrics.capitalExpenditures, 10);
  assert.equal(record.metrics.freeCashFlow, null);
  assert.equal(record.metrics.freeCashFlowGrowth, null);
  assert.deepEqual(record.metricSources.freeCashFlow, []);
  assert.equal(record.metrics.totalDebt, null);
  assert.deepEqual(record.metricSources.totalDebt, []);
});

test("conflicting duplicate values or currencies block that metric rather than choosing the last entry", () => {
  for (const duplicate of [annual(121), annual(120, "2025-12-31", { currencyCode: "EUR" })]) {
    const json = fixture();
    rows(json, "annualTotalRevenue").push(duplicate, annual(120));
    const record = normalize(json);
    assert.equal(record.metrics.revenue, null);
    assert.equal(record.metrics.revenueGrowth, null);
    assert.deepEqual(record.metricSources.revenue, []);
    assert.equal(record.metrics.netIncome, 30);
  }
  const identical = fixture();
  rows(identical, "annualTotalRevenue").push(annual(120));
  assert.equal(normalize(identical).metrics.revenue, 120);
  assert.equal(normalize(identical).metricSources.revenue.length, 1);
  const allConflicting = { timeseries: { result: [{ meta: { symbol: ["ACME"], type: ["annualTotalRevenue"] },
    annualTotalRevenue: [annual(100, "2024-12-31"), annual(120), annual(121)] }] } };
  assert.equal(normalize(allConflicting).available, false);
  assert.equal(normalize(allConflicting).periodEnd, "2025-12-31");
});

test("one common provider period and currency keeps older or differently denominated metrics out", () => {
  const mixed = fixture();
  for (const type of ["annualNetIncome", "annualDilutedEPS", "annualBasicEPS"]) {
    rows(mixed, type)[1].currencyCode = "EUR";
  }
  const record = normalize(mixed);
  assert.equal(record.currency, "USD");
  assert.equal(record.metrics.revenue, 120);
  assert.equal(record.metrics.netIncome, null);
  assert.equal(record.metrics.dilutedEPS, null);
  assert.equal(record.metrics.basicEPS, null);
  const newest = fixture();
  rows(newest, "annualTotalRevenue").push(annual(130, "2026-09-30"));
  const latestRecord = normalize(newest);
  assert.equal(latestRecord.periodEnd, "2026-09-30");
  assert.equal(latestRecord.metrics.revenue, 130);
  assert.equal(latestRecord.metrics.netIncome, null);
  assert.equal(latestRecord.metrics.dilutedEPS, null);
  assert.equal(latestRecord.fiscalYear, null);
});

test("growth needs comparable adjacent annual observations and a positive baseline; losses stay reported", () => {
  const json = fixture();
  rows(json, "annualNetIncome")[0] = annual(-20, "2024-12-31");
  rows(json, "annualNetIncome")[1] = annual(-10);
  rows(json, "annualOperatingCashFlow")[0] = annual(0, "2024-12-31");
  rows(json, "annualFreeCashFlow")[0] = annual(32, "2024-10-01");
  rows(json, "annualDilutedEPS")[1] = annual(-1.2);
  const record = normalize(json);
  assert.equal(record.metrics.netIncome, -10);
  assert.equal(record.metrics.netIncomeGrowth, null);
  assert.equal(record.metrics.operatingCashFlowGrowth, null);
  assert.equal(record.metrics.freeCashFlowGrowth, null);
  assert.equal(record.metrics.dilutedEPS, -1.2);
  const mismatch = fixture();
  rows(mismatch, "annualTotalRevenue")[0].currencyCode = "EUR";
  assert.equal(normalize(mismatch).metrics.revenueGrowth, null);
  const adjacent = fixture();
  rows(adjacent, "annualTotalRevenue")[0].asOfDate = "2025-01-29"; // 336 days is allowed for adjacent annual reports.
  assert.ok(Math.abs(normalize(adjacent).metrics.revenueGrowth - 0.2) < 1e-12);
  rows(adjacent, "annualTotalRevenue")[0].asOfDate = "2025-01-31"; // 334 days cannot establish annual comparability.
  assert.equal(normalize(adjacent).metrics.revenueGrowth, null);
});

test("fetcher requests annual concepts and serializes concurrent requests with 500 ms pacing", async () => {
  const time = clock();
  const starts = [];
  const fetcher = createYahooFetcher({ ...time, fetchImpl: async (url, options) => {
    starts.push({ url: new URL(url), at: time.now(), options });
    return response();
  } });
  const values = await Promise.all([fetcher(" acme "), fetcher("MSFT"), fetcher("BRK-B")]);
  assert.equal(values.length, 3);
  assert.deepEqual(starts.map((request) => request.url.searchParams.get("symbol")), ["ACME", "MSFT", "BRK-B"]);
  assert.deepEqual(starts.map((request) => request.at - starts[0].at), [0, 500, 1000]);
  assert.deepEqual(time.delays, [500, 500]);
  assert.equal(starts[0].url.origin, "https://query1.finance.yahoo.com");
  assert.deepEqual(starts[0].url.searchParams.get("type").split(","), YAHOO_ANNUAL_TYPES);
  assert.equal(starts[0].url.searchParams.get("period1"), String(Date.UTC(2021, 0, 1) / 1000));
  assert.equal(starts[0].url.searchParams.get("period2"), String(Date.parse(RETRIEVED) / 1000));
  assert.equal(starts[0].options.headers.Accept, "application/json");
  assert.ok(starts[0].options.signal instanceof AbortSignal);
});

test("429 and server failures receive one bounded retry", async () => {
  for (const status of [429, 500, 503]) {
    const time = clock();
    let calls = 0;
    const fetcher = createYahooFetcher({ ...time, fetchImpl: async () => response(++calls === 1 ? status : 200) });
    await fetcher("ACME");
    assert.equal(calls, 2);
    assert.deepEqual(time.delays, [1000]);
  }
  const time = clock();
  let calls = 0;
  const fetcher = createYahooFetcher({ ...time, fetchImpl: async () => response(++calls === 1 ? 429 : 200, fixture(), "100") });
  await fetcher("ACME");
  assert.deepEqual(time.delays, [5000]);
  let failures = 0;
  const failing = createYahooFetcher({ ...clock(), fetchImpl: async () => { failures += 1; return response(503); } });
  await assert.rejects(failing("ACME"), (error) => error instanceof YahooFetchError && error.status === 503);
  assert.equal(failures, 2);
});

test("403, malformed payloads and invalid tickers do not retry or poison the next request", async () => {
  const time = clock();
  let calls = 0;
  const fetcher = createYahooFetcher({ ...time, fetchImpl: async () => response(++calls === 1 ? 403 : 200) });
  await assert.rejects(fetcher("ACME"), (error) => error instanceof YahooFetchError && error.status === 403);
  assert.equal(calls, 1);
  await fetcher("MSFT");
  assert.equal(calls, 2);
  assert.deepEqual(time.delays, [500]);
  await assert.rejects(fetcher("ACME/OTHER"), /ticker is invalid/);
  assert.equal(calls, 2);
  for (const json of [{}, { timeseries: { result: [], error: { code: "Forbidden" } } }]) {
    let malformedCalls = 0;
    const malformed = createYahooFetcher({ ...clock(), fetchImpl: async () => { malformedCalls += 1; return response(200, json); } });
    await assert.rejects(malformed("ACME"), /unavailable or malformed/);
    assert.equal(malformedCalls, 1);
  }
});

test("network transport failures retry once and stop after a second failure", async () => {
  const time = clock();
  let calls = 0;
  const fetcher = createYahooFetcher({ ...time, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return response();
  } });
  await fetcher("ACME");
  assert.equal(calls, 2);
  assert.deepEqual(time.delays, [1000]);
  let persistentCalls = 0;
  const failing = createYahooFetcher({ ...clock(), fetchImpl: async () => { persistentCalls += 1; throw new TypeError("fetch failed"); } });
  await assert.rejects(failing("ACME"), (error) => error instanceof YahooFetchError && /request failed/.test(error.message));
  assert.equal(persistentCalls, 2);
  let malformedCalls = 0;
  const malformed = createYahooFetcher({ ...clock(), fetchImpl: async () => {
    malformedCalls += 1;
    return { ...response(), json: async () => { throw new SyntaxError("Invalid JSON"); } };
  } });
  await assert.rejects(malformed("ACME"), /malformed financial data/);
  assert.equal(malformedCalls, 1);
});

test("request timeout aborts and retries once before reporting timeout", async () => {
  const time = clock();
  let calls = 0;
  const fetcher = createYahooFetcher({ ...time, timeoutMs: 10, fetchImpl: async (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })), { once: true }));
  } });
  await assert.rejects(fetcher("ACME"), (error) => error instanceof YahooFetchError && /timed out/.test(error.message));
  assert.equal(calls, 2);
  assert.deepEqual(time.delays, [1000]);
});
