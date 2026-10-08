import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { broadFunds, companyAliases, marketProxyTickers, opportunityUniverse } from "../js/config/settings.js";
import { collectPriceTickers, createYahooPriceFetcher, generatePriceSnapshot, main,
  normalizePublishedPriceRecord, YahooPriceFetchError } from "../scripts/update-prices.mjs";
import { parseYahooChart } from "../js/data/yahoo-chart.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 8, 14);

function fixture(ticker, { now = NOW, count = 250, currency = "USD", today = false, future = false } = {}) {
  const dates = [];
  let date = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() - 1, 13, 30);
  while (dates.length < count) {
    if (![0, 6].includes(new Date(date).getUTCDay())) dates.unshift(date / 1000);
    date -= DAY;
  }
  const closes = dates.map((_, index) => 100 + index);
  const previous = closes.at(-1);
  if (today) { dates.push((now - 3600000) / 1000); closes.push(999); }
  if (future) { dates.push((now + DAY) / 1000); closes.push(888); }
  return { chart: { error: null, result: [{ meta: { symbol: ticker, currency,
    instrumentType: ticker.startsWith("^") ? "INDEX" : broadFunds.has(ticker) ? "ETF" : "EQUITY",
    dataGranularity: "1d", longName: `${ticker} company`, regularMarketPrice: previous + 2,
    regularMarketTime: (now - 60000) / 1000, previousClose: 1, chartPreviousClose: 2 },
    timestamp: dates, indicators: { quote: [{ close: closes, high: closes.map((value) => value + 1),
      low: closes.map((value) => value - 1), volume: closes.map(() => 1000000) }] },
    events: { splits: { one: { date: dates[120], numerator: 2, denominator: 1, splitRatio: "2:1" } } } }] } };
}

function response(status = 200, json = fixture("SPY"), retryAfter = null) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => retryAfter }, json: async () => json };
}

const generate = (options = {}) => generatePriceSnapshot({ tickers: ["SPY", "QQQ", "AAPL"],
  fetchChart: async (ticker) => fixture(ticker), now: () => NOW, ...options });

test("publisher uses completed original daily closes and the actual preceding close for one-day change", async () => {
  const snapshot = await generate({ fetchChart: async (ticker) => fixture(ticker, { today: true, future: true }) });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.generatedAt, new Date(NOW).toISOString());
  assert.equal(snapshot.provider, "Yahoo Finance");
  assert.deepEqual(snapshot.failures, {});
  const item = snapshot.byTicker.SPY;
  assert.equal(item.source, "Yahoo Finance published snapshot");
  assert.equal(item.prices.length, 250);
  assert.ok(item.prices.every((point) => point.date.slice(0, 10) < "2026-10-08"));
  assert.equal(item.prices.at(-1).close, 349);
  assert.equal(item.historyAsOf, item.prices.at(-1).date);
  assert.equal(item.quote.previousClose, 349);
  assert.equal(item.quote.price, 351);
  assert.ok(Math.abs(item.quote.dayChangePercent - 2 / 349) < 1e-12);
  assert.equal(item.quote.dayChange, 2);
  assert.equal(item.quote.source, "Yahoo Finance published quote");
  assert.equal(item.quote.quoteTime, new Date(NOW - 60000).toISOString());
  assert.equal(item.splits.length, 1);
  assert.equal(item.splits[0].splitRatio, "2:1");
});

test("partial failures retain qualified previous history and quote dates without redating them", async () => {
  const previous = await generate({ now: () => NOW - DAY, fetchChart: async (ticker) => fixture(ticker, { now: NOW - DAY }) });
  const original = structuredClone(previous);
  const snapshot = await generate({ previous, fetchChart: async (ticker) => {
    if (ticker === "AAPL") throw new YahooPriceFetchError("HTTP 503", 503);
    return fixture(ticker);
  } });
  assert.deepEqual(snapshot.byTicker.AAPL.prices, original.byTicker.AAPL.prices);
  assert.equal(snapshot.byTicker.AAPL.historyAsOf, original.byTicker.AAPL.historyAsOf);
  assert.equal(snapshot.byTicker.AAPL.quote.quoteTime, original.byTicker.AAPL.quote.quoteTime);
  assert.match(snapshot.failures.AAPL, /503/);
  assert.deepEqual(previous, original);
  assert.notEqual(snapshot.generatedAt, previous.generatedAt);
});

