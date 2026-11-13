import { buildSellGuidance } from "../analysis/signals.js";
import { escapeHtml } from "../shared/text.js";
import { els } from "../ui/dom.js";

export function renderSellGuidance(results, priceSource) {
  const guidance = buildSellGuidance(results);
  const sourceWarning = priceSource === "sample"
    ? `<p class="data-note">Sample prices cannot support technical signals.</p>`
    : `<p class="data-note">Technical Score v2 uses completed daily observations. Recent news is a separate risk check; technical strength does not establish undervaluation. Data Confidence measures evidence quality, not the chance of a return.</p>`;

  els.sellGuidance.innerHTML = `
    ${sourceWarning}
    <div class="sell-grid">
      <article class="sell-column sell-column-danger">
        <div class="sell-column-head">
          <span>Technical risk review</span>
          <strong>${guidance.sell.length}</strong>
        </div>
        ${guidance.sell.length ? guidance.sell.map(renderSellItem).join("") : `<div class="empty-state">No technical risk-review rules triggered.</div>`}
      </article>
      <article class="sell-column sell-column-hold">
        <div class="sell-column-head">
          <span>Constructive technical conditions</span>
          <strong>${guidance.hold.length}</strong>
        </div>
        ${guidance.hold.length ? guidance.hold.map(renderSellItem).join("") : `<div class="empty-state">No constructive technical conditions identified.</div>`}
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
      <b>Technical Score v2 · ${item.score}/100</b>
      <p>${escapeHtml(item.reason)}</p>
      ${item.detail ? `<details class="secondary-details"><summary>Other checks</summary><p>${escapeHtml(item.detail)}</p></details>` : ""}
    </div>
  `;
}
