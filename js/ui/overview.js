import { formatNumber, formatPercent } from "../shared/format.js";
import { parseTickers } from "../shared/symbols.js";
import { escapeHtml } from "../shared/text.js";
import { state } from "../storage.js";

const periods = { "1M": 1, "3M": 3, "1Y": 12 };
const selectedPeriods = new Map();
const boundCharts = new WeakSet();
const chartInteractions = new WeakMap();
const colors = ["#7189ff", "#36c8b1"];
let latestOverview = null;

export function renderDashboardOverview(results, priceSource, news, marketContext, quotes, { researchPending = false } = {}) {
  const qualified = results.filter((item) => item.dataQuality?.eligible && Number.isFinite(item.score));
  latestOverview = { results: qualified, priceSource };
  const activeSources = (news?.sources || []).filter((source) => source.ok && source.id !== "live-source-index").length;
  const scores = qualified.map((item) => item.score);
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;
  const stats = [
    ["Instruments scanned", results.length, "Watchlist and research universe"],
    ["Average technical score", average === null ? "—" : `${average}/100`, "Qualified price histories"],
    ["Quote snapshots", quotes?.count || 0, quotes?.count ? `Of ${quotes.total} requested symbols` : "Using daily prices"],
    ["Research sources", researchPending ? "Pending" : activeSources, researchPending ? "Research scan running" : `Of ${news?.configured || 0} configured sources`]
  ];
  setHtml("dashboardStats", stats.map(([label, value, note]) => `
    <article class="stat-card">
      <span class="stat-label">${escapeHtml(label)}</span>
      <strong class="stat-value">${escapeHtml(value)}</strong>
      <span class="stat-note">${escapeHtml(note)}</span>
    </article>`).join(""));
  const watched = parseTickers(state.tickerInput).slice(0, 6);
  setHtml("featuredStocks", watched.length ? `<ul class="watchlist-overview">${watched.map((ticker) =>
    featuredStock(results.find((item) => item.ticker === ticker) || { ticker }, quotes, priceSource)).join("")}</ul>`
    : '<p class="empty-state">Your watchlist is empty. <a href="#screener">Add a stock or ETF</a>.</p>');
  renderTrends();
  const top = qualified[0];
  const excludedCount = results.length - qualified.length;
  const activity = [
    ["Market regime", marketContext?.label || "Not available", `${marketContext?.liveCount || 0}/${marketContext?.total || 11} qualified market proxies`],
    ["Research coverage", researchPending ? "Research scan running" : `${news?.items?.length || 0} matched headlines`, researchPending ? "Headlines pending" : `${activeSources} sources responded`],
    ["Top technical score", top ? `${top.ticker} · ${top.score}/100` : "Unavailable", top?.setup?.signal || top?.label || "No qualified result"],
    ["Price data", `${qualified.length}/${results.length} histories qualified`, excludedCount ? `${excludedCount} sample, stale, or incomplete histories excluded` : "Recent real daily prices"]
  ];
  setHtml("scanActivity", activity.map(([label, title, note]) => `
    <div class="activity-row">
      <div><span class="activity-label">${escapeHtml(label)}</span><strong class="activity-title">${escapeHtml(title)}</strong>
      <span class="activity-note">${escapeHtml(note)}</span></div>
    </div>`).join(""));
}

