import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { emptyFundamentals, normalizeSecCompanyFacts } from "../js/analysis/fundamentals.js";
import { normalizeYahooFinancials } from "../js/analysis/yahoo-fundamentals.js";
import { broadFunds, opportunityUniverse } from "../js/config/settings.js";
import { createYahooFetcher, YahooFetchError } from "./yahoo-fundamentals.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_USER_AGENT = "investment-helper https://github.com/hugotristan/investment_helper";
export const SEC_TICKER_INDEX_URL = "https://www.sec.gov/files/company_tickers.json";
export const TICKER_INDEX_MAX_AGE_DAYS = 30;
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export class SecFetchError extends Error {
  constructor(message, status = 0) { super(message); this.name = "SecFetchError"; this.status = status; }
}

export function createSecFetcher({ fetchImpl = fetch, userAgent = process.env.SEC_USER_AGENT || DEFAULT_USER_AGENT,
  wait = sleep, now = Date.now, timeoutMs = 15000, maxRetries = 1 } = {}) {
  let lastStarted = -Infinity;
  return async function fetchSecJson(url) {
    for (let attempt = 0; attempt <= Math.min(maxRetries, 2); attempt += 1) {
      const delay = 500 - (now() - lastStarted);
      if (delay > 0) await wait(delay);
      lastStarted = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { headers: { "User-Agent": userAgent, Accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new SecFetchError(`SEC request returned HTTP ${response.status}.`, response.status);
        return await response.json();
      } catch (error) {
        const failure = error instanceof SecFetchError ? error : new SecFetchError(error.name === "AbortError" ? "SEC request timed out." : "SEC request failed.");
        const retryable = !failure.status || failure.status === 429 || failure.status >= 500;
        if (!retryable || attempt >= Math.min(maxRetries, 2)) throw failure;
        await wait(1000 * (attempt + 1));
      } finally { clearTimeout(timer); }
    }
  };
}

export function buildTickerIndex(companyTickers) {
  const index = new Map();
  if (!plainObject(companyTickers)) return index;
  for (const entry of Object.values(companyTickers)) {
    const ticker = canonicalTicker(entry?.ticker);
    const cik = canonicalCik(entry?.cik_str);
    if (ticker && cik) index.set(ticker, { cik, companyName: typeof entry.title === "string" ? entry.title : null,
      verifiedAt: entry.verifiedAt || null, sourceUrl: entry.sourceUrl || null, mappingSource: entry.mappingSource || null });
  }
  return index;
}

// Mapping age is independent of financial retrieval age. A successful facts
// request cannot make an old ticker-to-issuer association newly verified.
export function resolveTickerIndex({ live = null, fallback = null, previous = {}, indexError = null,
  now = Date.now(), maxAgeDays = TICKER_INDEX_MAX_AGE_DAYS } = {}) {
  const index = new Map();
  const errors = [indexError?.message || indexError].filter(Boolean).map(String);
  const nowIso = new Date(now).toISOString();
  const recent = (value) => {
    const time = Date.parse(value || "");
    return Number.isFinite(time) && time <= now && now - time <= maxAgeDays * 86400000;
  };
  for (const [key, record] of Object.entries(previous.byTicker || {})) {
    const ticker = canonicalTicker(key);
    const proof = record?.tickerMapping;
    const recordCik = canonicalCik(record?.cik);
    const cik = canonicalCik(proof?.cik ?? record?.cik);
    if (!ticker || ticker !== canonicalTicker(record?.ticker) || !cik) continue;
    const verifiedAt = proof ? proof.verifiedAt : record.retrievedAt;
    if (!recent(verifiedAt) || (proof && ((recordCik && recordCik !== cik) || proof.sourceUrl !== SEC_TICKER_INDEX_URL))) continue;
    index.set(ticker, { cik, companyName: record.companyName || null, verifiedAt,
      sourceUrl: SEC_TICKER_INDEX_URL, mappingSource: "Previous SEC records" });
  }
  const cached = buildTickerIndex(fallback?.companyTickers);
  if (fallback) {
    if (fallback.schemaVersion === 1 && fallback.sourceUrl === SEC_TICKER_INDEX_URL
      && recent(fallback.verifiedAt) && cached.size) {
      for (const [ticker, mapped] of cached) index.set(ticker, { ...mapped, verifiedAt: fallback.verifiedAt,
        sourceUrl: SEC_TICKER_INDEX_URL, mappingSource: "Verified SEC snapshot" });
    } else errors.push("The saved SEC ticker index is invalid, empty, future-dated, or older than the mapping age limit.");
  }
  const current = buildTickerIndex(live);
  if (current.size) {
    for (const [ticker, mapped] of current) index.set(ticker, { ...mapped, verifiedAt: nowIso,
      sourceUrl: SEC_TICKER_INDEX_URL, mappingSource: "SEC live ticker index" });
    if (Object.values(live).length !== current.size) errors.push("Malformed or duplicate live ticker mappings were ignored; valid fallback mappings were retained.");
  } else if (live !== null) errors.push("The live SEC ticker index contained no valid issuer mappings.");
  const sources = [...new Set([...index.values()].map((mapped) => mapped.mappingSource))];
  const companyTickers = Object.fromEntries([...index].map(([ticker, mapped]) => [ticker, {
    ticker, cik_str: mapped.cik, title: mapped.companyName,
    verifiedAt: mapped.verifiedAt, sourceUrl: mapped.sourceUrl, mappingSource: mapped.mappingSource
  }]));
  return { companyTickers, indexStatus: current.size ? "live" : index.size ? "fallback" : "unavailable",
    indexSource: sources.join(" + ") || "No verified issuer mapping",
    indexVerifiedAt: [...index.values()].map((mapped) => mapped.verifiedAt).sort()[0] || null,
    indexError: errors.length ? [...new Set(errors)].join(" ") : null };
}

function canonicalTicker(value) {
  if (typeof value !== "string") return null;
  const ticker = value.trim().toUpperCase().replace(/\./g, "-");
  return /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) ? ticker : null;
}

