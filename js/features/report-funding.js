import { fundingReport } from "../analysis/portfolio-reports.js";
import { getActivePortfolioBook } from "../portfolio-state.js";
import { escapeHtml } from "../shared/text.js";
import { downloadReport } from "../shared/report-export.js";
import { reportElement, reportHtml, reportEmpty, reportTable, euro } from "../shared/report-ui.js";

let current = null, initialized = false;
export function initializeFundingReport() {
  if (initialized || !reportElement("reportFundingBody")) return;
  initialized = true;
  reportElement("reportFundingFilters").addEventListener("submit", (event) => { event.preventDefault(); refreshFundingReport(); });
  reportElement("reportFundingAll").addEventListener("click", () => { reportElement("reportFundingFilters").reset(); refreshFundingReport(); });
  reportElement("reportFundingExport").addEventListener("click", () => {
    if (!current?.rows.length) return;
    downloadReport("funding.csv", ["Month", "Deposits EUR", "Withdrawals EUR", "Net funding EUR", "Starting cash EUR"], current.months.map((row) => [row.month, row.deposits, row.withdrawals, row.net, row.openingCash]));
  });
  refreshFundingReport();
}
export function refreshFundingReport() {
  if (!reportElement("reportFundingBody")) return;
  const book = document.documentElement?.dataset?.privateBlocked === "true" ? null : getActivePortfolioBook();
  current = book ? fundingReport(book, { from: reportElement("reportFundingFrom").value, to: reportElement("reportFundingTo").value }) : null;
  reportElement("reportFundingExport").disabled = !current?.rows.length || !!current.error;
  if (!current || current.error || !current.rows.length) { reportHtml("reportFundingBody", reportEmpty(current?.error || "No funding entries in this period.")); return; }
  const scale = Math.max(1, ...current.months.flatMap((row) => [row.deposits, row.withdrawals]).filter(Number.isFinite));
  const metrics = [["Deposits", current.deposits], ["Withdrawals", current.withdrawals], ["Net funding", current.net], ["Starting cash", current.openingCash]];
  reportHtml("reportFundingBody", `<div class="portfolio-performance-summary">${metrics.map(([label, value]) => `<article><span>${label}</span><strong>${euro(value)}</strong></article>`).join("")}</div>
    ${current.missing ? `<p class="data-note">${current.missing} funding entries lack an actual EUR settlement. Their affected totals are unavailable.</p>` : ""}
    <div class="report-funding-chart" role="img" aria-label="Monthly deposits and withdrawals in EUR"><div class="portfolio-chart-legend"><span>Green: deposits</span><span>Red: withdrawals</span></div>${current.months.map((row) => `<div class="report-funding-row"><span>${escapeHtml(row.month)}</span><div>${[[row.deposits, "gain"], [row.withdrawals, "loss"]].map(([value, type]) => `<i class="${type}" style="width:${Number.isFinite(value) ? (value / scale * 100).toFixed(4) : 0}%"></i>`).join("")}</div><span>${euro(row.net)}</span></div>`).join("")}</div>
    ${reportTable(["Month", "Deposits EUR", "Withdrawals EUR", "Net funding EUR", "Starting cash EUR"], [...current.months].reverse().map((row) => [escapeHtml(row.month), euro(row.deposits), euro(row.withdrawals), euro(row.net), euro(row.openingCash)]), "Recorded funding by month")}`);
}
