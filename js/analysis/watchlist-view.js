let companyNames = new Map();
export function setWatchlistCatalog(catalog) {
  companyNames = new Map((catalog?.entries || []).filter(entry => typeof entry.ticker === "string" && typeof entry.label === "string")
    .map(entry => [entry.ticker, entry.label.slice(0, 300)]));
}

// View order only: never reorder or change the saved ticker list.
export function watchlistRows(tickers, results, { search = "", sort = "score", direction = "desc" } = {}) {
  const term = String(search).trim().toLocaleLowerCase();
  const byTicker = new Map(results.map(item => [item.ticker, item]));
  const rows = tickers.map(ticker => {
    const item = byTicker.get(ticker);
    const quoteName = item?.quote?.name;
    const name = String(quoteName && quoteName !== ticker ? quoteName : companyNames.get(ticker) || ticker).slice(0, 300);
    return { ticker, name, item };
  }).filter(row => !term || `${row.ticker} ${row.name}`.toLocaleLowerCase().includes(term));
  const sign = direction === "asc" ? 1 : -1;
  const value = row => {
    if (!row.item?.dataQuality?.eligible) return null;
    const item = row.item;
    const result = sort === "change" ? item.oneDay : sort === "momentum" ? item.categories?.momentum
      : sort === "risk" ? item.categories?.risk : sort === "liquidity" ? item.averageDollarVolume
      : sort === "volume" ? item.volumePressure : item.score;
    return Number.isFinite(result) ? result : null;
  };
  return rows.sort((a, b) => {
    if (term && (a.ticker.toLocaleLowerCase() === term) !== (b.ticker.toLocaleLowerCase() === term)) return a.ticker.toLocaleLowerCase() === term ? -1 : 1;
    if (sort === "ticker" || sort === "name") return sign * (sort === "name" ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.ticker.localeCompare(b.ticker)) || a.ticker.localeCompare(b.ticker);
    const first = value(a), second = value(b);
    if ((first === null) !== (second === null)) return first === null ? 1 : -1;
    return (first === null ? 0 : sign * (first - second)) || a.ticker.localeCompare(b.ticker);
  });
}
