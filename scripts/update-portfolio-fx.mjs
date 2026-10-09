import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { PORTFOLIO_FX_SOURCE, PORTFOLIO_FX_SOURCE_URL, PORTFOLIO_FX_CURRENCIES,
  PORTFOLIO_FX_MAX_POINTS, normalizeHistoricalFx } from "../js/data/portfolio-history.js";

const DEFAULT_OUTPUT = fileURLToPath(new URL("../data/portfolio-fx.json", import.meta.url));
const DAY = 86400000;
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

export function portfolioFxStart(now = Date.now()) {
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 5);
  start.setUTCDate(start.getUTCDate() - 7);
  return start.toISOString().slice(0, 10);
}

export function buildPortfolioFxSnapshot(raw, { now = Date.now(), from = portfolioFxStart(now) } = {}) {
  if (!Array.isArray(raw) || !raw.length || raw.length > PORTFOLIO_FX_CURRENCIES.length * PORTFOLIO_FX_MAX_POINTS
    || !Number.isFinite(new Date(now).getTime())) return null;
  const start = Date.parse(from);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== from) return null;
  // For a weekend/holiday boundary the provider can include the previous
  // observed business date. Preserve its date rather than calling it Saturday.
  const earliest = new Date(start - 7 * DAY).toISOString().slice(0, 10);
  const byCurrency = Object.fromEntries(PORTFOLIO_FX_CURRENCIES.map((currency) => [currency, []]));
  for (const row of raw) {
    if (row?.base !== "EUR" || !PORTFOLIO_FX_CURRENCIES.includes(row?.quote) || typeof row?.date !== "string"
      || row.date < earliest || !Number.isFinite(row.rate) || row.rate <= 0 || !Number.isFinite(1 / row.rate)) return null;
    // The ECB publishes foreign units per euro. Store euro per native unit.
    byCurrency[row.quote].push({ date: row.date, rate: 1 / row.rate });
  }
  const normalized = normalizeHistoricalFx({ schemaVersion: 1, source: PORTFOLIO_FX_SOURCE,
    sourceUrl: PORTFOLIO_FX_SOURCE_URL, generatedAt: new Date(now).toISOString(), byCurrency }, { now });
  if (!normalized) return null;
  if (Object.values(normalized.byCurrency).some((points) => points.length < 200
    || Date.parse(points[0].date) - start > 14 * DAY || now - Date.parse(points.at(-1).date) > 7 * DAY)) return null;
  return normalized;
}

export function portfolioFxCoverage(snapshot) {
  return Object.fromEntries(Object.entries(snapshot?.byCurrency || {}).map(([currency, points]) => [currency,
    { from: points[0]?.date || null, to: points.at(-1)?.date || null, points: points.length }]));
}

export async function updatePortfolioFxSnapshot({ fetchImpl = globalThis.fetch, previous = null, now,
  timeoutMs = 20000, maxRetries = 1, wait = sleep } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 1) {
    throw new TypeError("Portfolio FX requests need a positive timeout and at most one retry.");
  }
  const clock = () => now === undefined ? Date.now() : now;
  const from = portfolioFxStart(clock());
  const url = new URL(PORTFOLIO_FX_SOURCE_URL);
  url.search = new URLSearchParams({ base: "eur", quotes: PORTFOLIO_FX_CURRENCIES.join(",").toLowerCase(),
    from, to: new Date(clock()).toISOString().slice(0, 10) });
  let reason = "Historical ECB exchange rates could not be retrieved.", attempts = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryable = true, delay = 1000;
    try {
      const response = await fetchImpl(url.href, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) {
        reason = `Historical ECB exchange rates returned HTTP ${response.status}.`;
        retryable = response.status === 429 || response.status >= 500 && response.status <= 599;
        const seconds = Number(response.headers?.get?.("retry-after"));
        if (seconds > 0) delay = Math.min(5000, Math.max(1000, seconds * 1000));
      } else {
        let raw;
        try { raw = await response.json(); }
        catch (error) {
          if (error?.name === "AbortError") throw error;
          retryable = false;
          reason = "Historical ECB exchange rates were not valid JSON.";
        }
        if (raw) {
          const snapshot = buildPortfolioFxSnapshot(raw, { now: clock(), from });
          if (snapshot) return { snapshot, status: "updated", retained: false, available: true,
            reason: null, attempts, coverage: portfolioFxCoverage(snapshot) };
          retryable = false;
          reason = "Historical ECB exchange rates have invalid values, dates, pairs, or incomplete five-year coverage.";
        } else if (retryable) {
          retryable = false;
          reason = "Historical ECB exchange rates response was empty.";
        }
      }
    } catch (error) {
      reason = error?.name === "AbortError" ? "Historical ECB exchange rates request timed out."
        : "Historical ECB exchange rates request failed.";
    } finally { clearTimeout(timer); }
    if (!retryable || attempt >= maxRetries) break;
    await wait(delay);
  }
  const retained = normalizeHistoricalFx(previous, { now: clock() });
  const snapshot = retained || { schemaVersion: 1, available: false, source: PORTFOLIO_FX_SOURCE,
    sourceUrl: PORTFOLIO_FX_SOURCE_URL, generatedAt: null, byCurrency: {}, reason };
  return { snapshot, status: retained ? "retained" : "unavailable", retained: !!retained,
    available: !!retained, reason, attempts, coverage: portfolioFxCoverage(retained) };
}

export async function runPortfolioFxUpdate({ outputPath = DEFAULT_OUTPUT, ...options } = {}) {
  let previous = null;
  try { previous = JSON.parse(await readFile(outputPath, "utf8")); }
  catch { /* A missing or malformed file supplies no historical rates. */ }
  const result = await updatePortfolioFxSnapshot({ ...options, previous });
  if (!result.retained) {
    await mkdir(dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(result.snapshot)}\n`, "utf8");
      await rename(temporary, outputPath);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { snapshot, ...diagnostics } = await runPortfolioFxUpdate();
    console.log(JSON.stringify({ source: PORTFOLIO_FX_SOURCE, ...diagnostics }));
  } catch (error) {
    console.warn(JSON.stringify({ status: "publish_failed", source: PORTFOLIO_FX_SOURCE,
      reason: error?.message || "Historical exchange-rate file could not be published." }));
  }
}