test("a separately valid fresh quote can accompany retained history when current history is too short", async () => {
  const previous = await generate({ now: () => NOW - DAY, fetchChart: async (ticker) => fixture(ticker, { now: NOW - DAY }) });
  const snapshot = await generate({ previous, fetchChart: async (ticker) => fixture(ticker, { count: ticker === "AAPL" ? 100 : 250 }) });
  assert.equal(snapshot.byTicker.AAPL.historyAsOf, previous.byTicker.AAPL.historyAsOf);
  assert.equal(snapshot.byTicker.AAPL.quote.quoteTime, new Date(NOW - 60000).toISOString());
  assert.match(snapshot.failures.AAPL, /200 recent completed/);
});

test("stale history cannot become current via generatedAt; independently recent quotes retain original times", async () => {
  const previous = await generate({ now: () => NOW - 10 * DAY, fetchChart: async (ticker) => fixture(ticker, { now: NOW - 10 * DAY }) });
  previous.byTicker.AAPL.quote.quoteTime = new Date(NOW - DAY).toISOString();
  const snapshot = await generate({ previous, fetchChart: async (ticker) => {
    if (ticker === "AAPL") throw new YahooPriceFetchError("Provider unavailable");
    return fixture(ticker);
  } });
  assert.deepEqual(snapshot.byTicker.AAPL.prices, []);
  assert.equal(snapshot.byTicker.AAPL.historyAsOf, null);
  assert.equal(snapshot.byTicker.AAPL.quote.quoteTime, new Date(NOW - DAY).toISOString());
  previous.byTicker.AAPL.quote.quoteTime = new Date(NOW - 8 * DAY).toISOString();
  const expired = await generate({ previous, fetchChart: async (ticker) => {
    if (ticker === "AAPL") throw new YahooPriceFetchError("Provider unavailable");
    return fixture(ticker);
  } });
  assert.equal(expired.byTicker.AAPL, undefined);
  assert.ok(expired.failures.AAPL);
});

test("malformed, mismatched, short and stale histories do not publish as qualified data", async () => {
  for (const bad of [{}, fixture("OTHER"), fixture("AAPL", { count: 199 }), fixture("AAPL", { currency: "usd" }), fixture("AAPL", { now: NOW - 9 * DAY })]) {
    const snapshot = await generate({ fetchChart: async (ticker) => ticker === "AAPL" ? bad : fixture(ticker) });
    assert.ok(snapshot.failures.AAPL);
    assert.ok(!snapshot.byTicker.AAPL?.prices.length);
  }
  const parsed = parseYahooChart(fixture("AAPL"), "AAPL");
  assert.equal(normalizePublishedPriceRecord({ ...parsed, source: "sample" }, "AAPL", { now: NOW }), null);
  assert.equal(normalizePublishedPriceRecord({ ...parsed, ticker: "OTHER" }, "AAPL", { now: NOW }), null);
});

test("unavailable SPY or QQQ and all-unqualified snapshots fail the build", async () => {
  await assert.rejects(generate({ fetchChart: async (ticker) => {
    if (ticker === "QQQ") throw new YahooPriceFetchError("Missing QQQ");
    return fixture(ticker);
  } }), /Required index.*QQQ/);
  await assert.rejects(generate({ fetchChart: async () => { throw new YahooPriceFetchError("No service"); } }), /No qualified real daily/);
});

test("price requests are bounded to three concurrent workers", async () => {
  let active = 0, maximum = 0;
  await generate({ tickers: ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMD", "GOOGL"], fetchChart: async (ticker) => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    active -= 1;
    return fixture(ticker);
  } });
  assert.equal(maximum, 3);
  await assert.rejects(generate({ concurrency: 4 }), /concurrency/);
});

test("an exhausted update budget retains recent original prices without making new requests", async () => {
  const previous = await generate({ now: () => NOW - DAY, fetchChart: async (ticker) => fixture(ticker, { now: NOW - DAY }) });
  let calls = 0;
  const snapshot = await generate({ previous, maximumDurationMs: 0,
    fetchChart: async () => { calls += 1; throw new Error("Must not fetch after the budget"); } });
  assert.equal(calls, 0);
  assert.deepEqual(snapshot.byTicker.SPY.prices, previous.byTicker.SPY.prices);
  assert.equal(snapshot.byTicker.SPY.historyAsOf, previous.byTicker.SPY.historyAsOf);
  assert.equal(snapshot.byTicker.SPY.quote.quoteTime, previous.byTicker.SPY.quote.quoteTime);
  assert.ok(Object.values(snapshot.failures).every((reason) => /bounded price update duration/.test(reason)));
});

