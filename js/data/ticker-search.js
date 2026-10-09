import { broadFunds, companyAliases, marketProxyTickers, opportunityUniverse } from "../config/settings.js";
import { isBlockedAssetTicker } from "../shared/symbols.js";
import { loadPriceSnapshot } from "./price-snapshot.js";

const CATALOG_URL = new URL("../../data/sec-tickers.json", import.meta.url);
let catalogRequest = null;
let expiresAt = 0;

export function buildTickerCatalog({ secTickers = null, priceSnapshot = null } = {}) {
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
    coverage: `Local suggestions include configured stocks and ETFs${issuerCount ? ` and ${issuerCount} bundled US issuers` : ""}. Other tickers can be typed and validated when saved.`
  };
}

export function loadTickerCatalog() {
  if (catalogRequest && Date.now() < expiresAt) return catalogRequest;
  expiresAt = Date.now() + 5 * 60 * 1000;
  catalogRequest = Promise.allSettled([fetchIssuerCatalog(), loadPriceSnapshot()]).then(([issuers, prices]) => {
    if (issuers.status !== "fulfilled" || !issuers.value) expiresAt = Date.now() + 30000;
    return buildTickerCatalog({ secTickers: issuers.status === "fulfilled" ? issuers.value : null,
      priceSnapshot: prices.status === "fulfilled" ? prices.value : null });
  });
  return catalogRequest;
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

function validTicker(ticker) {
  return typeof ticker === "string" && /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) && !isBlockedAssetTicker(ticker);
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fold(value) { return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " "); }
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function titleCase(value) { return value.replace(/\b\w/g, (letter) => letter.toUpperCase()); }