function canonicalCik(value) {
  const text = String(value ?? "");
  if (!/^\d{1,10}$/.test(text)) return null;
  return text.replace(/^0+/, "") || null;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfirmedEarnings(record, entry, { now = Date.now() } = {}) {
  const earnings = validCalendarEntry(entry, now) ? entry : validCalendarEntry(record.earnings, now) ? record.earnings : null;
  return { ...record, earnings: earnings ? { date: earnings.date, status: "confirmed", source: earnings.source,
    sourceUrl: earnings.sourceUrl, verifiedAt: earnings.verifiedAt || null } : null };
}

export async function generateFundamentalsSnapshot({ tickers = opportunityUniverse, previous = {}, companyTickers = {},
  fetchFacts, fetchYahooFacts = null, calendar = {}, retrievedAt = new Date().toISOString(), providerError = null,
  indexDiagnostics = {}, maximumDurationMs = 180000, now = Date.now } = {}) {
  if (typeof fetchFacts !== "function") throw new TypeError("A fetchFacts provider is required.");
  if (fetchYahooFacts !== null && typeof fetchYahooFacts !== "function") throw new TypeError("The optional Yahoo provider must be a function.");
  if (!Number.isFinite(maximumDurationMs) || maximumDurationMs < 0) throw new TypeError("A bounded non-negative update duration is required.");
  const index = buildTickerIndex(companyTickers);
  const byTicker = { ...(previous.byTicker || {}) };
  const factsByCik = new Map();
  const forbiddenCiks = new Set();
  const failures = [];
  const secFailures = [];
  const startedAt = now();
  const exhausted = () => now() - startedAt >= maximumDurationMs;
  const budgetReason = "The bounded fundamentals update time budget was reached; existing snapshots were retained.";
  let secSuccessfulRequests = 0;
  let yahooSuccessfulRequests = 0;
  let secBlockedReason = index.size ? null : providerError?.message || providerError || null;
  for (const ticker of [...new Set(tickers.map((value) => String(value).toUpperCase()))]) {
    const calendarEntry = (calendar.byTicker || calendar)[ticker];
    const mapped = index.get(ticker.replace(/\./g, "-"));
    const previousRecord = byTicker[ticker];
    // Yahoo snapshots identify the ticker directly and do not claim an SEC CIK.
    // Existing SEC figures must still match a newly resolved issuer association.
    const sameTicker = canonicalTicker(previousRecord?.ticker) === canonicalTicker(ticker);
    const yahooRecord = previousRecord?.provider === "Yahoo Finance" && !previousRecord.cik;
    const existing = sameTicker && (yahooRecord || !mapped || canonicalCik(previousRecord?.cik) === mapped.cik) ? previousRecord : null;
    if (broadFunds.has(ticker)) {
      byTicker[ticker] = mergeConfirmedEarnings({ ...emptyFundamentals(ticker,
        "ETF and fund fundamentals are not covered by these company financial adapters.", { status: "not_covered" }), provider: null },
      calendarEntry, { now: Date.parse(retrievedAt) });
      continue;
    }
    let record = null;
    let secUnavailable = null;
    let secFailure = null;
    if (exhausted()) secFailure = { ticker, reason: budgetReason, status: null };
    else if (secBlockedReason) secFailure = { ticker, reason: secBlockedReason, status: null };
    else if (!mapped) secFailure = { ticker, reason: "No matching issuer was found in the SEC ticker index.", status: null };
    else {
      if (!factsByCik.has(mapped.cik)) {
        try {
          const facts = await fetchFacts(mapped.cik);
          if (String(facts?.cik || "").replace(/^0+/, "") !== mapped.cik) throw new SecFetchError("SEC issuer identity did not match the requested issuer.");
          factsByCik.set(mapped.cik, { facts });
        } catch (error) {
          // Fetch failures are recoverable. Normalization/programming errors below
          // remain uncaught so deployment checks can identify actual broken code.
          if (!(error instanceof SecFetchError)) throw error;
          factsByCik.set(mapped.cik, { error });
          if (error.status === 403) forbiddenCiks.add(mapped.cik);
          if (forbiddenCiks.size >= 2) secBlockedReason = "SEC access was denied for two issuers; remaining SEC requests were skipped.";
        }
      }
      const response = factsByCik.get(mapped.cik);
      if (response?.facts) {
        const normalized = { ...normalizeSecCompanyFacts(response.facts, { ticker, cik: mapped.cik, retrievedAt }), provider: "SEC companyfacts" };
        normalized.companyName ||= mapped.companyName;
        if (normalized.available) {
          record = normalized;
          if (!response.counted) { secSuccessfulRequests += 1; response.counted = true; }
        } else {
          secUnavailable = normalized;
          secFailure = { ticker, reason: normalized.reason, status: null };
        }
      } else {
        secFailure = { ticker, reason: response?.error?.message || "SEC company facts are unavailable.", status: response?.error?.status || null };
      }
    }
    if (secFailure) secFailures.push(secFailure);
    let yahooFailure = null;
    if (!record && fetchYahooFacts) {
      if (exhausted()) yahooFailure = { reason: budgetReason, status: null };
      else {
        let yahooFacts = null;
        try { yahooFacts = await fetchYahooFacts(ticker); }
        catch (error) {
          if (!(error instanceof YahooFetchError)) throw error;
          yahooFailure = { reason: error.message, status: error.status || null };
        }
        if (yahooFacts) {
          const normalized = normalizeYahooFinancials(yahooFacts, { ticker, retrievedAt, companyName: mapped?.companyName || null });
          if (normalized.available) {
            record = { ...normalized, fallbackReason: secFailure?.reason || null };
            yahooSuccessfulRequests += 1;
          } else yahooFailure = { reason: normalized.reason, status: null };
        } else if (!yahooFailure) yahooFailure = { reason: "Yahoo Finance annual financials are unavailable.", status: null };
      }
    }
    if (!record) {
      const reason = [secFailure?.reason, yahooFailure?.reason].filter(Boolean).join(" Yahoo fallback: ") || "Company financials are unavailable.";
      record = existing || secUnavailable || { ...emptyFundamentals(ticker, reason, { cik: mapped?.cik }), provider: null };
      if (existing && !record.provider) record = { ...record, provider: "SEC companyfacts" };
      failures.push({ ticker, reason, status: yahooFailure?.status || secFailure?.status || null });
    }
    if (mapped) record = { ...record, tickerMapping: { cik: mapped.cik,
      verifiedAt: mapped.verifiedAt || retrievedAt, sourceUrl: mapped.sourceUrl || SEC_TICKER_INDEX_URL } };
    byTicker[ticker] = mergeConfirmedEarnings(record, calendarEntry, { now: Date.parse(retrievedAt) });
  }
  const successfulRequests = secSuccessfulRequests + yahooSuccessfulRequests;
  return { schemaVersion: 1, generatedAt: retrievedAt, provider: fetchYahooFacts ? "SEC companyfacts + Yahoo Finance" : "SEC companyfacts",
    providerStatus: failures.length ? successfulRequests ? "partial" : "unavailable" : successfulRequests ? "available" : "unavailable",
    secProviderStatus: secFailures.length ? secSuccessfulRequests ? "partial" : "unavailable" : secSuccessfulRequests ? "available" : "unavailable",
    ...indexDiagnostics,
    successfulRequests, secSuccessfulRequests, yahooSuccessfulRequests, failures, secFailures, byTicker };
}

function validCalendarEntry(entry, now) {
  if (entry?.status !== "confirmed" || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date || ""))) return false;
  const time = Date.parse(entry.date);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== entry.date
    || entry.date < new Date(now).toISOString().slice(0, 10) || !entry.source) return false;
  try { return new URL(entry.sourceUrl).protocol === "https:"; } catch { return false; }
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

