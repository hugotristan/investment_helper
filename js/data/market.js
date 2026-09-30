import { analyzeMarketContext } from "../analysis/market-context.js";
import { PRICE_TIMEOUT_MS, broadFunds, marketProxyTickers } from "../config/settings.js";
import { fetchWithRetry, fetchWithTimeout, mapLimit } from "./http.js";
import { finiteNumber } from "../shared/math.js";
import { isBlockedAssetTicker } from "../shared/symbols.js";
import { unique } from "../shared/text.js";

export async function validateWatchlistTicker(ticker) {
  // Validate live metadata directly; sample price fallbacks cannot establish a real symbol.
  const directUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`;
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;
  for (const url of [directUrl, proxyUrl]) {
    try {
      const response = await fetchWithTimeout(url, 8000, "json");
      const json = await response.json();
      if (String(json?.chart?.error?.code).toLowerCase() === "not found") return "invalid";
      if (!response.ok || json?.chart?.error) continue;
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta?.symbol || !meta.instrumentType) continue;
      if (String(meta.symbol).toUpperCase() !== ticker) return "invalid";
      if (!["EQUITY", "ETF"].includes(String(meta.instrumentType).toUpperCase())) return "unsupported";
      if (!Number.isFinite(Number(meta.regularMarketPrice)) || Number(meta.regularMarketPrice) <= 0) continue;
      return "valid";
    } catch {
      // Network, CORS, rate limits, or malformed responses do not prove a ticker is invalid.
    }
  }
  return "unavailable";
}

export async function loadTickerSeries(tickers) {
  const settled = await mapLimit(tickers, 12, (ticker) => loadMarketSeries(ticker));
  return settled
    .map((result, index) => result.status === "fulfilled" ? result.value : sampleSeries(tickers[index]))
    .filter((series) => series.prices.length >= 60);
}

export async function loadQuoteSnapshots(tickers) {
  const symbols = unique(tickers.map((ticker) => String(ticker || "").trim().toUpperCase()).filter(Boolean))
    .filter((ticker) => !isBlockedAssetTicker(ticker))
    .slice(0, 160);
  if (!symbols.length) {
    return { byTicker: new Map(), count: 0, total: 0, source: "none", label: "No live quote symbols requested" };
  }

  const settled = await mapLimit(symbols, 10, (ticker) => loadIntradayQuote(ticker));
  const quotes = settled
    .map((result) => result.status === "fulfilled" ? result.value : null)
    .filter(Boolean);
  const source = quotes.length ? "Yahoo Finance intraday chart" : "unavailable";
  return {
    byTicker: new Map(quotes.map((quote) => [quote.ticker, quote])),
    count: quotes.length,
    total: symbols.length,
    source,
    label: quotes.length ? `Live quotes: ${quotes.length}/${symbols.length} from ${source}` : "Live quotes unavailable; one-year chart data used"
  };
}

async function loadIntradayQuote(ticker) {
  const directUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`;
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;

  for (const [index, url] of [directUrl, proxyUrl].entries()) {
    try {
      const response = await fetchWithRetry(url, {
        timeoutMs: index === 0 ? PRICE_TIMEOUT_MS : PRICE_TIMEOUT_MS + 6000,
        type: "json",
        attempts: index === 0 ? 2 : 1,
        delayMs: 900
      });
      if (!response.ok) continue;
      const json = await response.json();
      const quote = parseIntradayQuote(json, ticker);
      if (quote) return quote;
    } catch {
      // Fall through to the relay or daily-chart fallback.
    }
  }

  return null;
}

function parseIntradayQuote(json, ticker) {
  const result = json?.chart?.result?.[0];
  const meta = result?.meta || {};
  const symbol = String(meta.symbol || ticker || "").toUpperCase();
  const price = finiteNumber(meta.regularMarketPrice);
  if (!symbol || !price) return null;
  const previousClose = finiteNumber(meta.previousClose || meta.chartPreviousClose);
  return {
    ticker: symbol,
    name: meta.longName || meta.shortName || symbol,
    exchange: meta.fullExchangeName || meta.exchangeName || "",
    marketState: marketStateFromMeta(meta),
    currency: meta.currency || "",
    price,
    previousClose,
    dayChange: previousClose ? price - previousClose : 0,
    dayChangePercent: previousClose ? price / previousClose - 1 : 0,
    volume: finiteNumber(meta.regularMarketVolume),
    averageVolume: 0,
    marketCap: 0,
    bid: 0,
    ask: 0,
    high52Week: finiteNumber(meta.fiftyTwoWeekHigh),
    low52Week: finiteNumber(meta.fiftyTwoWeekLow),
    dayHigh: finiteNumber(meta.regularMarketDayHigh),
    dayLow: finiteNumber(meta.regularMarketDayLow),
    quoteTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : null,
    epsTrailingTwelveMonths: 0,
    trailingPE: 0,
    dividendYield: 0,
    quoteType: meta.instrumentType || ""
  };
}

