import { holdSignalFor, sellSignalFor } from "../analysis/signals.js";
import { scanState } from "../scan-state.js";
import { formatNumber, formatPercent } from "../shared/format.js";
import { clamp } from "../shared/math.js";
import { parseTickers } from "../shared/symbols.js";
import { escapeHtml } from "../shared/text.js";
import { defaults, state } from "../storage.js";
import { els } from "../ui/dom.js";

export function renderScreener() {
  if (!scanState.latestRankedResults.length) {
    els.screenerResults.innerHTML = `<div class="empty-state">Waiting for watchlist prices.</div>`;
    return;
  }

  const signal = els.screenerSignal.value || defaults.screenerSignal;
  const minScore = clamp(Number(els.screenerMinScore.value || defaults.screenerMinScore), 0, 100);
  const minLiquidity = Math.max(0, Number(els.screenerMinLiquidity.value || defaults.screenerMinLiquidity)) * 1000000;
  const sort = els.screenerSort.value || defaults.screenerSort;
  const appliesScoreFloor = !["sell", "avoid"].includes(signal);
  const watched = new Set(parseTickers(state.tickerInput));
  const results = scanState.latestRankedResults.filter((item) => watched.has(item.ticker));
  const matches = results
    .filter((item) => item.dataQuality?.eligible && Number.isFinite(item.score))
    .filter((item) => !appliesScoreFloor || item.score >= minScore)
    .filter((item) => minLiquidity === 0 || item.averageDollarVolume >= minLiquidity || item.isFund)
    .filter((item) => screenerSignalMatches(item, signal))
    .sort((a, b) => sortScreenerResults(a, b, sort));
  const filtered = matches.slice(0, 40);
  const remaining = matches.slice(40);
  const unavailable = results.filter((item) => !item.dataQuality?.eligible);
  const returned = new Set(results.map((item) => item.ticker));
  const missing = [...watched].filter((ticker) => !returned.has(ticker));
  const filterNotes = [signal !== "all" ? `Signal: ${signal}` : "", minScore > 0 ? `Score ≥ ${minScore}` : "",
    minLiquidity > 0 ? `Daily traded value ≥ ${compactValue(minLiquidity)}` : ""].filter(Boolean);
  const summary = document.querySelector("#watchlistFilters > summary");
  if (summary) summary.textContent = filterNotes.length ? `Filters · ${filterNotes.join(" · ")}` : "Filters";

  els.screenerResults.innerHTML = `
    <p class="data-note">${matches.length} of ${watched.size} watched${filterNotes.length ? ` · ${escapeHtml(filterNotes.join(" · "))}` : ""}</p>
    ${unavailable.length || missing.length ? `<details class="secondary-details data-gaps"><summary>Unavailable prices (${unavailable.length + missing.length})</summary><ul>${unavailable.map((item) => `<li><strong>${escapeHtml(item.ticker)}</strong> — ${escapeHtml(item.dataQuality?.reason || "Price history unavailable")}</li>`).join("")}${missing.map((ticker) => `<li><strong>${escapeHtml(ticker)}</strong> — Not returned in the current scan.</li>`).join("")}</ul></details>` : ""}
    <div class="scan-list">
      ${filtered.length ? `${scanListHeading()}${filtered.map((item) => renderScanRow(item)).join("")}` : `<div class="empty-state">${watched.size ? "No watchlist symbols match these filters." : "Add a stock or ETF to your watchlist."}</div>`}
    </div>
    ${remaining.length ? `<details class="secondary-details"><summary>More stocks (${remaining.length})</summary><div class="scan-list">${scanListHeading()}${remaining.map((item) => renderScanRow(item)).join("")}</div></details>` : ""}
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

export function scanListHeading() {
  return '<div class="scan-list-head" aria-hidden="true"><span>Symbol</span><span>Signal</span><span>Price</span><span>1D</span><span>Score</span></div>';
}

export function renderScanRow(item, { showDetails = true } = {}) {
  const quote = item.quote || {};
  const currency = item.currency || quote.currency || "";
  const date = new Date(item.dataQuality?.asOf || "");
  const asOf = Number.isFinite(date.getTime()) ? date.toLocaleDateString() : "Date unavailable";
  const observed = new Date(quote.quoteTime || item.dataQuality?.asOf || "");
  const priceAsOf = Number.isFinite(observed.getTime()) ? observed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable";
  return `
    <article class="scan-list-row">
      <div class="scan-symbol"><a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</a>${quote.name && quote.name !== item.ticker ? `<small>${escapeHtml(quote.name)}</small>` : ""}</div>
      <span class="scan-signal" data-label="Signal">${escapeHtml(item.setup?.signal || item.label)}</span>
      <strong data-label="Price" title="${escapeHtml(`${quote.source || item.source || "Daily close"} · ${priceAsOf}`)}">${escapeHtml(formatNumber(item.latest))} ${escapeHtml(currency)}</strong>
      <span class="${item.oneDay > 0 ? "positive" : item.oneDay < 0 ? "negative" : ""}" data-label="1D">${formatPercent(item.oneDay)}</span>
      <span data-label="Score">${item.score}/100</span>
      ${showDetails ? `<details class="secondary-details scan-row-details"><summary>Checks</summary>
        <dl class="key-values"><div><dt>Price as of</dt><dd>${escapeHtml(priceAsOf)} · ${escapeHtml(quote.source || item.source || "Daily close")}</dd></div>
        <div><dt>History as of</dt><dd>${escapeHtml(asOf)}</dd></div>
        <div><dt>1M / 6M</dt><dd>${formatPercent(item.oneMonth)} / ${formatPercent(item.sixMonth)}</dd></div>
        <div><dt>Daily traded value</dt><dd>${escapeHtml(compactValue(item.averageDollarVolume))} ${escapeHtml(item.currency || "")}</dd></div>
        <div><dt>Risk</dt><dd>${escapeHtml(item.setup?.riskLevel || "Unavailable")}</dd></div></dl>
        ${item.reasons?.[0] ? `<p>${escapeHtml(item.reasons[0])}</p>` : ""}
      </details>` : ""}
    </article>
  `;
}

function compactValue(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value) : "Unavailable";
}
