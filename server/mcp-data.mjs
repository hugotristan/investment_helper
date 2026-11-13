import { projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { FUNDAMENTAL_METRICS } from "../js/analysis/fundamentals.js";
import { broadFunds } from "../js/config/settings.js";
import { VWCE_TICKERS } from "../js/data/vanguard-holdings.js";
import { normalizeStockHistory } from "../js/data/stock-history.js";
import { readCloudRecord } from "./cloud-store.mjs";
import { createMarketAssetReader } from "./market-data.mjs";
import { ApiError, readBoundedText } from "./request-body.mjs";
import { mapBatch, retryTransient } from "../js/shared/batch.js";
import { dataError } from "./data-errors.mjs";

const DAY = 86400000;
const FUNDAMENTALS_URL = "https://hugotristan.github.io/investment_helper/data/fundamentals.json";
const failed = dataError;
const date = (value, now) => (typeof value === "string" || value instanceof Date) && Number.isFinite(new Date(value).getTime()) && new Date(value).getTime() <= now
  ? new Date(value).toISOString() : null;
const latest = (values) => values.filter(Boolean).sort().at(-1) ?? null;
const oldest = (values) => values.filter(Boolean).sort()[0] ?? null;

// This module has no storage write dependency. Portfolio quantities, notes and
// balances never leave the Worker in requests to public market-data providers.
export function createMcpData({ market, assets, now = Date.now, fetchImpl = (url, init) => globalThis.fetch(url, init), companyProvider }) {
  const clock = () => typeof now === "function" ? now() : now;
  const readAsset = createMarketAssetReader(assets);
  let fundamentalsRequest, fundamentalsUntil = 0;
  let lastFundamentals = null;

  async function loadFundamentals() {
    if (fundamentalsRequest && clock() < fundamentalsUntil) return fundamentalsRequest;
    fundamentalsUntil = clock() + 5 * 60000;
    fundamentalsRequest = (async () => {
      const embedded = await readAsset("data/fundamentals.json").catch(() => null);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let failureCooldown = 30000;
      let published = null, refreshError = null;
      try {
        const response = await retryTransient(async () => {
          const response = await fetchImpl(FUNDAMENTALS_URL, { headers: { Accept: "application/json" }, redirect: "manual", signal: controller.signal });
          if (!response.ok) {
            const error = new Error("Unavailable");
            error.transient = response.status >= 500;
            if (response.status === 429) {
              const seconds = Number(response.headers.get("retry-after"));
              failureCooldown = Math.min(30 * 60000, Math.max(30000, Number.isFinite(seconds) ? seconds * 1000 : 60000));
            }
            throw error;
          }
          return response;
        }, { retryable: error => error.transient === true || error instanceof TypeError });
        published = JSON.parse(await readBoundedText(response, 4 * 1024 * 1024));
        if (!validSnapshot(published)) throw new Error("Invalid snapshot");
      } catch {
        published = null;
        refreshError = failed("FUNDAMENTALS_REFRESH_FAILED", "The published financial snapshot could not be loaded. Any retained figures keep their original successful retrieval time.");
        fundamentalsUntil = clock() + failureCooldown;
      } finally { clearTimeout(timer); }
      if (published) lastFundamentals = published;
      const snapshots = [embedded, lastFundamentals].filter(validSnapshot);
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

  async function prices(tickers, { concurrency = 2 } = {}) {
    const settled = await mapBatch(tickers, async ticker => {
      try {
        const loaded = await market.loadHistory(ticker);
        const history = normalizeStockHistory(loaded, ticker, { now: clock() });
        if (!history) throw new ApiError(503, "PRICES_UNAVAILABLE", "No recent validated daily history is available for this ticker.");
        const stalePrice = loaded.stale || clock() - Date.parse(history.historyAsOf) > 7*DAY;
        const quote = history.quote && Date.parse(history.quote.quoteTime) >= Date.parse(history.historyAsOf) ? history.quote : null;
        const observed = quote ? date(quote.quoteTime, clock()) : history.historyAsOf;
        const identity = await companyProvider?.identity(ticker);
        return { ticker, companyName:identity?.companyName || ticker, instrumentType:history.instrumentType, status: stalePrice ? "stale" : "available", stale: !!stalePrice, quoteTimestamp: observed, price: quote?.price ?? history.prices.at(-1).close, currency: history.currency,
          priceType: quote ? "dated_quote" : "completed_daily_close", source: quote?.source ?? history.source,
          latestSuccessfulUpdateAt: date(loaded.lastSuccessfulFetchAt,clock()) || observed, dataAsOf: observed, historyAsOf: history.historyAsOf,
          delayMinutes: quote?.delayMinutes ?? null, realtime: false, errors: stalePrice ? [failed("STALE_PRICE", loaded.refreshError || "The last validated observation is more than seven days old.",
            { ticker, provider: quote?.source ?? history.source, retryable: true, lastSuccessfulQuoteAt: observed })] : [] };
      } catch (error) {
        return { ticker, status: "unavailable", price: null, currency: null, latestSuccessfulUpdateAt: null, dataAsOf: null,
          stale: false, quoteTimestamp: null,
          errors: [error instanceof ApiError ? failed(error.code, error.message, { ticker, retryable: error.status >= 500 || error.status === 429 }) : failed("PRICES_UNAVAILABLE", "A validated price is unavailable for this ticker.", { ticker, retryable: true })] };
      }
    }, { concurrency });
    const rows = settled.map((result, index) => result.status === "fulfilled" ? result.value : ({ ticker: tickers[index], status: "unavailable", price: null, latestSuccessfulUpdateAt: null,
      errors: [failed("PRICES_UNAVAILABLE", "The ticker check failed independently of the remaining batch.", { ticker: tickers[index], retryable: true })] }));
    return aggregate(rows, "prices", "Successful price observation time, not the time of a fetch attempt. Quotes may be delayed; daily closes are labelled separately.");
  }

  async function metrics(tickers) {
    const { snapshots:publishedSnapshots, refreshError } = await loadFundamentals();
    const snapshots = [...publishedSnapshots];
    const dynamic = { schemaVersion:1, generatedAt:new Date(clock()).toISOString(), byTicker:{} };
    const identities = new Map(), failures = new Map();
    if (companyProvider) await mapBatch([...new Set(tickers)], async ticker => {
      const info = await companyProvider.identity(ticker); identities.set(ticker, info);
      if (info.type === "ETF") return;
      const fresh = snapshots.some(snapshot => snapshot.byTicker[ticker]?.available && clock()-Date.parse(snapshot.byTicker[ticker].retrievedAt) < 7*DAY);
      if (!fresh) try { dynamic.byTicker[ticker] = await companyProvider.company(ticker); }
      catch(error) { failures.set(ticker, failed("METRICS_UNAVAILABLE", error instanceof ApiError ? error.message : "Company financial retrieval failed.", {ticker,retryable:true})); }
    }, {concurrency:2});
    if (Object.keys(dynamic.byTicker).length) snapshots.push(dynamic);
    const rows = tickers.map(ticker => {
      const candidates = snapshots.flatMap(snapshot => {
        const record = Object.hasOwn(snapshot.byTicker, ticker) ? snapshot.byTicker[ticker] : null;
        const retrieved = date(record?.retrievedAt, clock());
        return record?.ticker === ticker && record.available === true && retrieved && /^[A-Z]{3}$/.test(record.currency || "")
          ? [{ snapshot, record, retrieved }] : [];
      }).sort((a, b) => b.retrieved.localeCompare(a.retrieved) || b.snapshot.generatedAt.localeCompare(a.snapshot.generatedAt));
      const selected = candidates[0];
      if (identities.get(ticker)?.type === "ETF") return {ticker, assetType:"ETF", status:"unavailable", metrics:null, latestSuccessfulUpdateAt:null, errors:[failed("ETF_METRICS_UNSUPPORTED", "Annual company accounts do not apply to this ETF.", {ticker})]};
      if (!selected) return { ticker, status: "unavailable", metrics: null, latestSuccessfulUpdateAt: null,
        errors: [failures.get(ticker) || (broadFunds.has(ticker) || VWCE_TICKERS.includes(ticker) ? failed("ETF_METRICS_UNSUPPORTED", "Company financial metrics do not apply to this known fund.")
          : failed("METRICS_UNAVAILABLE", "Company financial data has not been successfully published for this ticker. This is a coverage or provider failure, not an ETF classification.", { ticker, retryable: true }))], ...(refreshError ? { warnings: [refreshError] } : {}) };
      const { record, retrieved } = selected;
      const stale = record.stale === true || clock() - Date.parse(retrieved) >= 10 * DAY;
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
        warnings: [...(failures.has(ticker) ? [failures.get(ticker)] : []), ...(record.refreshError ? [failed("FINANCIAL_REFRESH_FAILED", record.refreshError, {ticker,retryable:true})] : []), ...(refreshError ? [refreshError] : []), ...(retained ? [failed("RETAINED_METRICS", "The latest refresh was unavailable or incomplete. Displayed figures retain the successful retrieval timestamp.")] : [])] };
    });
    return aggregate(rows, "companies", "Time each company's financial data was successfully retrieved. Reporting period dates and later update attempts are separate.");
  }

  async function status(env, userId, requestedTickers, { offset = 0, batchSize = 20, concurrency = 2, component = "all" } = {}) {
    const [portfolioResult, watchlistResult] = await Promise.allSettled([portfolio(env, userId), watchlists(env, userId)]);
    const recordStatus = result => result.status === "fulfilled" ? result.value
      : { status: "unavailable", latestSuccessfulUpdateAt: null, errors: [failed("STORAGE_UNAVAILABLE", "The saved record could not be loaded.")] };
    const p = recordStatus(portfolioResult), w = recordStatus(watchlistResult);
    const known = [...new Set([...(p.holdings || []).map(h => h.ticker).filter(Boolean), ...(w.watchlists?.[0]?.tickers || [])])];
    const universe = requestedTickers ?? known;
    const tickers = universe.slice(offset, offset + batchSize);
    const checkPrices = component === "all" || component === "prices";
    const checkMetrics = component === "all" || component === "financialMetrics";
    const settled = await Promise.allSettled([checkPrices && tickers.length ? prices(tickers, { concurrency }) : null,
      checkMetrics && tickers.length ? metrics(tickers) : null]);
    const componentResult = result => result.status === "fulfilled" ? result.value : ({ status: "unavailable", latestSuccessfulUpdateAt: null,
      errors: [failed("DATA_UNAVAILABLE", "This data source could not be checked. Other sources were checked independently.", { retryable: true })] });
    const [priceData, financialData] = settled.map(componentResult);
    const components = [p, w, priceData, financialData].filter(Boolean);
    return { status: components.every(value => value.status === "available") ? "available"
      : components.every(value => value.status === "unavailable") ? "unavailable" : "partial",
      latestSuccessfulUpdateAt: latest([priceData?.latestSuccessfulUpdateAt, financialData?.latestSuccessfulUpdateAt]),
      timestampMeaning: "Market-data timestamps only. Record save times are separate savedAt fields; inspect each ticker for its actual quote freshness.",
      scope: "Server data checks completed for this response. Browser scan progress is not available through MCP.",
      portfolio: { status: p.status, revision: p.revision ?? null, savedAt: p.latestSuccessfulUpdateAt, latestSuccessfulUpdateAt: p.latestSuccessfulUpdateAt, errors: p.errors },
      watchlist: { status: w.status, revision: w.revision ?? null, savedAt: w.latestSuccessfulUpdateAt, latestSuccessfulUpdateAt: w.latestSuccessfulUpdateAt, errors: w.errors },
      pagination: { offset, batchSize, totalTickers: universe.length, nextOffset: offset + tickers.length < universe.length ? offset + tickers.length : null,
        listRevision: `${p.revision ?? "unavailable"}:${w.revision ?? "unavailable"}`,
        remainingTickerCount: Math.max(0, universe.length - offset - tickers.length) },
      inspectedTickers: tickers, uninspectedTickerCount: requestedTickers ? null : Math.max(0, known.length - tickers.length),
      checkedComponents: ["portfolio", "watchlist", ...(checkPrices ? ["prices"] : []), ...(checkMetrics ? ["financialMetrics"] : [])],
      coverage: tickers.map(ticker => {
        const price = priceData?.prices?.find(row => row.ticker === ticker), financial = financialData?.companies?.find(row => row.ticker === ticker);
        const holding = p.holdings?.find(row => row.ticker === ticker);
        const unsupported = financial?.errors?.some(error => error.code === "ETF_METRICS_UNSUPPORTED");
        return {ticker, companyName:financial?.companyName || (price?.companyName !== ticker ? price?.companyName : null) || holding?.name || ticker,
          trackedBy:[...(holding ? ["portfolio"] : []), ...(w.watchlists?.some(list => list.tickers.includes(ticker)) ? ["watchlist"] : [])],
          assetType:unsupported ? "ETF" : price?.instrumentType || "company_or_unknown", price:price?.price ?? null, currency:price?.currency ?? null,
          priceObservationAt:price?.quoteTimestamp ?? price?.dataAsOf ?? null, priceType:price?.priceType ?? null,
          financialMetricsStatus:unsupported ? "unsupported" : financial?.status ?? "not_checked",
          lastSuccessfulDataUpdate:latest([price?.latestSuccessfulUpdateAt, financial?.latestSuccessfulUpdateAt]),
          source:{price:price?.source ?? null, financialMetrics:financial?.source ?? null},
          status:price?.status === "unavailable" ? "unavailable" : price?.status === "stale" || financial?.status === "stale" ? "stale" : price?.status === "available" && (unsupported || ["available","partial"].includes(financial?.status)) ? "available" : "unavailable",
          errors:[...(price?.errors || []), ...(financial?.errors || []), ...(financial?.warnings || [])]};
      }),
      prices: priceData, financialMetrics: financialData, errors: [...p.errors, ...w.errors, ...(priceData?.errors || []), ...(financialData?.errors || [])] };
  }
  async function financialSnapshot(ticker,env) {
    const {snapshots} = await loadFundamentals();
    let record = snapshots.map(snapshot => snapshot.byTicker[ticker]).filter(record => record?.available).sort((a,b) => String(b.retrievedAt).localeCompare(String(a.retrievedAt)))[0];
    if (companyProvider && (!record || record.historyVersion !== 1 || clock()-Date.parse(record.retrievedAt) >= 7*DAY)) try { record = await companyProvider.company(ticker); } catch { /* Retain the validated published record. */ }
    const peerMap = new Map(snapshots.flatMap(snapshot=>Object.values(snapshot.byTicker||{})).map(row=>[row.ticker,row]));
    if (env?.DB) { const cached=await env.DB.prepare("SELECT payload FROM market_cache WHERE key LIKE ? AND payload IS NOT NULL LIMIT 250").bind("financial:%").all();
      for(const row of cached.results)try{const company=JSON.parse(row.payload);if(company?.ticker&&company.available)peerMap.set(company.ticker,company);}catch{} }
    return {schemaVersion:1, generatedAt:new Date(clock()).toISOString(), peers:await Promise.all([...peerMap.values()].filter(row=>row.ticker!==ticker&&record?.issuerMetadata?.sic&&String(row.issuerMetadata?.sic).slice(0,2)===String(record.issuerMetadata.sic).slice(0,2)).slice(0,40).map(async row=>{
      let quote=null,analysisMarket={};if(env?.DB)try{const saved=await env.DB.prepare("SELECT payload FROM market_cache WHERE key = ?").bind("history:"+row.ticker).first();const prices=JSON.parse(saved?.payload||"null");quote=prices?.quote||null;analysisMarket={splitsComplete:prices?.splitsComplete===true,splits:prices?.splits||[],splitHistoryFrom:prices?.prices?.[0]?.date};}catch{}return {...row,analysisQuote:quote,analysisMarket};})), byTicker:record ? {[ticker]:record} : {}, providerStatus:record?.available ? "available" : "unavailable"};
  }
  return { portfolio, watchlists, prices, metrics, status, financialSnapshot };
}

function aggregate(rows, field, timestampMeaning) {
  const available = rows.filter(row => row.status === "available").length;
  return { status: available === rows.length ? "available" : rows.every(row => row.status === "unavailable") ? "unavailable" : "partial",
    latestSuccessfulUpdateAt: latest(rows.map(row => row.latestSuccessfulUpdateAt)),
    oldestSuccessfulUpdateAt: oldest(rows.map(row => row.latestSuccessfulUpdateAt)), timestampMeaning, [field]: rows,
    errors: rows.flatMap(row => row.errors.map(error => ({ ...error, ticker: error.ticker ?? row.ticker }))) };
}
function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["www.sec.gov", "finance.yahoo.com"].includes(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
