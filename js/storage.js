// Browser-local settings and scan history. Portfolio and watchlist data are not sent to a shared database.

import { legacyDefaultTickers, opportunityUniverse } from "./config/settings.js";

const STORAGE_KEY = "today-invest-model-state";

export const defaults = {
  tickerInput: opportunityUniverse.join(", "),
  myPortfolioInput: "",
  holdings: null,
  screenerSignal: "all",
  screenerMinScore: 0,
  screenerMinLiquidity: 0,
  screenerSort: "score",
  detailTicker: "MSFT",
  currency: "EUR",
  learningHistory: []
};

export const state = { ...defaults, ...loadState() };

if (String(state.tickerInput || "").trim() === legacyDefaultTickers) state.tickerInput = defaults.tickerInput;

if (!Array.isArray(state.learningHistory)) state.learningHistory = [];

export function saveLearningSnapshot(results, priceSource, newsSource) {
  state.learningHistory = [
    ...state.learningHistory,
    {
      at: new Date().toISOString(),
      priceSource,
      newsSource,
      scores: results.filter((item) => item.dataQuality?.eligible && Number.isFinite(item.score)).map((item) => ({ ticker: item.ticker, score: item.score, latest: item.latest }))
    }
  ].slice(-96);
  persist();
}

export function latestLearningPoint(ticker) {
  for (let i = state.learningHistory.length - 1; i >= 0; i -= 1) {
    const match = state.learningHistory[i].scores?.find((entry) => entry.ticker === ticker);
    if (match) return match;
  }
  return null;
}

export function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}
