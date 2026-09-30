import { buildSellGuidance } from "../analysis/signals.js";
import { escapeHtml } from "../shared/text.js";
import { els } from "../ui/dom.js";

export function renderSellGuidance(results, priceSource) {
  const guidance = buildSellGuidance(results);
  const sourceWarning = priceSource === "sample"
    ? `<p class="data-note">Price data fell back to sample data, so the sell/hold model is disabled for action.</p>`
    : `<p class="data-note">Sell/hold signals use the same live market, headline, outlook, volatility, trend, and local scan-change model. This is not an order ticket.</p>`;

  els.sellGuidance.innerHTML = `
    ${sourceWarning}
    <div class="sell-grid">
      <article class="sell-column sell-column-danger">
        <div class="sell-column-head">
          <span>Sell / reduce now</span>
          <strong>${guidance.sell.length}</strong>
        </div>
        ${guidance.sell.length ? guidance.sell.map(renderSellItem).join("") : `<div class="empty-state">No strong sell/reduce signal in the current watchlist.</div>`}
      </article>
      <article class="sell-column sell-column-hold">
        <div class="sell-column-head">
          <span>Do not sell / hold</span>
          <strong>${guidance.hold.length}</strong>
        </div>
        ${guidance.hold.length ? guidance.hold.map(renderSellItem).join("") : `<div class="empty-state">No high-conviction hold signal. Treat the rest as watch/rebalance candidates.</div>`}
      </article>
    </div>
  `;
}

function renderSellItem(item) {
  return `
    <div class="sell-item ${item.className}">
      <div>
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.ticker)}</strong>
      </div>
      <b>${item.score}/100</b>
      <p>${escapeHtml(item.reason)} ${escapeHtml(item.detail || "")}</p>
    </div>
  `;
}
