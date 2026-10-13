import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readBoundedText } from "../server/request-body.mjs";
import { LEEWAY_QUOTE_SOURCE } from "../js/data/quote-provenance.js";

const DAY = 86400000;
const DAILY_LIMIT = 40; // Leave room within the advertised 50/day for account checks.
const day = (now) => new Date(now).toISOString().slice(0, 10);

// Exchange/currency identity comes from validated Yahoo history, not user text.
// Unverified listings and GBP/GBp unit conversions are deliberately excluded.
export function leewayInstrument(ticker, record) {
  if (!record || record.ticker !== ticker || record.source !== "Yahoo Finance published snapshot"
    || !["EQUITY", "ETF"].includes(record.instrumentType)) return null;
  const match = /^([A-Z0-9][A-Z0-9-]{0,15})(?:\.(DE|HE|AS))?$/.exec(ticker);
  if (!match) return null;
  const listing = { DE: ["XETRA", "EUR", "Xetra"], HE: ["HE", "EUR", "Helsinki"],
    AS: ["AS", "EUR", "Amsterdam"] }[match[2]] || ["US", "USD", "US"];
  if (record.currency !== listing[1]) return null;
  return { ticker, symbol: `${match[1]}.${listing[0]}`, currency: listing[1], exchange: listing[2],
    quoteType: record.instrumentType, name: String(record.quote?.name || ticker).slice(0, 200) };
}

export function parseLeewayQuote(raw, instrument, { now = Date.now() } = {}) {
  const stamp = raw?.timestamp;
  const time = Number.isFinite(stamp) ? stamp * 1000 : NaN;
  if (!instrument || raw?.code !== instrument.symbol || !Number.isFinite(time)
    || time > now || now - time > 7 * DAY || !Number.isFinite(raw.close) || raw.close <= 0
    || raw.gmtoffset !== undefined && raw.gmtoffset !== 0
    || raw.currency !== undefined && raw.currency !== instrument.currency
    || raw.datetime !== undefined && Date.parse(raw.datetime) !== time) return null;
  const previousClose = Number.isFinite(raw.previousClose) && raw.previousClose > 0 ? raw.previousClose : null;
  return { ...instrument, providerSymbol: instrument.symbol, symbol: undefined, price: raw.close,
    previousClose, dayChange: previousClose ? raw.close - previousClose : null,
    dayChangePercent: previousClose ? raw.close / previousClose - 1 : null,
    quoteTime: new Date(time).toISOString(), source: LEEWAY_QUOTE_SOURCE, delayMinutes: 20,
    ...(Number.isFinite(raw.volume) && raw.volume >= 0 ? { volume: raw.volume } : {}),
    ...(Number.isFinite(raw.high) && raw.high >= raw.close ? { dayHigh: raw.high } : {}),
    ...(Number.isFinite(raw.low) && raw.low > 0 && raw.low <= raw.close ? { dayLow: raw.low } : {}) };
}

export function createLeewayQuoteFallback({ token = "", reserve = async () => false,
  fetchImpl = fetch, now = Date.now, timeoutMs = 5000 } = {}) {
  if (typeof token !== "string" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Invalid fallback configuration.");
  let unavailable = false;
  return async (ticker, record) => {
    if (!token || unavailable) return null;
    const instrument = leewayInstrument(ticker, record);
    if (!instrument || !await reserve()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // The secret is confined to this fixed provider request; no browser assets,
      // portfolio amounts, caller-supplied URLs, or provider error bodies are saved.
      const url = new URL(`https://api.leeway.tech/api/v1/public/live/${instrument.symbol}`);
      url.searchParams.set("apitoken", token);
      const response = await fetchImpl(url.href, { headers: { Accept: "application/json" }, redirect: "manual", signal: controller.signal });
      if (!response.ok) {
        if ([401, 403, 429].includes(response.status)) unavailable = true;
        return null;
      }
      return parseLeewayQuote(JSON.parse(await readBoundedText(response, 32768)), instrument, { now: now() });
    } catch { return null; }
    finally { clearTimeout(timer); }
  };
}

// Persist before every outbound call and serialize reservations. Scheduled jobs
// restore this private counter separately from public prices. If a configured
// job loses its counter, it pauses fallback for that UTC day rather than resets.
export async function createPriceFallbackBudget(path, { now = Date.now, configured = false } = {}) {
  const today = day(now());
  let saved;
  try { saved = JSON.parse(await readFile(path, "utf8")); } catch {}
  const valid = saved?.schemaVersion === 1 && /^\d{4}-\d{2}-\d{2}$/.test(saved.date)
    && Number.isInteger(saved.used) && saved.used >= 0 && saved.used <= DAILY_LIMIT;
  let state = valid && saved.date === today ? saved : {
    schemaVersion: 1, date: today, used: valid && saved.date < today || !configured ? 0 : DAILY_LIMIT
  };
  async function save() {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(state) + "\n");
    await rename(`${path}.tmp`, path);
  }
  await save();
  let pending = Promise.resolve();
  return { reserve() {
    const request = pending.then(async () => {
      if (day(now()) !== state.date) {
        if (day(now()) < state.date) return false;
        state = { schemaVersion: 1, date: day(now()), used: 0 };
      }
      if (state.used >= DAILY_LIMIT) return false;
      state.used += 1;
      await save();
      return true;
    });
    pending = request.catch(() => {});
    return request;
  } };
}
