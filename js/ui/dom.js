// DOM references and small app-wide status helpers.

export const els = {
  pageTitle: document.getElementById("pageTitle"),
  pageDescription: document.getElementById("pageDescription"),
  quickSearchForm: document.getElementById("quickSearchForm"),
  quickSearchInput: document.getElementById("quickSearchInput"),
  dataStatus: document.getElementById("dataStatus"),
  viewPages: document.querySelectorAll("[data-page]"),
  pageLinks: document.querySelectorAll("[data-page-link]"),
  tickerInput: document.getElementById("tickerInput"),
  watchlistChips: document.getElementById("watchlistChips"),
  watchlistCount: document.getElementById("watchlistCount"),
  watchlistToggle: document.getElementById("watchlistToggle"),
  watchlistAddForm: document.getElementById("watchlistAddForm"),
  watchlistAddInput: document.getElementById("watchlistAddInput"),
  watchlistMessage: document.getElementById("watchlistMessage"),
  watchlistApplyButton: document.getElementById("watchlistApplyButton"),
  myPortfolioInput: document.getElementById("myPortfolioInput"),
  screenerSignal: document.getElementById("screenerSignal"),
  screenerMinScore: document.getElementById("screenerMinScore"),
  screenerMinLiquidity: document.getElementById("screenerMinLiquidity"),
  screenerSort: document.getElementById("screenerSort"),
  screenerResults: document.getElementById("screenerResults"),
  detailTickerInput: document.getElementById("detailTickerInput"),
  detailButton: document.getElementById("detailButton"),
  detailOutput: document.getElementById("detailOutput"),
  askInput: document.getElementById("askInput"),
  askButton: document.getElementById("askButton"),
  askAnswer: document.getElementById("askAnswer"),
  marketPulseTitle: document.getElementById("marketPulseTitle"),
  marketPulse: document.getElementById("marketPulse"),
  marketForecast: document.getElementById("marketForecast"),
  portfolioReview: document.getElementById("portfolioReview"),
  lastScan: document.getElementById("lastScan"),
  refreshTitle: document.getElementById("refreshTitle"),
  nextScan: document.getElementById("nextScan"),
  modelInstructions: document.getElementById("modelInstructions"),
  sellGuidance: document.getElementById("sellGuidance"),
  researchEvidence: document.getElementById("researchEvidence"),
  marketFramework: document.getElementById("marketFramework"),
  sourceStatus: document.getElementById("sourceStatus"),
  analysisResults: document.getElementById("analysisResults"),
  toast: document.getElementById("toast")
};

export function setStatus(text) {
  els.dataStatus.textContent = text;
}

export function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.setTimeout(() => els.toast.classList.remove("show"), 1800);
}
