import { clamp } from "../shared/math.js";
import { escapeHtml } from "../shared/text.js";

export function renderCategoryBars(categories = {}) {
  const rows = [
    ["Trend", categories.trend],
    ["Momentum", categories.momentum],
    ["Technical", categories.technical],
    ["News", categories.news],
    ["Recent year", categories.recentYear],
    ["Liquidity", categories.liquidity],
    ["Risk control", categories.risk]
  ].filter(([, value]) => Number.isFinite(value));
  return `
    <div class="score-breakdown">
      ${rows.map(([label, value]) => `
        <div>
          <span>${escapeHtml(label)}</span>
          <strong>${Math.round(value)}</strong>
          <i style="width: ${clamp(value, 0, 100)}%"></i>
        </div>
      `).join("")}
    </div>
  `;
}
