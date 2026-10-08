import { buildOpportunities } from "../analysis/opportunities.js";
import { scanState } from "../scan-state.js";
import { parseTickers } from "../shared/symbols.js";
import { dateValue, escapeHtml } from "../shared/text.js";
import { state } from "../storage.js";
import { getPortfolioHoldings } from "./portfolio.js";
import { calculateHoldings } from "../analysis/holdings.js";
import { addTickerToWatchlist } from "./watchlist.js";

const boundContainers = new WeakSet();
let onChange = () => {};
let busyTicker = "";
let latestInput = null;

export function renderOpportunities(results, marketContext) {
  const container = document.getElementById("opportunityCards");
  if (!container) return;
  latestInput = { results, marketContext };
  const portfolio = calculateHoldings(getPortfolioHoldings(), results);
  const model = buildOpportunities(results, marketContext, { holdings: portfolio.holdings.map((holding) => ({
    ticker: holding.ticker, currency: holding.currency,
    weight: portfolio.groups.find((group) => group.currency === holding.currency)?.complete ? holding.weight : null
  })) });
  if (!model.candidates.length) {
    container.innerHTML = `<div class="opportunity-empty"><h3>No stocks to review</h3><p>${escapeHtml(model.reason)}</p></div>`;
    return;
  }
  const watched = new Set(parseTickers(state.tickerInput));
  container.innerHTML = model.candidates.slice(0, 3).map((candidate) => renderCandidate(candidate, watched)).join("");
}

function renderCandidate(candidate, watched) {
  const quote = candidate.quote || scanState.latestQuoteSnapshot?.byTicker?.get(candidate.ticker);
  const name = quote?.name || candidate.name || candidate.ticker;
  const currency = candidate.quote?.currency || candidate.currency || "";
  const score = Number.isFinite(candidate.score) ? candidate.score : null;
  const alreadyWatched = watched.has(candidate.ticker);
  const adding = busyTicker === candidate.ticker;
  const evidence = candidate.evidence || [];
  const reasons = (candidate.reasons || []).filter((reason) => !/^Direct company coverage:/.test(reason));
  const risks = candidate.risks || [];
  const asOf = candidate.quote?.quoteTime || candidate.asOf;
  const priceDate = dateValue(asOf) ? new Date(dateValue(asOf)).toISOString() : "";
  const invalidation = Number.isFinite(candidate.invalidation) && candidate.invalidation > 0
    ? `Below ${priceLabel(candidate.invalidation)}${currency ? ` ${escapeHtml(currency)}` : ""}` : "Unavailable";
  const owned = Number.isFinite(candidate.holdingWeight) && candidate.holdingWeight > 0;
  return `<article class="opportunity-row">
    <div class="opportunity-summary">
      <div class="opportunity-identity"><h3><a href="#detail" data-detail-ticker="${escapeHtml(candidate.ticker)}">${escapeHtml(candidate.ticker)}</a></h3>
        <span class="opportunity-name">${escapeHtml(name)}</span></div>
      <div class="opportunity-price"><strong>${priceLabel(candidate.latest)}</strong>${currency ? `<span>${escapeHtml(currency)}</span>` : ""}
        ${priceDate ? `<time datetime="${escapeHtml(priceDate)}">${escapeHtml(dateLabel(asOf))}</time>` : '<span>Date unavailable</span>'}</div>
      <div class="opportunity-context"><p class="opportunity-reason">${escapeHtml(reasons[0] || "")}</p>
        ${score === null ? "" : `<small class="opportunity-score">Technical score ${escapeHtml(score)}/100</small>`}</div>
      <div class="opportunity-actions"><a class="button secondary" href="#detail" data-detail-ticker="${escapeHtml(candidate.ticker)}">View analysis</a>
        ${alreadyWatched ? '<small class="opportunity-watchlist-status">On watchlist</small>'
    : `<button type="button" class="button" data-opportunity-ticker="${escapeHtml(candidate.ticker)}" ${busyTicker ? "disabled" : ""}>${adding ? "Checking…" : "Add to watchlist"}</button>`}</div>
    </div>
    <details class="opportunity-evidence"><summary>Why this stock?</summary><div class="opportunity-evidence-body">
      ${reasons.length > 1 ? `<section class="opportunity-evidence-section opportunity-reasons"><h4>Price setup</h4>
        <ul>${reasons.slice(1).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></section>` : ""}
      <section class="opportunity-evidence-section opportunity-sources"><h4>Company headlines</h4>${evidence.map(renderEvidence).join("")}</section>
      <section class="opportunity-evidence-section opportunity-risks"><h4>Risks</h4>
        <ul>${risks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}</ul></section>
      <section class="opportunity-evidence-section opportunity-parameters"><h4>Setup limits</h4>
        <dl class="opportunity-meta"><div><dt>Timeframe</dt><dd>${escapeHtml(candidate.horizon || "Unavailable")}</dd></div>
          <div><dt>Setup invalidation</dt><dd>${invalidation}</dd></div>
          <div><dt>Price history</dt><dd>${escapeHtml(dateLabel(candidate.asOf))}</dd></div>
          ${owned ? `<div><dt>Already held</dt><dd>${candidate.holdingWeight.toFixed(1)}% of a portfolio currency group</dd></div>` : ""}</dl></section>
    </div></details>
  </article>`;
}

function renderEvidence(article) {
  const href = safeArticleLink(article.link);
  const title = escapeHtml(article.title);
  return `<div class="opportunity-source">${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>` : `<span>${title}</span>`}
    <span>${escapeHtml(article.source)} · Published ${escapeHtml(dateLabel(article.pubDate))}</span></div>`;
}

export function bindOpportunityEvents(onWatchlistChange) {
  onChange = typeof onWatchlistChange === "function" ? onWatchlistChange : () => {};
  const container = document.getElementById("opportunityCards");
  if (!container || boundContainers.has(container)) return;
  container.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-opportunity-ticker]");
    if (!button || !container.contains(button) || button.disabled || busyTicker) return;
    const ticker = button.dataset.opportunityTicker;
    busyTicker = ticker;
    container.setAttribute("aria-busy", "true");
    setMessage(`Checking ${ticker} against live market data…`);
    container.querySelectorAll("[data-opportunity-ticker]").forEach((action) => { action.disabled = true; });
    button.textContent = "Checking…";
    let changed = false;
    try {
      const result = await addTickerToWatchlist(ticker);
      changed = result.ok && result.changed;
      setMessage(result.message || (result.ok ? `${ticker} added to your watchlist.` : `Could not add ${ticker}. Try again.`));
    } catch {
      setMessage(`Could not verify ${ticker}. Try again when market data is available.`);
    } finally {
      busyTicker = "";
      container.setAttribute("aria-busy", "false");
      if (latestInput) renderOpportunities(latestInput.results, latestInput.marketContext);
      container.querySelectorAll("[data-opportunity-ticker]").forEach((replacement) => {
        if (replacement.dataset.opportunityTicker === ticker && !replacement.disabled) replacement.focus();
      });
    }
    if (changed) {
      try {
        await onChange();
      } catch {
        setMessage(`${ticker} was saved. The follow-up scan could not start; refresh the scan to update results.`);
      }
    }
  });
  boundContainers.add(container);
}

function setMessage(message) {
  const element = document.getElementById("opportunityMessage");
  if (element) element.textContent = message;
}

function dateLabel(value) {
  const time = dateValue(value);
  return time ? new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Date unavailable";
}

function priceLabel(value) {
  return Number.isFinite(value) ? escapeHtml(new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)) : "—";
}

function safeArticleLink(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}
