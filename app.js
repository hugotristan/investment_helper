// App entry point: initializes feature controls, navigation, and the scan/refresh lifecycle.

import { applyLearningSignal, scoreSeries, stableRankSort } from "./js/analysis/scoring.js";
import { AUTO_REFRESH_DELAY_SECONDS, opportunityUniverse } from "./js/config/settings.js";
import { applyQuoteSnapshot, loadMarketContext, loadQuoteSnapshots, loadTickerSeries } from "./js/data/market.js";
import { loadNewsSources } from "./js/data/news.js";
import { loadScanCache, saveScanCache } from "./js/data/scan-cache.js";
import { runStockDetail } from "./js/features/detail.js";
import { buildPortfolioReview, parsePortfolioPositions, renderPortfolioReview } from "./js/features/portfolio.js";
import { answerQuestion } from "./js/features/questions.js";
import { renderScreener } from "./js/features/screener.js";
import { bindWatchlistEvents, renderWatchlist } from "./js/features/watchlist.js";
import { formatDuration } from "./js/shared/format.js";
import { isBlockedAssetTicker, parseTickers } from "./js/shared/symbols.js";
import { unique } from "./js/shared/text.js";
import { persist, saveLearningSnapshot, state } from "./js/storage.js";
import { renderAll } from "./js/ui/dashboard.js";
import { els, setStatus } from "./js/ui/dom.js";
import { bindQuickSearch, syncActivePage } from "./js/ui/navigation.js";
import { renderDashboardOverview, renderPortfolioSnapshot } from "./js/ui/overview.js";
import { bindOpportunityEvents } from "./js/features/opportunities.js";
import { scanState } from "./js/scan-state.js";

let autoRefreshTimer = null;
let refreshTicker = null;
let inputScanTimer = null;
let scanStartedAt = null;
let nextRunAt = null;
let lastScanDurationMs = 0;
let isRunning = false;
let pendingInputScan = false;
let cachedScanAt = null;

init();

function init() {
  hydrateInputs();
  bindEvents();
  syncActivePage();
  restoreCachedScan();
  startRefreshTicker();
  runAnalysis();
}

function hydrateInputs() {
  els.tickerInput.value = state.tickerInput;
  renderWatchlist();
  els.myPortfolioInput.value = state.myPortfolioInput;
  renderPortfolioSnapshot();
  els.screenerSignal.value = state.screenerSignal;
  els.screenerMinScore.value = state.screenerMinScore;
  els.screenerMinLiquidity.value = state.screenerMinLiquidity;
  els.screenerSort.value = state.screenerSort;
  els.detailTickerInput.value = state.detailTicker;
}

function bindEvents() {
  els.myPortfolioInput.addEventListener("input", () => {
    state.myPortfolioInput = els.myPortfolioInput.value;
    persist();
    renderPortfolioSnapshot();
    scheduleConfigScan();
  });
  bindWatchlistEvents(scheduleConfigScan);
  bindOpportunityEvents(scheduleConfigScan);
  bindQuickSearch(runStockDetail);

  ["screenerSignal", "screenerMinScore", "screenerMinLiquidity", "screenerSort"].forEach((key) => {
    els[key].addEventListener("input", () => {
      state[key] = els[key].value;
      persist();
      renderScreener();
    });
  });

  els.detailButton.addEventListener("click", () => runStockDetail());
  els.detailTickerInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") runStockDetail();
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const link = target?.closest("[data-detail-ticker]");
    if (!link) return;
    event.preventDefault();
    const ticker = link.getAttribute("data-detail-ticker");
    if (!ticker) return;
    els.detailTickerInput.value = ticker;
    state.detailTicker = ticker;
    persist();
    window.location.hash = "detail";
    runStockDetail();
  });

  els.askButton.addEventListener("click", () => answerQuestion());
  els.askInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") answerQuestion();
  });
  window.addEventListener("hashchange", syncActivePage);
}

