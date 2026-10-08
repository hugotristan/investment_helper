import { evaluateDataQuality, validHistoryPoints } from "../analysis/data-quality.js";
import { formatPercent } from "../shared/format.js";
import { escapeHtml } from "../shared/text.js";

const DAY = 86400000;
const periods = { "1M": 1, "3M": 3, "1Y": 12 };
const bound = new WeakSet();
const views = new WeakMap();
let selectedPeriod = "3M";
let latestInput = null;

// Restore the actual daily close before drawing: a live quote can replace the
// final price in the scan, but cannot become a completed daily observation.
function dailyHistory(item, now) {
  if (!item || item.dataQuality?.eligible === false || /^sample\b/i.test(item.source || "")) return [];
  let points = validHistoryPoints({ prices: item.prices || item.chartPrices || [] }).map((point) => ({ ...point }));
  if (item.quote || /intraday/i.test(item.source || "")) {
    const original = item.dailyClose;
    const last = points.at(-1);
    if (last && Number.isFinite(original?.price) && original.price > 0
      && day(original.asOf) === day(last.date) && (!item.currency || original.currency === item.currency)) {
      points[points.length - 1] = { ...last, close: original.price };
    } else points = points.slice(0, -1);
  }
  points = points.filter((point) => day(point.date) < day(now));
  if (!evaluateDataQuality({ ...item, prices: points, historyAsOf: points.at(-1)?.date }, now).eligible) return [];
  return points;
}

export function buildIndexComparison(results, period = "3M", { now = Date.now(), priceSource = "" } = {}) {
  if (/^sample\b/i.test(priceSource)) return unavailable("Recent real index history is unavailable.");
  const available = ["SPY", "QQQ"].map((ticker) => {
    const item = results.find((result) => result.ticker === ticker);
    const points = dailyHistory(item, now);
    return { ticker, currency: item?.currency || "", points, byDay: new Map(points.map((point) => [day(point.date), point.close])) };
  }).filter((series) => series.points.length >= 2);
  if (!available.length) return unavailable("SPY and QQQ need recent real daily price history.");
  let dates = [...available[0].byDay.keys()].filter((date) => available.every((series) => series.byDay.has(date)));
  if (dates.length < 2) return unavailable("There are not enough matching index dates to compare.");
  const cutoff = monthCutoff(dates.at(-1), periods[period] || 3);
  const partial = Date.parse(dates[0]) > cutoff + 7 * DAY;
  dates = dates.filter((date) => Date.parse(date) >= cutoff);
  if (dates.length < 2) return unavailable("There are not enough daily closes in this period.");
  const series = available.map((entry) => ({ ticker: entry.ticker, currency: entry.currency,
    closes: dates.map((date) => entry.byDay.get(date)),
    values: dates.map((date) => entry.byDay.get(date) / entry.byDay.get(dates[0]) - 1) }));
  if (series.some((entry) => !entry.values.every(finiteChange))) return unavailable("Index price changes could not be calculated from this history.");
  return { available: true, dates, series, partial,
    note: available.length === 1 ? `${available[0].ticker} only; the other index is unavailable.` : "Matching SPY and QQQ dates." };
}

function unavailable(reason) { return { available: false, reason, dates: [], series: [] }; }

function monthCutoff(date, months) {
  const end = new Date(date);
  const requestedDay = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() - months);
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(requestedDay, last));
  return end.getTime();
}

export function comparisonGeometry(model) {
  const width = 760, height = 300;
  const plot = { left: 54, right: 16, top: 18, bottom: 38 };
  const values = model.series.flatMap((series) => series.values);
  const low = Math.min(0, ...values), high = Math.max(0, ...values);
  const padding = Math.max((high - low) * .12, .005);
  const min = low - padding, max = high + padding;
  const first = Date.parse(model.dates[0]), elapsed = Date.parse(model.dates.at(-1)) - first || 1;
  const xs = model.dates.map((date) => plot.left + (Date.parse(date) - first) / elapsed * (width - plot.left - plot.right));
  const y = (value) => height - plot.bottom - (value - min) / (max - min) * (height - plot.top - plot.bottom);
  const paths = model.series.map((series) => series.values.map((value, index) => `${index ? "L" : "M"}${xs[index].toFixed(2)},${y(value).toFixed(2)}`).join(" "));
  const ticks = Array.from({ length: 5 }, (_, index) => min + (max - min) * index / 4);
  return { width, height, plot, xs, y, paths, ticks };
}

