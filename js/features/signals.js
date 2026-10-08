import { buildSellGuidance } from "../analysis/signals.js";
import { escapeHtml } from "../shared/text.js";
import { els } from "../ui/dom.js";

export function renderSellGuidance(results, priceSource) {
  const guidance = buildSellGuidance(results);
  const sourceWarning = priceSource === "sample"
    ? `<p class="data-note">Sample prices cannot support sell or hold signals.</p>`
    : `<p class="data-note">Rule-based signals from qualified price history and matched articles. Scores measure model strength, not the chance of a return.</p>`;

  els.sellGuidance.innerHTML = `
    ${sourceWarning}
    <div class="sell-grid">
      <article class="sell-column sell-column-danger">
        <div class="sell-column-head">
          <span>Sell / review signals</span>
          <strong>${guidance.sell.length}</strong>
        </div>
        ${guidance.sell.length ? guidance.sell.map(renderSellItem).join("") : `<div class="empty-state">No sell or review rules triggered.</div>`}
      </article>
      <article class="sell-column sell-column-hold">
        <div class="sell-column-head">
          <span>Hold signals</span>
          <strong>${guidance.hold.length}</strong>
        </div>
        ${guidance.hold.length ? guidance.hold.map(renderSellItem).join("") : `<div class="empty-state">No hold rules triggered.</div>`}
      </article>
    </div>
  `;
}

function renderSellItem(item) {
  return `
    <div class="sell-item ${item.className}">
      <div>
        <span>${escapeHtml(item.label)}</span>
        <strong><a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</a></strong>
      </div>
      <b>${item.score}/100</b>
      <p>${escapeHtml(item.reason)}</p>
      ${item.detail ? `<details class="secondary-details"><summary>Other checks</summary><p>${escapeHtml(item.detail)}</p></details>` : ""}
    </div>
  `;
}
