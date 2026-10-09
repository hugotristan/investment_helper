import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { EXCHANGE_RATE_SOURCE, EXCHANGE_RATE_SOURCE_URL, normalizeExchangeRate } from "../js/data/exchange-rate.js";

const DEFAULT_OUTPUT = fileURLToPath(new URL("../data/exchange-rate.json", import.meta.url));
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

export function buildExchangeRateSnapshot(raw, { now = Date.now() } = {}) {
  const date = new Date(now);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Number.isFinite(date.getTime())) return null;
  return normalizeExchangeRate({ schemaVersion: 1, available: true, base: raw.base, quote: raw.quote,
    rate: raw.rate, date: raw.date, source: EXCHANGE_RATE_SOURCE, sourceUrl: EXCHANGE_RATE_SOURCE_URL,
    retrievedAt: date.toISOString() }, { now });
}

export function unavailableExchangeRate(reason) {
  return { schemaVersion: 1, available: false, base: "USD", quote: "EUR", rate: null, date: null,
    source: EXCHANGE_RATE_SOURCE, sourceUrl: EXCHANGE_RATE_SOURCE_URL, retrievedAt: null,
    reason: String(reason || "The USD-to-EUR reference rate is unavailable.").slice(0, 500) };
}

export async function updateExchangeRateSnapshot({ fetchImpl = globalThis.fetch, previous = null, now,
  timeoutMs = 15000, maxRetries = 1, wait = sleep } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 1) {
    throw new TypeError("Exchange-rate requests need a positive timeout and at most one retry.");
  }
  const clock = () => now === undefined ? Date.now() : now;
  let reason = "The USD-to-EUR reference rate request failed.";
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryable = true;
    let delay = 1000;
    try {
      const response = await fetchImpl(EXCHANGE_RATE_SOURCE_URL, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) {
        retryable = response.status === 429 || response.status >= 500 && response.status <= 599;
        reason = `The USD-to-EUR reference rate returned HTTP ${response.status}.`;
        const seconds = Number(response.headers?.get?.("retry-after"));
        if (seconds > 0) delay = Math.min(5000, Math.max(1000, seconds * 1000));
      } else {
        let raw;
        try { raw = await response.json(); }
        catch (error) {
          if (error?.name === "AbortError") throw error;
          retryable = false;
          reason = "The USD-to-EUR reference rate response was not valid JSON.";
        }
        if (raw) {
          const snapshot = buildExchangeRateSnapshot(raw, { now: clock() });
          if (snapshot) return { snapshot, retained: false, available: true, reason: null };
          retryable = false;
          reason = "The USD-to-EUR reference rate has an invalid pair, date, or value.";
        } else if (retryable) {
          retryable = false;
          reason = "The USD-to-EUR reference rate response was empty.";
        }
      }
    } catch (error) {
      reason = error?.name === "AbortError" ? "The USD-to-EUR reference rate request timed out." : "The USD-to-EUR reference rate request failed.";
    } finally { clearTimeout(timer); }
    if (!retryable || attempt >= maxRetries) break;
    await wait(delay);
  }
  const retained = normalizeExchangeRate(previous, { now: clock() });
  return retained ? { snapshot: retained, retained: true, available: true, reason }
    : { snapshot: unavailableExchangeRate(reason), retained: false, available: false, reason };
}

export async function runExchangeRateUpdate({ outputPath = DEFAULT_OUTPUT, ...options } = {}) {
  let previous = null;
  try { previous = JSON.parse(await readFile(outputPath, "utf8")); }
  catch { /* Missing or malformed snapshots must not be treated as a rate. */ }
  const result = await updateExchangeRateSnapshot({ ...options, previous });
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
    const result = await runExchangeRateUpdate();
    console.log(result.retained ? `USD/EUR display rate retained (${result.snapshot.date}).`
      : result.available ? `USD/EUR display rate updated (${result.snapshot.date}).` : `USD/EUR display rate unavailable: ${result.reason}`);
  } catch (error) {
    // This optional display source must not block unrelated price publishing.
    console.warn(`USD/EUR display rate could not be published: ${error?.message || "write failed"}.`);
  }
}
