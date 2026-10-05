import { parsePortfolioPositions } from "../features/portfolio.js";
import { formatNumber, formatPercent, money } from "../shared/format.js";
import { escapeHtml } from "../shared/text.js";
import { state } from "../storage.js";

const periods = { "1M": 1, "3M": 3, "1Y": 12 };
const selectedPeriods = new Map();
const boundCharts = new WeakSet();
const colors = ["#7189ff", "#36c8b1", "#f3bd66", "#c38af5", "#607085"];
let latestOverview = null;

export function renderDashboardOverview(results, priceSource, news, marketContext, quotes) {
  const qualified = results.filter((item) => item.dataQuality?.eligible && Number.isFinite(item.score));
  latestOverview = { results: qualified, priceSource, quotes };
  const trusted = (news?.sources || []).filter((source) => source.ok && source.id !== "live-source-index").length;
  const scores = results.map((item) => item.score).filter(Number.isFinite);
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;
  const stats = [
    ["Instruments scanned", results.length, "Stocks & ETFs in your watchlist", "scan"],
    ["Average model score", average === null ? "—" : `${average}/100`, "Trend, momentum & risk combined", "score"],
    ["Live quote snapshots", quotes?.count || 0, quotes?.count ? `Of ${quotes.total} requested symbols` : "Daily chart prices used instead", "quote"],
    ["Trusted sources", trusted, `Of ${news?.configured || 0} research sources`, "source"]
  ];
  setHtml("dashboardStats", stats.map(([label, value, note, icon]) => `
    <article class="stat-card">
      <span class="stat-icon" aria-hidden="true">${statIcon(icon)}</span>
      <span class="stat-label">${escapeHtml(label)}</span>
      <strong class="stat-value">${escapeHtml(value)}</strong>
      <span class="stat-note">${escapeHtml(note)}</span>
    </article>`).join(""));
  setHtml("featuredStocks", qualified.slice(0, 4).map((item, index) => featuredStock(item, quotes, priceSource, index)).join("")
    || '<p class="empty-state">No qualified price history yet. Sample, stale, and incomplete data cannot generate market signals.</p>');
  renderTrends();
  renderPortfolioSnapshot();
  const top = qualified[0];
  const excludedCount = results.length - qualified.length;
  const activity = [
    ["Market regime", marketContext?.label || "Not available", `${marketContext?.liveCount || 0}/${marketContext?.total || 11} qualified market proxies`],
    ["Research coverage", `${news?.items?.length || 0} relevant headlines`, `${trusted} trusted sources active in this scan`],
    ["Leading instrument", top ? `${top.ticker} · ${top.score}/100` : "No result yet", top?.setup?.signal || top?.label || "Scan your watchlist to find a leader"],
    ["Price data", `${qualified.length}/${results.length} instruments qualified`, excludedCount ? `${excludedCount} excluded: sample, stale, or incomplete history. See the screener for coverage.` : "Recent real daily history. Signal strength is a rules-based score, not a measured success probability."]
  ];
  setHtml("scanActivity", activity.map(([label, title, note], index) => `
    <div class="activity-row"><span class="activity-dot" style="--activity-color:${colors[index]}" aria-hidden="true"></span>
      <div><span class="activity-label">${escapeHtml(label)}</span><strong class="activity-title">${escapeHtml(title)}</strong>
      <span class="activity-note">${escapeHtml(note)}</span></div>
    </div>`).join(""));
}

function featuredStock(item, quotes, priceSource, index) {
  const quote = quotes?.byTicker?.get(item.ticker) || item.quote;
  const sample = isSample(item, priceSource);
  const change = Number.isFinite(quote?.dayChangePercent) ? quote.dayChangePercent : item.oneDay;
  return `<article class="featured-stock" style="--stock-accent:${colors[index]}">
    <div class="featured-stock-head"><span class="stock-avatar" aria-hidden="true">${escapeHtml(item.ticker.slice(0, 2))}</span>
      <div><a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</a>
      <span class="stock-name">${escapeHtml(quote?.name || item.ticker)}</span></div>
      <span class="stock-score">${escapeHtml(item.score)}/100</span></div>
    <div class="featured-stock-price"><strong>${priceLabel(item, quote)}</strong>
      <span class="${changeClass(change)}">${percentLabel(change)} <small>1D</small></span></div>
    <div class="mini-chart">${priceChart(item, chartPoints(item).slice(-40), true, `featured-${index}`)}</div>
    <span class="stock-meta">${escapeHtml(item.setup?.signal || item.label || "Model signal")} · as of ${escapeHtml(dateLabel(item.dataQuality?.asOf))}</span>
  </article>`;
}

