import { VWCE_EXPOSURE } from "../data/fund-exposure.js";

// Company amounts are partial look-through estimates: current ETF value times
// dated fund weights. Unreported constituents never count as zero exposure.
export function calculateEtfExposure(analytics, { funds = [VWCE_EXPOSURE], now = Date.now() } = {}) {
  const companies = new Map(), reports = [], missingFunds = [];
  let unreported = 0, missingValue = false;
  const ensure = (id, name) => {
    if (!companies.has(id)) companies.set(id, { id, name, direct: 0, indirect: 0, sources: [] });
    return companies.get(id);
  };
  const knownCompany = (ticker) => funds.flatMap((fund) => fund.holdings).find((row) => row.tickers.includes(ticker));
  for (const position of analytics.rows) {
    if (position.value === null) { missingValue = true; continue; }
    if (position.assetType !== "ETFs") {
      const company = knownCompany(position.ticker);
      ensure(company?.id || `direct:${position.ticker}|${position.currency}`, company?.name || position.label).direct += position.value;
      continue;
    }
    const fund = funds.find((fund) => fund.tickers.includes(position.ticker));
    const date = fund ? Date.parse(`${fund.asOf}T00:00:00Z`) : NaN;
    const coverage = fund?.holdings.reduce((sum, row) => sum + row.weight, 0);
    const valid = fund && Number.isFinite(date) && date <= Number(now) && coverage > 0 && coverage <= 1
      && fund.holdings.every((row) => Number.isFinite(row.weight) && row.weight > 0 && row.weight <= 1);
    if (!valid) { unreported += position.value; missingFunds.push(position.ticker); continue; }
    const ageDays = Math.floor((Number(now) - date) / 86400000);
    reports.push({ ticker: position.ticker, value: position.value, coverage, asOf: fund.asOf, ageDays, source: fund.source, sourceUrl: fund.sourceUrl });
    unreported += position.value * (1 - coverage);
    for (const holding of fund.holdings) {
      const company = ensure(holding.id, holding.name);
      company.indirect += position.value * holding.weight;
      company.sources.push(`${position.ticker} · ${fund.asOf}`);
    }
  }
  const rows = [...companies.values()].map((row) => ({ ...row, value: row.direct + row.indirect,
    weight: analytics.complete && analytics.knownValue > 0 ? (row.direct + row.indirect) / analytics.knownValue : null }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return { rows, reports, missingFunds, unreported, missingValue, hasEtfs: analytics.hasEtfs, completeValuation: analytics.complete, total: analytics.knownValue,
    unreportedWeight: analytics.complete && analytics.knownValue > 0 ? unreported / analytics.knownValue : null };
}
