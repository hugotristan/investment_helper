import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateDataQuality } from "../js/analysis/data-quality.js";
import { broadFunds, companyAliases, marketProxyTickers, opportunityUniverse, blockedAssetSet, blockedTickerShortcuts } from "../js/config/settings.js";
import { parseYahooChart, parseYahooQuote } from "../js/data/yahoo-chart.js";
import { isMarketQuoteSource, publishedQuoteSource, LEEWAY_QUOTE_SOURCE } from "../js/data/quote-provenance.js";
import { createLeewayQuoteFallback, createPriceFallbackBudget } from "./price-fallback.mjs";

const SOURCE = "Yahoo Finance published snapshot";
const DAY = 86400000;
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

export class YahooPriceFetchError extends Error {
  constructor(message, status = 0) { super(message); this.name = "YahooPriceFetchError"; this.status = status; }
}

function canonicalTicker(value) {
  const ticker = String(value || "").trim().toUpperCase();
  return /^(?:\^[A-Z0-9]{1,19}|[A-Z0-9][A-Z0-9.-]{0,19})$/.test(ticker)
    && !blockedAssetSet.has(ticker) && !blockedTickerShortcuts.has(ticker) && !ticker.endsWith("-USD") ? ticker : null;
}

export function collectPriceTickers({ previous = {}, extraTickers = process.env.PRICE_TICKERS || "" } = {}) {
  const extra = Array.isArray(extraTickers) ? extraTickers : String(extraTickers).split(/[\s,;]+/);
  return [...new Set(["SPY", "QQQ", ...opportunityUniverse, ...marketProxyTickers.map((item) => item.ticker),
    ...broadFunds, ...Object.values(companyAliases), ...Object.keys(previous.byTicker || {}), ...extra]
    .map(canonicalTicker).filter(Boolean))].slice(0, 200);
}

export function createYahooPriceFetcher({ fetchImpl = fetch, wait = sleep, timeoutMs = 15000, maxRetries = 1 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 1) {
    throw new TypeError("Yahoo price requests need a positive timeout and at most one retry.");
  }
  return async function fetchYahooPriceChart(value) {
    const ticker = canonicalTicker(value);
    if (!ticker) throw new YahooPriceFetchError("Invalid or unsupported price ticker.");
    let lastFailure;
    for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
      const url = new URL(`https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}`);
      url.search = new URLSearchParams({ range: "5y", interval: "1d", events: "splits" });
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let retryDelay = 1000;
        try {
          const response = await fetchImpl(url.href, { headers: { Accept: "application/json" }, signal: controller.signal });
          if (!response.ok) {
            const seconds = Number(response.headers?.get?.("retry-after"));
            if (seconds > 0) retryDelay = Math.min(5000, Math.max(1000, seconds * 1000));
            throw new YahooPriceFetchError(`Yahoo chart request returned HTTP ${response.status}.`, response.status);
          }
          let json;
          try { json = await response.json(); }
          catch (error) {
            if (error?.name === "AbortError") throw error;
            throw new YahooPriceFetchError("Yahoo chart response was not valid JSON.");
          }
          if (!parseYahooChart(json, ticker)) throw new YahooPriceFetchError("Yahoo chart identity, currency, or daily prices were invalid.");
          return json;
        } catch (error) {
          const transportFailure = !(error instanceof YahooPriceFetchError);
          lastFailure = error instanceof YahooPriceFetchError ? error : new YahooPriceFetchError(error?.name === "AbortError" ? "Yahoo chart request timed out." : "Yahoo chart request failed.");
          if (attempt >= maxRetries || !(transportFailure || lastFailure.status === 429 || lastFailure.status >= 500 && lastFailure.status <= 599)) break;
        } finally { clearTimeout(timer); }
        await wait(retryDelay);
      }
    }
    throw lastFailure;
  };
}

function time(value) { return value === null || value === undefined || value === "" ? NaN : new Date(value).getTime(); }
function day(value) { return new Date(time(value)).toISOString().slice(0, 10); }
function validCurrency(value) { return /^(?:[A-Z]{3}|GBp)$/.test(String(value || "")); }
function supportedType(type, ticker) { return ["EQUITY", "ETF"].includes(String(type).toUpperCase()) || String(type).toUpperCase() === "INDEX" && ticker.startsWith("^"); }

function serializeQuote(quote, ticker, { currency = null, now = Date.now() } = {}) {
  const stamp = time(quote?.quoteTime);
  if (!quote || quote.ticker !== ticker || !validCurrency(quote.currency) || currency && quote.currency !== currency
    || !isMarketQuoteSource(quote.source)
    || !supportedType(quote.quoteType, ticker) || !Number.isFinite(quote.price) || quote.price <= 0
    || !Number.isFinite(stamp) || stamp > now || now - stamp > 7 * DAY) return null;
  const previousClose = Number.isFinite(quote.previousClose) && quote.previousClose > 0 ? quote.previousClose : null;
  const change = previousClose ? quote.price / previousClose - 1 : null;
  return { ...quote, ticker, previousClose, dayChange: previousClose ? quote.price - previousClose : null,
    dayChangePercent: Number.isFinite(change) ? change : null, quoteTime: new Date(stamp).toISOString(), source: publishedQuoteSource(quote.source) };
}