function renderTrends() {
  const container = document.getElementById("marketTrends");
  if (!container || !latestOverview) return;
  const { results, priceSource, quotes } = latestOverview;
  const selected = results.slice(0, 2);
  container.innerHTML = selected.map((item, index) => {
    const period = selectedPeriods.get(item.ticker) || "3M";
    const { points, partial } = periodHistory(item, periods[period]);
    const change = points.length > 1 ? points.at(-1).close / points[0].close - 1 : null;
    const quote = quotes?.byTicker?.get(item.ticker) || item.quote;
    const sample = isSample(item, priceSource);
    const range = points.length ? `${dateLabel(points[0].date)} – ${dateLabel(points.at(-1).date)}` : "Price history unavailable";
    return `<article class="trend-card" style="--stock-accent:${colors[index]}">
      <div class="trend-head"><div><span class="eyebrow">${sample ? "Sample price history" : "Price history"}</span>
        <h3><a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</a></h3></div>
        <div class="chart-periods" role="group" aria-label="${escapeHtml(item.ticker)} price history period">
          ${Object.keys(periods).map((label) => `<button type="button" data-chart-ticker="${escapeHtml(item.ticker)}" data-chart-period="${label}" aria-pressed="${label === period}" class="${label === period ? "active" : ""}">${label}</button>`).join("")}
        </div></div>
      <div class="trend-price"><strong>${priceLabel(item, quote)}</strong><span class="${changeClass(change)}">${percentLabel(change)} <small>in displayed period</small></span></div>
      <div class="trend-chart">${priceChart(item, points, false, `trend-${index}`)}</div>
      <div class="chart-axis"><span>${escapeHtml(dateLabel(points[0]?.date))}</span><span>${escapeHtml(dateLabel(points.at(-1)?.date))}</span></div>
      <p class="chart-caption">${escapeHtml(range)} · ${sample ? "Generated fallback data" : "Daily closing prices"}${partial ? " · available history only" : ""}${quote && !sample ? " · latest point updated from quote" : ""}</p>
    </article>`;
  }).join("") || '<p class="empty-state">Price charts will appear after your first scan.</p>';
  if (!boundCharts.has(container)) {
    container.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-chart-period]");
      if (!button || !container.contains(button) || !periods[button.dataset.chartPeriod]) return;
      selectedPeriods.set(button.dataset.chartTicker, button.dataset.chartPeriod);
      renderTrends();
      container.querySelectorAll("[data-chart-period]").forEach((replacement) => {
        if (replacement.dataset.chartTicker === button.dataset.chartTicker && replacement.dataset.chartPeriod === button.dataset.chartPeriod) replacement.focus();
      });
    });
    boundCharts.add(container);
  }
}

export function renderPortfolioSnapshot() {
  const holdings = parsePortfolioPositions(state.myPortfolioInput).sort((a, b) => b.amount - a.amount);
  const total = holdings.reduce((sum, holding) => sum + holding.amount, 0);
  if (!total) {
    setHtml("portfolioSnapshot", `<div class="portfolio-empty"><span class="portfolio-empty-icon" aria-hidden="true">${statIcon("quote")}</span>
      <strong>Your portfolio starts here</strong><p>Add your holdings to see how your allocation is spread.</p>
      <a class="button secondary" href="#portfolio">Add holdings <span aria-hidden="true">↗</span></a></div>`);
    return;
  }
  const rows = holdings.slice(0, 4).map((holding) => ({ ...holding, weight: holding.amount / total * 100 }));
  if (holdings.length > 4) {
    const others = holdings.slice(4).reduce((sum, holding) => sum + holding.amount, 0);
    rows.push({ ticker: "Others", label: `${holdings.length - 4} other holdings`, amount: others, weight: others / total * 100 });
  }
  setHtml("portfolioSnapshot", `<span class="snapshot-caption">Manually entered portfolio value</span>
    <strong class="snapshot-total">${escapeHtml(money(total))}</strong>
    <p class="snapshot-caption">${holdings.length} holding${holdings.length === 1 ? "" : "s"} · amounts saved in this browser</p>
    <div class="allocation-bar" aria-label="Portfolio allocation">${rows.map((holding, index) => `<span style="width:${holding.weight.toFixed(3)}%;background:${colors[index]}" title="${escapeHtml(holding.ticker)} ${holding.weight.toFixed(1)}%"></span>`).join("")}</div>
    <div class="allocation-legend">${rows.map((holding, index) => `<div class="snapshot-row"><span class="allocation-dot" style="background:${colors[index]}" aria-hidden="true"></span>
      <div><strong>${escapeHtml(holding.ticker)}</strong><span>${escapeHtml(holding.label)}</span></div>
      <div><strong>${escapeHtml(money(holding.amount))}</strong><span>${holding.weight.toFixed(1)}%</span></div></div>`).join("")}</div>
    <a class="snapshot-link" href="#portfolio">Manage portfolio <span aria-hidden="true">↗</span></a>`);
}

