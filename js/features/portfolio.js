import { broadFunds } from "../config/settings.js";
import { calculateHoldings } from "../analysis/holdings.js";
import { formatNumber, formatPercent } from "../shared/format.js";
import { escapeHtml } from "../shared/text.js";
import { state } from "../storage.js";
import { els } from "../ui/dom.js";

export function buildPortfolioReview(results, marketContext) {
  const calculated = calculateHoldings(getPortfolioHoldings(), results);
  const byTicker = new Map(results.map((item) => [item.ticker, item]));
  const byCurrency = new Map(calculated.groups.map((group) => [group.currency, group]));
  const enriched = calculated.holdings.map((holding) => {
    const item = byTicker.get(holding.ticker);
    const group = byCurrency.get(holding.currency);
    return {
      ...holding,
      weight: group?.complete ? holding.weight : null,
      analysis: item || null,
      isCore: Boolean(item?.isFund) || broadFunds.has(holding.ticker) || /vanguard|ftse|all-world|index|etf/i.test(holding.label)
    };
  });
  enriched.forEach((holding) => { holding.review = portfolioHoldingReview(holding, marketContext); });
  const groups = calculated.groups.map((group) => {
    const holdings = enriched.filter((holding) => holding.currency === group.currency);
    const coreValue = holdings.filter((holding) => holding.isCore).reduce((sum, holding) => sum + (holding.currentValue || 0), 0);
    return { ...group, holdings, coreValue, stockValue: group.total === null ? null : group.total - coreValue };
  });
  const onlyGroup = groups.length === 1 ? groups[0] : null;
  const downCount = enriched.filter((holding) => holding.status === "down").length;
  const concentrationNotes = [];
  groups.forEach((group) => {
    if (!group.complete) { concentrationNotes.push(`${group.currency}: some prices are unavailable. Totals show known values; weights remain unavailable.`); return; }
    const ownedTech = group.holdings.filter((holding) => ["MSFT", "TSM", "AVGO", "NVDA", "GOOGL"].includes(holding.ticker))
      .reduce((sum, holding) => sum + (holding.currentValue || 0), 0);
    if (group.total && group.coreValue / group.total >= 0.8) concentrationNotes.push(`${group.currency}: core fund exposure represents ${((group.coreValue / group.total) * 100).toFixed(1)}% of tracked value.`);
    if (group.total && ownedTech / group.total >= 0.1) concentrationNotes.push(`${group.currency}: technology and semiconductor holdings can fall together.`);
  });
  if (marketContext?.score < 45) concentrationNotes.push(`Market regime is weak (${marketContext.label}), so new buys need a stricter setup.`);
  if (!concentrationNotes.length) concentrationNotes.push("Values and weights are grouped by currency. No currency conversion is assumed.");

  return {
    holdings: enriched,
    groups,
    total: onlyGroup?.total ?? null,
    coreValue: onlyGroup?.coreValue ?? null,
    stockValue: onlyGroup?.stockValue ?? null,
    largest: onlyGroup ? onlyGroup.holdings.reduce((best, holding) => !best || holding.currentValue > best.currentValue ? holding : best, null) : null,
    missingCount: calculated.missingCount,
    downCount,
    concentrationNotes
  };
}

