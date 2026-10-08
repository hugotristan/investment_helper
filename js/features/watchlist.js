import { mapLimit } from "../data/http.js";
import { validateWatchlistTicker } from "../data/market.js";
import { isBlockedAssetTicker, parseTickers } from "../shared/symbols.js";
import { escapeHtml, unique } from "../shared/text.js";
import { persist, state } from "../storage.js";
import { els } from "../ui/dom.js";

let onWatchlistChange = () => {};
let watchlistExpanded = false;
let isWatchlistValidating = false;

export function renderWatchlist() {
  const tickers = parseTickers(state.tickerInput);
  const previewCount = 16;
  const visible = watchlistExpanded ? tickers : tickers.slice(0, previewCount);
  els.watchlistCount.textContent = `${tickers.length} ticker${tickers.length === 1 ? "" : "s"}`;
  els.watchlistChips.innerHTML = visible.length
    ? visible.map((ticker) => `<button type="button" class="ticker-chip" data-remove-ticker="${escapeHtml(ticker)}" aria-label="Remove ${escapeHtml(ticker)} from watchlist" ${isWatchlistValidating ? "disabled" : ""}><span>${escapeHtml(ticker)}</span><span class="ticker-chip-remove" aria-hidden="true">×</span></button>`).join("")
    : `<p class="watchlist-empty">Add tickers to build your watchlist.</p>`;
  els.watchlistToggle.hidden = tickers.length <= previewCount;
  els.watchlistToggle.textContent = watchlistExpanded ? "Show less" : `Show all ${tickers.length} tickers`;
  els.watchlistToggle.setAttribute("aria-expanded", String(watchlistExpanded));
}

export async function addTickerToWatchlist(ticker) {
  if (parseTickers(state.tickerInput).includes(ticker)) return { ok: true, changed: false, message: `${ticker} is already on your watchlist.` };
  if (isWatchlistValidating) return { ok: false, changed: false, message: "Another ticker check is running. Try again shortly." };
  await saveWatchlistInput(ticker, false, false);
  const ok = parseTickers(state.tickerInput).includes(ticker);
  return { ok, changed: ok, message: els.watchlistMessage.textContent };
}

function updateWatchlist(tickers, notify = true) {
  state.tickerInput = tickers.join(", ");
  els.tickerInput.value = state.tickerInput;
  renderWatchlist();
  persist();
  if (notify) onWatchlistChange();
}

async function saveWatchlistInput(value, replace, notify = true) {
  if (isWatchlistValidating) return;
  const input = value.trim().toUpperCase();
  const entries = input.split(/[\s,;]+/).filter(Boolean);
  if ((!entries.length && !replace) || entries.some((ticker) => !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker))) {
    els.watchlistMessage.textContent = "Enter ticker symbols of up to 20 characters, separated by commas or spaces (e.g. AAPL, BRK-B, VWCE.DE).";
    return;
  }
  if (entries.some(isBlockedAssetTicker)) {
    els.watchlistMessage.textContent = "This watchlist supports stocks and ETFs. Remove cryptocurrency symbols to continue.";
    return;
  }
  const current = parseTickers(state.tickerInput);
  const additions = unique(entries).filter((ticker) => !current.includes(ticker));
  const next = replace ? unique(entries) : current.concat(additions);
  if (!additions.length && !replace) {
    els.watchlistMessage.textContent = "Those tickers are already on your watchlist.";
    return;
  }
  if (next.length > 90) {
    els.watchlistMessage.textContent = "Your watchlist can hold up to 90 tickers. Remove some before adding more.";
    return;
  }
  setWatchlistValidating(true);
  try {
    if (additions.length) {
      els.watchlistMessage.textContent = `Checking ${additions.join(", ")}…`;
      const results = await mapLimit(additions, 6, validateWatchlistTicker);
      const invalid = additions.filter((_, index) => results[index].status === "fulfilled" && results[index].value === "invalid");
      const unsupported = additions.filter((_, index) => results[index].status === "fulfilled" && results[index].value === "unsupported");
      const unavailable = additions.filter((_, index) => results[index].status !== "fulfilled" || results[index].value === "unavailable");
      if (invalid.length || unsupported.length || unavailable.length) {
        const messages = [];
        if (invalid.length) messages.push(`Ticker not found: ${invalid.join(", ")}. Check the symbol and exchange suffix.`);
        if (unsupported.length) messages.push(`Only stocks and ETFs are supported: ${unsupported.join(", ")}.`);
        if (unavailable.length) messages.push(`Could not verify ${unavailable.join(", ")} because market data is unavailable. Try again shortly.`);
        els.watchlistMessage.textContent = `${messages.join(" ")} No changes saved.`;
        return;
      }
    }
    updateWatchlist(next, notify);
    if (!replace) els.watchlistAddInput.value = "";
    els.watchlistMessage.textContent = replace ? "Watchlist saved." : `${additions.join(", ")} added. Watchlist saved.`;
  } catch {
    els.watchlistMessage.textContent = "Could not save the watchlist. Try again. No new scan was requested.";
  } finally {
    setWatchlistValidating(false);
    (replace ? els.watchlistApplyButton : els.watchlistAddInput).focus();
  }
}

function setWatchlistValidating(busy) {
  isWatchlistValidating = busy;
  els.watchlistAddInput.disabled = busy;
  els.watchlistAddForm.querySelector("button").disabled = busy;
  els.tickerInput.disabled = busy;
  els.watchlistApplyButton.disabled = busy;
  els.watchlistAddForm.closest(".watchlist-editor").setAttribute("aria-busy", String(busy));
  renderWatchlist();
}

export function bindWatchlistEvents(onChange) {
  onWatchlistChange = onChange;
  els.tickerInput.addEventListener("input", () => {
    els.watchlistMessage.textContent = "Unsaved changes. Choose Save tickers to check new symbols and save.";
  });
  els.watchlistApplyButton.addEventListener("click", () => {
    saveWatchlistInput(els.tickerInput.value, true);
  });

  els.watchlistAddForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveWatchlistInput(els.watchlistAddInput.value, false);
  });
  els.watchlistToggle.addEventListener("click", () => {
    watchlistExpanded = !watchlistExpanded;
    renderWatchlist();
  });
  els.watchlistChips.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-ticker]");
    if (!button || isWatchlistValidating) return;
    const ticker = button.dataset.removeTicker;
    const buttons = Array.from(els.watchlistChips.querySelectorAll("[data-remove-ticker]"));
    const index = buttons.indexOf(button);
    updateWatchlist(parseTickers(state.tickerInput).filter((item) => item !== ticker));
    els.watchlistMessage.textContent = `${ticker} removed. Watchlist saved.`;
    const remaining = els.watchlistChips.querySelectorAll("[data-remove-ticker]");
    (remaining[Math.min(index, remaining.length - 1)] || els.watchlistAddInput).focus();
  });
}
