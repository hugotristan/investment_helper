import { normalizeHolding } from "../analysis/holdings.js";
import { validateWatchlistTicker } from "../data/market.js";
import { isBlockedAssetTicker } from "../shared/symbols.js";
import { escapeHtml } from "../shared/text.js";
import { persist, state } from "../storage.js";
import { getPortfolioHoldings, parsePortfolioPositions } from "./portfolio.js";

export { getPortfolioHoldings };

const currencies = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD"]);
let bound = false;
let busy = false;
let onChange = () => {};
let lastRemoved = null;

export function initializePortfolio() {
  let migrationFailed = false;
  if (!Array.isArray(state.holdings)) {
    state.holdings = parsePortfolioPositions(state.myPortfolioInput).map((holding) => ({
      ...holding, id: crypto.randomUUID(), kind: "manual", currency: state.currency || "EUR"
    }));
    try { persist(); } catch { migrationFailed = true; }
  }
  clearForm();
  renderHoldingEditor();
  if (migrationFailed) setMessage("Legacy holdings were loaded, but browser storage could not save the migration. The original text is retained.");
}

export function bindPortfolioEvents(callback) {
  onChange = typeof callback === "function" ? callback : () => {};
  const form = element("holdingForm");
  if (!form || bound) return;
  form.addEventListener("submit", saveHolding);
  element("holdingCancel")?.addEventListener("click", () => {
    if (busy) return;
    clearForm();
    setMessage("Edit cancelled. Your saved holding is unchanged.");
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-edit-holding], [data-remove-holding], [data-undo-holding]");
    if (!button || busy) return;
    if (button.dataset.editHolding !== undefined) editHolding(button.dataset.editHolding);
    else if (button.dataset.removeHolding !== undefined) removeHolding(button.dataset.removeHolding);
    else if (button.dataset.undoHolding !== undefined) undoRemoval();
  });
  bound = true;
}

async function saveHolding(event) {
  event.preventDefault();
  if (busy) return;
  const id = element("holdingId").value;
  const normalized = normalizeHolding({ id: id || crypto.randomUUID(), ticker: element("holdingTicker").value,
    label: element("holdingLabel").value, shares: element("holdingShares").value,
    averageCost: element("holdingCost").value, currency: element("holdingCurrency").value });
  if (!normalized.ok) { setMessage(normalized.error); return; }
  const holding = normalized.holding;
  if (!currencies.has(holding.currency)) { setMessage("Choose one of the supported purchase currencies."); return; }
  if (isBlockedAssetTicker(holding.ticker)) { setMessage("Only stock and ETF holdings are supported."); return; }
  if (id && !getPortfolioHoldings().some((row) => row.id === id)) { setMessage("That holding is no longer saved. Cancel the edit and start again."); return; }
  setBusy(true);
  setMessage(`Checking ${holding.ticker} against live stock and ETF data…`);
  try {
    const validity = await validateWatchlistTicker(holding.ticker);
    if (validity !== "valid") {
      setMessage(validity === "invalid" ? "Ticker not found. Check the symbol and exchange suffix."
        : validity === "unsupported" ? "That symbol is not a stock or ETF."
          : "The ticker could not be verified because market data is unavailable. Try again. No changes saved.");
      return;
    }
    const previous = state.holdings;
    const current = getPortfolioHoldings();
    state.holdings = id ? current.map((row) => row.id === id ? holding : row) : current.concat(holding);
    try { persist(); } catch (error) { state.holdings = previous; throw error; }
    clearForm();
    renderHoldingEditor();
    setMessage(`${holding.ticker} ${id ? "updated" : "added"}. Your holdings are saved in this browser.`);
    notifyChange();
  } catch {
    setMessage("Could not save this holding. Check market data and browser storage, then try again.");
  } finally {
    setBusy(false);
  }
}

function editHolding(id) {
  const holding = getPortfolioHoldings().find((row) => row.id === id);
  if (!holding) return;
  element("holdingId").value = holding.id;
  element("holdingTicker").value = holding.ticker;
  element("holdingLabel").value = holding.label || "";
  element("holdingShares").value = holding.kind === "manual" ? "" : holding.shares;
  element("holdingCost").value = holding.kind === "manual" ? "" : holding.averageCost;
  element("holdingCurrency").value = holding.currency;
  element("holdingSave").textContent = "Save changes";
  element("holdingCancel").hidden = false;
  setMessage(holding.kind === "manual" ? "This legacy amount stays unchanged until you enter shares and an average purchase price and save."
    : `Editing ${holding.ticker}. Changes are saved only when you choose Save changes.`);
  const panel = element("holdingForm").closest("details");
  if (panel) panel.open = true;
  element("holdingTicker").focus();
}