export function renderIndexComparison(results, priceSource) {
  const container = document.getElementById("overviewMarketChart");
  if (!container) return;
  latestInput = { results, priceSource };
  const model = buildIndexComparison(results, selectedPeriod, { priceSource });
  const controls = `<div class="market-chart-periods" role="group" aria-label="Index chart period">${Object.keys(periods).map((period) =>
    `<button type="button" data-market-period="${period}" aria-pressed="${period === selectedPeriod}" class="${period === selectedPeriod ? "active" : ""}">${period}</button>`).join("")}</div>`;
  if (!model.available) {
    container.innerHTML = `<div class="market-chart-toolbar">${controls}</div><p class="empty-state">${escapeHtml(model.reason)}</p>`;
    views.delete(container);
  } else {
    const geometry = comparisonGeometry(model);
    const { width, height, plot, xs, y, paths, ticks } = geometry;
    const classes = model.series.map((series) => series.ticker === "SPY" ? "market-series-primary" : "market-series-benchmark");
    const legend = model.series.map((series, index) => `<span><i class="market-legend-swatch ${classes[index]}" aria-hidden="true"></i>${series.ticker} <strong>${escapeHtml(formatPercent(series.values.at(-1)))}</strong></span>`).join("");
    const grids = ticks.map((value) => `<line class="market-chart-grid" x1="${plot.left}" x2="${width - plot.right}" y1="${y(value)}" y2="${y(value)}"/><text x="${plot.left - 8}" y="${y(value) + 4}" text-anchor="end">${(value * 100).toFixed(1)}%</text>`).join("");
    const label = `${model.series.map((series) => series.ticker).join(" and ")} daily closing-price change from ${dateLabel(model.dates[0])}. Use arrow keys, Home, and End to inspect.`;
    const last = model.dates.length - 1;
    container.innerHTML = `<div class="market-chart-toolbar"><div class="market-chart-legend">${legend}</div>${controls}</div>
      <svg class="market-comparison-chart" data-market-chart tabindex="0" role="img" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="${escapeHtml(label)}" aria-describedby="overviewChartReadout" aria-keyshortcuts="ArrowLeft ArrowRight Home End">
        ${grids}<line class="market-chart-zero" x1="${plot.left}" x2="${width - plot.right}" y1="${y(0)}" y2="${y(0)}"/>
        ${model.series[0].ticker === "SPY" ? `<path class="market-chart-area" d="${paths[0]} L${xs.at(-1)},${y(0)} L${xs[0]},${y(0)} Z"/>` : ""}
        ${paths.map((path, index) => `<path class="${classes[index]}" d="${path}" fill="none" stroke-width="2.2" vector-effect="non-scaling-stroke"/>`).join("")}
        <line data-market-cursor class="market-chart-cursor" x1="${xs[last]}" x2="${xs[last]}" y1="${plot.top}" y2="${height - plot.bottom}"/>
        ${model.series.map((series, index) => `<circle data-market-dot="${index}" class="market-chart-dot ${classes[index]}" cx="${xs[last]}" cy="${y(series.values[last])}" r="4" fill="currentColor"/>`).join("")}
        <text x="${plot.left}" y="${height - 8}">${escapeHtml(dateLabel(model.dates[0]))}</text><text x="${width - plot.right}" y="${height - 8}" text-anchor="end">${escapeHtml(dateLabel(model.dates.at(-1)))}</text>
      </svg><output id="overviewChartReadout" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(readout(model, last))}</output>
      <p class="market-chart-caption">${escapeHtml(model.note)}${model.partial ? " Available history only." : ""} Today's unfinished bar is excluded. Hover, touch, or use ← →, Home, End.</p>`;
    views.set(container, { model, geometry, index: last });
  }
  bindInteractions(container);
}

function bindInteractions(container) {
  if (bound.has(container)) return;
  container.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-market-period]");
    if (!button || !container.contains(button) || !periods[button.dataset.marketPeriod]) return;
    selectedPeriod = button.dataset.marketPeriod;
    if (latestInput) renderIndexComparison(latestInput.results, latestInput.priceSource);
    container.querySelector(`[data-market-period="${selectedPeriod}"]`)?.focus();
  });
  const pointer = (event) => {
    const svg = event.target.closest?.("svg[data-market-chart]");
    const view = views.get(container);
    if (!svg || !container.contains(svg) || !view || !Number.isFinite(event.clientX)) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const x = (event.clientX - rect.left) / rect.width * view.geometry.width;
    const index = view.geometry.xs.reduce((best, value, index, values) => Math.abs(value - x) < Math.abs(values[best] - x) ? index : best, 0);
    inspect(container, index);
    if (event.type === "pointerdown") {
      svg.focus({ preventScroll: true });
      if (event.pointerType === "touch") svg.setPointerCapture?.(event.pointerId);
    }
  };
  container.addEventListener("pointermove", pointer);
  container.addEventListener("pointerdown", pointer);
  container.addEventListener("keydown", (event) => {
    const view = views.get(container);
    const svg = event.target.closest?.("svg[data-market-chart]");
    if (!view || !svg || !container.contains(svg) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    inspect(container, event.key === "Home" ? 0 : event.key === "End" ? view.model.dates.length - 1 : view.index + (event.key === "ArrowLeft" ? -1 : 1));
  });
  bound.add(container);
}

