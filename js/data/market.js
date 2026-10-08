import { analyzeMarketContext } from "../analysis/market-context.js";
import { evaluateDataQuality } from "../analysis/data-quality.js";
import { PRICE_TIMEOUT_MS, marketProxyTickers } from "../config/settings.js";
import { fetchWithRetry, fetchWithTimeout, mapLimit } from "./http.js";
import { isBlockedAssetTicker } from "../shared/symbols.js";
import { unique } from "../shared/text.js";
import { loadPriceSnapshot, readSnapshotQuote, readSnapshotSeries } from "./price-snapshot.js";
import { parseYahooChart, parseYahooQuote } from "./yahoo-chart.js";
import { loadScanCache } from "./scan-cache.js";

export async function validateWatchlistTicker(ticker) {
  const published = readSnapshotSeries(await loadPriceSnapshot(), ticker);
  if (published) return ["EQUITY", "ETF"].includes(published.instrumentType.toUpperCase()) ? "valid" : "unsupported";
  // Newly added symbols outside the published universe still need metadata.
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
  const snapshot = await loadPriceSnapshot();
  const cachedSeries = loadScanCache()?.series || [];
  const settled = await mapLimit(tickers, 3, (ticker) => loadMarketSeries(ticker, { snapshot, cachedSeries }));
  return settled
    .map((result, index) => result.status === "fulfilled" ? result.value : unavailableSeries(tickers[index]));
}

export async function loadQuoteSnapshots(tickers) {
  const symbols = unique(tickers.map((ticker) => String(ticker || "").trim().toUpperCase()).filter(Boolean))
    .filter((ticker) => !isBlockedAssetTicker(ticker))
    .slice(0, 160);
  if (!symbols.length) {
    return { byTicker: new Map(), count: 0, total: 0, source: "none", label: "No live quote symbols requested" };
  }

  const snapshot = await loadPriceSnapshot();
  const savedQuotes = loadScanCache()?.quotes?.byTicker;
  const settled = await mapLimit(symbols, 3, (ticker) => {
    const published = readSnapshotQuote(snapshot, ticker);
    const saved = savedQuotes?.get(ticker);
    if (published) return saved && saved.quoteTime > published.quoteTime ? saved : published;
    return saved || loadIntradayQuote(ticker);
  });
  const quotes = settled
    .map((result) => result.status === "fulfilled" ? result.value : null)
    .filter(Boolean);
  const source = quotes.length ? [...new Set(quotes.map((quote) => quote.source))].join(" / ") : "unavailable";
  return {
    byTicker: new Map(quotes.map((quote) => [quote.ticker, quote])),
    count: quotes.length,
    total: symbols.length,
    source,
    label: quotes.length ? `Dated quotes: ${quotes.length}/${symbols.length} from ${source}` : "Quotes unavailable; daily price history used"
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
        attempts: 1,
        delayMs: 900
      });
      if (!response.ok) continue;
      const json = await response.json();
      const quote = parseYahooQuote(json, ticker);
      if (quote) return quote;
    } catch {
      // Fall through to the relay or daily-chart fallback.
    }
  }

  return null;
}

export function applyQuoteSnapshot(series, quoteMap) {
  const quote = quoteMap?.get(series.ticker);
  const quality = evaluateDataQuality(series);
  const quoteTime = quote?.quoteTime ? new Date(quote.quoteTime).getTime() : NaN;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  // Keep generated/stale history intact. Only a dated current quote may update
  // qualified history; historyAsOf remains the date of the actual daily series.
  if (!quote || !quality.eligible || !Number.isFinite(quoteTime)
    || (quote.ticker && String(quote.ticker).toUpperCase() !== series.ticker)
    || (series.currency && quote.currency !== series.currency)
    || quoteTime > now || now - quoteTime > 7 * dayMs
    || quoteTime < new Date(quality.asOf).getTime()
    || !Number.isFinite(quote.price) || quote.price <= 0) return series;
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
    dailyClose: series.dailyClose || { price: latest?.close, currency: series.currency, asOf: quality.asOf },
    historyAsOf: series.historyAsOf ?? quality.asOf,
    source: `${series.source} + ${quote.source || "Yahoo intraday"}`
  };
}

export async function loadMarketSeries(ticker, { snapshot, cachedSeries } = {}) {
  const published = readSnapshotSeries(snapshot || await loadPriceSnapshot(), ticker);
  const saved = (cachedSeries || loadScanCache()?.series || []).find((item) => item.ticker === ticker && evaluateDataQuality(item).eligible);
  // Keep a later real history already saved in this browser if a deployment
  // temporarily publishes an older snapshot. Neither path changes its date.
  if (published) return saved && Date.parse(evaluateDataQuality(saved).asOf) > Date.parse(published.historyAsOf) ? saved : published;
  if (saved) return { ...saved, source: `${saved.source.replace(/ \(saved history\)$/, "")} (saved history)` };
  const directUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d&events=splits`;
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;

  for (const [index, url] of [directUrl, proxyUrl].entries()) {
    try {
      const response = await fetchWithRetry(url, {
        timeoutMs: index === 0 ? PRICE_TIMEOUT_MS : PRICE_TIMEOUT_MS + 6000,
        type: "json",
        attempts: 1,
        delayMs: 1200
      });
      if (!response.ok) continue;
      const json = await response.json();
      const parsed = parseYahooChart(json, ticker);
      if (parsed?.prices.length) {
        parsed.source = url === directUrl ? "Yahoo Finance chart" : "Yahoo Finance via CORS relay";
        return parsed;
      }
    } catch {
      // Fall through to the next data route.
    }
  }

  return unavailableSeries(ticker);
}

export async function loadMarketContext() {
  const prices = await loadTickerSeries(marketProxyTickers.map((proxy) => proxy.ticker));
  const series = marketProxyTickers.map((proxy, index) => ({ ...proxy, series: prices[index] }));
  return analyzeMarketContext(series);
}

function unavailableSeries(ticker) {
  return { ticker, prices: [], source: "unavailable", historyAsOf: null,
    error: "No recent published or saved prices; the live provider and relay could not return usable history." };
}
