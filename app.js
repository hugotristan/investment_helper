// App entry point: initializes feature controls, navigation, and the scan/refresh lifecycle.

import { applyLearningSignal, scoreSeries, stableRankSort } from "./js/analysis/scoring.js";
import { AUTO_REFRESH_DELAY_SECONDS, MIN_ACTIVE_SOURCES } from "./js/config/settings.js";
import { applyQuoteSnapshot, loadMarketContext, loadQuoteSnapshots, loadTickerSeries } from "./js/data/market.js";
import { loadNewsSources } from "./js/data/news.js";
import { runStockDetail } from "./js/features/detail.js";
import { parsePortfolioPositions } from "./js/features/portfolio.js";
import { answerQuestion } from "./js/features/questions.js";
import { renderScreener } from "./js/features/screener.js";
import { bindWatchlistEvents, renderWatchlist } from "./js/features/watchlist.js";
import { formatDuration } from "./js/shared/format.js";
import { isBlockedAssetTicker, parseTickers } from "./js/shared/symbols.js";
import { unique } from "./js/shared/text.js";
import { persist, saveLearningSnapshot, state } from "./js/storage.js";
import { renderAll } from "./js/ui/dashboard.js";
import { els, setStatus } from "./js/ui/dom.js";

let autoRefreshTimer = null;
let refreshTicker = null;
let inputScanTimer = null;
let scanStartedAt = null;
let nextRunAt = null;
let lastScanDurationMs = 0;
let isRunning = false;
let pendingInputScan = false;

init();

function init() {
  hydrateInputs();
  bindEvents();
  syncActivePage();
  startRefreshTicker();
  runAnalysis();
}

function hydrateInputs() {
  els.tickerInput.value = state.tickerInput;
  renderWatchlist();
  els.myPortfolioInput.value = state.myPortfolioInput;
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
    scheduleConfigScan();
  });
  bindWatchlistEvents(scheduleConfigScan);

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

function syncActivePage() {
  const pageNames = ["dashboard", "screener", "detail", "portfolio", "ask", "signals", "research", "sources"];
  const requested = String(window.location.hash || "").replace(/^#/, "") || "dashboard";
  const activePage = pageNames.includes(requested) ? requested : "dashboard";

  els.viewPages.forEach((page) => {
    const isActive = page.dataset.page === activePage;
    page.hidden = !isActive;
    page.classList.toggle("active", isActive);
  });

  els.pageLinks.forEach((link) => {
    const isActive = link.dataset.pageLink === activePage;
    link.classList.toggle("active", isActive);
    if (isActive) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  if (requested !== activePage) {
    window.history.replaceState(null, "", `#${activePage}`);
  }
}

async function runAnalysis(options = {}) {
  if (isRunning) {
    if (options.reason === "config") pendingInputScan = true;
    return;
  }
  const tickers = unique(parseTickers(state.tickerInput)
    .concat(parsePortfolioPositions(state.myPortfolioInput).map((holding) => holding.ticker)))
    .filter((ticker) => !isBlockedAssetTicker(ticker))
    .slice(0, 96);
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
  els.modelInstructions.innerHTML = `<div class="empty-state">Building one consolidated review from live price action, macro proxies, headlines, and outlooks. The scan retries slow sources and keeps widening until it gets at least ${MIN_ACTIVE_SOURCES} trusted sources, or until the review time budget is reached...</div>`;

  try {
    const [series, quotes, news, marketContext] = await Promise.all([
      loadTickerSeries(tickers),
      loadQuoteSnapshots(tickers),
      loadNewsSources(tickers),
      loadMarketContext()
    ]);
    const priceSource = series.find((item) => item.source !== "sample")?.source || "sample";
    const ranked = series
      .map((item) => applyQuoteSnapshot(item, quotes.byTicker))
      .map((item) => scoreSeries(item, news.byTicker[item.ticker] || []))
      .map(applyLearningSignal)
      .sort(stableRankSort);

    renderAll(ranked, priceSource, news, marketContext, quotes);
    saveLearningSnapshot(ranked, priceSource, news.label);
    setStatus(priceSource === "sample" ? "Sample fallback" : "Live web data");
  } catch (error) {
    console.error(error);
    setStatus("Scan failed");
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