function featuredStock(item, quotes, priceSource) {
  const quote = item.quote || quotes?.byTicker?.get(item.ticker);
  const quoteTime = quote?.quoteTime ? new Date(quote.quoteTime).getTime() : NaN;
  const now = Date.now();
  const qualified = item.dataQuality?.eligible && Number.isFinite(item.score) && !isSample(item, priceSource);
  const historyTime = new Date(item.dataQuality?.asOf || "").getTime();
  const recentQuote = Number.isFinite(quote?.price) && quote.price > 0 && Number.isFinite(quoteTime)
    && quoteTime <= now && now - quoteTime <= 7 * 86400000
    && (!quote.ticker || quote.ticker === item.ticker)
    && (!qualified || !Number.isFinite(historyTime) || quoteTime >= historyTime)
    && (!qualified || !item.currency || quote.currency === item.currency);
  const price = recentQuote ? quote.price : qualified ? item.latest : null;
  const currency = recentQuote ? quote.currency : item.currency;
  const change = recentQuote ? quote.dayChangePercent : qualified ? item.oneDay : null;
  const asOf = recentQuote ? quote.quoteTime : qualified ? item.dataQuality.asOf : null;
  const signal = qualified ? item.setup?.signal || item.label : item.dataQuality?.label || "Not scanned";
  return `<li class="watchlist-overview-row">
    <div class="watchlist-overview-name"><a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</a>
      <span>${escapeHtml(quote?.name || item.name || item.ticker)}</span></div>
    <div class="watchlist-overview-price"><strong>${Number.isFinite(price) ? `${escapeHtml(new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price))}${currency ? ` ${escapeHtml(currency)}` : ""}` : "Unavailable"}</strong>
      <small>${asOf ? escapeHtml(dateLabel(asOf)) : "Price unavailable"}</small></div>
    <div class="watchlist-overview-change ${changeClass(change)}"><span>${percentLabel(change)}</span><small>Today</small></div>
    <span class="watchlist-overview-signal">${escapeHtml(signal || "Unavailable")}</span>
  </li>`;
}

function renderTrends() {
  const container = document.getElementById("marketTrends");
  if (!container || !latestOverview) return;
  const { results, priceSource } = latestOverview;
  const selected = ["SPY", "QQQ"].map((ticker) => results.find((item) => item.ticker === ticker && !isSample(item, priceSource))).filter(Boolean);
  const interactive = [];
  container.innerHTML = selected.map((item, index) => {
    const period = selectedPeriods.get(item.ticker) || "3M";
    const { points, partial } = periodHistory(item, periods[period]);
    const change = points.length > 1 ? points.at(-1).close / points[0].close - 1 : null;
    const quote = chartQuote(item);
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
  }).join("") || '<p class="empty-state">Index charts unavailable. SPY and QQQ need recent real price history.</p>';
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

function priceChart(item, points, mini, id) {
  if (points.length < 2) return '<span class="chart-empty">Price history unavailable</span>';
  const { width, height, pad, coordinates } = chartGeometry(points, mini);
  const path = coordinates.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${path} L${width - pad},${height} L${pad},${height} Z`;
  const grid = mini ? "" : [0.2, 0.5, 0.8].map((fraction) => `<line class="chart-grid" x1="0" y1="${height * fraction}" x2="${width}" y2="${height * fraction}"/>`).join("");
  const label = `${item.ticker} price history, ${dateLabel(points[0].date)} to ${dateLabel(points.at(-1).date)}: ${formatNumber(points[0].close)} to ${formatNumber(points.at(-1).close)}. Use left and right arrows, Home, or End to inspect prices.`;
  const chartIndex = id.replace("trend-", "");
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" ${mini ? 'aria-hidden="true"' : `tabindex="0" role="img" data-chart-inspect="${escapeHtml(chartIndex)}" aria-keyshortcuts="ArrowLeft ArrowRight Home End" aria-describedby="chart-readout-${escapeHtml(chartIndex)}" aria-label="${escapeHtml(label)}"`}>
    ${grid}<path class="chart-area" d="${area}" fill="currentColor" fill-opacity="0.06"/>
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
  const currency = quote?.currency || item.currency;
  return `${escapeHtml(formatNumber(item.latest))}${currency ? ` <small>${escapeHtml(currency)}</small>` : ""}`;
}

function chartQuote(item) {
  const quote = item.quote;
  const time = quote?.quoteTime ? new Date(quote.quoteTime).getTime() : NaN;
  const historyTime = new Date(item.dataQuality?.asOf || "").getTime();
  const now = Date.now();
  return quote && Number.isFinite(time) && time <= now && now - time <= 7 * 86400000
    && time >= historyTime && Number.isFinite(quote.price) && quote.price === item.latest
    && (!quote.ticker || quote.ticker === item.ticker) && (!item.currency || quote.currency === item.currency) ? quote : null;
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
