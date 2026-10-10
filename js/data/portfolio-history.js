import { usesCloudMarket } from "./cloud-mode.js";

export const PORTFOLIO_FX_SOURCE = "ECB reference rates via Frankfurter";
export const PORTFOLIO_FX_SOURCE_URL = "https://api.frankfurter.dev/v2/providers/ecb/rates";
export const PORTFOLIO_FX_CURRENCIES = Object.freeze(["USD", "GBP", "JPY", "CHF", "CAD", "AUD"]);
export const PORTFOLIO_FX_MAX_POINTS = 1600;
const DAY = 86400000;
const normalizedSnapshots = new WeakSet();
let request = null;
let cachedSnapshot = null;
let expiresAt = 0;

function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : null;
}

// Historical reference rates value a dated portfolio. They never change a
// saved broker settlement, opening cash balance, or transaction cost.
export function normalizeHistoricalFx(input, { now = Date.now() } = {}) {
  const clock = new Date(now).getTime();
  if (!input || typeof input !== "object" || Array.isArray(input) || !Number.isFinite(clock)
    || input.schemaVersion !== 1 || input.available === false
    || Object.hasOwn(input, "available") && typeof input.available !== "boolean" || input.source !== PORTFOLIO_FX_SOURCE
    || input.sourceUrl !== PORTFOLIO_FX_SOURCE_URL || typeof input.generatedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.generatedAt)
    || !input.byCurrency || typeof input.byCurrency !== "object" || Array.isArray(input.byCurrency)) return null;
  const generated = Date.parse(input.generatedAt);
  if (!Number.isFinite(generated) || generated > clock
    || new Date(generated).toISOString().slice(0, 10) !== input.generatedAt.slice(0, 10)) return null;
  const byCurrency = {};
  for (const [currency, points] of Object.entries(input.byCurrency)) {
    if (!PORTFOLIO_FX_CURRENCIES.includes(currency) || !Array.isArray(points)
      || !points.length || points.length > PORTFOLIO_FX_MAX_POINTS) return null;
    const days = new Map();
    for (const point of points) {
      const date = calendarDate(point?.date);
      if (date === null || date > generated || date > clock || !Number.isFinite(point?.rate) || point.rate <= 0
        || days.has(point.date)) return null;
      days.set(point.date, Object.freeze({ date: point.date, rate: point.rate }));
    }
    byCurrency[currency] = Object.freeze([...days.values()].sort((a, b) => a.date.localeCompare(b.date)));
  }
  if (!Object.keys(byCurrency).length) return null;
  const result = Object.freeze({ schemaVersion: 1, source: PORTFOLIO_FX_SOURCE,
    sourceUrl: PORTFOLIO_FX_SOURCE_URL, generatedAt: new Date(generated).toISOString(), byCurrency: Object.freeze(byCurrency) });
  normalizedSnapshots.add(result);
  return result;
}

export function historicalRate(snapshot, currency, date, { now = Date.now() } = {}) {
  const day = date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : date;
  const target = calendarDate(day);
  const clock = new Date(now).getTime();
  if (target === null || !Number.isFinite(clock) || target > clock) return null;
  if (currency === "EUR") return { rate: 1, date: day };
  if (!PORTFOLIO_FX_CURRENCIES.includes(currency)) return null;
  const normalized = snapshot && normalizedSnapshots.has(snapshot) ? snapshot : normalizeHistoricalFx(snapshot, { now });
  if (!normalized || Date.parse(normalized.generatedAt) > clock) return null;
  const points = normalized?.byCurrency[currency];
  if (!points?.length) return null;
  let low = 0, high = points.length - 1, found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].date <= day) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  const point = points[found];
  return point && target - Date.parse(point.date) <= 7 * DAY ? { ...point } : null;
}

export function loadPortfolioFx() {
  if (!request || Date.now() >= expiresAt) {
    expiresAt = Date.now() + 5 * 60 * 1000;
    request = fetchSnapshot();
  }
  return request;
}

async function fetchSnapshot() {
  const cloud = usesCloudMarket();
  const controller = new AbortController();
  // Allow the Worker to recover from a timed-out provider with a dated snapshot.
  const timeout = setTimeout(() => controller.abort(), cloud ? 16000 : 8000);
  try {
    const response = await fetch(cloud ? "/api/portfolio-fx" : new URL("../../data/portfolio-fx.json", import.meta.url), { cache: "no-cache", credentials: "same-origin", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const normalized = normalizeHistoricalFx(await response.json());
    if (!normalized) throw new Error("Invalid portfolio exchange-rate history");
    cachedSnapshot = normalized;
  } catch {
    expiresAt = Date.now() + 30000;
    // Original observation dates stay intact during transient source failures.
  } finally { clearTimeout(timeout); }
  return cachedSnapshot;
}
