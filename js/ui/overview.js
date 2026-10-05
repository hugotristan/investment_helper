import { calculateHoldings } from "../analysis/holdings.js";
import { getPortfolioHoldings } from "../features/portfolio.js";
import { formatNumber, formatPercent } from "../shared/format.js";
import { parseTickers } from "../shared/symbols.js";
import { escapeHtml } from "../shared/text.js";
import { state } from "../storage.js";

const periods = { "1M": 1, "3M": 3, "1Y": 12 };
const selectedPeriods = new Map();
const boundCharts = new WeakSet();
const chartInteractions = new WeakMap();
const colors = ["#7189ff", "#36c8b1", "#f3bd66", "#c38af5", "#607085"];
let latestOverview = null;

export function renderDashboardOverview(results, priceSource, news, marketContext, quotes, { researchPending = false } = {}) {
  const qualified = results.filter((item) => item.dataQuality?.eligible && Number.isFinite(item.score));
  latestOverview = { results: qualified, priceSource, quotes };
  const trusted = (news?.sources || []).filter((source) => source.ok && source.id !== "live-source-index").length;
  const scores = results.map((item) => item.score).filter(Number.isFinite);
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;
  const stats = [
    ["Instruments scanned", results.length, "Watchlist + discovery universe", "scan"],
    ["Average model score", average === null ? "—" : `${average}/100`, researchPending ? "Price signals · research pending" : "Trend, momentum & risk combined", "score"],
    ["Live quote snapshots", quotes?.count || 0, quotes?.count ? `Of ${quotes.total} requested symbols` : "Daily chart prices used instead", "quote"],
    ["Trusted sources", researchPending ? "Pending" : trusted, researchPending ? "Research scan is still running" : `Of ${news?.configured || 0} research sources`, "source"]
  ];
  setHtml("dashboardStats", stats.map(([label, value, note, icon]) => `
    <article class="stat-card">
      <span class="stat-icon" aria-hidden="true">${statIcon(icon)}</span>
      <span class="stat-label">${escapeHtml(label)}</span>
      <strong class="stat-value">${escapeHtml(value)}</strong>
      <span class="stat-note">${escapeHtml(note)}</span>
    </article>`).join(""));
  const watched = new Set(parseTickers(state.tickerInput));
  setHtml("featuredStocks", qualified.filter((item) => watched.has(item.ticker)).slice(0, 4).map((item, index) => featuredStock(item, quotes, priceSource, index)).join("")
    || '<p class="empty-state">No qualified price history for your watchlist yet. Add stocks or ETFs below; sample, stale, and incomplete data cannot generate signals.</p>');
  renderTrends();
  renderPortfolioSnapshot();
  const top = qualified[0];
  const excludedCount = results.length - qualified.length;
  const activity = [
    ["Market regime", marketContext?.label || "Not available", `${marketContext?.liveCount || 0}/${marketContext?.total || 11} qualified market proxies`],
    ["Research coverage", researchPending ? "Research scan running" : `${news?.items?.length || 0} relevant headlines`, researchPending ? "Price charts are ready. Headlines and source checks will follow." : `${trusted} trusted sources active in this scan`],
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
  const marketProxies = ["SPY", "QQQ"].map((ticker) => results.find((item) => item.ticker === ticker)).filter(Boolean);
  const selected = marketProxies.length === 2 ? marketProxies : results.slice(0, 2);
  const interactive = [];
  container.innerHTML = selected.map((item, index) => {
    const period = selectedPeriods.get(item.ticker) || "3M";
    const { points, partial } = periodHistory(item, periods[period]);
    const change = points.length > 1 ? points.at(-1).close / points[0].close - 1 : null;
    const quote = quotes?.byTicker?.get(item.ticker) || item.quote;
    const sample = isSample(item, priceSource);
    interactive.push({ points, currency: quote?.currency || item.currency || "", ticker: item.ticker });
    const range = points.length ? `${dateLabel(points[0].date)} – ${dateLabel(points.at(-1).date)}` : "Price history unavailable";
    return `<article class="trend-card" style="--stock-accent:${colors[index]}">
      <div class="trend-head"><div><span class="eyebrow">${sample ? "Sample price history" : "Price history"}</span>
        <h3><a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</a></h3></div>
        <div class="chart-periods" role="group" aria-label="${escapeHtml(item.ticker)} price history period">
          ${Object.keys(periods).map((label) => `<button type="button" data-chart-ticker="${escapeHtml(item.ticker)}" data-chart-period="${label}" aria-pressed="${label === period}" class="${label === period ? "active" : ""}">${label}</button>`).join("")}
        </div></div>
      <div class="trend-price"><strong>${priceLabel(item, quote)}</strong><span class="${changeClass(change)}">${percentLabel(change)} <small>in displayed period</small></span></div>
      <div class="trend-chart">${priceChart(item, points, false, `trend-${index}`)}</div>
      <output class="chart-readout" id="chart-readout-${index}" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(chartReadout(points.at(-1), quote?.currency || item.currency || ""))}</output>
      <div class="chart-axis"><span>${escapeHtml(dateLabel(points[0]?.date))}</span><span>${escapeHtml(dateLabel(points.at(-1)?.date))}</span></div>
      <p class="chart-caption">${escapeHtml(range)} · ${sample ? "Generated fallback data" : "Daily closing prices"}${partial ? " · available history only" : ""}${quote && !sample ? " · latest point updated from quote" : ""}<span class="chart-instructions">Hover or touch to inspect. Keyboard: ← →, Home, End.</span></p>
    </article>`;
  }).join("") || '<p class="empty-state">Price charts will appear after your first scan.</p>';
  container.querySelectorAll("svg[data-chart-inspect]").forEach((svg) => {
    const data = interactive[Number(svg.dataset.chartInspect)];
    if (!data || data.points.length < 2) return;
    const cursor = document.createElementNS("http://www.w3.org/2000/svg", "line");
    cursor.setAttribute("class", "chart-cursor");
    cursor.setAttribute("y1", "10");
    cursor.setAttribute("y2", "170");
    cursor.setAttribute("aria-hidden", "true");
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("class", "chart-cursor-dot");
    dot.setAttribute("r", "4");
    dot.setAttribute("aria-hidden", "true");
    svg.append(cursor, dot);
    const interaction = { ...data, coordinates: chartGeometry(data.points, false).coordinates, cursor, dot,
      readout: svg.closest(".trend-card").querySelector(".chart-readout"), index: data.points.length - 1 };
    chartInteractions.set(svg, interaction);
    inspectChartPoint(svg, interaction.index);
  });
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
    container.addEventListener("pointermove", (event) => inspectPointer(event, container));
    container.addEventListener("pointerdown", (event) => {
      const svg = inspectionTarget(event, container);
      if (!svg) return;
      svg.focus({ preventScroll: true });
      inspectPointer(event, container);
      if (event.pointerType === "touch") svg.setPointerCapture?.(event.pointerId);
    });
    container.addEventListener("focusin", (event) => {
      const svg = inspectionTarget(event, container);
      const interaction = svg && chartInteractions.get(svg);
      if (interaction) inspectChartPoint(svg, interaction.index);
    });
    container.addEventListener("keydown", (event) => {
      const svg = inspectionTarget(event, container);
      const interaction = svg && chartInteractions.get(svg);
      if (!interaction || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? interaction.points.length - 1
        : interaction.index + (event.key === "ArrowLeft" ? -1 : 1);
      inspectChartPoint(svg, index);
    });
    boundCharts.add(container);
  }
}

function inspectionTarget(event, container) {
  const svg = event.target?.closest?.("svg[data-chart-inspect]");
  return svg && container.contains(svg) ? svg : null;
}

function inspectPointer(event, container) {
  const svg = inspectionTarget(event, container);
  const interaction = svg && chartInteractions.get(svg);
  if (!interaction) return;
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !Number.isFinite(event.clientX)) return;
  const x = (event.clientX - rect.left) / rect.width * 600;
  const index = Math.round((x - 10) / 580 * (interaction.points.length - 1));
  inspectChartPoint(svg, index);
}