function portfolioHoldingReview(holding, marketContext) {
  const item = holding.analysis;
  if (!item || !item.dataQuality?.eligible || marketContext?.available === false) {
    return {
      label: "Analysis unavailable",
      className: "holding-watch",
      reason: marketContext?.available === false ? "Market context is unavailable; the model cannot issue a position signal." : item?.dataQuality?.reason || "This holding was not returned by the live price scan. Check the ticker.",
      detail: "Saved holdings and available prices remain visible while analysis is unavailable."
    };
  }

  const down = holding.status === "down";
  const overweightSatellite = !holding.isCore && holding.weight > 8;
  const largeCore = holding.isCore && holding.weight > 80;
  const broken = item.score <= 44 || (item.latest < item.sma200 && item.sixMonth < 0) || item.eventRisk?.level === "High";
  const healthy = item.score >= 58 && item.latest > item.sma200 && item.eventRisk?.level !== "High";
  const stretched = item.rsi14 > 72 || item.volatility > (holding.isCore ? 0.28 : 0.5);

  if (broken && down) {
    return {
      label: "Review / possible trim",
      className: "holding-danger",
      reason: `${holding.ticker} is down and the live model also sees technical or event damage.`,
      detail: `${item.label} (${item.score}/100). ${item.flags[0] || "Trend, momentum, or risk filters are weak."}`
    };
  }

  if (broken) {
    return {
      label: "Avoid adding",
      className: "holding-warning",
      reason: `${holding.ticker} does not clear the quality gate today.`,
      detail: `${item.label} (${item.score}/100). Let the setup repair before adding more.`
    };
  }

  if (healthy && down) {
    return {
      label: "Hold, no panic sell",
      className: "holding-good",
      reason: `${holding.ticker} is down for you, but the current setup is not broken.`,
      detail: `${item.label} (${item.score}/100). The safer move is to avoid emotional selling and only add if the signal stays strong across scans.`
    };
  }

  if (largeCore && healthy) {
    return {
      label: "Core hold",
      className: "holding-good",
      reason: "Your Vanguard/FTSE position is the portfolio anchor and currently passes the broad-holding checks.",
      detail: `Weight ${holding.weight.toFixed(1)}%. Consider future additions carefully because it already drives most portfolio movement.`
    };
  }

  if (overweightSatellite || stretched) {
    return {
      label: "Hold / avoid adding",
      className: "holding-warning",
      reason: overweightSatellite ? `${holding.ticker} is a large satellite position.` : `${holding.ticker} looks stretched or volatile.`,
      detail: `${item.label} (${item.score}/100). New money may be better reserved unless the setup improves.`
    };
  }

  return {
    label: marketContext?.score < 45 ? "Hold, be selective" : "Hold / watch",
    className: "holding-watch",
    reason: `${holding.ticker} does not show an urgent sell signal today.`,
    detail: `${item.label} (${item.score}/100). Watch the invalidation area near ${formatNumber(item.setup?.invalidation || item.sma50)}.`
  };
}

export function renderPortfolioReview(portfolio, priceSource) {
  if (!portfolio.holdings.length) {
    els.portfolioReview.innerHTML = `<div class="empty-state">Add your holdings above to make the model position-aware.</div>`;
    return;
  }
  const sourceWarning = priceSource === "sample"
    ? '<p class="data-note">Sample prices cannot value holdings or support position signals. Legacy amounts remain as entered.</p>'
    : '<p class="data-note">Share positions use qualified prices in their purchase currency. Legacy amounts stay manual; currency totals remain separate.</p>';
  els.portfolioReview.innerHTML = `
    ${sourceWarning}
    <div class="portfolio-notes">
      ${portfolio.concentrationNotes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}
    </div>
    ${portfolio.groups.map((group) => `<section class="portfolio-currency-group"><h3>${escapeHtml(group.currency)} holdings</h3>
      <div class="portfolio-summary">
        <article><span>${group.complete ? "Tracked value" : "Known tracked value"}</span><strong>${escapeHtml(currencyMoney(group.total, group.currency))}</strong></article>
        <article><span>Cost basis</span><strong>${escapeHtml(currencyMoney(group.costBasis, group.currency))}</strong></article>
        <article><span>Unrealized gain / loss</span><strong>${escapeHtml(gainMoney(group.gain, group.currency))}</strong></article>
        <article><span>Core fund weight</span><strong>${group.complete && group.total > 0 ? `${((group.coreValue / group.total) * 100).toFixed(1)}%` : "Unavailable"}</strong></article>
      </div>
      ${group.legacyCount ? `<p class="data-note">${group.legacyCount} legacy amount${group.legacyCount === 1 ? " is" : "s are"} included as entered. Group cost basis and gain / loss need share quantities and purchase prices for every holding.</p>` : ""}
      <div class="holding-grid">${group.holdings.map(renderHoldingCard).join("")}</div>
    </section>`).join("")}
  `;
}

