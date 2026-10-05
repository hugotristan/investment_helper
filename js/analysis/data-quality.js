const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_HISTORY_POINTS = 200;
const MAX_HISTORY_AGE_MS = 7 * DAY_MS;

// Only real daily history can support the trend and risk model. A newer quote
// cannot repair missing or old history, so its timestamp is deliberately ignored.
export function evaluateDataQuality(series, now = Date.now()) {
  const points = validHistoryPoints(series);
  const historyTime = timestamp(series?.historyAsOf ?? points.at(-1)?.date);
  const asOf = Number.isFinite(historyTime) ? new Date(historyTime).toISOString() : null;
  const result = (eligible, label, reason) => ({ eligible, label, reason, asOf });
  if (/^sample\b/i.test(String(series?.source || ""))) {
    return result(false, "Sample price history", "Generated sample prices cannot support a market signal.");
  }
  if (!points.length || !series?.source || !asOf) {
    return result(false, "Price history unavailable", "Real daily price history is unavailable.");
  }
  if (historyTime > now + DAY_MS || points.some((point) => timestamp(point.date) > now + DAY_MS)) {
    return result(false, "Future-dated price history", "Price history contains dates beyond the current market session.");
  }
  if (points.length < MIN_HISTORY_POINTS) {
    return result(false, "Insufficient price history", `At least ${MIN_HISTORY_POINTS} valid daily prices are needed; ${points.length} are available.`);
  }
  if (now - historyTime > MAX_HISTORY_AGE_MS) {
    return result(false, "Stale price history", "The last daily price is more than seven calendar days old.");
  }
  return result(true, "Qualified price history", "Real daily history is recent and supports the 200-day trend check.");
}

export function validHistoryPoints(series) {
  const days = new Map();
  for (const point of series?.prices || []) {
    const time = timestamp(point?.date);
    if (!Number.isFinite(time) || !Number.isFinite(point?.close) || point.close <= 0) continue;
    days.set(new Date(time).toISOString().slice(0, 10), point);
  }
  return [...days.values()].sort((a, b) => timestamp(a.date) - timestamp(b.date));
}

export function hasQualifiedSignal(item) {
  return item?.dataQuality?.eligible === true && Number.isFinite(item.score);
}

export function isEtfSeries(series) {
  return [series?.instrumentType, series?.quote?.quoteType]
    .some((value) => String(value || "").toUpperCase() === "ETF");
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return new Date(value).getTime();
}