function inspectChartPoint(svg, requested) {
  const interaction = chartInteractions.get(svg);
  if (!interaction) return;
  const index = Math.min(interaction.points.length - 1, Math.max(0, requested));
  const [x, y] = interaction.coordinates[index];
  interaction.index = index;
  interaction.cursor.setAttribute("x1", String(x));
  interaction.cursor.setAttribute("x2", String(x));
  interaction.dot.setAttribute("cx", String(x));
  interaction.dot.setAttribute("cy", String(y));
  const readout = chartReadout(interaction.points[index], interaction.currency);
  if (interaction.readout && interaction.readout.textContent !== readout) interaction.readout.textContent = readout;
}

function chartReadout(point, currency) {
  if (!point || !Number.isFinite(point.close)) return "Price history unavailable";
  const price = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(point.close);
  return `${dateLabel(point.date)} · ${price}${currency ? ` ${currency}` : ""}`;
}

export function renderPortfolioSnapshot() {
  const portfolio = calculateHoldings(getPortfolioHoldings(), latestOverview?.results || []);
  if (!portfolio.holdings.length) {
    setHtml("portfolioSnapshot", `<div class="portfolio-empty"><span class="portfolio-empty-icon" aria-hidden="true">${statIcon("quote")}</span>
      <strong>Your portfolio starts here</strong><p>Add your holdings to see how your allocation is spread.</p>
      <a class="button secondary" href="#portfolio">Add holdings <span aria-hidden="true">↗</span></a></div>`);
    return;
  }
  setHtml("portfolioSnapshot", `<p class="snapshot-caption">${portfolio.holdings.length} holding${portfolio.holdings.length === 1 ? "" : "s"} · currency totals shown separately</p>
    ${portfolio.groups.map((group) => snapshotCurrencyGroup(group, portfolio.holdings)).join("")}
    <a class="snapshot-link" href="#portfolio">Manage portfolio <span aria-hidden="true">↗</span></a>`);
}