// Only completed daily bars are published. GeneratedAt describes the build;
// historyAsOf and quoteTime always describe the provider's original prices.
export function normalizePublishedPriceRecord(series, ticker, { quote = null, now = Date.now(), requireQualified = true } = {}) {
  if (!series || series.ticker !== ticker || !validCurrency(series.currency) || !supportedType(series.instrumentType, ticker)
    || ![SOURCE, "Yahoo Finance chart"].includes(series.source) || !Array.isArray(series.prices) || series.prices.length > 1600) return null;
  const days = new Map();
  const today = day(now);
  for (const point of series.prices) {
    const stamp = time(point?.date);
    if (!Number.isFinite(stamp) || stamp > now || day(stamp) >= today || !Number.isFinite(point?.close) || point.close <= 0) continue;
    days.set(day(stamp), { date: new Date(stamp).toISOString(), close: point.close,
      high: Number.isFinite(point.high) && point.high > 0 ? point.high : null,
      low: Number.isFinite(point.low) && point.low > 0 ? point.low : null,
      volume: Number.isFinite(point.volume) && point.volume >= 0 ? point.volume : null });
  }
  const allPrices = [...days.values()].sort((a, b) => time(a.date) - time(b.date));
  // Trend scans only need the latest400 full daily bars. Performance history
  // needs dated closes, so older bars omit unused OHLC/volume fields.
  const prices = allPrices.map((point, index) => index < allPrices.length - 400 ? { date: point.date, close: point.close } : point);
  const validSplit = (split) => Number.isFinite(time(split?.date)) && time(split.date) <= now
    && Number.isFinite(split.numerator) && split.numerator > 0 && Number.isFinite(split.denominator) && split.denominator > 0;
  const splitsComplete = series.splitsComplete !== false && Array.isArray(series.splits) && series.splits.every(validSplit);
  const record = { ticker, prices, historyAsOf: prices.at(-1)?.date || null,
    instrumentType: series.instrumentType, currency: series.currency,
    splitsComplete,
    splits: (Array.isArray(series.splits) ? series.splits : []).filter(validSplit)
      .map((split) => ({ ...split, date: new Date(time(split.date)).toISOString() })), source: SOURCE,
    quote: serializeQuote(quote, ticker, { currency: series.currency, now }) };
  return prices.length && (!requireQualified || evaluateDataQuality(record, now).eligible) ? record : null;
}

function retainPriceRecord(previous, ticker, freshQuote, now) {
  const prior = previous?.ticker === ticker && previous?.source === SOURCE ? previous : null;
  const record = normalizePublishedPriceRecord(prior, ticker, { now })
    || prior?.source === SOURCE && normalizePublishedPriceRecord(prior, ticker, { now, requireQualified: false });
  const savedQuote = isMarketQuoteSource(prior?.quote?.source) ? prior.quote : null;
  const quote = [freshQuote, savedQuote].map(value => serializeQuote(value, ticker, { currency: record?.currency, now }))
    .filter(value => value && (!record?.historyAsOf || time(value.quoteTime) >= time(record.historyAsOf)))
    .sort((a, b) => time(b.quoteTime) - time(a.quoteTime))[0] || null;
  if (record) return { ...record, quote };
  if (!quote) return null;
  return { ticker, prices: [], historyAsOf: null, instrumentType: quote.quoteType, currency: quote.currency,
    splits: [], source: SOURCE, quote };
}

export function assertPriceSnapshotCoverage(snapshot, { now = Date.now(), requiredTickers = ["SPY", "QQQ"] } = {}) {
  const qualified = Object.entries(snapshot.byTicker || {}).filter(([ticker, record]) => normalizePublishedPriceRecord(record, ticker, { now }));
  if (!qualified.length) throw new Error("No qualified real daily price histories are available; the previous deployment must be retained.");
  const missing = requiredTickers.filter((ticker) => !qualified.some(([symbol]) => symbol === ticker));
  if (missing.length) throw new Error(`Required index price histories are unavailable: ${missing.join(", ")}. The previous deployment must be retained.`);
  return qualified.length;
}

