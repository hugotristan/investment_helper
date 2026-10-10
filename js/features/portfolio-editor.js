import { normalizeHolding } from "../analysis/holdings.js";
import { validateWatchlistTicker } from "../data/market.js";
import { resolveTickerInput } from "../data/ticker-search.js";
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
let adapter = null;
let formRevision = null;

export function configurePortfolioEditor(value) {
  adapter = value;
  lastRemoved = null;
  clearForm();
  renderHoldingEditor();
  const summary = element("portfolioEditor")?.querySelector("summary strong");
  if (summary) summary.textContent = adapter ? "Opening positions" : "Add or edit holdings";
  const help = element("portfolioInputHelp");
  if (help && adapter) help.textContent = "Positions held at your tracking start date. Later purchases and sales belong in Transactions. Changes must remain compatible with your saved sales.";
}

export function refreshPortfolioEditor() {
  renderHoldingEditor();
  // A blank form can adopt the new revision; a typed edit must stay protected.
  if (adapter && ["holdingId", "holdingTicker", "holdingLabel", "holdingShares", "holdingCost"].every((id) => !element(id)?.value)) {
    formRevision = adapter.revision();
  }
}

function editableHoldings() { return adapter ? adapter.read() : getPortfolioHoldings(); }

async function saveHoldings(holdings, revision) {
  if (adapter) { await adapter.write(holdings, revision); return; }
  const previous = state.holdings;
  state.holdings = holdings;
  try { persist(); } catch (error) { state.holdings = previous; throw error; }
}

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
  const expectedRevision = formRevision;
  setBusy(true);
  try {
    const ticker = await resolveTickerInput(element("holdingTicker").value);
    if (!ticker) { setMessage("Select a matching stock or ETF, or enter its ticker symbol."); return; }
    const normalized = normalizeHolding({ id: id || crypto.randomUUID(), ticker,
      label: element("holdingLabel").value, shares: element("holdingShares").value,
      averageCost: element("holdingCost").value, currency: element("holdingCurrency").value });
    if (!normalized.ok) { setMessage(normalized.error); return; }
    const holding = normalized.holding;
    if (!currencies.has(holding.currency)) { setMessage("Choose one of the supported purchase currencies."); return; }
    if (isBlockedAssetTicker(holding.ticker)) { setMessage("Only stock and ETF holdings are supported."); return; }
    if (id && !editableHoldings().some((row) => row.id === id)) { setMessage("That holding is no longer saved. Cancel the edit and start again."); return; }
    setMessage(`Checking ${holding.ticker} against stock and ETF listings…`);
    const validity = await validateWatchlistTicker(holding.ticker);
    if (validity !== "valid") {
      setMessage(validity === "invalid" ? "Ticker not found. Check the symbol and exchange suffix."
        : validity === "unsupported" ? "That symbol is not a stock or ETF."
          : "The ticker could not be verified because market data is unavailable. Try again. No changes saved.");
      return;
    }
    const current = editableHoldings();
    await saveHoldings(id ? current.map((row) => row.id === id ? holding : row) : current.concat(holding), expectedRevision);
    clearForm();
    renderHoldingEditor();
    setMessage(`${holding.ticker} ${id ? "updated" : "added"}. Your holdings are saved in this browser.`);
    notifyChange();
  } catch (error) {
    setMessage(error.message || "Could not save this holding. Check market data and browser storage, then try again.");
  } finally {
    setBusy(false);
  }
}

function editHolding(id) {
  const holding = editableHoldings().find((row) => row.id === id);
  if (!holding) return;
  formRevision = adapter?.revision() ?? null;
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

async function removeHolding(id) {
  const current = editableHoldings();
  const index = current.findIndex((row) => row.id === id);
  if (index < 0) return;
  const removed = current[index];
  setBusy(true);
  try { await saveHoldings(current.filter((row) => row.id !== id), adapter?.revision() ?? null); }
  catch (error) { setMessage(error.message || "Could not remove the holding from browser storage."); return; }
  finally { setBusy(false); }
  lastRemoved = { holding: removed, index };
  if (element("holdingId").value === id) clearForm();
  renderHoldingEditor();
  setMessage(`${removed.ticker} removed.`);
  notifyChange();
}

async function undoRemoval() {
  if (!lastRemoved) return;
  const ticker = lastRemoved.holding.ticker;
  const current = [...editableHoldings()];
  if (current.some((row) => row.id === lastRemoved.holding.id)) return;
  current.splice(Math.min(lastRemoved.index, current.length), 0, lastRemoved.holding);
  setBusy(true);
  try { await saveHoldings(current, adapter?.revision() ?? null); }
  catch (error) { setMessage(error.message || "Could not restore the holding to browser storage."); return; }
  finally { setBusy(false); }
  lastRemoved = null;
  renderHoldingEditor();
  setMessage(`${ticker} restored.`);
  notifyChange();
}

function renderHoldingEditor() {
  const rows = element("holdingEditorRows");
  if (!rows) return;
  const holdings = editableHoldings();
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
  formRevision = adapter?.revision() ?? null;
  element("holdingCurrency").value = currencies.has(state.currency) ? state.currency : "USD";
  element("holdingSave").textContent = adapter ? "Save opening position" : "Save holding";
  element("holdingCancel").hidden = !adapter;
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
