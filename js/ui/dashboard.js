import { buildModelAllocation } from "../analysis/allocation.js";
import { loadFundamentalsSnapshot } from "../data/fundamentals.js";
import { uniqueArticles } from "../data/news-helpers.js";
import { buildPortfolioReview, renderPortfolioReview } from "../features/portfolio.js";
import { renderScanRow, scanListHeading, renderScreener } from "../features/screener.js";
import { renderSellGuidance } from "../features/signals.js";
import { scanState } from "../scan-state.js";
import { formatNumber } from "../shared/format.js";
import { dateValue, escapeHtml, unique } from "../shared/text.js";
import { els } from "./dom.js";
import { renderDashboardOverview } from "./overview.js";
import { renderOpportunities } from "../features/opportunities.js";

let frameworkVersion = 0;

export function renderAll(results, priceSource, news, marketContext, quoteSnapshot = null, { scannedAt = Date.now() } = {}) {
  scanState.latestRankedResults = results;
  scanState.latestPriceSource = priceSource;
  scanState.latestNews = news;
  scanState.latestMarketContext = marketContext;
  scanState.latestQuoteSnapshot = quoteSnapshot;
  const allocation = buildModelAllocation(results, marketContext);
  const portfolio = buildPortfolioReview(results, marketContext);
  const qualified = results.filter((item) => item.dataQuality?.eligible && Number.isFinite(item.score));
  const now = new Date(scannedAt);
  const sourceLine = `Illustrative model weights · ${qualified.length}/${results.length} instruments have qualified history. These weights are separate from your holdings.`;
  const activeTrustedSources = news.sources.filter((source) => source.ok && source.id !== "live-source-index").length;

  renderDashboardOverview(results, priceSource, news, marketContext, quoteSnapshot);
  renderOpportunities(results, marketContext);

  els.lastScan.textContent = now.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  els.marketPulseTitle.textContent = "Latest scan";
  els.marketPulse.innerHTML = [
    ["Scanned", results.length],
    ["Qualified history", `${qualified.length}/${results.length}`],
    ["Feeds loaded", `${activeTrustedSources}/${news.configured}`],
    ["Quote responses", `${quoteSnapshot?.count || 0}/${quoteSnapshot?.total || results.length}`],
    ["Market proxies", `${marketContext.liveCount || 0}/${marketContext.total || 0}`],
    ["Matched articles", news.items.length]
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");

  renderModelInstructions(allocation, sourceLine);
  renderScreener();
  renderMarketForecast(marketContext, news);
  renderPortfolioReview(portfolio, priceSource);
  renderSellGuidance(results, priceSource);
  renderEvidence(results, allocation);
  void renderMarketFramework(results, marketContext, news);
  renderSourceStatus(news.sources, news.configured);
  renderRanking(qualified);
}

function renderModelInstructions(allocation, sourceLine) {
  els.modelInstructions.innerHTML = `
    <p class="data-note">${escapeHtml(sourceLine)}</p>
    <div class="instruction-list">
      ${allocation.actions.map((action) => renderAction(action)).join("")}
    </div>
    <details class="secondary-details">
      <summary>Lower-ranked instrument · ${escapeHtml(allocation.avoid.ticker)}</summary>
      <p>${escapeHtml(allocation.avoid.text)}</p>
    </details>
  `;
}

function renderMarketForecast(forecast, news) {
  if (!forecast.available) {
    els.marketForecast.innerHTML = `<div class="empty-state"><h3>Market context unavailable</h3><p>${escapeHtml((forecast.risks || []).join(" ") || "Recent equity and credit proxy prices are unavailable.")}</p></div>`;
    return;
  }
  els.marketForecast.innerHTML = `
    <article class="forecast-card">
      <div class="forecast-head">
        <div>
          <span>Market context</span>
          <h3>${escapeHtml(forecast.label)}</h3>
        </div>
        <strong>${forecast.score}/100</strong>
      </div>
      <p class="data-note">${forecast.liveCount}/${forecast.total} qualified proxies · ${escapeHtml(dateLabel(forecast.dataQuality?.asOf))}. This score combines proxy trends; it is not a return probability.</p>
      <details class="secondary-details"><summary>Proxy checks</summary>
        <ul>${(forecast.evidence || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        ${(forecast.risks || []).length ? `<p>${escapeHtml(forecast.risks.join(" "))}</p>` : ""}
      </details>
    </article>
  `;
}

function renderAction(action) {
  return `
    <article class="instruction-row ${action.kind === "cash" ? "cash-row" : ""}">
      <div><span>${escapeHtml(action.kind === "cash" ? "Cash reserve" : action.signal)}</span><h3>${action.kind === "cash" ? escapeHtml(action.ticker) : `<a href="#detail" data-detail-ticker="${escapeHtml(action.ticker)}">${escapeHtml(action.ticker)}</a>`}</h3></div>
      <strong>${action.percent.toFixed(1)}%</strong>
      <details class="secondary-details"><summary>Checks</summary><p>${escapeHtml(action.reason)}</p>
        ${action.setup ? `<dl class="key-values">${metric("Entry zone", action.setup.entryZone)}${metric("Invalidation", formatNumber(action.setup.invalidation))}${metric("Risk", action.setup.riskLevel)}</dl>` : ""}
      </details>
    </article>
  `;
}

function renderEvidence(results, allocation) {
  const tickers = allocation.actions.filter((action) => action.kind === "invest").map((action) => action.ticker);
  const selected = results.filter((item) => tickers.includes(item.ticker)).slice(0, 6);
  els.researchEvidence.innerHTML = selected.map((item) => {
    const articles = uniqueArticles([...(item.outlooks || []), ...(item.headlines || [])])
      .map((article) => ({ ...article, link: safeUrl(article.link) })).filter((article) => article.link).slice(0, 5);
    return `<details class="secondary-details evidence-card"><summary>${escapeHtml(item.ticker)} · ${item.score}/100 · ${articles.length} matched articles</summary>
      <p>${escapeHtml(item.setup?.signal || item.label)}</p>
      <ul>${(item.reasons || []).slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
      ${articles.length ? articles.map((article) => `<div class="detail-source-entry"><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}: ${escapeHtml(article.title)}</a><small>${escapeHtml(evidenceScope(article, item.ticker))} · ${escapeHtml(dateLabel(article.pubDate))}</small></div>`).join("") : '<p>No usable article links matched this instrument.</p>'}
      <a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">Price chart and company data</a>
    </details>`;
  }).join("") || '<p class="data-note">No qualified model instruments to show.</p>';
}

