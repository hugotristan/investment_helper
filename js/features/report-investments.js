import { subscribePortfolioPerformance } from "./portfolio-performance.js";
import { getActivePortfolioBook } from "../portfolio-state.js";
import { positionOrganization } from "../analysis/portfolio-organization.js";
import { escapeHtml } from "../shared/text.js";
import { downloadReport } from "../shared/report-export.js";
import { reportElement, reportHtml, reportEmpty, reportTable, euro, reportPercent } from "../shared/report-ui.js";

let report = null, selected = "", initialized = false, optionSignature = "";
const identity = (row) => `${row.ticker}|${row.currency}`;
const gain = (row) => Number.isFinite(row.realizedGain) && Number.isFinite(row.unrealizedGain) ? row.realizedGain + row.unrealizedGain : null;
export function initializeInvestmentReport() {
  if (initialized || !reportElement("reportInvestmentBody")) return;
  initialized = true;
  reportElement("reportInvestmentSelect").addEventListener("change", (event) => { selected = event.target.value; render(); });
  reportElement("reportInvestmentExport").addEventListener("click", () => {
    if (!report?.holdings?.length) return;
    downloadReport("investment-performance.csv", ["Ticker", "Currency", "Shares", "Remaining cost EUR", "Value EUR", "Realized gain EUR", "Unrealized gain EUR", "Capital gain EUR", "As of", "Foreign opening cost estimated"],
      report.holdings.map((row) => [row.ticker, row.currency, row.shares, row.costBasis, row.currentValue, row.realizedGain, row.unrealizedGain, gain(row), report.endDate, report.methodology?.openingCostEstimated ? "See calculation notes" : "No"]));
  });
  subscribePortfolioPerformance((value) => { report = value; render(); });
  globalThis.window?.addEventListener("hashchange", render);
}
function render() {
  if (!initialized) return;
  if (!getActivePortfolioBook() || document.documentElement?.dataset?.privateBlocked === "true") report = null;
  const rows = report?.holdings || [];
  const input = reportElement("reportInvestmentSelect");
  reportElement("reportInvestmentExport").disabled = !rows.length;
  if (!rows.length) { input.innerHTML = ""; optionSignature = ""; reportHtml("reportInvestmentBody", reportEmpty("Investment gains are waiting for recorded history.")); return; }
  if (!rows.some((row) => identity(row) === selected)) selected = identity(rows[0]);
  const sorted = [...rows].sort((a, b) => identity(a).localeCompare(identity(b)));
  const signature = sorted.map((row) => `${identity(row)}:${row.shares === 0}`).join(",");
  if (signature !== optionSignature) {
    input.innerHTML = sorted.map((row) => `<option value="${escapeHtml(identity(row))}">${escapeHtml(row.ticker)} · ${escapeHtml(row.currency)}${row.shares === 0 ? " · Sold" : ""}</option>`).join("");
    optionSignature = signature;
  }
  input.value = selected;
  const row = rows.find((row) => identity(row) === selected);
  const annotation = positionOrganization(getActivePortfolioBook()?.organization, row);
  const metrics = [["Remaining value", row.currentValue], ["Realized gain", row.realizedGain], ["Unrealized gain", row.unrealizedGain], ["Capital gain", gain(row)]];
  const scale = Math.max(1, ...[row.realizedGain, row.unrealizedGain].filter(Number.isFinite).map(Math.abs));
  reportHtml("reportInvestmentBody", `<p class="data-note">Gains through ${escapeHtml(report.endDate)} · ${row.shares === 0 ? "sold position" : `${escapeHtml(row.shares)} shares remaining`}. EUR cost includes recorded trade fees and currency changes. Cash dividends are excluded from capital gain.</p>
    <div class="portfolio-performance-summary">${metrics.map(([label, value]) => `<article><span>${label}</span><strong>${euro(value)}</strong></article>`).join("")}</div>
    <div class="report-gain-chart" role="img" aria-label="Realized and unrealized gains in EUR">${metrics.slice(1, 3).map(([label, value]) => `<div><span>${label}</span><div class="report-gain-track"><i style="${value < 0 ? "right:50%" : "left:50%"};width:${Number.isFinite(value) ? (Math.abs(value) / scale * 50).toFixed(4) : 0}%" class="${value < 0 ? "loss" : "gain"}"></i></div><strong>${euro(value)}</strong></div>`).join("")}</div>
    <p class="data-note">Remaining EUR cost: ${euro(row.costBasis)} · unrealized return on remaining cost: ${reportPercent(row.costBasis > 0 && Number.isFinite(row.unrealizedGain) ? row.unrealizedGain / row.costBasis : null)}.</p>
    ${annotation.note ? `<details class="secondary-details"><summary>Position note</summary><p class="position-note">${escapeHtml(annotation.note)}</p></details>` : ""}
    ${(report.reasons || []).length ? `<details class="secondary-details"><summary>Calculation notes</summary><ul>${report.reasons.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul></details>` : ""}
    ${report.methodology?.openingCostEstimated ? '<p class="data-note">Foreign opening-position cost is estimated using the tracking start-date rate.</p>' : ""}
    ${reportTable(["Investment", "Shares", "Value EUR", "Realized EUR", "Unrealized EUR", "Capital gain EUR"], [...rows].sort((a, b) => (b.currentValue ?? -1) - (a.currentValue ?? -1)).map((holding) => [escapeHtml(`${holding.ticker} · ${holding.currency}${holding.shares === 0 ? " · Sold" : ""}`), escapeHtml(holding.shares), euro(holding.currentValue), euro(holding.realizedGain), euro(holding.unrealizedGain), euro(gain(holding))]), "All investments · includes sold positions")}`);
}