function removeHolding(id) {
  const current = getPortfolioHoldings();
  const index = current.findIndex((row) => row.id === id);
  if (index < 0) return;
  const removed = current[index];
  const previous = state.holdings;
  state.holdings = current.filter((row) => row.id !== id);
  try { persist(); } catch { state.holdings = previous; setMessage("Could not remove the holding from browser storage."); return; }
  lastRemoved = { holding: removed, index };
  if (element("holdingId").value === id) clearForm();
  renderHoldingEditor();
  setMessage(`${removed.ticker} removed.`);
  notifyChange();
}

function undoRemoval() {
  if (!lastRemoved) return;
  const previous = state.holdings;
  const current = [...getPortfolioHoldings()];
  if (current.some((row) => row.id === lastRemoved.holding.id)) return;
  current.splice(Math.min(lastRemoved.index, current.length), 0, lastRemoved.holding);
  state.holdings = current;
  try { persist(); } catch { state.holdings = previous; setMessage("Could not restore the holding to browser storage."); return; }
  const ticker = lastRemoved.holding.ticker;
  lastRemoved = null;
  renderHoldingEditor();
  setMessage(`${ticker} restored.`);
  notifyChange();
}

function renderHoldingEditor() {
  const rows = element("holdingEditorRows");
  if (!rows) return;
  const holdings = getPortfolioHoldings();
  rows.innerHTML = holdings.length ? holdings.map((holding) => `<div class="holding-editor-row">
    <div class="holding-editor-name"><strong>${escapeHtml(holding.ticker)}</strong><span>${escapeHtml(holding.label)}</span></div>
    <div class="holding-editor-values"><span>${holding.kind === "manual" ? `Entered amount ${escapeHtml(number(holding.amount))}`
      : `${escapeHtml(number(holding.shares))} shares · average cost ${escapeHtml(number(holding.averageCost))}`}</span>
      <small>${escapeHtml(holding.currency)} · ${holding.kind === "manual" ? `legacy amount, manual status ${escapeHtml(holding.status)}` : "share position"}</small></div>
    <div class="holding-editor-actions"><button type="button" class="ghost" data-edit-holding="${escapeHtml(holding.id)}">Edit</button>
      <button type="button" class="ghost" data-remove-holding="${escapeHtml(holding.id)}">Remove</button></div></div>`).join("")
    : '<p class="empty-state">Add your first holding with its share quantity and average purchase price.</p>';
}

function clearForm() {
  const form = element("holdingForm");
  if (!form) return;
  form.reset();
  element("holdingId").value = "";
  element("holdingCurrency").value = currencies.has(state.currency) ? state.currency : "USD";
  element("holdingSave").textContent = "Save holding";
  element("holdingCancel").hidden = true;
}

function setBusy(value) {
  busy = value;
  const form = element("holdingForm");
  form.setAttribute("aria-busy", String(value));
  form.querySelectorAll("input,select,button").forEach((control) => { control.disabled = value; });
  document.querySelectorAll("[data-edit-holding], [data-remove-holding]").forEach((control) => { control.disabled = value; });
  const undo = element("holdingEditorMessage")?.querySelector("[data-undo-holding]");
  if (undo) undo.disabled = value;
}

function setMessage(text) {
  const message = element("holdingEditorMessage");
  if (message) message.innerHTML = `${escapeHtml(text)}${lastRemoved ? ` <button type="button" class="ghost" data-undo-holding ${busy ? "disabled" : ""}>Undo removal</button>` : ""}`;
}

function notifyChange() {
  try { Promise.resolve(onChange()).catch(() => setMessage("Holdings were saved. Refresh the scan to update market analysis.")); }
  catch { setMessage("Holdings were saved. Refresh the scan to update market analysis."); }
}

function number(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(value) : "Unavailable";
}

function element(id) { return document.getElementById(id); }