async function renderMarketFramework(results, marketContext, news) {
  const version = ++frameworkVersion;
  const qualified = results.filter((item) => item.dataQuality?.eligible && Number.isFinite(item.score));
  const yearOutlookItems = news.items.filter((item) => item.horizon === "recent-year");
  const yearSourceCount = unique(yearOutlookItems.map((item) => item.sourceId)).length;
  const above200 = qualified.filter((item) => item.latest > item.sma200).length;
  const positiveSixMonth = qualified.filter((item) => item.sixMonth > 0).length;
  const highRisk = qualified.filter((item) => item.volatility > 0.45 || item.drawdown < -0.18).length;
  const equities = results.filter((item) => !item.isFund && item.instrumentType !== "ETF");
  const coverage = `<dl class="key-values">
    ${metric("Qualified price histories", `${qualified.length}/${results.length}`)}
    ${metric("Above 200-day average", `${above200}/${qualified.length}`)}
    ${metric("Positive six-month change", `${positiveSixMonth}/${qualified.length}`)}
    ${metric("Elevated volatility / drawdown", highRisk)}
    ${metric("Recent-year outlook items", `${yearOutlookItems.length} from ${yearSourceCount} sources`)}
  </dl>`;
  els.marketFramework.innerHTML = `${coverage}<p class="data-note">Loading company-data coverage…</p>`;
  const snapshot = await loadFundamentalsSnapshot();
  if (version !== frameworkVersion) return;
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const records = equities.map((item) => snapshot.byTicker?.[item.ticker]).filter(Boolean);
  const available = records.filter((record) => record.available === true);
  const fresh = available.filter((record) => {
    const time = new Date(record.retrievedAt || "").getTime();
    return Number.isFinite(time) && time <= now && now - time < 10 * 86400000;
  });
  const earnings = records.filter((record) => record.earnings?.status === "confirmed"
    && /^\d{4}-\d{2}-\d{2}$/.test(record.earnings.date || "") && record.earnings.date >= today && safeUrl(record.earnings.sourceUrl));
  const providers = unique(available.map((record) => record.provider).filter(Boolean));
  els.marketFramework.innerHTML = `${coverage}<dl class="key-values">
    ${metric("Company data available", `${available.length}/${equities.length} companies`)}
    ${metric("Retrieved within 10 days", `${fresh.length}/${available.length} available records`)}
    ${metric("Confirmed upcoming earnings", `${earnings.length} covered companies`)}
  </dl>
  <details class="secondary-details"><summary>Data coverage and scoring</summary>
    <p>${available.length ? `Company figures come from ${escapeHtml(providers.join(" and ") || "the published snapshot")}. Reporting periods and source links appear on each company detail page.` : escapeHtml(snapshot.reason || "Company financial records are unavailable for the scanned companies.")}</p>
    <p>Company financials and the limited confirmed earnings calendar are shown on Detail. They are not part of the technical score.</p>
    <p>Scores combine price trend, momentum, volatility, drawdown, volume, and matched news or outlooks. Sample or stale histories cannot generate a signal.</p>
    <p>Bid-ask spreads, analyst revisions, and options activity are not included.</p>
    ${earnings.length ? `<ul>${earnings.map((record) => `<li><a href="${escapeHtml(safeUrl(record.earnings.sourceUrl))}" target="_blank" rel="noopener noreferrer">${escapeHtml(record.ticker)} · ${escapeHtml(record.earnings.date)}</a></li>`).join("")}</ul>` : ""}
  </details>`;
}

