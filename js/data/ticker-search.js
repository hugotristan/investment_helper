import { broadFunds, companyAliases, marketProxyTickers, opportunityUniverse } from "../config/settings.js";
import { isBlockedAssetTicker } from "../shared/symbols.js";
import { loadPriceSnapshot } from "./price-snapshot.js";

const CATALOG_URL = new URL("../../data/sec-tickers.json", import.meta.url);
const INSTRUMENT_URL = new URL("../../data/instruments.json", import.meta.url);
export const INSTRUMENT_SOURCE = "Nasdaq Trader symbol directory";
export const INSTRUMENT_SOURCE_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt";
export const INSTRUMENT_MAX_ENTRIES = 20000;
let catalogRequest = null;
let expiresAt = 0;
let savedInstruments = null;

export function normalizeInstrumentCatalog(value, { now = Date.now() } = {}) {
  const stamp = Date.parse(value?.generatedAt);
  if (value?.schemaVersion !== 1 || value.source !== INSTRUMENT_SOURCE || value.sourceUrl !== INSTRUMENT_SOURCE_URL
    || !Number.isFinite(now) || typeof value.generatedAt !== "string" || !Number.isFinite(stamp) || stamp > now
    || typeof value.sourceAsOf !== "string" || !/^\d{10}:\d{2}$/.test(value.sourceAsOf)
    || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > INSTRUMENT_MAX_ENTRIES) return null;
  const sourceDate = instrumentSourceDate(value.sourceAsOf);
  if (!Number.isFinite(sourceDate) || sourceDate - now > 86400000) return null;
  const symbols = new Set();
  const entries = [];
  for (const entry of value.entries) {
    if (!validTicker(entry?.ticker) || symbols.has(entry.ticker) || typeof entry.label !== "string"
      || !entry.label.trim() || entry.label.length > 300 || !["stock", "ETF"].includes(entry.type)
      || typeof entry.exchange !== "string" || !/^[A-Z]$/.test(entry.exchange)
      || !Array.isArray(entry.aliases) || entry.aliases.length > 8
      || entry.aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 300)) return null;
    symbols.add(entry.ticker);
    entries.push({ ticker: entry.ticker, label: entry.label.trim(), type: entry.type,
      exchange: entry.exchange, aliases: [...new Set(entry.aliases)] });
  }
  return { schemaVersion: 1, source: INSTRUMENT_SOURCE, sourceUrl: INSTRUMENT_SOURCE_URL,
    sourceAsOf: value.sourceAsOf, generatedAt: value.generatedAt, entries };
}

export function buildTickerCatalog({ instruments = null, secTickers = null, priceSnapshot = null, now = Date.now() } = {}) {
  const entries = new Map();
  const add = (ticker, label, type, alias) => {
    if (!validTicker(ticker)) return;
    const existing = entries.get(ticker) || { ticker, label: ticker, type: broadFunds.has(ticker) ? "ETF" : "stock", aliases: [] };
    if (typeof label === "string" && label.trim() && label.length <= 300) existing.label = label.trim();
    if (type === "ETF" || type === "stock") existing.type = type;
    if (alias && !existing.aliases.includes(alias)) existing.aliases.push(alias);
    entries.set(ticker, existing);
  };
  for (const ticker of [...opportunityUniverse, ...broadFunds]) add(ticker);
  for (const { ticker, label } of marketProxyTickers) add(ticker, label, broadFunds.has(ticker) ? "ETF" : "stock");
  for (const [alias, ticker] of Object.entries(companyAliases)) {
    add(ticker, entries.get(ticker)?.label === ticker ? titleCase(alias.replace(/ stock$/, "")) : null, null, alias);
  }
  let issuerCount = 0;
  const issuers = secTickers?.schemaVersion === 1 && object(secTickers.companyTickers) ? Object.values(secTickers.companyTickers) : [];
  for (const issuer of issuers.slice(0, 20000)) {
    if (!object(issuer) || !validTicker(issuer.ticker) || !Number.isSafeInteger(issuer.cik_str) || issuer.cik_str <= 0
      || typeof issuer.title !== "string" || !issuer.title.trim() || issuer.title.length > 300) continue;
    add(issuer.ticker, issuer.title, broadFunds.has(issuer.ticker) ? "ETF" : "stock");
    issuerCount += 1;
  }
  const instrumentSnapshot = normalizeInstrumentCatalog(instruments, { now });
  for (const instrument of instrumentSnapshot?.entries || []) {
    add(instrument.ticker, instrument.label, instrument.type);
    for (const alias of instrument.aliases) add(instrument.ticker, null, null, alias);
  }
  if (priceSnapshot?.schemaVersion === 1 && object(priceSnapshot.byTicker)) {
    for (const [ticker, record] of Object.entries(priceSnapshot.byTicker).slice(0, 20000)) {
      if (!validTicker(ticker) || record?.ticker !== ticker || /^sample\b/i.test(record.source || "")
        || !["EQUITY", "ETF"].includes(record.instrumentType)) continue;
      const name = record.quote?.ticker === ticker ? record.quote.name : null;
      add(ticker, name, record.instrumentType === "ETF" ? "ETF" : "stock");
    }
  }
  return {
    entries: [...entries.values()].sort((a, b) => compare(a.ticker, b.ticker)),
    instrumentSnapshot,
    coverage: instrumentSnapshot ? `${instrumentSnapshot.entries.length.toLocaleString("en-US")} US-listed stocks and ETFs, plus configured international tickers. Other tickers can be typed and validated when saved.`
      : `Local suggestions include configured stocks and ETFs${issuerCount ? ` and ${issuerCount} bundled US issuers` : ""}. Other tickers can be typed and validated when saved.`
  };
}

