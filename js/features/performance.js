import { calculateHoldings } from "../analysis/holdings.js";
import { buildOpportunities } from "../analysis/opportunities.js";
import { observeRecommendations, recordRecommendations as buildRecordedEntries } from "../analysis/recommendations.js";
import { loadRecommendationJournal, saveRecommendationJournal } from "../data/recommendation-store.js";
import { formatPercent } from "../shared/format.js";
import { escapeHtml } from "../shared/text.js";
import { getPortfolioHoldings } from "./portfolio.js";

const boundExports = new WeakSet();
let latestReport = null;
let lastRecordStatus = "";

export function initializePerformance() {
  const button = element("exportRecommendations");
  if (button && !boundExports.has(button)) {
    button.addEventListener("click", exportRecommendations);
    boundExports.add(button);
  }
  renderPerformance();
}

export function getRecommendationTickers() {
  return [...new Set(loadRecommendationJournal().entries.map((entry) => entry.ticker))];
}

// This hook is called only after a complete fresh scan. Restoring a cache and
// opening the Performance page never create or persist recommendation records.
export function recordRecommendations(results, marketContext, { now = Date.now() } = {}) {
  const stored = loadRecommendationJournal();
  if (!stored.ok) { lastRecordStatus = stored.error; renderPerformance(results); return stored; }
  const portfolio = calculateHoldings(getPortfolioHoldings(), results, { now });
  const selection = buildOpportunities(results, marketContext, { now, holdings: portfolio.holdings.map((holding) => ({
    ticker: holding.ticker, currency: holding.currency,
    weight: portfolio.groups.find((group) => group.currency === holding.currency)?.complete ? holding.weight : null
  })) });
  const observed = observeRecommendations(stored.entries, results, { now });
  const candidates = selection.candidates.map((candidate) => ({ ...candidate, name: candidate.quote?.name || candidate.name || candidate.ticker }));
  const next = buildRecordedEntries(observed.entries, candidates, results, { now, complete: true, fresh: true });
  const saved = saveRecommendationJournal(next);
  if (!saved.ok) lastRecordStatus = saved.error;
  else {
    const existingIds = new Set(stored.entries.map((entry) => entry.id));
    const added = next.filter((entry) => !existingIds.has(entry.id)).length;
    const date = new Date(now).toISOString().slice(0, 10);
    const untracked = candidates.some((candidate) => !existingIds.has(`${candidate.ticker}|${date}`));
    lastRecordStatus = added ? `${added} new forward-tracking record${added === 1 ? "" : "s"} saved. Original signals and evidence stay frozen.`
      : untracked ? "Picks need matching dated stock and SPY baseline prices in the same currency before tracking can start."
        : candidates.length ? "Today's qualified picks are already recorded. Their original signals stay frozen."
          : selection.reason;
  }
  renderPerformance(results);
  return saved;
}

export function renderPerformance(results = []) {
  const stored = loadRecommendationJournal();
  latestReport = observeRecommendations(stored.entries, results);
  const entries = latestReport.entries;
  const outcomes = entries.flatMap((entry) => [entry.outcomes["5"], entry.outcomes["21"]]);
  const counts = [
    ["Completed outcomes", outcomes.filter((outcome) => outcome.status === "matured").length, "Observed after 5 or 21 matched sessions"],
    ["Pending outcomes", outcomes.filter((outcome) => outcome.status === "pending").length, "Waiting for later settled daily prices"],
    ["Unavailable outcomes", outcomes.filter((outcome) => outcome.status === "unavailable").length, "Missing qualified comparison data"]
  ];
  setHtml("performanceSummary", counts.map(([label, value, note]) => `<article class="performance-metric"><span>${escapeHtml(label)}</span><strong>${value}</strong><small>${escapeHtml(note)}</small></article>`).join(""));
  const empty = element("performanceEmpty");
  if (empty) empty.hidden = entries.length > 0;
  const exportButton = element("exportRecommendations");
  if (exportButton) exportButton.disabled = !stored.entries.length;
  const description = entries.length
    ? `${entries.length} saved record${entries.length === 1 ? "" : "s"}. Average excess vs SPY: 5 sessions ${excessLabel(latestReport.summary.averageExcess5)} (${latestReport.summary.matured5} completed), 21 sessions ${excessLabel(latestReport.summary.averageExcess21)} (${latestReport.summary.matured21} completed). Overlapping daily picks are correlated; averages are descriptive, not success probabilities.`
    : "Tracking starts with future qualified picks. Historical picks are not reconstructed from today's data.";
  const status = element("performanceStatus");
  if (status) status.textContent = `${!stored.ok ? `${stored.error} ` : lastRecordStatus ? `${lastRecordStatus} ` : ""}${description}`;
  setHtml("performanceTable", entries.length ? `<div class="performance-table-wrap" tabindex="0" aria-label="Recommendation price returns table, scroll horizontally for all columns">
    <table class="performance-table"><thead><tr><th scope="col">Recorded signal</th><th scope="col">5-session stock</th><th scope="col">SPY</th><th scope="col">Excess (pp)</th><th scope="col">21-session stock</th><th scope="col">SPY</th><th scope="col">Excess (pp)</th><th scope="col">Frozen evidence</th></tr></thead>
    <tbody>${[...entries].reverse().map(renderRecord).join("")}</tbody></table></div>` : "");
}