function priceChart(item, points, mini, id) {
  if (points.length < 2) return '<span class="chart-empty">Price history unavailable</span>';
  const width = mini ? 300 : 600;
  const height = mini ? 54 : 180;
  const pad = mini ? 2 : 10;
  const min = Math.min(...points.map((point) => point.close));
  const max = Math.max(...points.map((point) => point.close));
  const spread = max - min || Math.max(max * 0.01, 1);
  const coordinates = points.map((point, index) => [
    pad + index / (points.length - 1) * (width - pad * 2),
    height - pad - ((point.close - min) / spread) * (height - pad * 2)
  ]);
  const path = coordinates.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${path} L${width - pad},${height} L${pad},${height} Z`;
  const grid = mini ? "" : [0.2, 0.5, 0.8].map((fraction) => `<line class="chart-grid" x1="0" y1="${height * fraction}" x2="${width}" y2="${height * fraction}"/>`).join("");
  const label = `${item.ticker} price history, ${dateLabel(points[0].date)} to ${dateLabel(points.at(-1).date)}: ${formatNumber(points[0].close)} to ${formatNumber(points.at(-1).close)}`;
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" ${mini ? 'aria-hidden="true"' : `role="img" aria-label="${escapeHtml(label)}"`}>
    <defs><linearGradient id="overview-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="currentColor" stop-opacity="0.22"/><stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path class="chart-area" d="${area}" fill="url(#overview-${id})"/>
    <path class="chart-line" d="${path}" fill="none" stroke="currentColor" stroke-width="${mini ? 1.8 : 2.4}" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function chartPoints(item) {
  return (item.chartPrices || item.prices || [])
    .filter((point) => Number.isFinite(point.close) && point.close > 0 && Number.isFinite(new Date(point.date).getTime()))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function periodHistory(item, months) {
  const history = chartPoints(item);
  if (!history.length) return { points: [], partial: false };
  const end = new Date(history.at(-1).date);
  const cutoff = new Date(end);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay));
  return {
    points: history.filter((point) => new Date(point.date) >= cutoff),
    partial: new Date(history[0].date).getTime() > cutoff.getTime() + 7 * 24 * 60 * 60 * 1000
  };
}

function priceLabel(item, quote) {
  return `${escapeHtml(formatNumber(item.latest))}${quote?.currency ? ` <small>${escapeHtml(quote.currency)}</small>` : ""}`;
}

function percentLabel(value) {
  return Number.isFinite(value) ? escapeHtml(formatPercent(value)) : "—";
}

function changeClass(value) {
  return !Number.isFinite(value) || value === 0 ? "change-neutral" : value > 0 ? "change-positive" : "change-negative";
}

function dateLabel(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
}

function isSample(item, source) {
  return item.source === "sample" || source === "sample";
}

function setHtml(id, html) {
  const element = document.getElementById(id);
  if (element) element.innerHTML = html;
}

function statIcon(kind) {
  const paths = {
    scan: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    score: '<path d="M4 18V6m0 12h16M8 13l4-4 4 2 5-6"/><path d="M17 5h4v4"/>',
    quote: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 13h5M6 5V3h12v2"/>',
    source: '<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z"/><path d="m8 12 3 3 5-6"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg>`;
}
