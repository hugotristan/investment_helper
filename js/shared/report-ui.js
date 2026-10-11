import { escapeHtml } from "./text.js";
import { portfolioMoney } from "./portfolio-money.js";

export const reportElement = (id) => globalThis.document?.getElementById(id);
export const reportHtml = (id, html) => { const node = reportElement(id); if (node) node.innerHTML = html; };
export const euro = (value) => escapeHtml(portfolioMoney(value, "EUR"));
export const reportPercent = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "Unavailable";
export const reportEmpty = (text = "Record transactions in Portfolio to use this report.") => `<p class="empty-state">${escapeHtml(text)} <a href="#portfolio">Open Portfolio ↗</a></p>`;
export function reportTable(headers, rows, caption) {
  return `<div class="portfolio-performance-table-wrap" tabindex="0" aria-label="${escapeHtml(caption)}, scroll for all columns"><table class="portfolio-performance-table"><caption>${escapeHtml(caption)}</caption><thead><tr>${headers.map((head) => `<th scope="col">${escapeHtml(head)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, index) => `<${index ? "td" : 'th scope="row"'}>${cell}</${index ? "td" : "th"}>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
export function reportBars(rows) {
  return `<ol class="portfolio-allocation-list">${rows.map((row) => `<li><div class="allocation-label"><span>${escapeHtml(row.label)}</span><span>${euro(row.value)} · ${reportPercent(row.weight)}</span></div><div class="allocation-track" aria-hidden="true">${Number.isFinite(row.weight) ? `<span style="width:${Math.min(100, Math.max(0, row.weight * 100)).toFixed(4)}%"></span>` : ""}</div></li>`).join("")}</ol>`;
}
