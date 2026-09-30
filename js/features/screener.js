import { holdSignalFor, sellSignalFor } from "../analysis/signals.js";
import { scanState } from "../scan-state.js";
import { compactMoney, formatNumber, formatPercent } from "../shared/format.js";
import { clamp } from "../shared/math.js";
import { escapeHtml } from "../shared/text.js";
import { defaults } from "../storage.js";
import { els } from "../ui/dom.js";

export function renderScreener() {
  if (!scanState.latestRankedResults.length) {
    els.screenerResults.innerHTML = `<div class="empty-state">The screener will populate after the first live scan.</div>`;
    return;
  }

  const signal = els.screenerSignal.value || defaults.screenerSignal;
  const minScore = clamp(Number(els.screenerMinScore.value || defaults.screenerMinScore), 0, 100);
  const minLiquidity = Math.max(0, Number(els.screenerMinLiquidity.value || defaults.screenerMinLiquidity)) * 1000000;
  const sort = els.screenerSort.value || defaults.screenerSort;
  const appliesScoreFloor = !["sell", "avoid"].includes(signal);
  const filtered = scanState.latestRankedResults
    .filter((item) => !appliesScoreFloor || item.score >= minScore)
    .filter((item) => item.averageDollarVolume >= minLiquidity || item.isFund)
    .filter((item) => screenerSignalMatches(item, signal))
    .sort((a, b) => sortScreenerResults(a, b, sort))
    .slice(0, 40);
  const top = filtered[0];

  els.screenerResults.innerHTML = `
    <div class="screener-summary">
      <article><span>Matched</span><strong>${filtered.length}/${scanState.latestRankedResults.length}</strong></article>
      <article><span>Top ticker</span><strong>${escapeHtml(top?.ticker || "-")}</strong></article>
      <article><span>Quote data</span><strong>${scanState.latestQuoteSnapshot?.count ? `${scanState.latestQuoteSnapshot.count}/${scanState.latestQuoteSnapshot.total}` : "Chart only"}</strong></article>
      <article><span>Source set</span><strong>${scanState.latestNews?.label ? escapeHtml(scanState.latestNews.label.split(" ")[0]) : "-"}</strong></article>
    </div>
    <div class="screener-table">
      ${filtered.length ? filtered.map((item, index) => renderScreenerRow(item, index)).join("") : `<div class="empty-state">No tickers match these filters. Lower the score or liquidity filter, or choose all scanned tickers.</div>`}
    </div>
  `;
}

function screenerSignalMatches(item, signal) {
  const modelSignal = String(item.setup?.signal || item.label || "").toLowerCase();
  if (signal === "all") return true;
  if (signal === "buy") return item.score >= 62 && !modelSignal.includes("avoid") && !modelSignal.includes("sell");
  if (signal === "hold") return Boolean(holdSignalFor(item)) || modelSignal.includes("hold");
  if (signal === "sell") return Boolean(sellSignalFor(item)) || modelSignal.includes("sell");
  if (signal === "avoid") return modelSignal.includes("avoid") || item.score < 48;
  return item.score >= 58 && !sellSignalFor(item) && !modelSignal.includes("avoid");
}

function sortScreenerResults(a, b, sort) {
  const tie = b.score - a.score || a.ticker.localeCompare(b.ticker);
  if (sort === "momentum") return (b.categories?.momentum || 0) - (a.categories?.momentum || 0) || tie;
  if (sort === "risk") return (b.categories?.risk || 0) - (a.categories?.risk || 0) || tie;
  if (sort === "liquidity") return (b.averageDollarVolume || 0) - (a.averageDollarVolume || 0) || tie;
  if (sort === "volume") return (b.volumePressure || 0) - (a.volumePressure || 0) || tie;
  return tie;
}

function renderScreenerRow(item, index) {
  const quote = item.quote || {};
  const dayRange = quote.dayLow && quote.dayHigh ? `${formatNumber(quote.dayLow)}-${formatNumber(quote.dayHigh)}` : "-";
  const source = quote.price ? "Intraday + chart" : item.source === "sample" ? "Sample fallback" : "Chart";
  return `
    <article class="screener-row ${item.score >= 75 ? "grade-good" : item.score >= 60 ? "grade-watch" : item.score >= 45 ? "grade-mixed" : "grade-avoid"}">
      <div class="rank">${index + 1}</div>
      <div>
        <div class="stock-title">
          <h3><a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</a></h3>
          <span>${item.score}/100</span>
        </div>
        <strong>${escapeHtml(quote.name && quote.name !== item.ticker ? quote.name : item.setup?.signal || item.label)}</strong>
        <div class="stock-stats">
          <span>Price ${escapeHtml(formatNumber(item.latest))}</span>
          <span>Today ${formatPercent(item.oneDay)}</span>
          <span>1M ${formatPercent(item.oneMonth)}</span>
          <span>Day range ${escapeHtml(dayRange)}</span>
          <span>Liquidity ${escapeHtml(compactMoney(item.averageDollarVolume))}</span>
          <span>Source ${escapeHtml(source)}</span>
        </div>
      </div>
      <div>
        <b class="signal-pill">${escapeHtml(item.setup?.signal || item.label)}</b>
        <p>${escapeHtml(item.reasons[0] || item.flags[0] || "No dominant note.")}</p>
        <a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">Open detail</a>
      </div>
    </article>
  `;
}
