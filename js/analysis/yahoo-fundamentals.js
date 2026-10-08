import { emptyFundamentals } from "./fundamentals.js";

const DAY_MS = 86400000;
const TYPES = {
  revenue: "annualTotalRevenue", netIncome: "annualNetIncome", operatingCashFlow: "annualOperatingCashFlow",
  capitalExpenditures: "annualCapitalExpenditure", freeCashFlow: "annualFreeCashFlow", totalDebt: "annualTotalDebt",
  dilutedEPS: "annualDilutedEPS", basicEPS: "annualBasicEPS"
};
export const YAHOO_ANNUAL_TYPES = Object.freeze(Object.values(TYPES));
const CURRENCIES = new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency")
  : ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD", "TWD", "KRW", "INR", "SGD", "BRL", "MXN", "ZAR", "SEK", "NOK", "DKK"]);

// Yahoo's annual period dates are provider labels, not verified SEC accounting
// dates. Never infer fiscal-year labels, start dates, filing dates or accessions.
export function normalizeYahooFinancials(json, { ticker = "", retrievedAt = new Date().toISOString(), companyName = null } = {}) {
  ticker = String(ticker).trim().toUpperCase();
  const record = { ...emptyFundamentals(ticker, "No supported Yahoo Finance annual financials were available."), provider: "Yahoo Finance" };
  const acquired = Date.parse(retrievedAt);
  if (!Number.isFinite(acquired) || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker)) return record;
  record.retrievedAt = new Date(acquired).toISOString();
  record.companyName = typeof companyName === "string" && companyName.trim() ? companyName.trim() : null;
  if (json?.timeseries?.error || !Array.isArray(json?.timeseries?.result)) return record;
  const facts = annualFacts(json.timeseries.result, ticker, acquired);
  if (!facts.size) return record;
  const latestEnd = [...facts.values()].map((fact) => fact.end).sort().at(-1);
  const current = [...facts.values()].filter((fact) => fact.end === latestEnd && !fact.conflict);
  const currency = Object.keys(TYPES).map((metric) => current.find((fact) => fact.metric === metric)?.currency).find(Boolean);
  record.periodEnd = latestEnd;
  if (!currency) {
    record.reason = "Yahoo Finance annual values conflict for the latest provider period; they were left unavailable.";
    return record;
  }
  record.currency = currency;
  for (const metric of Object.keys(TYPES)) {
    const fact = facts.get(`${metric}|${latestEnd}`);
    if (!fact || fact.conflict || fact.currency !== currency) continue;
    record.metrics[metric] = metric === "capitalExpenditures" ? Math.abs(fact.value) : fact.value;
    record.metricSources[metric] = [provenance(fact, ticker)];
  }
  for (const [growth, metric] of [["revenueGrowth", "revenue"], ["netIncomeGrowth", "netIncome"],
    ["operatingCashFlowGrowth", "operatingCashFlow"], ["freeCashFlowGrowth", "freeCashFlow"]]) {
    const currentFact = facts.get(`${metric}|${latestEnd}`);
    const prior = [...facts.values()].filter((fact) => {
      const days = (Date.parse(latestEnd) - Date.parse(fact.end)) / DAY_MS;
      return fact.metric === metric && !fact.conflict && fact.currency === currency && days >= 335 && days <= 400;
    }).sort((a, b) => b.end.localeCompare(a.end))[0];
    const value = record.metrics[metric];
    if (!Number.isFinite(value) || !prior || prior.value <= 0 || currentFact?.conflict) continue;
    const ratio = value / prior.value - 1;
    if (!Number.isFinite(ratio)) continue;
    record.metrics[growth] = ratio;
    record.metricSources[growth] = [provenance(currentFact, ticker), provenance(prior, ticker)];
  }
  record.available = Object.values(record.metrics).some(Number.isFinite);
  record.status = record.available ? "available" : "unavailable";
  if (record.available) {
    record.periodType = "12M";
    record.reason = "Yahoo Finance annual reported values; provider period dates may be nominal. SEC filing dates and missing concepts remain unavailable.";
  }
  return record;
}

function annualFacts(results, ticker, acquired) {
  const facts = new Map();
  for (const result of results) {
    const symbols = result?.meta?.symbol;
    const types = result?.meta?.type;
    if (!Array.isArray(symbols) || symbols.length !== 1 || symbols[0] !== ticker
      || !Array.isArray(types) || types.length !== 1 || !YAHOO_ANNUAL_TYPES.includes(types[0])) continue;
    const type = types[0];
    const metric = Object.keys(TYPES).find((key) => TYPES[key] === type);
    if (!Array.isArray(result[type])) continue;
    for (const item of result[type]) {
      const value = item?.reportedValue?.raw;
      if (item?.periodType !== "12M" || !validDate(item.asOfDate) || Date.parse(item.asOfDate) > acquired
        || !CURRENCIES.has(item.currencyCode) || !Number.isFinite(value) || metric === "totalDebt" && value < 0) continue;
      const fact = { metric, type, end: item.asOfDate, currency: item.currencyCode, value };
      const key = `${metric}|${fact.end}`;
      const previous = facts.get(key);
      // Without filing/restatement timestamps, a duplicate conflict cannot be
      // resolved by choosing the last value or by assuming currency conversion.
      if (previous && (previous.conflict || previous.currency !== fact.currency || previous.value !== value)) facts.set(key, { ...previous, conflict: true });
      else if (!previous) facts.set(key, fact);
    }
  }
  return facts;
}

function provenance(fact, ticker) {
  const section = fact.metric === "totalDebt" ? "balance-sheet" : ["operatingCashFlow", "capitalExpenditures", "freeCashFlow"].includes(fact.metric) ? "cash-flow" : "financials";
  const source = { provider: "Yahoo Finance", tag: fact.type, unit: `${fact.currency}${fact.metric.endsWith("EPS") ? "/shares" : ""}`,
    periodType: "12M", start: null, end: fact.end, filed: null, accession: null, value: fact.value,
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/${section}/` };
  if (fact.metric === "capitalExpenditures" && fact.value < 0) source.transformation = "Absolute value of the reported capital-expenditure cash outflow.";
  return source;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
