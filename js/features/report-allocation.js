import { calculatePortfolioAnalytics } from "../analysis/portfolio-analytics.js";
import { escapeHtml } from "../shared/text.js";
import { downloadReport } from "../shared/report-export.js";
import { reportElement, reportHtml, reportEmpty, reportBars, reportTable, euro, reportPercent } from "../shared/report-ui.js";

let model = null, select = null, button = null;
export function renderAllocationReport(holdings) {
  if (!reportElement("reportAllocationBody")) return;
  model = document.documentElement.dataset.privateBlocked === "true" ? null : calculatePortfolioAnalytics(holdings);
  const input = reportElement("reportAllocationView");
  if (input && input !== select) { select = input; input.addEventListener("change", renderBody); }
  const exportButton = reportElement("reportAllocationExport");
  if (exportButton && button !== exportButton) {
    button = exportButton;
    button.addEventListener("click", () => {
      if (!model?.count) return;
      const rows = model.allocations[select?.value] || model.allocations.holdings;
      downloadReport("allocation.csv", ["Allocation", "Value EUR", "Weight fraction", "Positions", "Missing valuations", "Oldest price date", "Newest price date"],
        rows.map((row) => [row.label, row.value, row.weight, row.count, row.missing, model.oldestPrice, model.newestPrice]));
    });
  }
  renderBody();
}
function renderBody() {
  if (button) button.disabled = !model?.count;
  if (!model?.count) { reportHtml("reportAllocationBody", reportEmpty("Add holdings to see their allocation.")); return; }
  const rows = model.allocations[select?.value] || model.allocations.holdings;
  const dates = model.oldestPrice ? `Prices: ${escapeHtml(model.oldestPrice.slice(0, 10))}${model.newestPrice !== model.oldestPrice ? ` to ${escapeHtml(model.newestPrice.slice(0, 10))}` : ""}.` : "Price dates unavailable.";
  reportHtml("reportAllocationBody", `<p class="report-total">${euro(model.knownValue)} <span>${model.complete ? "holdings value" : `known value · ${model.valuedCount} of ${model.count} valued`}</span></p><p class="data-note">${dates} Cash is excluded.</p>
    ${model.complete ? "" : '<p class="data-note">Allocation percentages need a value for every holding. Known subtotals are shown below.</p>'}
    ${reportBars(rows)}${reportTable(["Allocation", "Value in EUR", "Weight", "Positions", "Missing"], rows.map((row) => [escapeHtml(row.label), euro(row.value), reportPercent(row.weight), String(row.count), String(row.missing)]), "Current holdings allocation")}`);
}
