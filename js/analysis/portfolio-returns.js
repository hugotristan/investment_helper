// EUR return compares today's valuation with the actual EUR cash paid.
// It never revalues historical purchase costs using today's exchange rate.
export function holdingEurReturn(holding, { eurCostBases = null, exchangeRate = null } = {}) {
  const recorded = eurCostBases?.find((entry) => entry.id === holding.id
    && entry.ticker === holding.ticker && entry.currency === holding.currency);
  const costBasis = recorded ? recorded.costBasis : holding.currency === "EUR" ? holding.costBasis : null;
  const rate = holding.currency === "EUR" ? 1 : holding.currency === "USD"
    && exchangeRate?.available === true && exchangeRate.base === "USD" && exchangeRate.quote === "EUR"
    && Number.isFinite(exchangeRate.rate) && exchangeRate.rate > 0 ? exchangeRate.rate : null;
  const value = Number.isFinite(holding.currentValue) && rate !== null ? holding.currentValue * rate : null;
  const currentValue = Number.isFinite(value) ? value : null;
  const gain = currentValue !== null && Number.isFinite(costBasis) ? currentValue - costBasis : null;
  return { costBasis: Number.isFinite(costBasis) ? costBasis : null, currentValue,
    gain: Number.isFinite(gain) ? gain : null,
    gainPercent: Number.isFinite(gain) && costBasis > 0 ? gain / costBasis : null };
}
