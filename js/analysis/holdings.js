import { hasQualifiedSignal, validHistoryPoints } from "./data-quality.js";

const DAY_MS = 86400000;
const MAX_AGE_MS = 7 * DAY_MS;

export function normalizeHolding(input = {}) {
  const ticker = String(input.ticker || "").trim().toUpperCase();
  const currency = String(input.currency || "").trim().toUpperCase();
  const shares = decimalNumber(input.shares);
  const averageCost = decimalNumber(input.averageCost);
  const fail = (error) => ({ ok: false, holding: null, error });
  if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker)) return fail("Enter a valid stock or ETF ticker.");
  if (!Number.isFinite(shares) || shares <= 0) return fail("Share quantity must be a positive number.");
  if (!Number.isFinite(averageCost) || averageCost < 0) return fail("Average purchase price must be zero or a positive number.");
  if (!Number.isFinite(shares * averageCost)) return fail("The entered cost basis exceeds the supported number range.");
  if (!/^[A-Z]{3}$/.test(currency)) return fail("Choose a three-letter currency code.");
  return { ok: true, error: null, holding: { id: input.id ?? null, kind: "position", ticker,
    label: String(input.label || "").trim() || ticker, shares, averageCost, currency } };
}

export function calculateHoldings(holdings, results, { now = Date.now() } = {}) {
  const byTicker = new Map((results || []).map((item) => [item.ticker, item]));
  const rows = (holdings || []).map((holding) => {
    if (holding.kind === "manual") {
      const currentValue = Number.isFinite(holding.amount) && holding.amount >= 0 ? holding.amount : null;
      return { ...holding, price: null, currentValue, costBasis: null, gain: null, gainPercent: null,
        weight: null, asOf: null, source: "manual", valuationError: currentValue === null ? "The entered amount is unavailable." : null };
    }
    const normalized = normalizeHolding(holding);
    if (!normalized.ok) return { ...holding, price: null, currentValue: null, costBasis: null,
      gain: null, gainPercent: null, status: "unknown", weight: null, asOf: null,
      source: "unavailable", valuationError: normalized.error };
    const position = normalized.holding;
    const costBasis = position.shares * position.averageCost;
    const valuation = priceForHolding(byTicker.get(position.ticker), position.currency, now);
    const calculatedValue = valuation ? position.shares * valuation.price : null;
    const currentValue = Number.isFinite(calculatedValue) ? calculatedValue : null;
    const gain = currentValue === null ? null : currentValue - costBasis;
    return { ...position, price: currentValue === null ? null : valuation.price,
      currentValue, costBasis, gain, gainPercent: gain !== null && costBasis > 0 ? gain / costBasis : null,
      status: gain === null ? "unknown" : gain > 0 ? "up" : gain < 0 ? "down" : "flat",
      weight: null, asOf: currentValue === null ? null : valuation.asOf,
      source: currentValue === null ? "unavailable" : valuation.source,
      valuationError: currentValue === null ? "A qualified recent price in this holding's exact currency is unavailable." : null };
  });
  const grouped = new Map();
  for (const row of rows) {
    if (!/^[A-Z]{3}$/.test(String(row.currency || ""))) continue;
    if (!grouped.has(row.currency)) grouped.set(row.currency, []);
    grouped.get(row.currency).push(row);
  }
  const groups = [...grouped].map(([currency, members]) => {
    const valued = members.filter((row) => Number.isFinite(row.currentValue));
    const total = valued.length ? valued.reduce((sum, row) => sum + row.currentValue, 0) : null;
    const complete = valued.length === members.length;
    const legacyCount = members.filter((row) => row.kind === "manual").length;
    const knownBases = members.filter((row) => Number.isFinite(row.costBasis));
    const costBasis = !legacyCount && knownBases.length === members.length ? knownBases.reduce((sum, row) => sum + row.costBasis, 0) : null;
    const gain = complete && !legacyCount && costBasis !== null && total !== null ? total - costBasis : null;
    for (const row of valued) row.weight = total > 0 ? row.currentValue / total * 100 : null;
    return { currency, total, costBasis, gain, complete, legacyCount };
  }).sort((a, b) => a.currency.localeCompare(b.currency));
  return { holdings: rows, groups, missingCount: rows.filter((row) => row.currentValue === null).length };
}

function priceForHolding(item, currency, now) {
  const historyTime = Date.parse(item?.dataQuality?.asOf || "");
  const points = validHistoryPoints(item);
  const verifiedShortHistory = ["EQUITY", "ETF"].includes(item?.instrumentType)
    && /^Yahoo Finance (?:published snapshot|chart|via CORS relay)(?: \+ .*)?$/.test(item?.source || "")
    && points.length > 0 && new Date(points.at(-1).date).getTime() === historyTime;
  if ((!hasQualifiedSignal(item) && !verifiedShortHistory) || /^sample\b/i.test(String(item?.source || ""))
    || !Number.isFinite(historyTime) || historyTime > now || now - historyTime > MAX_AGE_MS) return null;
  const quote = item.quote;
  const quoteTime = quote?.quoteTime ? new Date(quote.quoteTime).getTime() : NaN;
  if (quote && (!quote.ticker || quote.ticker === item.ticker) && quote.currency === currency
    && (!item.currency || quote.currency === item.currency)
    && Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(quoteTime)
    && quoteTime <= now && now - quoteTime <= MAX_AGE_MS && quoteTime >= historyTime) {
    return { price: quote.price, asOf: new Date(quoteTime).toISOString(), source: "quote" };
  }
  // Yahoo's GBp is pence, not GBP. Currency metadata is matched exactly and no
  // exchange rate or minor-unit conversion is assumed by this calculator.
  const dailyClose = item.dailyClose;
  const dailyTime = dailyClose?.asOf ? new Date(dailyClose.asOf).getTime() : NaN;
  if (dailyClose?.currency === currency && dailyTime === historyTime
    && Number.isFinite(dailyClose.price) && dailyClose.price > 0) {
    return { price: dailyClose.price, asOf: new Date(dailyTime).toISOString(), source: "daily" };
  }
  // Intraday substitution changes item.latest and the last prices point. Without
  // the original close snapshot neither can establish a genuine daily price.
  if (/\+\s*Yahoo intraday\b/i.test(String(item.source || ""))) return null;
  if (verifiedShortHistory && item.currency === currency) {
    return { price: points.at(-1).close, asOf: new Date(historyTime).toISOString(), source: "daily" };
  }
  if (item.currency === currency && Number.isFinite(item.latest) && item.latest > 0) {
    if (quote && item.latest === quote.price) {
      const dailyPoint = validHistoryPoints(item).at(-1);
      if (!dailyPoint || new Date(dailyPoint.date).getTime() !== historyTime
        || dailyPoint.close !== item.latest) return null;
    }
    return { price: item.latest, asOf: new Date(historyTime).toISOString(), source: "daily" };
  }
  return null;
}

function decimalNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return NaN;
  return Number(value.trim());
}