function renderRecord(entry) {
  return `<tr><td class="performance-record"><a href="#detail" data-detail-ticker="${escapeHtml(entry.ticker)}">${escapeHtml(entry.ticker)}</a>
    <small>${escapeHtml(dateLabel(entry.recordedAt))} · ${escapeHtml(entry.score)}/100</small>
    <small>Baseline ${escapeHtml(priceLabel(entry.baseline.price))} ${escapeHtml(entry.currency)} · as of ${escapeHtml(dateLabel(entry.baseline.asOf))}</small></td>
    ${outcomeCells(entry.outcomes["5"])}${outcomeCells(entry.outcomes["21"])}
    <td>${renderFrozenEvidence(entry)}</td></tr>`;
}

function outcomeCells(outcome) {
  if (outcome.status !== "matured") {
    return `<td class="return-cell"><span class="performance-status is-${outcome.status}">${outcome.status === "pending" ? "Pending" : "Unavailable"}</span>
      <small>${escapeHtml(outcome.reason || "Comparison data pending")}</small></td><td class="return-cell">—</td><td class="return-cell">—</td>`;
  }
  return `<td class="return-cell ${returnClass(outcome.stockReturn)}">${escapeHtml(returnLabel(outcome.stockReturn))}<small>Observed ${escapeHtml(dateLabel(outcome.asOf))}</small></td>
    <td class="return-cell ${returnClass(outcome.benchmarkReturn)}">${escapeHtml(returnLabel(outcome.benchmarkReturn))}</td>
    <td class="return-cell ${returnClass(outcome.excessReturn)}">${escapeHtml(excessLabel(outcome.excessReturn))}</td>`;
}

function renderFrozenEvidence(entry) {
  return `<details class="performance-evidence"><summary>Signal &amp; evidence (${entry.evidence.length})</summary>
    <p>${escapeHtml(entry.name || entry.ticker)} · ${escapeHtml(entry.signal || "Research signal")} · ${escapeHtml(entry.horizon || "Timeframe not specified")}</p>
    <p>Recorded ${escapeHtml(dateLabel(entry.recordedAt))}. Invalidation ${Number.isFinite(entry.invalidation) ? `${escapeHtml(priceLabel(entry.invalidation))} ${escapeHtml(entry.currency)}` : "unavailable"}.</p>
    <strong>Original reasons</strong><ul>${entry.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
    <strong>Original risks</strong><ul>${entry.risks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}</ul>
    ${entry.evidence.map((article) => `<div class="performance-source">${sourceLink(article.link, article.title)}<small>${escapeHtml(article.source || "Linked source")} · Published ${escapeHtml(dateLabel(article.pubDate))}</small></div>`).join("")}</details>`;
}

function exportRecommendations() {
  const stored = loadRecommendationJournal();
  if (!stored.ok || !stored.entries.length) return;
  try {
    const payload = { schemaVersion: 1, exportedAt: new Date().toISOString(), journal: { schemaVersion: 1, entries: stored.entries },
      observedReport: latestReport || { entries: stored.entries },
      method: "Prospective observed price returns after 5/21 matching settled stock/SPY sessions; fees, dividends, and FX excluded. Overlapping picks are correlated." };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `investment-helper-recommendations-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    const status = element("performanceStatus");
    if (status) status.textContent = "The journal could not be exported. Your stored records remain unchanged.";
  }
}

function sourceLink(value, title) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol)) return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`;
  } catch { /* Keep the original title readable if its link is unavailable. */ }
  return `<span>${escapeHtml(title)}</span>`;
}

function returnClass(value) { return value > 0 ? "change-positive" : value < 0 ? "change-negative" : "change-neutral"; }
function returnLabel(value) { return Number.isFinite(value) ? formatPercent(value) : "No completed outcome"; }
function excessLabel(value) { return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} pp` : "No completed outcome"; }
function priceLabel(value) { return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value); }
function dateLabel(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable";
}
function element(id) { return document.getElementById(id); }
function setHtml(id, html) { const target = element(id); if (target) target.innerHTML = html; }