export function loadTickerCatalog() {
  if (catalogRequest && Date.now() < expiresAt) return catalogRequest;
  expiresAt = Date.now() + 5 * 60 * 1000;
  catalogRequest = Promise.allSettled([fetchInstrumentCatalog(), fetchIssuerCatalog(), loadPriceSnapshot()]).then(([instruments, issuers, prices]) => {
    if (instruments.status === "fulfilled" && instruments.value) savedInstruments = instruments.value;
    else expiresAt = Date.now() + 30000;
    return buildTickerCatalog({ instruments: savedInstruments, secTickers: issuers.status === "fulfilled" ? issuers.value : null,
      priceSnapshot: prices.status === "fulfilled" ? prices.value : null });
  });
  return catalogRequest;
}

// Only exact identities resolve automatically. Ambiguous company names stay in
// the suggestion list so the user can select the intended share class.
export async function resolveTickerInput(value, { catalog = null } = {}) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) return null;
  const current = catalog || await loadTickerCatalog();
  const entries = Array.isArray(current) ? current : current?.entries || [];
  const input = fold(value);
  const symbol = entries.find((entry) => validTicker(entry?.ticker) && fold(entry.ticker) === input);
  if (symbol) return symbol.ticker;
  const matches = entries.filter((entry) => validTicker(entry?.ticker) && typeof entry.label === "string"
    && (fold(entry.label) === input || companyKey(entry.label) === companyKey(value)
      || entry.aliases?.some((alias) => typeof alias === "string" && fold(alias) === input)));
  const tickers = [...new Set(matches.map((entry) => entry.ticker))];
  if (tickers.length) return tickers.length === 1 ? tickers[0] : null;
  const typed = value.trim().toUpperCase();
  return validTicker(typed) ? typed : null;
}

export function findListedInstrument(catalog, ticker, { now = Date.now(), maxAgeMs = 7 * 86400000 } = {}) {
  const snapshot = normalizeInstrumentCatalog(catalog?.instrumentSnapshot, { now });
  const sourceDate = snapshot && instrumentSourceDate(snapshot.sourceAsOf);
  if (!snapshot || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || now - Date.parse(snapshot.generatedAt) > maxAgeMs
    || now - sourceDate > maxAgeMs + 86400000 || sourceDate - now > 86400000) return null;
  const entry = snapshot.entries.find((item) => item.ticker === ticker);
  return entry ? { ticker: entry.ticker, name: entry.label, quoteType: entry.type === "ETF" ? "ETF" : "EQUITY",
    exchange: entry.exchange, source: snapshot.source, sourceUrl: snapshot.sourceUrl, verifiedAt: snapshot.generatedAt } : null;
}

export function searchTickers(query, { catalog = buildTickerCatalog(), limit = 8 } = {}) {
  if (typeof query !== "string" || query.trim().length > 120) return [];
  const needle = fold(query);
  if (!needle) return [];
  const entries = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.entries) ? catalog.entries : [];
  const maximum = Math.min(8, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 8));
  const ranked = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!validTicker(entry?.ticker) || seen.has(entry.ticker) || typeof entry.label !== "string"
      || !["stock", "ETF"].includes(entry.type)) continue;
    seen.add(entry.ticker);
    const ticker = fold(entry.ticker);
    const label = fold(entry.label);
    const aliases = Array.isArray(entry.aliases) ? entry.aliases.filter((alias) => typeof alias === "string").map(fold) : [];
    const rank = ticker === needle ? 0 : label === needle || aliases.includes(needle) ? 1
      : ticker.startsWith(needle) ? 2 : label.startsWith(needle) ? 3 : aliases.some((alias) => alias.startsWith(needle)) ? 4
        : ticker.includes(needle) ? 5 : label.includes(needle) ? 6 : aliases.some((alias) => alias.includes(needle)) ? 7 : null;
    if (rank !== null) ranked.push({ rank, entry });
  }
  return ranked.sort((a, b) => a.rank - b.rank || compare(a.entry.ticker, b.entry.ticker))
    .slice(0, maximum).map(({ entry }) => ({ ticker: entry.ticker, label: entry.label, type: entry.type }));
}

async function fetchIssuerCatalog() {
  if (typeof fetch !== "function") return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(CATALOG_URL, { cache: "no-cache", credentials: "same-origin", signal: controller.signal });
    if (!response.ok) return null;
    const result = await response.json();
    return result?.schemaVersion === 1 && object(result.companyTickers) ? result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchInstrumentCatalog() {
  if (typeof fetch !== "function") return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(INSTRUMENT_URL, { cache: "no-cache", credentials: "same-origin", signal: controller.signal });
    if (!response.ok) return null;
    return normalizeInstrumentCatalog(await response.json());
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

function validTicker(ticker) {
  return typeof ticker === "string" && /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) && !isBlockedAssetTicker(ticker);
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fold(value) { return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " "); }
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function titleCase(value) { return value.replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function companyKey(value) {
  return fold(value).replace(/\s+-\s+.*$/, "").replace(/\b(?:class [a-z] )?(?:new )?(?:common|ordinary|capital) (?:stock|shares?)\b.*$/, "")
    .replace(/\b(?:american )?depositary (?:shares?|receipts?)\b.*$/, "")
    .replace(/\s*\(the\)\s*$/, "").replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/(?:\s+(?:incorporated|corporation|company|limited|holdings|technologies|technology|systems|inc|corp|plc|ltd|co|nv|sa|ag))+$/, "").trim();
}
function instrumentSourceDate(value) {
  const year = Number(value.slice(4, 8)), month = Number(value.slice(0, 2)), day = Number(value.slice(2, 4));
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1990 && date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    && Number(value.slice(8, 10)) <= 23 && Number(value.slice(11)) <= 59 ? date.getTime() : NaN;
}