export async function generatePriceSnapshot({ tickers = collectPriceTickers(), previous = {}, fetchChart = createYahooPriceFetcher(),
  fetchFallbackQuote = null,
  now = Date.now, concurrency = 3, maximumDurationMs = 240000, requiredTickers = ["SPY", "QQQ"] } = {}) {
  if (typeof fetchChart !== "function" || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3
    || !Number.isFinite(maximumDurationMs) || maximumDurationMs < 0) throw new TypeError("A price provider, concurrency of 1–3, and bounded update duration are required.");
  const symbols = [...new Set(tickers.map(canonicalTicker).filter(Boolean))].slice(0, 200);
  // European listings get first access to the limited independent allowance.
  // Published order stays unchanged; this only affects retrieval scheduling.
  const workSymbols = typeof fetchFallbackQuote === "function" ? [...symbols].sort((a, b) =>
    Number(previous.byTicker?.[b]?.currency === "EUR") - Number(previous.byTicker?.[a]?.currency === "EUR")) : symbols;
  const records = new Map(), failures = new Map();
  const startedAt = now();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, async () => {
    while (next < symbols.length) {
      const ticker = workSymbols[next++];
      let quote = null;
      let failure;
      let attempted = false;
      let freshHistory = null;
      try {
        if (now() - startedAt >= maximumDurationMs) throw new YahooPriceFetchError("The bounded price update duration was reached.");
        attempted = true;
        const json = await fetchChart(ticker);
        const observedAt = now();
        quote = parseYahooQuote(json, ticker, { now: observedAt });
        freshHistory = normalizePublishedPriceRecord(parseYahooChart(json, ticker), ticker, { quote, now: observedAt });
        if (!freshHistory) throw new YahooPriceFetchError("Yahoo did not supply at least 200 recent completed real daily prices with matching issuer and currency metadata.");
        if (freshHistory.quote) {
          records.set(ticker, retainPriceRecord(freshHistory, ticker, previous.byTicker?.[ticker]?.quote, now()));
          continue;
        }
        failure = "Yahoo did not supply a usable dated quote.";
      } catch (error) {
        if (!(error instanceof YahooPriceFetchError)) throw error;
        failure = error.message;
      }
      let retained = freshHistory ? retainPriceRecord(freshHistory, ticker, previous.byTicker?.[ticker]?.quote, now())
        : retainPriceRecord(previous.byTicker?.[ticker], ticker, quote, now());
      if (attempted && retained && typeof fetchFallbackQuote === "function" && now() - startedAt < maximumDurationMs) {
        // A new quote never fabricates missing bars, refreshes history dates,
        // changes split metadata, or makes stale history qualify for a signal.
        try {
          const alternate = await fetchFallbackQuote(ticker, retained);
          retained = retainPriceRecord(retained, ticker, alternate, now());
        } catch { /* Failed independent quotes leave genuine dated data intact. */ }
      }
      if (retained) records.set(ticker, retained);
      failures.set(ticker, failure);
    }
  }));
  const snapshot = { schemaVersion: 1, generatedAt: new Date(now()).toISOString(),
    provider: [...new Set(["Yahoo Finance", ...[...records.values()].filter(record => record.quote?.source === LEEWAY_QUOTE_SOURCE).map(() => "Leeway")])].join(" / "),
    byTicker: Object.fromEntries(symbols.filter((ticker) => records.has(ticker)).map((ticker) => [ticker, records.get(ticker)])),
    failures: Object.fromEntries(symbols.filter((ticker) => failures.has(ticker)).map((ticker) => [ticker, failures.get(ticker)])) };
  assertPriceSnapshotCoverage(snapshot, { now: now(), requiredTickers });
  return snapshot;
}

export async function main(args = process.argv.slice(2), { fetchChart = createYahooPriceFetcher(), now = Date.now,
  fallbackToken = process.env.LEEWAY_API_TOKEN || "", fallbackBudgetPath = null,
  extraTickers = process.env.PRICE_TICKERS || "", maximumDurationMs = 240000 } = {}) {
  let output = resolve(REPO_ROOT, "data/prices.json");
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--output" || !args[index + 1]) throw new Error(`Unknown or incomplete price publisher option: ${args[index]}.`);
    output = resolve(args[++index]);
  }
  let previous = {};
  try { previous = JSON.parse(await readFile(output, "utf8")); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  const budget = await createPriceFallbackBudget(fallbackBudgetPath || (output === resolve(REPO_ROOT, "data/prices.json")
    ? resolve(REPO_ROOT, ".sites-runtime/price-provider-budget.json") : `${output}.budget.json`), { now, configured: Boolean(fallbackToken) });
  const fallback = createLeewayQuoteFallback({ token: fallbackToken, reserve: budget.reserve, now });
  const snapshot = await generatePriceSnapshot({ tickers: collectPriceTickers({ previous, extraTickers }), previous, fetchChart,
    fetchFallbackQuote: fallbackToken ? fallback : null, now, maximumDurationMs });
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot) + "\n", "utf8");
  await rename(temporary, output);
  process.stdout.write(`Price snapshot: ${Object.keys(snapshot.byTicker).length} symbols; ${Object.keys(snapshot.failures).length} refresh failures with original retained timestamps.\n`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
