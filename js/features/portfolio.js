import { broadFunds } from "../config/settings.js";
import { formatNumber, formatPercent, money } from "../shared/format.js";
import { escapeHtml } from "../shared/text.js";
import { state } from "../storage.js";
import { els } from "../ui/dom.js";

export function buildPortfolioReview(results, marketContext) {
  const holdings = parsePortfolioPositions(state.myPortfolioInput);
  const byTicker = new Map(results.map((item) => [item.ticker, item]));
  const enriched = holdings.map((holding) => {
    const item = byTicker.get(holding.ticker);
    return {
      ...holding,
      analysis: item || null,
      isCore: broadFunds.has(holding.ticker) || /vanguard|ftse|all-world|index|etf/i.test(holding.label)
    };
  });
  const total = enriched.reduce((sum, holding) => sum + holding.amount, 0);
  enriched.forEach((holding) => {
    holding.weight = total ? (holding.amount / total) * 100 : 0;
    holding.review = portfolioHoldingReview(holding, marketContext);
  });

  const coreValue = enriched.filter((holding) => holding.isCore).reduce((sum, holding) => sum + holding.amount, 0);
  const stockValue = total - coreValue;
  const largest = enriched.reduce((best, holding) => !best || holding.amount > best.amount ? holding : best, null);
  const downCount = enriched.filter((holding) => holding.status === "down").length;
  const ownedTech = enriched
    .filter((holding) => ["MSFT", "TSM", "AVGO", "NVDA", "GOOGL"].includes(holding.ticker))
    .reduce((sum, holding) => sum + holding.amount, 0);
  const concentrationNotes = [];
  if (total && coreValue / total >= 0.8) concentrationNotes.push("Most of the portfolio is in one broad Vanguard/FTSE core holding. That is diversified by companies, but still concentrated in one fund wrapper.");
  if (total && ownedTech / total >= 0.1) concentrationNotes.push("The satellite positions are mostly mega-cap tech and semiconductors, so they can fall together even if each individual amount is small.");
  if (downCount >= 3) concentrationNotes.push("Several satellite holdings are down. The model separates normal drawdown from actual trend damage before suggesting any reduction.");
  if (marketContext?.score < 45) concentrationNotes.push(`Market regime is weak (${marketContext.label}), so new buys need a stricter setup.`);
  if (!concentrationNotes.length) concentrationNotes.push("Position sizes look controlled. The main task is patience and avoiding impulsive averaging down.");

  return {
    holdings: enriched,
    total,
    coreValue,
    stockValue,
    largest,
    downCount,
    concentrationNotes
  };
}

function portfolioHoldingReview(holding, marketContext) {
  const item = holding.analysis;
  if (!item || !item.dataQuality?.eligible) {
    return {
      label: "Analysis unavailable",
      className: "holding-watch",
      reason: item?.dataQuality?.reason || "This holding was not returned by the live price scan. Check the ticker.",
      detail: "The app can still count the position size, but it cannot score trend or risk until price data loads."
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
    ? `<p class="data-note">Price data fell back to sample data, so this is only a position-size review.</p>`
    : `<p class="data-note">This is a portfolio-aware market signal, not personal financial advice. It uses your stated position sizes, current model scores, trend checks, and risk filters.</p>`;
  els.portfolioReview.innerHTML = `
    ${sourceWarning}
    <div class="portfolio-summary">
      <article><span>Total tracked</span><strong>${money(portfolio.total)}</strong></article>
      <article><span>Core ETF weight</span><strong>${portfolio.total ? `${((portfolio.coreValue / portfolio.total) * 100).toFixed(1)}%` : "-"}</strong></article>
      <article><span>Satellite stock weight</span><strong>${portfolio.total ? `${((portfolio.stockValue / portfolio.total) * 100).toFixed(1)}%` : "-"}</strong></article>
      <article><span>Down positions</span><strong>${portfolio.downCount}/${portfolio.holdings.length}</strong></article>
    </div>
    <div class="portfolio-notes">
      ${portfolio.concentrationNotes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}
    </div>
    <div class="holding-grid">
      ${portfolio.holdings.map(renderHoldingCard).join("")}
    </div>
  `;
}

function renderHoldingCard(holding) {
  const item = holding.analysis;
  return `
    <article class="holding-card ${holding.review.className}">
      <div class="holding-head">
        <div>
          <span>${escapeHtml(holding.status === "down" ? "Currently down" : holding.status === "up" ? "Currently up" : "Status unknown")}</span>
          <h3>${escapeHtml(holding.label || holding.ticker)}</h3>
        </div>
        <strong>${holding.weight.toFixed(1)}%</strong>
      </div>
      <div class="stock-stats">
        <span>${escapeHtml(holding.ticker)}</span>
        <span>${money(holding.amount)}</span>
        ${item?.dataQuality?.eligible ? `<span>Signal strength ${item.score}/100</span><span>1M ${formatPercent(item.oneMonth)}</span><span>Risk ${escapeHtml(item.setup?.riskLevel || "-")}</span>` : ""}
      </div>
      <b class="holding-label">${escapeHtml(holding.review.label)}</b>
      <p>${escapeHtml(holding.review.reason)} ${escapeHtml(holding.review.detail)}</p>
    </article>
  `;
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