function marketStateFromMeta(meta) {
  const now = Date.now() / 1000;
  const regular = meta?.currentTradingPeriod?.regular;
  if (regular?.start && regular?.end) {
    if (now >= regular.start && now <= regular.end) return "Market open";
    if (now < regular.start) return "Pre-market";
    return "After hours";
  }
  return meta.marketState || "";
}

export function applyQuoteSnapshot(series, quoteMap) {
  const quote = quoteMap?.get(series.ticker);
  if (!quote) return series;
  const prices = series.prices.slice();
  const latest = prices.at(-1);
  if (latest && Number.isFinite(quote.price) && quote.price > 0) {
    prices[prices.length - 1] = {
      ...latest,
      close: quote.price,
      high: quote.dayHigh || (Number.isFinite(latest.high) ? Math.max(latest.high, quote.price) : quote.price),
      low: quote.dayLow || (Number.isFinite(latest.low) ? Math.min(latest.low, quote.price) : quote.price),
      volume: quote.volume || latest.volume
    };
  }
  return {
    ...series,
    prices,
    quote,
    source: series.source === "sample" ? series.source : `${series.source} + ${quote.price ? "Yahoo intraday" : "quote metadata"}`
  };
}

export async function loadMarketSeries(ticker) {
  const directUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;

  for (const [index, url] of [directUrl, proxyUrl].entries()) {
    try {
      const response = await fetchWithRetry(url, {
        timeoutMs: index === 0 ? PRICE_TIMEOUT_MS : PRICE_TIMEOUT_MS + 6000,
        type: "json",
        attempts: index === 0 ? 2 : 1,
        delayMs: 1200
      });
      if (!response.ok) continue;
      const json = await response.json();
      const parsed = parseYahooChart(json, ticker);
      if (parsed.prices.length >= 60) {
        parsed.source = url === directUrl ? "Yahoo Finance chart" : "Yahoo Finance via CORS relay";
        return parsed;
      }
    } catch {
      // Fall through to the next data route.
    }
  }

  return sampleSeries(ticker);
}

function parseYahooChart(json, ticker) {
  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const volumes = quote.volume || [];
  const prices = timestamps.map((time, index) => ({
    date: new Date(time * 1000),
    close: Number(closes[index]),
    high: Number(highs[index]),
    low: Number(lows[index]),
    volume: Number(volumes[index] || 0)
  })).filter((point) => Number.isFinite(point.close) && point.close > 0);

  return {
    ticker: String(result?.meta?.symbol || ticker).toUpperCase(),
    prices,
    source: "Yahoo Finance chart"
  };
}

export async function loadMarketContext() {
  const series = await Promise.all(marketProxyTickers.map(async (proxy) => ({
    ...proxy,
    series: await loadMarketSeries(proxy.ticker)
  })));
  return analyzeMarketContext(series);
}

function sampleSeries(ticker) {
  const days = 252;
  const seed = ticker.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const drift = broadFunds.has(ticker) ? 0.00034 : ((seed % 9) - 2) / 10000;
  const vol = broadFunds.has(ticker) ? 0.010 : 0.014 + (seed % 7) / 1000;
  let price = 50 + (seed % 180);
  const prices = [];
  const today = new Date();

  for (let i = days; i >= 0; i -= 1) {
    price = Math.max(5, price * (1 + drift + Math.sin((days - i + seed) / 13) * vol + Math.sin((days - i + seed) / 37) * vol * 0.7));
    const range = price * vol * 1.8;
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    prices.push({ date, close: price, high: price + range, low: Math.max(1, price - range), volume: 1000000 + seed * 1000 });
  }

  return { ticker, prices, source: "sample" };
}