function snapshotCurrencyGroup(group, allHoldings) {
  const holdings = allHoldings.filter((holding) => holding.currency === group.currency)
    .sort((a, b) => (b.currentValue ?? -1) - (a.currentValue ?? -1));
  const missing = holdings.filter((holding) => !Number.isFinite(holding.currentValue));
  const rows = holdings.slice(0, 4).map((holding) => ({ ...holding }));
  const remaining = holdings.slice(4).filter((holding) => Number.isFinite(holding.currentValue));
  if (remaining.length) {
    const currentValue = remaining.reduce((sum, holding) => sum + holding.currentValue, 0);
    rows.push({ ticker: "Others", label: `${remaining.length} other valued holdings`, currentValue,
      weight: group.total > 0 ? currentValue / group.total * 100 : null, source: "combined", currency: group.currency });
  }
  const valued = rows.filter((holding) => Number.isFinite(holding.currentValue));
  const label = !group.complete ? "Partial known value" : group.legacyCount ? "Tracked value" : "Current value";
  const gain = Number.isFinite(group.gain)
    ? `<p class="snapshot-gain ${changeClass(group.gain)}">Unrealized ${group.gain > 0 ? "+" : ""}${escapeHtml(snapshotMoney(group.gain, group.currency))}${group.costBasis > 0 ? ` · ${escapeHtml(formatPercent(group.gain / group.costBasis))}` : ""}</p>`
    : `<p class="snapshot-caption">${group.legacyCount ? "Gain/loss needs shares and purchase cost for amount-only holdings." : "Gain/loss unavailable until all prices match the purchase currency."}</p>`;
  return `<section class="snapshot-currency-group"><span class="snapshot-caption">${escapeHtml(label)} · ${escapeHtml(group.currency)}</span>
    <strong class="snapshot-total">${Number.isFinite(group.total) ? escapeHtml(snapshotMoney(group.total, group.currency)) : "Unavailable"}</strong>
    ${gain}
    ${group.legacyCount ? `<p class="snapshot-caption">Includes ${group.legacyCount} manually entered amount${group.legacyCount === 1 ? "" : "s"}.</p>` : ""}
    ${valued.length && group.total > 0 ? `<div class="allocation-bar" aria-label="Allocation of known ${escapeHtml(group.currency)} values">${valued.map((holding) => {
      const index = rows.indexOf(holding);
      const weight = holding.currentValue / group.total * 100;
      return `<span style="width:${weight.toFixed(3)}%;background:${colors[index]}" title="${escapeHtml(holding.ticker)} ${weight.toFixed(1)}%"></span>`;
    }).join("")}</div>` : ""}
    <div class="allocation-legend">${rows.map((holding, index) => {
      const known = Number.isFinite(holding.currentValue);
      const source = holding.source === "manual" ? "Entered amount" : holding.source === "daily" ? "Daily close" : holding.source === "quote" ? "Live quote" : holding.source === "combined" ? holding.label : "Price unavailable";
      return `<div class="snapshot-row"><span class="allocation-dot" style="background:${colors[index]}" aria-hidden="true"></span>
      <div><strong>${escapeHtml(holding.ticker)}</strong><span title="${escapeHtml(holding.label || holding.ticker)}">${escapeHtml(source)}</span></div>
      <div><strong>${known ? escapeHtml(snapshotMoney(holding.currentValue, group.currency)) : "Unavailable"}</strong><span>${known && group.total > 0 ? `${(holding.currentValue / group.total * 100).toFixed(1)}% of known value` : "Quote needed"}</span></div></div>`;
    }).join("")}</div>
    ${missing.length ? `<p class="snapshot-unavailable">${missing.length} unpriced holding${missing.length === 1 ? "" : "s"}: ${escapeHtml(missing.slice(0, 3).map((holding) => holding.ticker).join(", "))}${missing.length > 3 ? ` +${missing.length - 3} more` : ""}. Partial values exclude unavailable prices.</p>` : ""}
  </section>`;
}

