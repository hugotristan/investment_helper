import { calculatePortfolioAnalytics } from "../analysis/portfolio-analytics.js";
import { portfolioMoney } from "../shared/portfolio-money.js";
import { formatPercent } from "../shared/format.js";
import { escapeHtml } from "../shared/text.js";

let current = null, view = "holdings", boundSelect = null;
const money = (value, signed = false) => escapeHtml(portfolioMoney(value, "EUR", { signed }));
const percent = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "Unavailable";

export function renderPortfolioAnalytics(holdings, { document: doc = globalThis.document } = {}) {
  const panel = doc?.getElementById("portfolioAnalytics");
  if (!panel) return;
  panel.hidden = !holdings.length || doc.documentElement?.dataset?.privateBlocked === "true";
  if (panel.hidden) { current = null; doc.getElementById("portfolioAnalyticsBody").innerHTML = ""; return; }
  current = calculatePortfolioAnalytics(holdings);
  const select = doc.getElementById("portfolioAllocationView");
  if (boundSelect !== select) {
    boundSelect = select;
    select.value = view;
    select.addEventListener("change", () => {
      view = select.value;
      if (current) renderBody(doc);
    });
  }
  renderBody(doc);
}

function renderBody(doc) {
  const model = current;
  const rows = model.allocations[view] || model.allocations.holdings;
  const allocation = rows.map((row) => `<li>
    <div class="allocation-label"><span>${escapeHtml(row.label)}</span><span>${money(row.value)}${row.missing && row.value !== null ? " known" : ""} <strong>${percent(row.weight)}</strong></span></div>
    <div class="allocation-track" aria-hidden="true">${row.weight === null ? "" : `<span style="width:${(row.weight * 100).toFixed(4)}%"></span>`}</div>
  </li>`).join("");
  const concentration = model.concentration;
  const rankList = (positions, empty) => positions.length ? `<ol class="portfolio-return-list">${positions.map((row) => `<li>
    <span>${escapeHtml(row.ticker)} <small>${escapeHtml(row.currency)}</small></span>
    <span class="${row.gain >= 0 ? "positive" : "negative"}">${escapeHtml(formatPercent(row.returnPercent))}<small>${money(row.gain, true)}</small></span>
  </li>`).join("")}</ol>` : `<p class="data-note">${empty}</p>`;
  const date = (value) => value ? new Date(value).toISOString().slice(0, 10) : "unavailable";
  doc.getElementById("portfolioAnalyticsBody").innerHTML = `
    <div class="portfolio-allocation-heading"><h3>Holdings allocation</h3><span>${model.complete ? "" : "Known value · "}${money(model.knownValue)}</span></div>
    ${!model.complete ? `<p class="data-note">EUR values available for ${model.valuedCount} of ${model.count} positions. Weights and concentration need every position valued. Missing: ${model.missing.map(escapeHtml).join(", ")}.</p>` : ""}
    <ul class="portfolio-allocation" aria-label="Holdings allocation in EUR">${allocation}</ul>
    <p class="data-note">Holdings only; cash excluded. Prices: ${escapeHtml(date(model.oldestPrice))}${date(model.oldestPrice) !== date(model.newestPrice) ? ` to ${escapeHtml(date(model.newestPrice))}` : ""}.</p>
    <div class="portfolio-return-ranks">
      <section><h3>Best performers</h3>${rankList(model.best, model.returnCount ? "No positions with a positive EUR return." : "EUR purchase costs and current values are needed.")}</section>
      <section><h3>Worst performers</h3>${rankList(model.worst, model.returnCount ? "No positions with a negative EUR return." : "EUR purchase costs and current values are needed.")}</section>
    </div>
    <p class="data-note">Ranked by unrealized EUR return on recorded purchase cost, including fees and currency changes. ${model.returnCount} of ${model.count} positions have a comparable return.</p>
    <div class="portfolio-concentration"><h3>Concentration</h3>
      ${concentration ? `<dl>
        <div><dt>Largest position · ${escapeHtml(concentration.largest.ticker)}</dt><dd>${percent(concentration.largest.weight)}</dd></div>
        ${concentration.topCount > 1 ? `<div><dt>Largest ${concentration.topCount} positions combined</dt><dd>${percent(concentration.topWeight)}</dd></div>` : ""}
        ${concentration.largestStock && concentration.largestStock !== concentration.largest ? `<div><dt>Largest individual stock · ${escapeHtml(concentration.largestStock.ticker)}</dt><dd>${percent(concentration.largestStock.weight)}</dd></div>` : ""}
      </dl>` : '<p class="data-note">Complete EUR valuations are needed to calculate concentration.</p>'}
      ${model.hasEtfs ? '<p class="data-note">ETFs count as individual positions. <a href="#report-etf">View partial company exposure ↗</a></p>' : ""}
    </div>`;
}
