// Merge public market results without replacing a newer portfolio valuation
// when a slower, broader scan finishes with older or missing prices.
export function mergePortfolioPriceResults(results, portfolioResults) {
  const merged = new Map(results.map((item) => [item.ticker, item]));
  for (const item of portfolioResults) {
    const current = merged.get(item.ticker);
    if (!current || observationTime(item) > observationTime(current)) merged.set(item.ticker, item);
  }
  return [...merged.values()];
}

function observationTime(item) {
  if (!item?.prices?.length || /^(?:unavailable|sample)\b/i.test(String(item.source || ""))) return -Infinity;
  const history = new Date(item.historyAsOf || item.dailyClose?.asOf || item.dataQuality?.asOf).getTime();
  const quote = new Date(item.quote?.quoteTime).getTime();
  return Math.max(Number.isFinite(history) ? history : -Infinity, Number.isFinite(quote) ? quote : -Infinity);
}
