import { transactionReport, TRANSACTION_LABELS } from "../analysis/portfolio-reports.js";
import { getActivePortfolioBook } from "../portfolio-state.js";
import { escapeHtml } from "../shared/text.js";
import { portfolioMoney } from "../shared/portfolio-money.js";
import { downloadReport } from "../shared/report-export.js";
import { reportElement, reportHtml, reportEmpty, reportTable } from "../shared/report-ui.js";

let current = null, page = 0, initialized = false;
const PAGE_SIZE = 50;
export function initializeTransactionReport() {
  if (initialized || !reportElement("reportTransactionsBody")) return;
  initialized = true;
  reportElement("reportTransactionsFilters").addEventListener("submit", (event) => { event.preventDefault(); refreshTransactionReport(); });
  reportElement("reportTransactionsReset").addEventListener("click", () => { reportElement("reportTransactionsFilters").reset(); refreshTransactionReport(); });
  reportElement("reportTransactionsPrevious").addEventListener("click", () => { page = Math.max(0, page - 1); render(); });
  reportElement("reportTransactionsNext").addEventListener("click", () => { page++; render(); });
  reportElement("reportTransactionsExport").addEventListener("click", () => {
    if (!current?.rows.length) return;
    downloadReport("transactions.csv", ["Date", "Type", "Ticker", "Currency", "Quantity", "Price", "Gross amount", "Fee", "Cash currency", "Net cash movement", "Recorded EUR movement", "Note", "ID"],
      current.rows.map((row) => [row.date, TRANSACTION_LABELS[row.type], row.ticker, row.currency, row.quantity, row.price, row.amount, row.fee || 0, row.cash.currency, row.cash.amount, row.cash.eurAmount, row.note, row.id]));
  });
  refreshTransactionReport();
}
export function refreshTransactionReport() {
  if (!reportElement("reportTransactionsBody")) return;
  const book = document.documentElement.dataset.privateBlocked === "true" ? null : getActivePortfolioBook();
  current = book ? transactionReport(book, { from: reportElement("reportTransactionsFrom").value,
    to: reportElement("reportTransactionsTo").value, type: reportElement("reportTransactionsType").value, search: reportElement("reportTransactionsSearch").value }) : null;
  page = 0; render();
}
function render() {
  const rows = current?.rows || [];
  reportElement("reportTransactionsExport").disabled = !rows.length || !!current?.error;
  reportElement("reportTransactionsPagination").hidden = rows.length <= PAGE_SIZE;
  if (!rows.length || current?.error) { reportHtml("reportTransactionsBody", reportEmpty(current?.error || "No transactions match these filters.")); return; }
  page = Math.max(0, Math.min(page, Math.ceil(rows.length / PAGE_SIZE) - 1));
  reportElement("reportTransactionsPrevious").disabled = page === 0;
  reportElement("reportTransactionsNext").disabled = (page + 1) * PAGE_SIZE >= rows.length;
  reportElement("reportTransactionsPage").textContent = `Page ${page + 1} of ${Math.ceil(rows.length / PAGE_SIZE)}`;
  const nativeMoney = (row, value) => {
    const net = row.amount + (row.type === "buy" ? row.fee || 0 : row.type === "sell" ? -(row.fee || 0) : 0);
    const eurValue = row.currency === "EUR" ? value : row.cash.currency === "EUR" && net > 0 ? value * Math.abs(row.cash.amount) / net : null;
    return escapeHtml(portfolioMoney(value, row.currency, { eurValue }));
  };
  reportHtml("reportTransactionsBody", `<p class="data-note">${rows.length} matching transactions. CSV includes every matching row. EUR cash is the recorded settlement; EUR estimates beside USD prices and fees use its conversion ratio.</p>${reportTable(["Date", "Type", "Ticker", "Quantity", "Price", "Gross amount", "Fee", "Net cash movement", "Note"], rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row) => [escapeHtml(row.date), escapeHtml(TRANSACTION_LABELS[row.type]), escapeHtml(row.ticker || "—"), row.quantity === undefined ? "—" : escapeHtml(row.quantity), row.price === undefined ? "—" : nativeMoney(row, row.price), nativeMoney(row, row.amount), nativeMoney(row, row.fee || 0), escapeHtml(portfolioMoney(row.cash.amount, row.cash.currency, { eurValue: row.cash.eurAmount })), escapeHtml(row.note || "—")]), "Recorded transactions · latest first")}`);
}
