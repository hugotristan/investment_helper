import { createPortfolioBook, normalizeTransaction, portfolioToday, validatePortfolioBook } from "../analysis/portfolio-ledger.js";
import { MAX_PORTFOLIO_BACKUP_BYTES, parsePortfolioBackup, portfolioBookStore, serializePortfolioBackup } from "../data/portfolio-book-store.js";
import { validateWatchlistTicker } from "../data/market.js";
import { getActivePortfolioBook, getPortfolioProjection, setActivePortfolioBook } from "../portfolio-state.js";
import { escapeHtml } from "../shared/text.js";
import { state } from "../storage.js";
import { configurePortfolioEditor, refreshPortfolioEditor } from "./portfolio-editor.js";
import { getPortfolioHoldings } from "./portfolio.js";

const labels = { buy: "Purchase", sell: "Sale", deposit: "Deposit", withdrawal: "Withdrawal", dividend: "Dividend", fee: "Fee", opening_cash: "Opening cash" };

export function createPortfolioBookController({ store = portfolioBookStore, document: doc = globalThis.document,
  now = () => Date.now(), uuid = () => crypto.randomUUID(), validateTicker = validateWatchlistTicker,
  onChange = () => {}, download = downloadBackup, subscribe = true } = {}) {
  let busy = false;
  let loaded = false;
  let bound = false;
  let pendingBackup = null;
  let formRevision = null;
  let settingsRevision = null;
  let confirmDelete = null;
  let channel = null;
  let adapted = false;
  const el = (id) => doc.getElementById(id);
  const message = (id, text) => { if (el(id)) el(id).textContent = text; };
  const today = () => portfolioToday(now());

  async function initialize() {
    bind();
    setBusy(true);
    message("portfolioBookStatus", "Loading saved portfolio…");
    try {
      const book = await store.read();
      loaded = true;
      apply(book);
      message("portfolioBookStatus", book ? "Portfolio saved in this browser. Export a backup to keep a separate copy." : "");
    } catch (error) {
      el("portfolioSetup").hidden = true;
      message("portfolioBookStatus", `${error.message} Your previous holdings remain visible. Reload to retry.`);
    } finally {
      setBusy(false);
      if (!loaded) {
        for (const id of ["portfolioSetupSave", "portfolioRestore", "portfolioImport", "portfolioExport"]) el(id).disabled = true;
      }
    }
    if (subscribe && globalThis.window) {
      window.addEventListener("focus", refreshFromStorage);
      try {
        if (globalThis.BroadcastChannel) {
          channel = new BroadcastChannel("investment-helper-portfolio");
          channel.onmessage = refreshFromStorage;
        }
      } catch { /* Focus/reload still checks for newer revisions. */ }
    }
    return loaded;
  }

  function apply(book) {
    setActivePortfolioBook(book);
    if (book && !adapted) {
      configurePortfolioEditor({ read: () => getActivePortfolioBook().openingHoldings,
        revision: () => getActivePortfolioBook().updatedAt, write: writeOpeningHoldings });
      adapted = true;
    } else if (book) refreshPortfolioEditor();
    render();
  }

  async function commit(candidate, expectedUpdatedAt) {
    const checked = validatePortfolioBook(candidate, { now: now() });
    if (!checked.ok) throw new TypeError(checked.error);
    const saved = await store.write(checked.book, { expectedUpdatedAt });
    apply(saved);
    try { channel?.postMessage({ updatedAt: saved.updatedAt }); } catch { /* Save has committed. */ }
    try { onChange(); } catch { message("portfolioBookStatus", "Portfolio saved. Refresh to update the holdings view."); }
    return saved;
  }

  function changed(book, changes) {
    return { ...book, ...changes, updatedAt: new Date(Math.max(now(), Date.parse(book.updatedAt) + 1)).toISOString() };
  }

  async function work(id, action) {
    if (!loaded || busy) return false;
    setBusy(true);
    try { await action(); return true; }
    catch (error) {
      message(id, error.message || "The change could not be saved.");
      if (error.code === "CONFLICT") message("portfolioBookStatus", "Another tab changed this portfolio. Reload before saving your edits. Your edits have not been saved.");
      return false;
    } finally { setBusy(false); }
  }

  async function setup(event) {
    event?.preventDefault();
    return work("portfolioBookStatus", async () => {
      if (getActivePortfolioBook()) throw new TypeError("Tracking is already set up.");
      const book = createPortfolioBook({ holdings: getPortfolioHoldings(), legacyPortfolioInput: state.myPortfolioInput || "",
        baseCurrency: el("portfolioSetupCurrency").value, startDate: el("portfolioSetupDate").value, now: now() });
      await commit(book, null);
      message("portfolioBookStatus", "Tracking started. Your saved holdings are opening positions. Record only changes after the start date.");
    });
  }

  async function verifyTicker(ticker, book) {
    if (book.openingHoldings.some((h) => h.ticker === ticker) || book.transactions.some((t) => t.ticker === ticker)) return;
    const validity = await validateTicker(ticker);
    if (validity !== "valid") throw new TypeError(validity === "invalid" ? "Ticker not found. Check the symbol and exchange suffix."
      : validity === "unsupported" ? "Only stocks and ETFs are supported."
        : "Market data could not verify that ticker. Try again; no changes were saved.");
  }

  async function saveTransaction(event) {
    event?.preventDefault();
    return work("transactionMessage", async () => {
      const book = getActivePortfolioBook();
      const id = el("transactionId").value;
      if (!book) throw new TypeError("Start portfolio tracking first.");
      if (formRevision !== book.updatedAt) throw new TypeError("The portfolio changed while this form was open. Cancel and reopen the transaction before saving.");
      if (id && !book.transactions.some((t) => t.id === id)) throw new TypeError("This transaction is no longer saved.");
      const type = el("transactionType").value;
      const trade = ["buy", "sell"].includes(type);
      const normalized = normalizeTransaction({ id: id || uuid(), type,
        date: el("transactionDate").value, currency: el("transactionCurrency").value,
        ...(trade || type === "dividend" ? { ticker: el("transactionTicker").value } : {}),
        ...(trade ? { quantity: el("transactionQuantity").value, price: el("transactionPrice").value, fee: el("transactionFee").value || 0 }
          : { amount: el("transactionAmount").value }), note: el("transactionNote").value },
      { startDate: book.settings.startDate, now: now() });
      if (!normalized.ok) throw new TypeError(normalized.error);
      const transaction = normalized.transaction;
      message("transactionMessage", transaction.ticker ? `Checking ${transaction.ticker}…` : "Saving…");
      if (transaction.ticker) await verifyTicker(transaction.ticker, book);
      const transactions = id ? book.transactions.map((t) => t.id === id ? transaction : t) : [...book.transactions, transaction];
      await commit(changed(book, { transactions }), book.updatedAt);
      clearTransaction();
      el("portfolioTransactionEditor").open = false;
      message("transactionMessage", `${labels[transaction.type]} ${id ? "updated" : "recorded"}.`);
    });
  }

  async function removeTransaction(id) {
    return work("transactionMessage", async () => {
      const book = getActivePortfolioBook();
      const transaction = book?.transactions.find((t) => t.id === id);
      if (!transaction) throw new TypeError("This transaction is no longer saved.");
      if (confirmDelete?.id !== id || confirmDelete.revision !== book.updatedAt) {
        confirmDelete = { id, revision: book.updatedAt };
        renderRows();
        message("transactionMessage", "Click Confirm delete to remove this transaction. Later sales must still be supported by your holdings.");
        return;
      }
      await commit(changed(book, { transactions: book.transactions.filter((t) => t.id !== id) }), book.updatedAt);
      confirmDelete = null;
      clearTransaction();
      renderRows();
      message("transactionMessage", "Transaction deleted.");
    });
  }

  async function saveSettings(event) {
    event?.preventDefault();
    return work("portfolioBookStatus", async () => {
      const book = getActivePortfolioBook();
      if (!book || settingsRevision !== book.updatedAt) throw new TypeError("Portfolio settings changed. Reload before saving.");
      const settings = { baseCurrency: el("portfolioBaseCurrency").value, startDate: el("portfolioStartDate").value };
      if (book.transactions.length && settings.startDate !== book.settings.startDate) throw new TypeError("The tracking start date cannot change after transactions have been recorded.");
      await commit(changed(book, { settings }), book.updatedAt);
      clearTransaction();
      message("portfolioBookStatus", "Reporting settings saved. Amounts remain in their recorded currencies.");
    });
  }

  async function writeOpeningHoldings(holdings, expectedUpdatedAt) {
    const book = getActivePortfolioBook();
    if (!book || expectedUpdatedAt !== book.updatedAt) throw new TypeError("The portfolio changed. Cancel and reopen the opening-position edit.");
    await commit(changed(book, { openingHoldings: holdings }), expectedUpdatedAt);
  }

  async function importBackup(file) {
    pendingBackup = null;
    el("portfolioRestore").hidden = true;
    message("portfolioBackupPreview", "");
    return work("portfolioBackupPreview", async () => {
      if (!file) return;
      if (file.size > MAX_PORTFOLIO_BACKUP_BYTES) throw new TypeError("Choose a portfolio JSON backup no larger than 5 MiB.");
      const expectedUpdatedAt = getActivePortfolioBook()?.updatedAt ?? null;
      const parsed = parsePortfolioBackup(await file.text(), { now: now() });
      if (!parsed.ok) throw new TypeError(parsed.error);
      pendingBackup = { book: parsed.book, expectedUpdatedAt };
      const book = parsed.book;
      message("portfolioBackupPreview", `Ready to restore: ${book.settings.baseCurrency}, starting ${book.settings.startDate}; ${book.openingHoldings.length} opening positions and ${book.transactions.length} transactions. Restore replaces this browser’s tracked portfolio. Export your current portfolio first if you want to keep it.`);
      el("portfolioRestore").hidden = false;
    });
  }

  async function restoreBackup() {
    return work("portfolioBackupPreview", async () => {
      if (!pendingBackup) throw new TypeError("Choose and preview a valid backup first.");
      const { book, expectedUpdatedAt } = pendingBackup;
      if ((getActivePortfolioBook()?.updatedAt ?? null) !== expectedUpdatedAt) throw new TypeError("Your portfolio changed after the backup preview. Choose the file again before restoring.");
      // A restore is a new revision, even if the backup came from this same browser.
      const restored = { ...book, updatedAt: new Date(Math.max(now(), Date.parse(book.updatedAt) + 1, expectedUpdatedAt ? Date.parse(expectedUpdatedAt) + 1 : 0)).toISOString() };
      await commit(restored, expectedUpdatedAt);
      pendingBackup = null;
      el("portfolioRestore").hidden = true;
      el("portfolioImport").value = "";
      clearTransaction();
      message("portfolioBackupPreview", "Portfolio restored. Your watchlist and research records were unchanged.");
    });
  }

  async function exportBackup() {
    return work("portfolioBackupPreview", async () => {
      const book = await store.read();
      if (!book) throw new TypeError("Start tracking before exporting a portfolio backup.");
      const serialized = serializePortfolioBackup(book, { now: now() });
      download(serialized, `investment-helper-portfolio-${today()}.json`);
      message("portfolioBackupPreview", "Backup downloaded. It contains portfolio settings, opening positions, and transactions.");
    });
  }

  async function refreshFromStorage() {
    if (!loaded || busy) return;
    try {
      const book = await store.read();
      if (!book || book.updatedAt === getActivePortfolioBook()?.updatedAt) return;
      apply(book);
      // Keep typed input, but preserve its old revision so it cannot overwrite newer data.
      message("portfolioBookStatus", "Portfolio updated from another tab. Cancel and reopen any unfinished transaction or opening-position edit.");
      onChange();
    } catch (error) { message("portfolioBookStatus", error.message); }
  }

  function clearTransaction() {
    el("transactionForm").reset();
    el("transactionId").value = "";
    el("transactionDate").value = today();
    el("transactionDate").max = today();
    el("transactionCurrency").value = getActivePortfolioBook()?.settings.baseCurrency || "EUR";
    el("transactionSave").textContent = "Save transaction";
    el("transactionCancel").hidden = false;
    formRevision = getActivePortfolioBook()?.updatedAt ?? null;
    syncTransactionFields();
  }

  function syncTransactionFields() {
    const type = el("transactionType").value;
    const trade = ["buy", "sell"].includes(type);
    const ticker = trade || type === "dividend";
    for (const [field, visible, required] of [["Ticker", ticker, ticker], ["Quantity", trade, trade], ["Price", trade, trade], ["Amount", !trade, !trade], ["Fee", trade, false]]) {
      el(`transaction${field}Field`).hidden = !visible;
      el(`transaction${field}`).disabled = !visible;
      el(`transaction${field}`).required = required;
    }
    const opening = type === "opening_cash";
    el("transactionAmount").min = opening ? "0" : "0.00000001";
    el("transactionDate").disabled = opening;
    if (opening) el("transactionDate").value = getActivePortfolioBook()?.settings.startDate || today();
    el("transactionHelp").textContent = trade ? "Enter the execution price in the selected currency. An optional fee is recorded in the same currency."
      : opening ? "Cash already held on your tracking start date. Record one opening balance per currency."
        : type === "dividend" ? "Enter the cash dividend you received. Record any separately charged tax or fee as a Fee transaction."
          : "Enter the cash amount and its currency. Deposits and withdrawals describe money entering or leaving your portfolio.";
  }

  function openTransactionEditor(id = null) {
    if (busy || !getActivePortfolioBook()) return;
    clearTransaction();
    if (id) {
      const transaction = getActivePortfolioBook().transactions.find((t) => t.id === id);
      if (!transaction) return;
      for (const [field, key] of [["Id", "id"], ["Type", "type"], ["Date", "date"], ["Currency", "currency"], ["Ticker", "ticker"], ["Quantity", "quantity"], ["Price", "price"], ["Amount", "amount"], ["Fee", "fee"], ["Note", "note"]]) el(`transaction${field}`).value = transaction[key] ?? "";
      el("transactionSave").textContent = "Save changes";
      el("transactionCancel").hidden = false;
      syncTransactionFields();
    }
    message("transactionMessage", "");
    el("portfolioTransactions").open = true;
    el("portfolioTransactionEditor").open = true;
    el("transactionType").focus();
  }

  function renderRows() {
    const book = getActivePortfolioBook();
    if (!book) return;
    el("portfolioTransactionCount").textContent = String(book.transactions.length);
    const rows = book.transactions.map((transaction, index) => ({ transaction, index }))
      .sort((a, b) => b.transaction.date.localeCompare(a.transaction.date) || b.index - a.index);
    el("portfolioTransactionRows").innerHTML = rows.length ? rows.map(({ transaction: t }) => `<div class="portfolio-transaction-row">
      <div><strong>${escapeHtml(labels[t.type])}${t.ticker ? ` · ${escapeHtml(t.ticker)}` : ""}</strong>
      <p>${escapeHtml(t.date)} · ${escapeHtml(money(t.amount, t.currency))}${t.quantity !== undefined ? ` · ${escapeHtml(String(t.quantity))} shares at ${escapeHtml(money(t.price, t.currency))}` : ""}${t.fee ? ` · fee ${escapeHtml(money(t.fee, t.currency))}` : ""}</p>
      ${t.note ? `<small>${escapeHtml(t.note)}</small>` : ""}</div><div class="portfolio-transaction-actions">
      <button type="button" class="ghost" data-edit-transaction="${escapeHtml(t.id)}">Edit</button>
      <button type="button" class="ghost" data-delete-transaction="${escapeHtml(t.id)}">${confirmDelete?.id === t.id && confirmDelete.revision === book.updatedAt ? "Confirm delete" : "Delete"}</button></div></div>`).join("")
      : '<p class="empty-state">No transactions recorded. Existing holdings are opening positions.</p>';
    const projection = getPortfolioProjection();
    el("portfolioCashSummary").hidden = !projection.cash.length && !projection.warnings.length;
    el("portfolioCashSummary").innerHTML = `<h3>Recorded cash</h3>${projection.cash.map(({ currency, amount }) => `<p>${escapeHtml(money(amount, currency))}</p>`).join("")}
      ${projection.warnings.map((warning) => `<p class="data-note">${escapeHtml(warning)}</p>`).join("")}`;
  }

  function render() {
    const book = getActivePortfolioBook();
    el("portfolioSetup").hidden = Boolean(book);
    el("portfolioBookControls").hidden = !book;
    el("openHoldingEditor").textContent = book ? "Record transaction" : "Add or edit holdings";
    el("portfolioExport").disabled = !book || busy;
    if (!book) {
      el("portfolioSetupDate").value ||= today();
      el("portfolioSetupDate").max = today();
      message("portfolioSetupSummary", `${getPortfolioHoldings().length} saved holdings will become opening positions. Add or correct holdings below before starting.`);
      return;
    }
    el("portfolioBaseCurrency").value = book.settings.baseCurrency;
    el("portfolioStartDate").value = book.settings.startDate;
    el("portfolioStartDate").max = today();
    el("portfolioStartDate").disabled = Boolean(book.transactions.length);
    settingsRevision = book.updatedAt;
    el("transactionDate").min = book.settings.startDate;
    el("transactionDate").max = today();
    renderRows();
    if (formRevision === null) clearTransaction();
  }

  function setBusy(value) {
    busy = value;
    for (const id of ["portfolioSetupForm", "portfolioSettingsForm", "transactionForm"]) {
      el(id).setAttribute("aria-busy", String(value));
      el(id).querySelectorAll("input,select,textarea,button").forEach((control) => { control.disabled = value; });
    }
    for (const id of ["portfolioExport", "portfolioImport", "portfolioRestore", "openTransactionEditor", "openHoldingEditor"]) el(id).disabled = value;
    if (!value) el("portfolioExport").disabled = !getActivePortfolioBook();
    doc.querySelectorAll("[data-edit-transaction], [data-delete-transaction]").forEach((control) => { control.disabled = value; });
    if (!value && getActivePortfolioBook()) {
      syncTransactionFields();
      el("portfolioStartDate").disabled = Boolean(getActivePortfolioBook().transactions.length);
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    el("portfolioSetupForm").addEventListener("submit", setup);
    el("transactionForm").addEventListener("submit", saveTransaction);
    el("portfolioSettingsForm").addEventListener("submit", saveSettings);
    el("transactionType").addEventListener("change", syncTransactionFields);
    el("openTransactionEditor").addEventListener("click", () => openTransactionEditor());
    el("transactionCancel").addEventListener("click", () => { clearTransaction(); el("portfolioTransactionEditor").open = false; message("transactionMessage", "Edit cancelled."); });
    el("portfolioImport").addEventListener("change", () => importBackup(el("portfolioImport").files?.[0]));
    el("portfolioRestore").addEventListener("click", restoreBackup);
    el("portfolioExport").addEventListener("click", exportBackup);
    doc.addEventListener("click", (event) => {
      if (busy) return;
      const button = event.target.closest?.("[data-edit-transaction], [data-delete-transaction], [data-portfolio-transactions]");
      if (!button) return;
      if (button.dataset.editTransaction !== undefined) openTransactionEditor(button.dataset.editTransaction);
      else if (button.dataset.deleteTransaction !== undefined) removeTransaction(button.dataset.deleteTransaction);
      else el("portfolioTransactions").open = true;
    });
  }

  return { initialize, setup, saveTransaction, saveSettings, removeTransaction, importBackup, restoreBackup, exportBackup,
    openTransactionEditor, writeOpeningHoldings, refreshFromStorage, render,
    get book() { return getActivePortfolioBook(); }, get pendingBackup() { return pendingBackup; } };
}

function money(amount, currency) { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount); }

function downloadBackup(serialized, filename) {
  const url = URL.createObjectURL(new Blob([serialized], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let controller;
export async function initializePortfolioBook(onChange) {
  controller ||= createPortfolioBookController({ onChange });
  return controller.initialize();
}
export function openPortfolioTransactionEditor() { controller?.openTransactionEditor(); }
