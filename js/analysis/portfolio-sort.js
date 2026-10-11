export function sortPortfolioHoldings(holdings, { by = "size", direction = "desc" } = {}) {
  const sign = direction === "asc" ? 1 : -1;
  const name = (holding) => holding.label || holding.ticker || "";
  const compareName = (a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: "base" })
    || String(a.ticker).localeCompare(String(b.ticker)) || String(a.id).localeCompare(String(b.id));
  return [...holdings].sort((a, b) => {
    if (by === "name") return sign * compareName(a, b);
    const first = by === "performance" ? a.eur?.gainPercent : a.currentValue;
    const second = by === "performance" ? b.eur?.gainPercent : b.currentValue;
    // Unknown values stay last in both directions, never masquerading as zero.
    if (!Number.isFinite(first)) return Number.isFinite(second) ? 1 : compareName(a, b);
    if (!Number.isFinite(second)) return -1;
    return sign * (first - second) || compareName(a, b);
  });
}