export async function main(args = process.argv.slice(2), { fetchSec = createSecFetcher(), fetchYahooFacts = createYahooFetcher(),
  now = Date.now, maximumDurationMs = 180000 } = {}) {
  const startedAt = now();
  const options = { output: resolve(REPO_ROOT, "data/fundamentals.json"), calendar: resolve(REPO_ROOT, "data/earnings-calendar.json"),
    tickerIndex: resolve(REPO_ROOT, "data/sec-tickers.json"), tickers: opportunityUniverse };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[++index];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--output") options.output = resolve(value);
    else if (flag === "--calendar") options.calendar = resolve(value);
    else if (flag === "--ticker-index") options.tickerIndex = resolve(value);
    else if (flag === "--tickers") options.tickers = value.split(/[\s,]+/).filter(Boolean);
    else throw new Error(`Unknown argument ${flag}.`);
  }
  const previous = await readJson(options.output, {});
  const calendar = await readJson(options.calendar, {});
  let fallback = null;
  let indexError = null;
  try { fallback = await readJson(options.tickerIndex, null); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; indexError = "The saved SEC ticker index could not be parsed."; }
  let live = null;
  try { live = await fetchSec(SEC_TICKER_INDEX_URL); }
  catch (error) { if (!(error instanceof SecFetchError)) throw error; indexError = [indexError, error.message].filter(Boolean).join(" "); }
  const retrievedAt = new Date(now()).toISOString();
  const { companyTickers, ...indexDiagnostics } = resolveTickerIndex({ live, fallback, previous, indexError, now: Date.parse(retrievedAt) });
  const current = buildTickerIndex(live);
  if (current.size && Object.values(live).length === current.size) {
    await writeJsonAtomic(options.tickerIndex, { schemaVersion: 1, verifiedAt: retrievedAt,
      sourceUrl: SEC_TICKER_INDEX_URL, companyTickers: live });
  }
  const providerError = indexDiagnostics.indexStatus === "unavailable"
    ? indexDiagnostics.indexError || "No verified SEC issuer mappings are available." : null;
  const snapshot = await generateFundamentalsSnapshot({ tickers: options.tickers, previous, companyTickers, calendar,
    providerError, indexDiagnostics, retrievedAt, now,
    fetchYahooFacts, maximumDurationMs: Math.max(0, maximumDurationMs - (now() - startedAt)),
    fetchFacts: (cik) => fetchSec(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik.padStart(10, "0")}.json`) });
  await writeJsonAtomic(options.output, snapshot);
  process.stdout.write(`Fundamentals snapshot: ${snapshot.providerStatus}; ticker index ${snapshot.indexStatus}; ${snapshot.secSuccessfulRequests} SEC and ${snapshot.yahooSuccessfulRequests} Yahoo issuer requests succeeded, ${snapshot.failures.length} symbols retained or unavailable.\n`);
  return snapshot;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
