import { broadFunds } from "../config/settings.js";

// Inputs are valued positions with EUR returns from the ledger calculation layer.
// Cash and ETF constituents are intentionally outside direct-holdings allocation.
export function calculatePortfolioAnalytics(holdings = []) {
  const rows = holdings.map((holding) => ({
    ticker: holding.ticker, currency: holding.currency, label: holding.label || holding.ticker,
    groupId: holding.annotation?.groupId || null, groupName: holding.groupName || "Ungrouped",
    assetType: assetType(holding),
    value: holding.kind !== "manual" && Number.isFinite(holding.eur?.currentValue) && holding.eur.currentValue >= 0
      ? holding.eur.currentValue : null,
    gain: holding.kind !== "manual" && Number.isFinite(holding.eur?.gain) ? holding.eur.gain : null,
    returnPercent: holding.kind !== "manual" && holding.eur?.costBasis > 0
      && Number.isFinite(holding.eur?.gainPercent) && Number.isFinite(holding.eur?.gain)
      && Number.isFinite(holding.eur?.currentValue) ? holding.eur.gainPercent : null,
    asOf: holding.asOf || null
  }));
  const valued = rows.filter((row) => row.value !== null);
  const sum = valued.reduce((total, row) => total + row.value, 0);
  const knownValue = Number.isFinite(sum) ? sum : null;
  const complete = rows.length > 0 && valued.length === rows.length && knownValue !== null;
  const weightAvailable = complete && knownValue > 0;
  const byValue = (a, b) => (b.value ?? -1) - (a.value ?? -1)
    || (a.ticker ? identity(a) : a.label).localeCompare(b.ticker ? identity(b) : b.label);
  rows.sort(byValue);
  for (const row of rows) row.weight = weightAvailable ? row.value / knownValue : null;
  const allocation = (key, label) => {
    const buckets = new Map();
    for (const row of rows) {
      const id = key(row);
      if (!buckets.has(id)) buckets.set(id, { id, label: label(row), value: 0, count: 0, missing: 0 });
      const bucket = buckets.get(id);
      bucket.count++;
      if (row.value === null) bucket.missing++;
      else bucket.value += row.value;
    }
    return [...buckets.values()].map((bucket) => ({ ...bucket,
      value: bucket.count === bucket.missing || !Number.isFinite(bucket.value) ? null : bucket.value,
      weight: weightAvailable ? bucket.value / knownValue : null
    })).sort((a, b) => byValue(a, b) || a.label.localeCompare(b.label));
  };
  const ranked = rows.filter((row) => row.returnPercent !== null && row.value !== null);
  const top = rows.slice(0, Math.min(3, rows.length));
  const dates = valued.map((row) => row.asOf).filter((date) => Number.isFinite(Date.parse(date))).sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    rows, count: rows.length, valuedCount: valued.length, returnCount: ranked.length,
    knownValue, complete, missing: rows.filter((row) => row.value === null).map(identity),
    allocations: {
      holdings: rows.map((row) => ({ id: identity(row), label: identity(row), value: row.value, weight: row.weight, count: 1, missing: row.value === null ? 1 : 0 })),
      groups: allocation((row) => row.groupId ? `group:${row.groupId}` : "unassigned", (row) => row.groupName),
      types: allocation((row) => row.assetType, (row) => row.assetType)
    },
    best: ranked.filter((row) => row.returnPercent > 0).sort((a, b) => b.returnPercent - a.returnPercent || byValue(a, b)).slice(0, 3),
    worst: ranked.filter((row) => row.returnPercent < 0).sort((a, b) => a.returnPercent - b.returnPercent || byValue(a, b)).slice(0, 3),
    concentration: weightAvailable ? {
      largest: rows[0], topCount: top.length, topWeight: top.reduce((total, row) => total + row.weight, 0),
      largestStock: rows.find((row) => row.assetType === "Stocks") || null
    } : null,
    oldestPrice: dates[0] || null, newestPrice: dates.at(-1) || null,
    hasEtfs: rows.some((row) => row.assetType === "ETFs")
  };
}

function identity(row) { return `${row.ticker} · ${row.currency}`; }
function assetType(holding) {
  const type = holding.analysis?.instrumentType || holding.analysis?.quote?.quoteType;
  if (type === "ETF" || holding.analysis?.isFund === true || broadFunds.has(holding.ticker)) return "ETFs";
  return type === "EQUITY" ? "Stocks" : "Unclassified";
}