test("ticker universe includes configured, alias, fund, saved and optional symbols, validates and caps at 200", () => {
  const symbols = collectPriceTickers({ previous: { byTicker: { SAVED: {} } }, extraTickers: "CUSTOM, custom, ^IXIC, BAD/TICKER, BTC-USD" });
  for (const ticker of [...opportunityUniverse, ...marketProxyTickers.map((item) => item.ticker), ...broadFunds, ...Object.values(companyAliases)]) assert.ok(symbols.includes(ticker), ticker);
  assert.ok(symbols.includes("SAVED") && symbols.includes("CUSTOM") && symbols.includes("^IXIC"));
  assert.equal(symbols.filter((ticker) => ticker === "CUSTOM").length, 1);
  assert.ok(!symbols.includes("BAD/TICKER") && !symbols.includes("BTC-USD"));
  const many = collectPriceTickers({ extraTickers: Array.from({ length: 400 }, (_, index) => `CUSTOM${index}`) });
  assert.equal(many.length, 200);
  assert.deepEqual(many.slice(0, 2), ["SPY", "QQQ"]);
});

test("429 and 5xx retry once, honor bounded Retry-After, and request the specified original daily feed", async () => {
  for (const status of [429, 500, 503]) {
    const calls = [], waits = [];
    const fetcher = createYahooPriceFetcher({ wait: async (milliseconds) => waits.push(milliseconds), fetchImpl: async (url) => {
      calls.push(new URL(url)); return response(calls.length === 1 ? status : 200);
    } });
    await fetcher("SPY");
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [1000]);
    assert.equal(calls[0].host, "query1.finance.yahoo.com");
    assert.equal(calls[0].searchParams.get("range"), "1y");
    assert.equal(calls[0].searchParams.get("interval"), "1d");
    assert.equal(calls[0].searchParams.get("events"), "splits");
  }
  let count = 0;
  const waits = [];
  const limited = createYahooPriceFetcher({ wait: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async () => response(++count === 1 ? 429 : 200, fixture("SPY"), "999") });
  await limited("SPY");
  assert.deepEqual(waits, [5000]);
});

test("query2 is the fallback after server errors, malformed data or mismatched issuer metadata", async () => {
  const cases = [response(503), response(200, {}), response(200, fixture("OTHER")),
    { ...response(), json: async () => { throw new SyntaxError("Bad JSON"); } }];
  for (const first of cases) {
    const hosts = [];
    const fetcher = createYahooPriceFetcher({ maxRetries: 0, fetchImpl: async (url) => {
      hosts.push(new URL(url).host); return hosts.length === 1 ? first : response();
    } });
    const result = await fetcher("SPY");
    assert.ok(result.chart.result.length);
    assert.deepEqual(hosts, ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]);
  }
});

test("403 is not retried and timeouts have at most one retry per host", async () => {
  let forbiddenCalls = 0;
  const forbidden = createYahooPriceFetcher({ fetchImpl: async () => { forbiddenCalls += 1; return response(403); } });
  await assert.rejects(forbidden("SPY"), (error) => error instanceof YahooPriceFetchError && error.status === 403);
  assert.equal(forbiddenCalls, 2);
  let timeoutCalls = 0;
  const timeout = createYahooPriceFetcher({ timeoutMs: 5, wait: async () => {}, fetchImpl: async (_url, { signal }) => {
    timeoutCalls += 1;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })), { once: true }));
  } });
  await assert.rejects(timeout("SPY"), /timed out/);
  assert.equal(timeoutCalls, 4);
  await assert.rejects(forbidden("BTC-USD"), /Invalid or unsupported/);
  assert.equal(forbiddenCalls, 2);
});

test("atomic publisher leaves the prior file unchanged if required indices expire", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "investment-prices-test-"));
  const output = join(directory, "prices.json");
  t.after(async () => { await unlink(output).catch(() => {}); await unlink(`${output}.tmp`).catch(() => {}); await rmdir(directory); });
  const fetchChart = async (ticker) => {
    if (!["SPY", "QQQ"].includes(ticker)) throw new YahooPriceFetchError("Fixture excludes optional symbols");
    return fixture(ticker);
  };
  await main(["--output", output], { fetchChart, now: () => NOW, extraTickers: "" });
  const original = await readFile(output, "utf8");
  assert.equal(original.split("\n").length, 2);
  await assert.rejects(main(["--output", output], { now: () => NOW + 9 * DAY, extraTickers: "",
    fetchChart: async () => { throw new YahooPriceFetchError("Provider unavailable"); } }), /No qualified/);
  assert.equal(await readFile(output, "utf8"), original);
  await assert.rejects(readFile(`${output}.tmp`), (error) => error.code === "ENOENT");
});
