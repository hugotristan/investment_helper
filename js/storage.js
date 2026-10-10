// Preferences and public scan history stay local. Sites portfolio/watchlist data use private API storage.

import { legacyDefaultTickers, opportunityUniverse } from "./config/settings.js";
import { cloudSession, cloudWatchlistStore } from "./data/cloud-portfolio-store.js";

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

// A shared browser must not display the previous signed-in account's private data.
if (cloudSession.isCloud) {
  state.tickerInput = defaults.tickerInput;
  state.myPortfolioInput = "";
  state.holdings = [];
}

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
  if (cloudSession.isCloud) {
    const { tickerInput, myPortfolioInput, holdings, ...preferences } = state;
    // Keep an old browser portfolio untouched for deliberate migration/recovery.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadState(), ...preferences }));
  } else localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export async function loadPrivateWatchlist() {
  if (!cloudSession.isCloud) return;
  const tickers = await cloudWatchlistStore.read();
  state.tickerInput = tickers === null ? defaults.tickerInput : tickers.join(", ");
}

export async function savePrivateWatchlist(tickers) {
  const previous = state.tickerInput;
  if (cloudSession.isCloud) {
    const expectedTickers = previous.split(",").map((value) => value.trim()).filter(Boolean);
    const saved = await cloudWatchlistStore.write(tickers, { expectedTickers });
    state.tickerInput = saved.join(", ");
    return;
  }
  state.tickerInput = tickers.join(", ");
  try { persist(); } catch (error) { state.tickerInput = previous; throw error; }
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}