function renderHoldingCard(holding) {
  const item = holding.analysis;
  const manual = holding.kind === "manual";
  const status = holding.status === "down" ? "In loss" : holding.status === "up" ? "In profit" : holding.status === "flat" ? "At cost" : "Gain / loss unavailable";
  const values = manual
    ? `<div><span>Entered amount</span><strong>${escapeHtml(currencyMoney(holding.amount, holding.currency))}</strong></div>`
    : `<div><span>Shares</span><strong>${escapeHtml(quantity(holding.shares))}</strong></div>
      <div><span>Average purchase</span><strong>${escapeHtml(currencyMoney(holding.averageCost, holding.currency))}</strong></div>
      <div><span>Cost basis</span><strong>${escapeHtml(currencyMoney(holding.costBasis, holding.currency))}</strong></div>
      <div><span>Current value</span><strong>${escapeHtml(currencyMoney(holding.currentValue, holding.currency))}</strong></div>
      <div><span>Unrealized gain / loss</span><strong>${escapeHtml(gainMoney(holding.gain, holding.currency))}${Number.isFinite(holding.gainPercent) ? ` <small>${escapeHtml(formatPercent(holding.gainPercent))}</small>` : ""}</strong></div>`;
  return `
    <article class="holding-card ${holding.review.className}">
      <div class="holding-head">
        <div>
          <span>${escapeHtml(manual ? `Manual status: ${holding.status}` : status)}</span>
          <h3>${escapeHtml(holding.label || holding.ticker)}</h3>
        </div>
        <strong>${Number.isFinite(holding.weight) ? `${holding.weight.toFixed(1)}%` : "Weight unavailable"}</strong>
      </div>
      <div class="stock-stats">
        <span>${escapeHtml(holding.ticker)}</span>
        <span>${escapeHtml(holding.currency)}</span>
        ${item?.dataQuality?.eligible ? `<span>Signal strength ${item.score}/100</span><span>1M ${formatPercent(item.oneMonth)}</span><span>Risk ${escapeHtml(item.setup?.riskLevel || "-")}</span>` : ""}
      </div>
      <div class="holding-values">${values}</div>
      <p class="data-note">${manual ? "Legacy amount stays as entered. Edit to add shares and average purchase price." : Number.isFinite(holding.price)
        ? `Price ${escapeHtml(currencyMoney(holding.price, holding.currency))} · ${holding.source === "quote" ? "quote" : "daily close"} as of ${escapeHtml(holdingDate(holding.asOf))}`
        : escapeHtml(holding.valuationError || "A qualified price in the purchase currency is unavailable.")}</p>
      <b class="holding-label">${escapeHtml(holding.review.label)}</b>
      <p>${escapeHtml(holding.review.reason)} ${escapeHtml(holding.review.detail)}</p>
      <button type="button" class="ghost" data-edit-holding="${escapeHtml(holding.id)}">Edit holding</button>
    </article>
  `;
}

export function getPortfolioHoldings() {
  if (Array.isArray(state.holdings)) return state.holdings;
  return parsePortfolioPositions(state.myPortfolioInput).map((holding, index) => ({
    ...holding, id: `legacy-${index}`, kind: "manual", currency: state.currency || "EUR"
  }));
}

function currencyMoney(value, currency) {
  if (!Number.isFinite(value)) return "Unavailable";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${value.toFixed(2)} ${currency || ""}`.trim(); }
}

function gainMoney(value, currency) {
  return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${currencyMoney(value, currency)}` : "Unavailable";
}

function quantity(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(value) : "Unavailable";
}

function holdingDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable";
}

export function parsePortfolioPositions(value) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[|,\t]+/).map((part) => part.trim()).filter(Boolean);
      const ticker = String(parts[0] || "")
        .toUpperCase()
        .replace(/[^A-Z0-9.^-]/g, "");
      const label = parts[1] && !/^\d/.test(parts[1]) ? parts[1] : ticker;
      const amountPart = parts.find((part, index) => index > 0 && /[\d]/.test(part) && Number.isFinite(parseMoneyNumber(part)));
      const amount = parseMoneyNumber(amountPart);
      const statusText = parts.join(" ").toLowerCase();
      const status = /\b(up|profit|green|positive)\b/.test(statusText)
        ? "up"
        : /\b(down|loss|red|negative)\b/.test(statusText)
          ? "down"
          : "unknown";
      return ticker && amount > 0 ? { ticker, label, amount, status } : null;
    })
    .filter(Boolean);
}

function parseMoneyNumber(value) {
  const cleaned = String(value || "").replace(/[^0-9.,-]/g, "").replace(",", ".");
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : 0;
}
