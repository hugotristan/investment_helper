import { usesCloudMarket } from "./cloud-mode.js";

export const EXCHANGE_RATE_SOURCE = "ECB reference rate via Frankfurter";
export const EXCHANGE_RATE_SOURCE_URL = "https://api.frankfurter.dev/v2/providers/ecb/rate/usd/eur";
export const EXCHANGE_RATE_MAX_AGE_MS = 7 * 86400000;

let rawSnapshot = null;
let request = null;
let expiresAt = 0;

// These dated reference rates are for display only, never transaction settlement.
export function normalizeExchangeRate(input, { now = Date.now() } = {}) {
  const clock = new Date(now).getTime();
  if (!input || typeof input !== "object" || Array.isArray(input) || !Number.isFinite(clock)
    || input.schemaVersion !== 1 || input.available === false || Object.hasOwn(input, "available") && typeof input.available !== "boolean"
    || input.base !== "USD" || input.quote !== "EUR"
    || !Number.isFinite(input.rate) || input.rate <= 0 || input.source !== EXCHANGE_RATE_SOURCE
    || input.sourceUrl !== EXCHANGE_RATE_SOURCE_URL) return null;
  if (typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return null;
  const asOf = Date.parse(input.date);
  if (!Number.isFinite(asOf) || new Date(asOf).toISOString().slice(0, 10) !== input.date
    || asOf > clock || clock - asOf > EXCHANGE_RATE_MAX_AGE_MS) return null;
  if (typeof input.retrievedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.retrievedAt)) return null;
  const retrieved = Date.parse(input.retrievedAt);
  if (!Number.isFinite(retrieved) || new Date(retrieved).toISOString().slice(0, 10) !== input.retrievedAt.slice(0, 10)
    || retrieved > clock || retrieved < asOf) return null;
  return { schemaVersion: 1, available: true, base: "USD", quote: "EUR", rate: input.rate, date: input.date,
    source: EXCHANGE_RATE_SOURCE, sourceUrl: EXCHANGE_RATE_SOURCE_URL, retrievedAt: new Date(retrieved).toISOString() };
}

export function getExchangeRate({ now = Date.now() } = {}) {
  return normalizeExchangeRate(rawSnapshot, { now });
}

export function loadExchangeRate() {
  if (!request || Date.now() >= expiresAt) {
    expiresAt = Date.now() + 5 * 60 * 1000;
    request = fetchSnapshot();
  }
  return request.then(() => getExchangeRate());
}

async function fetchSnapshot() {
  const cloud = usesCloudMarket();
  const controller = new AbortController();
  // The Worker can try a dated snapshot after its provider request times out.
  const timeout = setTimeout(() => controller.abort(), cloud ? 16000 : 8000);
  try {
    const response = await fetch(cloud ? "/api/exchange-rate" : new URL("../../data/exchange-rate.json", import.meta.url), { cache: "no-cache", credentials: "same-origin", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const input = await response.json();
    rawSnapshot = normalizeExchangeRate(input) ? input : null;
    if (!rawSnapshot) expiresAt = Date.now() + 30000;
  } catch {
    // A transient refresh failure can still use the original dated recent rate.
    if (!normalizeExchangeRate(rawSnapshot)) rawSnapshot = null;
    expiresAt = Date.now() + 30000;
  } finally {
    clearTimeout(timeout);
  }
}
