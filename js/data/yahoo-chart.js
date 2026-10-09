// Shared by the browser fallback and the scheduled price publisher.
const DAY_MS = 86400000;
const positive = (value) => value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

function chartResult(json, ticker) {
  const result = json?.chart?.result?.[0];
  const meta = result?.meta;
  if (json?.chart?.error || !meta || String(meta.symbol || "").toUpperCase() !== String(ticker).toUpperCase()
    || !/^[A-Za-z]{3}$/.test(meta.currency || "")
    || !["EQUITY", "ETF", "INDEX"].includes(String(meta.instrumentType).toUpperCase())) return null;
  return result;
}

export function parseYahooChart(json, ticker) {
  const result = chartResult(json, ticker);
  if (!result || !Array.isArray(result.timestamp)) return null;
  const quote = result.indicators?.quote?.[0] || {};
  const days = new Map();
  for (const [index, time] of result.timestamp.entries()) {
    const close = positive(quote.close?.[index]);
    const date = typeof time === "number" && Number.isFinite(time) ? new Date(time * 1000) : new Date(NaN);
    if (!close || !Number.isFinite(date.getTime())) continue;
    days.set(date.toISOString().slice(0, 10), { date, close,
      high: positive(quote.high?.[index]) || close, low: positive(quote.low?.[index]) || close,
      volume: Math.max(0, Number(quote.volume?.[index]) || 0) });
  }
  const prices = [...days.values()].sort((a, b) => a.date - b.date);
  if (!prices.length) return null;
  const rawSplits = result.events?.splits;
  const splitEvents = rawSplits && typeof rawSplits === "object" && !Array.isArray(rawSplits) ? Object.values(rawSplits) : [];
  const validSplit = (event) => Number.isFinite(event?.date) && Number.isFinite(new Date(event.date * 1000).getTime())
    && Number.isFinite(event.numerator) && event.numerator > 0 && Number.isFinite(event.denominator) && event.denominator > 0;
  const splitsComplete = (rawSplits === undefined || rawSplits !== null && typeof rawSplits === "object" && !Array.isArray(rawSplits))
    && splitEvents.every(validSplit);
  return { ticker: String(ticker).toUpperCase(), prices, historyAsOf: prices.at(-1).date.toISOString(),
    instrumentType: result.meta.instrumentType, currency: result.meta.currency,
    splitsComplete,
    splits: splitEvents.filter(validSplit)
      .map((event) => ({ date: new Date(event.date * 1000).toISOString(), numerator: event.numerator,
        denominator: event.denominator, splitRatio: event.splitRatio })), source: "Yahoo Finance chart" };
}

export function parseYahooQuote(json, ticker, { now = Date.now() } = {}) {
  const result = chartResult(json, ticker);
  const meta = result?.meta;
  const price = positive(meta?.regularMarketPrice);
  const time = typeof meta?.regularMarketTime === "number" ? meta.regularMarketTime * 1000 : NaN;
  if (!result || !price || !Number.isFinite(time) || time > now || now - time > 7 * DAY_MS) return null;
  const quoteTime = new Date(time);
  const quoteDay = quoteTime.toISOString().slice(0, 10);
  // chartPreviousClose on a one-year chart is the close before that entire
  // range. It must never be presented as yesterday's price.
  const daily = meta.dataGranularity ? meta.dataGranularity === "1d" : result.timestamp?.length > 1
    && result.timestamp[1] - result.timestamp[0] >= 20 * 3600;
  const previousClose = daily ? parseYahooChart(json, ticker)?.prices
    .filter((point) => point.date.toISOString().slice(0, 10) < quoteDay).at(-1)?.close || null
    : positive(meta.previousClose) || positive(meta.chartPreviousClose);
  const dayChangePercent = previousClose ? price / previousClose - 1 : null;
  const regular = meta.currentTradingPeriod?.regular;
  const current = now / 1000;
  const marketState = regular?.start && regular?.end
    ? current >= regular.start && current <= regular.end ? "Market open" : current < regular.start ? "Pre-market" : "After hours"
    : meta.marketState || "";
  return { ticker: String(ticker).toUpperCase(), name: meta.longName || meta.shortName || ticker,
    exchange: meta.fullExchangeName || meta.exchangeName || "", marketState, currency: meta.currency,
    price, previousClose, dayChange: previousClose ? price - previousClose : null,
    dayChangePercent: Number.isFinite(dayChangePercent) ? dayChangePercent : null,
    volume: Math.max(0, Number(meta.regularMarketVolume) || 0), averageVolume: 0, marketCap: 0, bid: 0, ask: 0,
    high52Week: positive(meta.fiftyTwoWeekHigh) || 0, low52Week: positive(meta.fiftyTwoWeekLow) || 0,
    dayHigh: positive(meta.regularMarketDayHigh) || 0, dayLow: positive(meta.regularMarketDayLow) || 0,
    quoteTime, epsTrailingTwelveMonths: 0, trailingPE: 0, dividendYield: 0,
    quoteType: meta.instrumentType, source: "Yahoo Finance quote" };
}