function inspect(container, requested) {
  const view = views.get(container);
  if (!view) return;
  const { model, geometry } = view;
  const index = Math.max(0, Math.min(model.dates.length - 1, requested));
  view.index = index;
  const cursor = container.querySelector("[data-market-cursor]");
  cursor?.setAttribute("x1", geometry.xs[index]);
  cursor?.setAttribute("x2", geometry.xs[index]);
  container.querySelectorAll("[data-market-dot]").forEach((dot, series) => {
    dot.setAttribute("cx", geometry.xs[index]);
    dot.setAttribute("cy", geometry.y(model.series[series].values[index]));
  });
  const output = container.querySelector("#overviewChartReadout");
  if (output) output.textContent = readout(model, index);
}

function readout(model, index) {
  return `${dateLabel(model.dates[index])} · ${model.series.map((series) => `${series.ticker} ${series.closes[index].toFixed(2)}${series.currency ? ` ${series.currency}` : ""} (${formatPercent(series.values[index])})`).join(" · ")}`;
}

export function buildWatchlistMoves(results, tickers, quotes, { now = Date.now(), priceSource = "" } = {}) {
  return tickers.slice(0, 6).map((ticker) => {
    const item = results.find((result) => result.ticker === ticker);
    const quote = item?.quote || quotes?.byTicker?.get(ticker);
    const time = quote?.quoteTime ? new Date(quote.quoteTime).getTime() : NaN;
    const historyTime = new Date(item?.dataQuality?.asOf || "").getTime();
    const recent = !/^sample\b/i.test(quote?.source || "") && Number.isFinite(quote?.price) && quote.price > 0
      && Number.isFinite(time) && time <= now && now - time <= 7 * DAY
      && (!quote.ticker || quote.ticker === ticker) && (!item?.currency || quote.currency === item.currency)
      && (!Number.isFinite(historyTime) || time >= historyTime)
      && finiteChange(quote.dayChangePercent) && quote.dayChangePercent > -1;
    if (recent) return { ticker, change: quote.dayChangePercent, asOf: new Date(time).toISOString(), source: "Quote" };
    const points = /^sample\b/i.test(priceSource) ? [] : dailyHistory(item, now);
    if (points.length < 2) return { ticker, change: null, asOf: null, source: "Unavailable" };
    const change = points.at(-1).close / points.at(-2).close - 1;
    return finiteChange(change) ? { ticker, change, asOf: day(points.at(-1).date), source: "Daily close" }
      : { ticker, change: null, asOf: null, source: "Unavailable" };
  });
}

export function renderWatchlistMoves(results, tickers, quotes, priceSource) {
  const container = document.getElementById("watchlistMoves");
  if (!container) return;
  const moves = buildWatchlistMoves(results, tickers, quotes, { priceSource });
  const scale = Math.max(.001, ...moves.map((move) => Math.abs(move.change || 0)));
  container.innerHTML = moves.length ? `<ul class="watchlist-moves-list">${moves.map((move) => {
    const known = Number.isFinite(move.change);
    const width = known ? Math.abs(move.change) / scale * 50 : 0;
    return `<li class="watchlist-move"><div class="watchlist-move-label"><a href="#detail" data-detail-ticker="${escapeHtml(move.ticker)}">${escapeHtml(move.ticker)}</a><small>${known ? escapeHtml(dateLabel(move.asOf)) : "Price unavailable"}</small></div>
      <div class="watchlist-move-value ${known ? move.change < 0 ? "change-negative" : move.change > 0 ? "change-positive" : "change-neutral" : "change-neutral"}">${known ? escapeHtml(formatPercent(move.change)) : "Unavailable"}<small>${escapeHtml(move.source)}</small></div>
      <div class="watchlist-move-bar" aria-hidden="true"><span class="${move.change < 0 ? "negative" : "positive"}" style="left:${move.change < 0 ? 50 - width : 50}%;width:${width}%"></span></div></li>`;
  }).join("")}</ul><p class="data-note">Bars share a scale; dates may differ.</p>` : '<p class="empty-state">Your watchlist is empty. <a href="#screener">Add a stock or ETF</a>.</p>';
}

function day(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
}

function finiteChange(value) { return Number.isFinite(value) && Number.isFinite(value * 100); }

function dateLabel(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