function renderSourceStatus(sources, configured) {
  const feeds = sources.filter((source) => source.id !== "live-source-index");
  const loaded = feeds.filter((source) => source.ok);
  const matched = loaded.filter((source) => source.count > 0);
  const indexSource = sources.find((source) => source.id === "live-source-index");
  els.sourceStatus.innerHTML = `
    <p class="data-note">${loaded.length}/${configured} feeds loaded · ${matched.length} returned matching articles.</p>
    <details class="secondary-details"><summary>Feed status (${feeds.length})</summary>
      ${indexSource ? `<p class="data-note">${escapeHtml(indexSource.ok ? indexSource.meta || "Source index loaded." : indexSource.error || "Source index unavailable.")}</p>` : ""}
      <div class="source-list">${feeds.map((source) => `<div class="source-card ${source.ok ? "source-ok" : "source-fail"}"><strong>${escapeHtml(source.name)}</strong><span>${escapeHtml(source.ok ? `${source.count || 0} matching articles${source.via ? ` · ${source.via}` : ""}` : source.error || "Unavailable")}</span></div>`).join("")}</div>
    </details>
  `;
}

function renderRanking(results) {
  els.analysisResults.innerHTML = results.length
    ? `<div class="scan-list">${scanListHeading()}${results.map((item) => renderScanRow(item, { showDetails: false })).join("")}</div>`
    : '<div class="empty-state">No qualified instruments to rank. Recent real price history is required.</div>';
}

function metric(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "Unavailable")}</dd></div>`;
}

function safeUrl(value) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; }
  catch { return ""; }
}

function dateLabel(value) {
  const time = dateValue(String(value || "").replace(/^(\d{8})T(\d{6})Z?$/, "$1$2"));
  return time ? new Date(time).toLocaleDateString() : "Date unavailable";
}

function evidenceScope(article, ticker) {
  return article.directTickers?.includes(ticker) ? "Direct company evidence" : article.sectorTickers?.includes(ticker) ? "Sector context" : "Market context";
}