function snapshotMoney(value, currency) {
  return `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${currency}`;
}

function priceChart(item, points, mini, id) {
  if (points.length < 2) return '<span class="chart-empty">Price history unavailable</span>';
  const { width, height, pad, coordinates } = chartGeometry(points, mini);
  const path = coordinates.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${path} L${width - pad},${height} L${pad},${height} Z`;
  const grid = mini ? "" : [0.2, 0.5, 0.8].map((fraction) => `<line class="chart-grid" x1="0" y1="${height * fraction}" x2="${width}" y2="${height * fraction}"/>`).join("");
  const label = `${item.ticker} price history, ${dateLabel(points[0].date)} to ${dateLabel(points.at(-1).date)}: ${formatNumber(points[0].close)} to ${formatNumber(points.at(-1).close)}. Use left and right arrows, Home, or End to inspect prices.`;
  const chartIndex = id.replace("trend-", "");
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" ${mini ? 'aria-hidden="true"' : `tabindex="0" role="img" data-chart-inspect="${escapeHtml(chartIndex)}" aria-keyshortcuts="ArrowLeft ArrowRight Home End" aria-describedby="chart-readout-${escapeHtml(chartIndex)}" aria-label="${escapeHtml(label)}"`}>
    <defs><linearGradient id="overview-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="currentColor" stop-opacity="0.22"/><stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path class="chart-area" d="${area}" fill="url(#overview-${id})"/>
    <path class="chart-line" d="${path}" fill="none" stroke="currentColor" stroke-width="${mini ? 1.8 : 2.4}" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function chartGeometry(points, mini) {
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
  return { width, height, pad, coordinates };
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
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
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
