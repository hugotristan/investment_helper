import { calculatePortfolioAnalytics } from "../analysis/portfolio-analytics.js";
import { calculateEtfExposure } from "../analysis/etf-exposure.js";
import { escapeHtml } from "../shared/text.js";
import { downloadReport } from "../shared/report-export.js";
import { reportElement, reportHtml, reportEmpty, reportTable, reportBars, euro, reportPercent } from "../shared/report-ui.js";

let current = null, button = null;
export function renderEtfReport(holdings) {
  if (!reportElement("reportEtfBody")) return;
  current = document.documentElement.dataset.privateBlocked === "true" ? null : calculateEtfExposure(calculatePortfolioAnalytics(holdings));
  const exportButton = reportElement("reportEtfExport");
  if (button !== exportButton) {
    button = exportButton;
    button.addEventListener("click", () => {
      if (!current?.rows.length) return;
      downloadReport("etf-exposure.csv", ["Company", "Direct EUR", "Estimated ETF EUR", "Known combined EUR", "Known weight fraction", "Fund and weight date"],
        [...current.rows.map((row) => [row.name, row.direct, row.indirect, row.value, row.weight, row.sources.join("; ")]), ["Unreported ETF constituents", null, current.unreported, current.unreported, current.unreportedWeight, "Not assigned to companies"]]);
    });
  }
  button.disabled = !current?.hasEtfs || !current.rows.length;
  if (!current?.hasEtfs) { reportHtml("reportEtfBody", reportEmpty("No ETF holdings are recorded.")); return; }
  const sources = current.reports.map((fund) => `<li><strong>${escapeHtml(fund.ticker)}</strong> · top ten securities cover ${reportPercent(fund.coverage)} of the fund · weights dated ${escapeHtml(fund.asOf)} (${fund.ageDays} days old). <a href="${escapeHtml(fund.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(fund.source)} ↗</a></li>`).join("");
  reportHtml("reportEtfBody", `<p class="data-note">Company exposure combines your direct holdings with current ETF values multiplied by published fund weights. This is a partial estimate; weights can change between reports. Cash is excluded.</p><ul class="data-note">${sources}</ul>
    ${current.missingFunds.length ? `<p class="data-note">No verified holdings dataset for ${escapeHtml(current.missingFunds.join(", "))}.</p>` : ""}
    ${current.missingValue ? '<p class="data-note">Some holdings have no current EUR value. Weights and complete totals are unavailable.</p>' : ""}
    <p class="report-total">${euro(current.unreported)} <span>ETF value not assigned to a company</span></p>
    ${reportBars(current.rows.slice(0, 12).map((row) => ({ ...row, label: row.name })))}
    ${reportTable(["Company", "Direct EUR", "Via ETFs · estimate EUR", "Known combined EUR", "Known weight"], current.rows.map((row) => [escapeHtml(row.name), euro(row.direct), euro(row.indirect), euro(row.value), reportPercent(row.weight)]), "Known company exposure · Alphabet classes and TSMC share / ADR exposure are combined")}`);
}