async function runAnalysis(options = {}) {
  if (isRunning) {
    if (options.reason === "config") pendingInputScan = true;
    return;
  }
  const tickers = unique(parseTickers(state.tickerInput)
    .concat(parsePortfolioPositions(state.myPortfolioInput).map((holding) => holding.ticker), opportunityUniverse))
    .filter((ticker) => !isBlockedAssetTicker(ticker))
    .slice(0, 180);
  if (!tickers.length) {
    setStatus("Add tickers");
    return;
  }

  clearAutoRefresh();
  isRunning = true;
  scanStartedAt = Date.now();
  nextRunAt = null;
  pendingInputScan = false;
  updateRefreshTimer();
  setStatus(options.reason === "config" ? "Settings changed; rescanning" : "Deep source scan running");
  setScanStage(`${cachedScanAt ? `Showing saved scan from ${new Date(cachedScanAt).toLocaleString()}. ` : ""}Refreshing prices and market context. Company research runs in the background.`);
  if (!scanState.latestRankedResults.length) els.modelInstructions.innerHTML = `<div class="empty-state">Checking prices and market context, then gathering company evidence from trusted sources.</div>`;

  try {
    const newsRequest = loadNewsSources(tickers).then((news) => ({ news }), (error) => ({ error }));
    const [series, quotes, marketContext] = await Promise.all([
      loadTickerSeries(tickers),
      loadQuoteSnapshots(tickers),
      loadMarketContext()
    ]);
    const priceSource = series.find((item) => item.source !== "sample")?.source || "sample";
    const preliminary = rankSeries(series, quotes, {});
    scanState.latestRankedResults = preliminary;
    scanState.latestQuoteSnapshot = quotes;
    scanState.latestMarketContext = marketContext;
    renderDashboardOverview(preliminary, priceSource, { sources: [], items: [] }, marketContext, quotes, { researchPending: true });
    renderPortfolioReview(buildPortfolioReview(preliminary, marketContext), priceSource);
    setStatus("Prices ready; research scanning");
    setScanStage("Prices are ready. Technical scores are preliminary while company evidence is gathered.");
    const response = await newsRequest;
    if (response.error) throw response.error;
    const news = response.news;
    const ranked = rankSeries(series, quotes, news.byTicker);

    renderAll(ranked, priceSource, news, marketContext, quotes);
    cachedScanAt = null;
    saveLearningSnapshot(ranked, priceSource, news.label);
    saveScanCache({ series, quotes, news, marketContext });
    const qualifiedCount = ranked.filter((item) => item.dataQuality?.eligible).length;
    setStatus(`${qualifiedCount}/${ranked.length} price histories qualified`);
    setScanStage(`Scan complete · ${qualifiedCount} qualified histories · research and market checks updated.`);
  } catch (error) {
    console.error(error);
    setStatus("Scan failed");
    setScanStage("The complete scan could not finish. Available prices remain visible; research will retry on the next scan.");
    els.modelInstructions.innerHTML = `<div class="empty-state">Could not complete the live scan. Check the connection and try again.</div>`;
  } finally {
    if (scanStartedAt) lastScanDurationMs = Date.now() - scanStartedAt;
    isRunning = false;
    scanStartedAt = null;
    if (pendingInputScan) {
      pendingInputScan = false;
      window.setTimeout(() => runAnalysis({ reason: "config" }), 300);
    } else {
      scheduleNextRun();
    }
    updateRefreshTimer();
  }
}

function rankSeries(series, quotes, byTicker) {
  return series.map((item) => applyQuoteSnapshot(item, quotes.byTicker))
    .map((item) => scoreSeries(item, byTicker[item.ticker] || []))
    .map(applyLearningSignal).sort(stableRankSort);
}

function restoreCachedScan() {
  const cached = loadScanCache();
  if (!cached) return;
  const requested = new Set(parseTickers(state.tickerInput).concat(opportunityUniverse,
    parsePortfolioPositions(state.myPortfolioInput).map((holding) => holding.ticker)));
  const series = cached.series.filter((item) => requested.has(item.ticker));
  if (!series.length) return;
  const ranked = rankSeries(series, cached.quotes, cached.news.byTicker);
  cachedScanAt = cached.savedAt;
  renderAll(ranked, series[0].source, cached.news, cached.marketContext, cached.quotes, { scannedAt: cached.savedAt });
  setScanStage(`Showing saved scan from ${new Date(cached.savedAt).toLocaleString()}. A fresh scan is starting.`);
}

function setScanStage(message) {
  const stage = document.getElementById("scanStage");
  if (stage) stage.textContent = message;
}

function scheduleConfigScan() {
  if (inputScanTimer) window.clearTimeout(inputScanTimer);
  pendingInputScan = true;
  clearAutoRefresh();
  nextRunAt = Date.now() + 2500;
  updateRefreshTimer();
  inputScanTimer = window.setTimeout(() => {
    inputScanTimer = null;
    runAnalysis({ reason: "config" });
  }, 2500);
}

function startRefreshTicker() {
  refreshTicker = window.setInterval(updateRefreshTimer, 1000);
  updateRefreshTimer();
}

function scheduleNextRun() {
  clearAutoRefresh();
  nextRunAt = Date.now() + AUTO_REFRESH_DELAY_SECONDS * 1000;
  autoRefreshTimer = window.setTimeout(() => runAnalysis(), AUTO_REFRESH_DELAY_SECONDS * 1000);
}

function clearAutoRefresh() {
  if (autoRefreshTimer) window.clearTimeout(autoRefreshTimer);
  autoRefreshTimer = null;
}

function updateRefreshTimer() {
  if (isRunning && scanStartedAt) {
    els.refreshTitle.textContent = "Scanning now";
    els.nextScan.textContent = `Elapsed ${formatDuration(Date.now() - scanStartedAt)}`;
    return;
  }

  if (nextRunAt) {
    const remainingMs = Math.max(0, nextRunAt - Date.now());
    els.refreshTitle.textContent = lastScanDurationMs ? `Last scan ${formatDuration(lastScanDurationMs)}` : "Deep live scan";
    els.nextScan.textContent = remainingMs ? `Next in ${formatDuration(remainingMs)}` : "Starting now";
    return;
  }

  els.refreshTitle.textContent = "Deep live scan";
  els.nextScan.textContent = "Starting now";
}
