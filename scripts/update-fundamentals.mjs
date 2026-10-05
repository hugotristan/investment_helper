import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { emptyFundamentals, normalizeSecCompanyFacts } from "../js/analysis/fundamentals.js";
import { broadFunds, opportunityUniverse } from "../js/config/settings.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_USER_AGENT = "investment-helper https://github.com/hugotristan/investment_helper";
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
  for (const entry of Object.values(companyTickers || {})) {
    const ticker = String(entry?.ticker || "").toUpperCase().replace(/\./g, "-");
    const cik = String(entry?.cik_str || "").replace(/^0+/, "");
    if (ticker && /^\d+$/.test(cik)) index.set(ticker, { cik, companyName: entry.title || null });
  }
  return index;
}

export function mergeConfirmedEarnings(record, entry, { now = Date.now() } = {}) {
  const earnings = validCalendarEntry(entry, now) ? entry : validCalendarEntry(record.earnings, now) ? record.earnings : null;
  return { ...record, earnings: earnings ? { date: earnings.date, status: "confirmed", source: earnings.source,
    sourceUrl: earnings.sourceUrl, verifiedAt: earnings.verifiedAt || null } : null };
}

export async function generateFundamentalsSnapshot({ tickers = opportunityUniverse, previous = {}, companyTickers = {},
  fetchFacts, calendar = {}, retrievedAt = new Date().toISOString(), providerError = null,
  maximumDurationMs = 180000, now = Date.now } = {}) {
  if (typeof fetchFacts !== "function") throw new TypeError("A fetchFacts provider is required.");
  const index = buildTickerIndex(companyTickers);
  const byTicker = { ...(previous.byTicker || {}) };
  const factsByCik = new Map();
  const forbiddenCiks = new Set();
  const failures = [];
  const startedAt = now();
  let successfulRequests = 0;
  let blockedReason = providerError?.message || providerError || null;
  for (const ticker of [...new Set(tickers.map((value) => String(value).toUpperCase()))]) {
    const existing = byTicker[ticker];
    const calendarEntry = (calendar.byTicker || calendar)[ticker];
    const mapped = index.get(ticker.replace(/\./g, "-"));
    let record;
    if (broadFunds.has(ticker)) record = emptyFundamentals(ticker, "ETF and fund fundamentals are not covered by this company filing adapter.", { status: "not_covered" });
    else if (blockedReason) {
      record = existing || emptyFundamentals(ticker, blockedReason, { cik: mapped?.cik });
      failures.push({ ticker, reason: blockedReason });
    } else if (!mapped) record = existing || emptyFundamentals(ticker, "No matching issuer was found in the SEC ticker index.", { status: "not_covered" });
    else {
      if (now() - startedAt >= maximumDurationMs) blockedReason = "The bounded SEC update time budget was reached; existing snapshots were retained.";
      if (!blockedReason && !factsByCik.has(mapped.cik)) {
        try {
          const facts = await fetchFacts(mapped.cik);
          if (String(facts?.cik || "").replace(/^0+/, "") !== mapped.cik) throw new SecFetchError("SEC issuer identity did not match the requested issuer.");
          factsByCik.set(mapped.cik, { facts });
          successfulRequests += 1;
        } catch (error) {
          // Fetch failures are recoverable. Normalization/programming errors below
          // remain uncaught so deployment checks can identify actual broken code.
          if (!(error instanceof SecFetchError)) throw error;
          factsByCik.set(mapped.cik, { error });
          if (error.status === 403) forbiddenCiks.add(mapped.cik);
          if (forbiddenCiks.size >= 2) blockedReason = "SEC access was denied for two issuers; remaining requests were skipped and prior snapshots retained.";
        }
      }
      const response = factsByCik.get(mapped.cik);
      if (response?.facts) {
        record = normalizeSecCompanyFacts(response.facts, { ticker, cik: mapped.cik, retrievedAt });
        record.companyName ||= mapped.companyName;
      } else {
        const reason = response?.error?.message || blockedReason || "SEC company facts are unavailable.";
        record = existing || emptyFundamentals(ticker, reason, { cik: mapped.cik });
        failures.push({ ticker, reason, status: response?.error?.status || null });
      }
    }
    byTicker[ticker] = mergeConfirmedEarnings(record, calendarEntry, { now: Date.parse(retrievedAt) });
  }
  return { schemaVersion: 1, generatedAt: retrievedAt, provider: "SEC companyfacts",
    providerStatus: failures.length ? successfulRequests ? "partial" : "unavailable" : "available",
    successfulRequests, failures, byTicker };
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

export async function main(args = process.argv.slice(2)) {
  const options = { output: resolve(REPO_ROOT, "data/fundamentals.json"), calendar: resolve(REPO_ROOT, "data/earnings-calendar.json"), tickers: opportunityUniverse };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[++index];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--output") options.output = resolve(value);
    else if (flag === "--calendar") options.calendar = resolve(value);
    else if (flag === "--tickers") options.tickers = value.split(/[\s,]+/).filter(Boolean);
    else throw new Error(`Unknown argument ${flag}.`);
  }
  const previous = await readJson(options.output, {});
  const calendar = await readJson(options.calendar, {});
  const fetchSec = createSecFetcher();
  let companyTickers = {};
  let providerError = null;
  try { companyTickers = await fetchSec("https://www.sec.gov/files/company_tickers.json"); }
  catch (error) { if (!(error instanceof SecFetchError)) throw error; providerError = error; }
  const snapshot = await generateFundamentalsSnapshot({ tickers: options.tickers, previous, companyTickers, calendar, providerError,
    fetchFacts: (cik) => fetchSec(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik.padStart(10, "0")}.json`) });
  await mkdir(dirname(options.output), { recursive: true });
  const temporary = `${options.output}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  await rename(temporary, options.output);
  process.stdout.write(`Fundamentals snapshot: ${snapshot.providerStatus}; ${snapshot.successfulRequests} issuer requests succeeded, ${snapshot.failures.length} symbols retained or unavailable.\n`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
