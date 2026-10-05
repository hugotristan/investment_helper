import { buildModelAllocation } from "../analysis/allocation.js";
import { buildPortfolioReview, renderPortfolioReview } from "../features/portfolio.js";
import { renderScreener } from "../features/screener.js";
import { renderSellGuidance } from "../features/signals.js";
import { scanState } from "../scan-state.js";
import { formatNumber, formatPercent, formatSignal } from "../shared/format.js";
import { average } from "../shared/math.js";
import { escapeHtml, unique } from "../shared/text.js";
import { renderCategoryBars } from "./components.js";
import { els } from "./dom.js";
import { renderDashboardOverview } from "./overview.js";

export function renderAll(results, priceSource, news, marketContext, quoteSnapshot = null) {
  scanState.latestRankedResults = results;
  scanState.latestPriceSource = priceSource;
  scanState.latestNews = news;
  scanState.latestMarketContext = marketContext;
  scanState.latestQuoteSnapshot = quoteSnapshot;
  const allocation = buildModelAllocation(results, marketContext);
  const portfolio = buildPortfolioReview(results, marketContext);
  const qualified = results.filter((item) => item.dataQuality?.eligible && Number.isFinite(item.score));
  const top = qualified[0];
  const now = new Date();
  const sourceLine = `${qualified.length}/${results.length} instruments have qualified recent real history. Unavailable instruments are excluded from recommendations. Headlines: ${news.label}.`;
  const activeTrustedSources = Math.max(0, news.sources.filter((source) => source.ok).length - 1);

  renderDashboardOverview(results, priceSource, news, marketContext, quoteSnapshot);

  els.lastScan.textContent = now.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  els.marketPulseTitle.textContent = top ? `${top.ticker} leads today's scan` : "No leader";
  els.marketPulse.innerHTML = [
    ["Scanned", results.length],
    ["Average signal", qualified.length ? Math.round(average(qualified.map((item) => item.score))) : "—"],
    ["Top score", top ? `${top.score}/100` : "-"],
    ["Active sources", `${activeTrustedSources}/${news.configured}`],
    ["Quotes", quoteSnapshot?.count ? `${quoteSnapshot.count}/${quoteSnapshot.total}` : "Chart only"],
    ["Universe", `${news.configured}+`],
    ["Forecast", marketContext.label],
    ["Proxy coverage", `${marketContext.liveCount}/${marketContext.total}`],
    ["Headlines", news.items.length],
    ["Outlooks", news.outlookCount || 0],
    ["Source", priceSource === "sample" ? "Sample" : "Live"]
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");

  renderModelInstructions(allocation, sourceLine);
  renderScreener();
  renderMarketForecast(marketContext, news);
  renderPortfolioReview(portfolio, priceSource);
  renderSellGuidance(results, priceSource);
  renderEvidence(results, allocation);
  renderMarketFramework(qualified, marketContext, news);
  renderSourceStatus(news.sources, news.configured);
  renderRanking(qualified);
}

function renderModelInstructions(allocation, sourceLine) {
  els.modelInstructions.innerHTML = `
    <p class="data-note">${escapeHtml(sourceLine)} Output is phrased as market signals, not personal investment advice. Use entry and invalidation levels as risk markers, not guaranteed instructions.</p>
    <div class="instruction-list">
      ${allocation.actions.map((action) => renderAction(action)).join("")}
    </div>
    <div class="avoid-box">
      <span>Do not buy today</span>
      <strong>${escapeHtml(allocation.avoid.ticker)}</strong>
      <p>${escapeHtml(allocation.avoid.text)}</p>
    </div>
  `;
}

function renderMarketForecast(forecast, news) {
  if (!forecast.available) {
    els.marketForecast.innerHTML = `<div class="empty-state"><h3>Market outlook unavailable</h3><p>Recent real equity and credit proxy data is required.</p><p>${escapeHtml((forecast.risks || []).join(" "))}</p></div>`;
    return;
  }
  const activeTrustedSources = Math.max(0, news.sources.filter((source) => source.ok).length - 1);
  els.marketForecast.innerHTML = `
    <article class="forecast-card ${forecast.score >= 56 ? "forecast-positive" : forecast.score < 45 ? "forecast-negative" : "forecast-neutral"}">
      <div class="forecast-head">
        <div>
          <span>${escapeHtml(forecast.horizon)}</span>
          <h3>${escapeHtml(forecast.label)}</h3>
        </div>
        <strong>${forecast.liveCount}/${forecast.total} proxy coverage</strong>
      </div>
      <div class="forecast-meter" aria-hidden="true"><span style="width: ${forecast.score}%"></span></div>
      <div class="stock-stats">
        <span>Forecast ${forecast.score}/100</span>
        <span>Sources ${activeTrustedSources}/${news.configured}</span>
        <span>Proxies ${forecast.liveCount}/${forecast.total}</span>
        <span>Outlooks ${news.outlookCount || 0}</span>
      </div>
      <ul>${forecast.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      ${forecast.risks.length ? `<p>${escapeHtml(forecast.risks.join(" "))}</p>` : `<p>No major contradiction found across the market proxy set.</p>`}
    </article>
  `;
}

function renderAction(action) {
  const verb = action.kind === "cash" ? "Reserve" : "Signal";
  return `
    <article class="instruction-row ${action.kind === "cash" ? "cash-row" : ""}">
      <div><span>${escapeHtml(verb)}</span><h3>${escapeHtml(action.ticker)}</h3></div>
      <strong>${action.percent.toFixed(1)}%</strong>
      <p>
        ${action.kind === "cash" ? "" : `<b class="signal-pill">${escapeHtml(action.signal)}</b> `}
        ${escapeHtml(action.reason)}
        ${action.setup ? ` Entry zone ${escapeHtml(action.setup.entryZone)}, invalidated below ${escapeHtml(formatNumber(action.setup.invalidation))}, risk ${escapeHtml(action.setup.riskLevel)}.` : ""}
      </p>
    </article>
  `;
}

function renderEvidence(results, allocation) {
  const tickers = allocation.actions.filter((action) => action.kind === "invest").map((action) => action.ticker);
  const selected = results.filter((item) => tickers.includes(item.ticker)).slice(0, 6);
  els.researchEvidence.innerHTML = selected.map((item) => `
    <article class="evidence-card">
      <div class="evidence-head">
        <h3>${escapeHtml(item.ticker)}</h3>
        <span>${item.score}/100</span>
      </div>
      <div class="stock-stats">
        <span>${escapeHtml(item.setup?.signal || item.label)}</span>
        <span>1W ${formatPercent(item.oneWeek)}</span>
        <span>1M ${formatPercent(item.oneMonth)}</span>
        <span>3M ${formatPercent(item.threeMonth)}</span>
        <span>RSI ${Number.isFinite(item.rsi14) ? item.rsi14.toFixed(0) : "-"}</span>
        <span>MACD ${item.macd?.histogram >= 0 ? "positive" : "negative"}</span>
        <span>Vol ${formatPercent(item.volatility)}</span>
        <span>ATR ${formatPercent(item.atrPercent)}</span>
        <span>Drawdown ${formatPercent(item.drawdown)}</span>
        <span>Volume ${formatPercent(item.volumePressure)}</span>
        <span>Outlook ${item.outlookSourceCount || 0}</span>
      </div>
      <div class="setup-line">
        <span>Entry ${escapeHtml(item.setup?.entryZone || "-")}</span>
        <span>Invalidation ${escapeHtml(item.setup ? formatNumber(item.setup.invalidation) : "-")}</span>
        <span>Support ${escapeHtml(formatNumber(item.support))}</span>
        <span>Resistance ${escapeHtml(formatNumber(item.resistance))}</span>
      </div>
      ${renderCategoryBars(item.categories)}
      <ul>${item.reasons.slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
      ${item.outlooks[0] ? `<a href="${escapeHtml(item.outlooks[0].link)}" target="_blank" rel="noreferrer">Outlook: ${escapeHtml(item.outlooks[0].source)}: ${escapeHtml(item.outlooks[0].title)}</a>` : ""}
      ${item.headlines[0] ? `<a href="${escapeHtml(item.headlines[0].link)}" target="_blank" rel="noreferrer">${escapeHtml(item.headlines[0].source)}: ${escapeHtml(item.headlines[0].title)}</a>` : `<span class="muted-line">No current ticker headline found.</span>`}
    </article>
  `).join("");
}

function renderMarketFramework(results, marketContext, news) {
  const averageScore = results.length ? Math.round(average(results.map((item) => item.score))) : "—";
  const yearOutlookItems = news.items.filter((item) => item.horizon === "recent-year");
  const yearSourceCount = unique(yearOutlookItems.map((item) => item.sourceId)).length;
  const yearTone = yearOutlookItems.length ? average(yearOutlookItems.map((item) => item.sentiment)) : 0;
  const above200 = results.filter((item) => item.latest > item.sma200).length;
  const above50 = results.filter((item) => item.latest > item.sma50).length;
  const positiveSixMonth = results.filter((item) => item.sixMonth > 0).length;
  const highRisk = results.filter((item) => item.volatility > 0.45 || item.drawdown < -0.18).length;
  const breadth = results.length ? Math.round((above200 / results.length) * 100) : 0;
  const nearTermBreadth = results.length ? Math.round((above50 / results.length) * 100) : 0;
  const momentumBreadth = results.length ? Math.round((positiveSixMonth / results.length) * 100) : 0;

  els.marketFramework.innerHTML = `
    <article class="framework-card">
      <span>Recent-year research</span>
      <strong>${yearSourceCount} sources</strong>
      <p>${yearOutlookItems.length ? `${yearOutlookItems.length} recent-year outlook items found. Tone is ${formatSignal(yearTone)}.` : "No recent-year outlook items matched the current watchlist in this scan."}</p>
    </article>
    <article class="framework-card">
      <span>Trend and momentum</span>
      <strong>${breadth}% above 200D</strong>
      <p>${nearTermBreadth}% are above the 50-day average and ${momentumBreadth}% have positive six-month momentum.</p>
    </article>
    <article class="framework-card">
      <span>Risk discipline</span>
      <strong>${highRisk} high-risk setups</strong>
      <p>The model penalizes high volatility, large drawdowns, weak 200-day trend, and negative six-month momentum.</p>
    </article>
    <article class="framework-card">
      <span>Market regime</span>
      <strong>${escapeHtml(marketContext.label)}</strong>
      <p>Allocation cash is adjusted using equity breadth, VIX, credit appetite, rate pressure, dollar, oil, and gold signals.</p>
    </article>
    <article class="framework-card framework-wide">
      <span>How stock-market knowledge is applied</span>
      <strong>${averageScore}/100 average score</strong>
      <p>The model favors diversified exposure first, then individual stocks only when trend, momentum, volatility, drawdown, volume pressure, source breadth, current headlines, and recent-year research agree. It reduces exposure when market regime, credit, volatility, or long-term trend contradict the buy case.</p>
    </article>
    <article class="framework-card framework-wide">
      <span>Known data gaps</span>
      <strong>Not yet connected</strong>
      <p>Bid-ask spread, stock fundamentals, earnings calendar, analyst revisions, options flow, and social hype need reliable dedicated APIs before they can be scored honestly.</p>
    </article>
  `;
}

function renderSourceStatus(sources, configured) {
  const visibleSources = sources.filter((source) => source.ok);
  const indexSource = visibleSources.find((source) => source.id === "live-source-index");
  const trustedSources = visibleSources.filter((source) => source.id !== "live-source-index");
  els.sourceStatus.innerHTML = `
    <article class="source-card source-summary">
      <strong>${trustedSources.length}/${configured} trusted sources active</strong>
      <span>${escapeHtml(indexSource?.meta || "The app checked the live source index and direct RSS feeds.")}</span>
    </article>
    ${trustedSources.slice(0, 80).map((source) => `
    <article class="source-card ${source.ok ? "source-ok" : "source-fail"} ${source.ok && source.count === 0 ? "source-empty" : ""}">
      <strong>${escapeHtml(source.name)}</strong>
      <span>${source.ok ? source.count ? `${source.count} relevant headlines via ${source.via}` : `Loaded via ${source.via}; no relevant watchlist headlines` : source.error || "Unavailable"}</span>
    </article>
    `).join("")}
    ${trustedSources.length > 80 ? `<article class="source-card source-empty"><strong>More sources</strong><span>${trustedSources.length - 80} additional active sources were included in the score.</span></article>` : ""}
  `;
}

function renderRanking(results) {
  els.analysisResults.innerHTML = results.map((item, index) => `
    <article class="stock-row ${item.score >= 75 ? "grade-good" : item.score >= 60 ? "grade-watch" : item.score >= 45 ? "grade-mixed" : "grade-avoid"}">
      <div class="rank">${index + 1}</div>
      <div>
        <div class="stock-title"><h3><a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</a></h3><span>${item.score}/100</span></div>
        <strong>${escapeHtml(item.setup?.signal || item.label)}</strong>
        <div class="stock-stats">
          <span>Price ${formatNumber(item.latest)}</span>
          <span>1M ${formatPercent(item.oneMonth)}</span>
          <span>6M ${formatPercent(item.sixMonth)}</span>
          <span>RSI ${Number.isFinite(item.rsi14) ? item.rsi14.toFixed(0) : "-"}</span>
          <span>ATR ${formatPercent(item.atrPercent)}</span>
          <span>Risk ${escapeHtml(item.setup?.riskLevel || "-")}</span>
          <span>Delta ${item.scoreDelta >= 0 ? "+" : ""}${item.scoreDelta}</span>
        </div>
        ${renderCategoryBars(item.categories)}
        <div class="setup-line">
          <span>Entry ${escapeHtml(item.setup?.entryZone || "-")}</span>
          <span>Invalidation ${escapeHtml(item.setup ? formatNumber(item.setup.invalidation) : "-")}</span>
        </div>
      </div>
      <p>${escapeHtml(item.flags[0] || item.reasons[0] || "No major note.")}</p>
    </article>
  `).join("") || '<div class="empty-state">No qualified instruments to rank. Price data must be recent, real, and sufficiently complete.</div>';
}
