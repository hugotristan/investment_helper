import { projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { FUNDAMENTAL_METRICS } from "../js/analysis/fundamentals.js";
import { broadFunds } from "../js/config/settings.js";
import { normalizeStockHistory } from "../js/data/stock-history.js";
import { readCloudRecord } from "./cloud-store.mjs";
import { createMarketAssetReader } from "./market-data.mjs";
import { ApiError, readBoundedText } from "./request-body.mjs";

const DAY = 86400000;
const FUNDAMENTALS_URL = "https://hugotristan.github.io/investment_helper/data/fundamentals.json";
const failed = (code, message) => ({ code, message });
const date = (value, now) => (typeof value === "string" || value instanceof Date) && Number.isFinite(new Date(value).getTime()) && new Date(value).getTime() <= now
  ? new Date(value).toISOString() : null;
const latest = (values) => values.filter(Boolean).sort().at(-1) ?? null;
const oldest = (values) => values.filter(Boolean).sort()[0] ?? null;

// This module has no storage write dependency. Portfolio quantities, notes and
// balances never leave the Worker in requests to public market-data providers.
export function createMcpData({ market, assets, now = Date.now, fetchImpl = (url, init) => globalThis.fetch(url, init) }) {
  const clock = () => typeof now === "function" ? now() : now;
  const readAsset = createMarketAssetReader(assets);
  let fundamentalsRequest, fundamentalsUntil = 0;

  async function loadFundamentals() {
    if (fundamentalsRequest && clock() < fundamentalsUntil) return fundamentalsRequest;
    fundamentalsUntil = clock() + 5 * 60000;
    fundamentalsRequest = (async () => {
      const embedded = await readAsset("data/fundamentals.json").catch(() => null);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let published = null, refreshError = null;
      try {
        const response = await fetchImpl(FUNDAMENTALS_URL, { headers: { Accept: "application/json" }, redirect: "manual", signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        published = JSON.parse(await readBoundedText(response, 4 * 1024 * 1024));
        if (!validSnapshot(published)) throw new Error("Invalid snapshot");
      } catch {
        published = null;
        refreshError = failed("FUNDAMENTALS_REFRESH_FAILED", "The published financial snapshot could not be loaded. Any retained figures keep their original successful retrieval time.");
        fundamentalsUntil = clock() + 30000;
      } finally { clearTimeout(timer); }
      const snapshots = [embedded, published].filter(validSnapshot);
      return { snapshots, refreshError };
    })();
    return fundamentalsRequest;
  }
  function validSnapshot(snapshot) {
    return snapshot?.schemaVersion === 1 && date(snapshot.generatedAt, clock()) && snapshot.byTicker
      && typeof snapshot.byTicker === "object" && !Array.isArray(snapshot.byTicker);
  }

  async function portfolio(env, userId) {
    const record = await readCloudRecord(env, userId, "portfolio", clock());
    if (!record.book) return { status: "unavailable", latestSuccessfulUpdateAt: null, holdings: [], errors: [failed("NO_PORTFOLIO", "No saved portfolio is available.")] };
    const projection = projectPortfolioBook(record.book);
    const holdings = projection.holdings.map(holding => {
      const basis = projection.eurCostBases.find(entry => entry.id === holding.id && entry.ticker === holding.ticker && entry.currency === holding.currency);
      return holding.kind === "manual"
        ? { kind: "manual", label: holding.label, currency: holding.currency, recordedAmount: holding.amount,
          errors: [failed("MANUAL_HOLDING", "This amount-only position has no share quantity or market valuation.")] }
        : { kind: "position", ticker: holding.ticker, name: holding.label, currency: holding.currency, shares: holding.shares,
          averagePurchasePrice: holding.averageCost, nativeCostBasis: holding.shares * holding.averageCost,
          eurCostBasis: basis ? basis.costBasis : holding.currency === "EUR" ? holding.shares * holding.averageCost : null };
    });
    return { status: "available", revision: record.revision, latestSuccessfulUpdateAt: record.updatedAt,
      timestampMeaning: "Time the portfolio was successfully saved; holdings are recorded positions, not current market valuations.",
      holdings, recordedCash: { currency: projection.reportingCash.currency, amount: projection.reportingCash.amount,
        complete: projection.reportingCash.complete }, warnings: projection.warnings, errors: [] };
  }

  async function watchlists(env, userId) {
    const record = await readCloudRecord(env, userId, "watchlist", clock());
    return { status: record.tickers === null ? "unavailable" : "available", revision: record.revision,
      latestSuccessfulUpdateAt: record.updatedAt, timestampMeaning: "Time the watchlist was successfully saved.",
      watchlists: record.tickers === null ? [] : [{ name: "Watchlist", tickers: record.tickers }],
      errors: record.tickers === null ? [failed("NO_WATCHLIST", "No cloud watchlist has been saved. Browser-local defaults are not a saved watchlist.")] : [] };
  }

  async function prices(tickers) {
    const rows = await Promise.all(tickers.map(async ticker => {
      try {
        const loaded = await market.loadHistory(ticker);
        const history = normalizeStockHistory(loaded, ticker, { now: clock() });
        if (!history || clock() - Date.parse(history.historyAsOf) > 7 * DAY) throw new ApiError(503, "PRICES_UNAVAILABLE", "No recent validated daily history is available for this ticker.");
        const quote = history.quote && Date.parse(history.quote.quoteTime) >= Date.parse(history.historyAsOf) ? history.quote : null;
        const observed = quote ? date(quote.quoteTime, clock()) : history.historyAsOf;
        return { ticker, status: loaded.stale ? "stale" : "available", stale: !!loaded.stale, quoteTimestamp: observed, price: quote?.price ?? history.prices.at(-1).close, currency: history.currency,
          priceType: quote ? "dated_quote" : "completed_daily_close", source: quote?.source ?? history.source,
          latestSuccessfulUpdateAt: observed, dataAsOf: observed, historyAsOf: history.historyAsOf,
          delayMinutes: quote?.delayMinutes ?? null, realtime: false, errors: loaded.stale ? [failed("STALE_PRICE", loaded.refreshError)] : [] };
      } catch (error) {
        return { ticker, status: "unavailable", price: null, currency: null, latestSuccessfulUpdateAt: null, dataAsOf: null,
          errors: [error instanceof ApiError ? failed(error.code, error.message) : failed("PRICES_UNAVAILABLE", "A validated price is unavailable for this ticker.")] };
      }
    }));
    return aggregate(rows, "prices", "Successful price observation time, not the time of a fetch attempt. Quotes may be delayed; daily closes are labelled separately.");
  }

  async function metrics(tickers) {
    const { snapshots, refreshError } = await loadFundamentals();
    const rows = tickers.map(ticker => {
      const candidates = snapshots.flatMap(snapshot => {
        const record = Object.hasOwn(snapshot.byTicker, ticker) ? snapshot.byTicker[ticker] : null;
        const retrieved = date(record?.retrievedAt, clock());
        return record?.ticker === ticker && record.available === true && retrieved && /^[A-Z]{3}$/.test(record.currency || "")
          ? [{ snapshot, record, retrieved }] : [];
      }).sort((a, b) => b.retrieved.localeCompare(a.retrieved) || b.snapshot.generatedAt.localeCompare(a.snapshot.generatedAt));
      const selected = candidates[0];
      if (!selected) return { ticker, status: "unavailable", metrics: null, latestSuccessfulUpdateAt: null,
        errors: [broadFunds.has(ticker) ? failed("ETF_METRICS_UNSUPPORTED", "Company financial metrics do not apply to this known fund.")
          : failed("METRICS_UNAVAILABLE", "Company financial data has not been successfully published for this ticker. This is a coverage or provider failure, not an ETF classification.")], ...(refreshError ? { warnings: [refreshError] } : {}) };
      const { record, retrieved } = selected;
      const stale = clock() - Date.parse(retrieved) >= 10 * DAY;
      const values = Object.fromEntries(FUNDAMENTAL_METRICS.map(key => [key, Number.isFinite(record.metrics?.[key]) ? record.metrics[key] : null]));
      const missingMetrics = FUNDAMENTAL_METRICS.filter(key => values[key] === null);
      if (missingMetrics.length === FUNDAMENTAL_METRICS.length) return { ticker, status: "unavailable", metrics: null,
        latestSuccessfulUpdateAt: null, errors: [failed("METRICS_UNAVAILABLE", "The record contains no usable financial metrics.")] };
      const latestSnapshot = [...snapshots].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
      const retained = !!refreshError || latestSnapshot.providerStatus === "unavailable"
        || Array.isArray(latestSnapshot.failures) && latestSnapshot.failures.some(failure => failure.ticker === ticker);
      return { ticker, status: stale ? "stale" : missingMetrics.length ? "partial" : "available", companyName: String(record.companyName || ticker).slice(0, 200),
        currency: record.currency, periodEnd: record.periodEnd ?? null, source: record.provider || "Company financial snapshot",
        latestSuccessfulUpdateAt: retrieved, lastUpdateAttemptAt: latest(snapshots.map(snapshot => date(snapshot.generatedAt, clock()))), retained: !!retained,
        metrics: values, missingMetrics, metricSources: Object.fromEntries(FUNDAMENTAL_METRICS.map(key => [key,
          (Array.isArray(record.metricSources?.[key]) ? record.metricSources[key] : []).slice(0, 4).map(source => ({
            provider: source.provider ?? null, unit: source.unit ?? null, end: source.end ?? null, filed: source.filed ?? null,
            url: safeSourceUrl(source.url),
          }))])),
        errors: [...(stale ? [failed("METRICS_STALE", "These retained financial figures were retrieved ten or more days ago; they have not been refreshed by this request.")] : []),
          ...(missingMetrics.length ? [failed("METRICS_INCOMPLETE", "Some financial metrics are unavailable; missing values are null, not zero.")] : [])],
        warnings: [...(refreshError ? [refreshError] : []), ...(retained ? [failed("RETAINED_METRICS", "The latest refresh was unavailable or incomplete. Displayed figures retain the successful retrieval timestamp.")] : [])] };
    });
    return aggregate(rows, "companies", "Time each company's financial data was successfully retrieved. Reporting period dates and later update attempts are separate.");
  }

  async function status(env, userId, requestedTickers) {
    const [portfolioResult, watchlistResult] = await Promise.allSettled([portfolio(env, userId), watchlists(env, userId)]);
    const recordStatus = result => result.status === "fulfilled" ? result.value
      : { status: "unavailable", latestSuccessfulUpdateAt: null, errors: [failed("STORAGE_UNAVAILABLE", "The saved record could not be loaded.")] };
    const p = recordStatus(portfolioResult), w = recordStatus(watchlistResult);
    const known = [...new Set([...(p.holdings || []).map(h => h.ticker).filter(Boolean), ...(w.watchlists?.[0]?.tickers || [])])];
    const tickers = requestedTickers ?? known.slice(0, 20);
    const [priceData, financialData] = tickers.length ? await Promise.all([prices(tickers), metrics(tickers)]) : [null, null];
    const components = [p, w, priceData, financialData].filter(Boolean);
    return { status: components.every(value => value.status === "available") ? "available"
      : components.every(value => value.status === "unavailable") ? "unavailable" : "partial",
      latestSuccessfulUpdateAt: latest([p.latestSuccessfulUpdateAt, w.latestSuccessfulUpdateAt, priceData?.latestSuccessfulUpdateAt, financialData?.latestSuccessfulUpdateAt]),
      timestampMeaning: "Newest successful timestamp among components, not proof all components are current. Inspect each component and per-ticker timestamps.",
      scope: "Server data checks completed for this response. Browser scan progress is not available through MCP.",
      portfolio: { status: p.status, revision: p.revision ?? null, latestSuccessfulUpdateAt: p.latestSuccessfulUpdateAt, errors: p.errors },
      watchlist: { status: w.status, revision: w.revision ?? null, latestSuccessfulUpdateAt: w.latestSuccessfulUpdateAt, errors: w.errors },
      inspectedTickers: tickers, uninspectedTickerCount: requestedTickers ? null : Math.max(0, known.length - tickers.length),
      prices: priceData, financialMetrics: financialData, errors: [...p.errors, ...w.errors] };
  }
  return { portfolio, watchlists, prices, metrics, status };
}

function aggregate(rows, field, timestampMeaning) {
  const available = rows.filter(row => row.status === "available").length;
  return { status: available === rows.length ? "available" : rows.every(row => row.status === "unavailable") ? "unavailable" : "partial",
    latestSuccessfulUpdateAt: latest(rows.map(row => row.latestSuccessfulUpdateAt)),
    oldestSuccessfulUpdateAt: oldest(rows.map(row => row.latestSuccessfulUpdateAt)), timestampMeaning, [field]: rows,
    errors: rows.flatMap(row => row.errors.map(error => ({ ticker: row.ticker, ...error }))) };
}
function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["www.sec.gov", "finance.yahoo.com"].includes(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
