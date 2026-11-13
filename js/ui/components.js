import {assessDataConfidence} from "../analysis/data-confidence.js";
import { clamp } from "../shared/math.js";
import { escapeHtml } from "../shared/text.js";

export function renderCategoryBars(categories = {}) {
  const rows = [
    ["Trend", categories.trend],
    ["Momentum", categories.momentum],
    ["Oscillators / ATR", categories.technical],
    ["News context (not scored)", categories.news],
    ["Recent outlook context (not scored)", categories.recentYear],
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

export function renderDataConfidence(item,{financial=null,now=Date.now(),compact=false}={}) {
  const data = assessDataConfidence(item,{financial,now});
  const title = [data.meaning,...data.missing].join(' ');
  if (compact) return '<small class="data-confidence" title="'+escapeHtml(title)+'">Data Confidence: '+escapeHtml(data.label)+' · '+data.value+'/100'+(data.financials==='not_checked'?' · financials not checked':'')+'</small>';
  return '<section class="data-confidence-panel"><h3>Data Confidence · '+escapeHtml(data.label)+' · '+data.value+'/100</h3><p>'+escapeHtml(data.meaning)+'</p>'
    +'<details><summary>Evidence quality and missing inputs</summary><ul>'+data.components.map(part=>'<li>'+escapeHtml(part.name)+': '+Math.round(part.value*100)+'/100 evidence quality</li>').join('')+'</ul>'
    +(data.missing.length?'<ul>'+data.missing.map(reason=>'<li>'+escapeHtml(reason)+'</li>').join('')+'</ul>':'<p>All assessed inputs have current, recognized provenance.</p>')
    +(data.financials==='not_applicable'?'<p>Company financial ratios are not applicable to ETF units. Fund diversification is not inferred from the ETF label.</p>':'')+'</details></section>';
}
