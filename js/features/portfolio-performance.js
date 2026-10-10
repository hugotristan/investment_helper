import { calculatePortfolioPerformance } from "../analysis/portfolio-performance.js";
import { loadPriceSnapshot } from "../data/price-snapshot.js";
import { loadStockHistories } from "../data/stock-history.js";
import { loadPortfolioFx } from "../data/portfolio-history.js";
import { getActivePortfolioBook } from "../portfolio-state.js";
import { portfolioMoney } from "../shared/portfolio-money.js";
import { escapeHtml } from "../shared/text.js";

let refreshId = 0;
let latestReport = null;
const boundInputs = new WeakSet();
const element = (id) => globalThis.document?.getElementById(id);
const money = (value) => portfolioMoney(value, "EUR");
const percent = (value) => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%` : "Unavailable";
const setHtml = (id, html) => { const node = element(id); if (node) node.innerHTML = html; };

export function initializePortfolioPerformance() {
  const input = element("portfolioChartDate");
  if (input && !boundInputs.has(input)) {
    input.addEventListener("input", () => updateChartReadout(Number(input.value)));
    boundInputs.add(input);
  }
  return refreshPortfolioPerformance();
}

export async function refreshPortfolioPerformance() {
  const id = ++refreshId;
  if (!getActivePortfolioBook()) { renderPortfolioPerformance(null); return null; }
  try {
    const [snapshot, fxHistory] = await Promise.all([loadPriceSnapshot(), loadPortfolioFx()]);
    if (id !== refreshId) return null;
    const book = getActivePortfolioBook();
    if (!book) { renderPortfolioPerformance(null); return null; }
    const tickers = new Set(["SPY", ...book.openingHoldings.map((holding) => holding.ticker),
      ...book.transactions.map((entry) => entry.ticker).filter(Boolean)]);
    const histories = await loadStockHistories([...tickers], { snapshot });
    if (id !== refreshId || book !== getActivePortfolioBook()) return null;
    const report = calculatePortfolioPerformance({ book, histories, fxHistory });
    renderPortfolioPerformance(report);
    return report;
  } catch {
    if (id !== refreshId) return null;
    renderPortfolioPerformance({ summary: {}, series: [], months: [], holdings: [],
      reasons: ["Portfolio performance could not be calculated. Your saved transactions remain available in Portfolio."] });
    return null;
  }
}

export function renderPortfolioPerformance(report) {
  latestReport = report;
  const status = element("portfolioPerformanceStatus");
  if (!report) {
    if (status) status.textContent = "Start portfolio tracking and record your transactions in Portfolio to see performance.";
    setHtml("portfolioPerformanceSummary", "");
    setHtml("portfolioPerformanceChart", '<p class="empty-state"><a href="#portfolio">Open Portfolio</a></p>');
    setHtml("portfolioPerformanceMonths", "");
    setHtml("portfolioPerformanceHoldings", "");
    setHtml("portfolioPerformanceReasons", "");
    renderChartControls([]);
    return;
  }
  const summary = report.summary || {};
  if (status) status.textContent = report.startDate && report.endDate
    ? `${report.startDate} to ${report.endDate} · EUR · daily closes, including cash. Live holding values may differ.`
    : "Recorded history does not yet support a complete performance period.";
  if (status && report.returnStartDate && report.returnStartDate !== report.startDate) {
    status.textContent += ` Return and SPY comparison start with invested capital on ${report.returnStartDate}.`;
  }
  const metrics = [
    ["Total value", money(summary.currentValue)],
    ["Growth since start", money(summary.selectedPeriodGain)],
    ["Adjusted return (approx.)", percent(summary.return)],
    ["SPY price return in EUR", percent(summary.benchmarkReturn)]
  ];
  setHtml("portfolioPerformanceSummary", metrics.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join(""));
  setHtml("portfolioPerformanceReasons", (report.reasons || []).length
    ? `<details class="secondary-details"><summary>Calculation notes (${new Set(report.reasons).size})</summary><ul>${[...new Set(report.reasons)].map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></details>` : "");
  setHtml("portfolioPerformanceChart", renderValueChart(report.series || []));
  renderChartControls(report.series || []);
  setHtml("portfolioPerformanceMonths", renderMonthlyTable(report.months || []));
  setHtml("portfolioPerformanceHoldings", renderGainDetails(report));
}

function renderMonthlyTable(months, { showAll = false } = {}) {
  if (!months.length) return '<p class="empty-state">Monthly results need two dated valuations.</p>';
  if (!showAll && months.length > 12) {
    return renderMonthlyTable(months.slice(-12), { showAll: true })
      + `<details class="secondary-details"><summary>Earlier months (${months.length - 12})</summary>${renderMonthlyTable(months.slice(0, -12), { showAll: true })}</details>`;
  }
  return `<div class="portfolio-performance-table-wrap" tabindex="0" aria-label="Monthly portfolio performance, scroll for all columns">
    <table class="portfolio-performance-table"><caption>Monthly results · first and last months may be partial</caption>
      <thead><tr><th scope="col">Month</th><th scope="col">End value</th><th scope="col">Deposits − withdrawals</th><th scope="col">Gain</th><th scope="col">Approx. return</th><th scope="col">SPY in EUR</th></tr></thead>
      <tbody>${[...months].reverse().map((row) => `<tr><th scope="row">${escapeHtml(row.month)}<small>${escapeHtml(row.startDate)} → ${escapeHtml(row.endDate)}</small></th>
        <td>${escapeHtml(money(row.endValue))}</td><td>${escapeHtml(money(row.netFlow))}</td><td>${escapeHtml(money(row.gain))}</td>
        <td>${row.status === "no-exposure" ? "No invested capital" : percent(row.return)}</td><td>${percent(row.benchmarkReturn)}</td></tr>`).join("")}</tbody>
    </table></div>`;
}

function renderGainDetails(report) {
  const summary = report.summary || {};
  const details = [["Realized gain", summary.realizedGain], ["Unrealized gain", summary.unrealizedGain],
    ["Cash dividends", summary.income], [report.methodology?.feesEstimated ? "Fees · EUR estimate" : "Recorded fees", summary.fees], ["Net deposits", summary.netContributions]];
  return `<dl class="portfolio-performance-breakdown">${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(money(value))}</dd></div>`).join("")}</dl>
    <p class="data-note">Realized gains come from sold shares; unrealized gains come from shares still held. Trade fees are already included in the costs and proceeds. Fees are shown here for reference.</p>
    ${report.methodology?.feesEstimated ? '<p class="data-note">Foreign trade fees are shown in EUR using the recorded settlement ratio. Other foreign fees use the dated reference rate. These EUR fee figures are estimates; the total EUR trade costs and proceeds remain as recorded.</p>' : ""}
    ${report.methodology?.openingCostEstimated ? '<p class="data-note">Foreign opening-position cost uses the reference rate on your tracking start date. Earlier broker EUR costs are not recorded.</p>' : ""}
    ${(report.holdings || []).length ? `<div class="portfolio-performance-table-wrap" tabindex="0" aria-label="Investment gains in EUR, scroll for all columns"><table class="portfolio-performance-table">
      <caption>Investment gains in EUR · includes sold positions</caption><thead><tr><th scope="col">Investment</th><th scope="col">Remaining cost</th><th scope="col">Current value</th><th scope="col">Realized gain</th><th scope="col">Unrealized gain</th></tr></thead>
      <tbody>${report.holdings.map((holding) => `<tr><th scope="row">${escapeHtml(holding.ticker)}<small>${escapeHtml(holding.currency)}</small></th>
        <td>${escapeHtml(money(holding.costBasis))}</td><td>${escapeHtml(money(holding.currentValue))}</td>
        <td>${escapeHtml(money(holding.realizedGain))}</td><td>${escapeHtml(money(holding.unrealizedGain))}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
}

export function renderValueChart(series) {
  const valid = series.filter((point) => Number.isFinite(point.value));
  if (!valid.length) return '<p class="empty-state">A value chart needs dated prices, exchange rates, and complete cash records.</p>';
  const start = Date.parse(series[0].date), end = Date.parse(series.at(-1).date);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '<p class="empty-state">Chart dates are unavailable.</p>';
  const values = series.flatMap((point) => [point.value, point.netContributions]).filter(Number.isFinite);
  const low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max((high - low) * .12, Math.abs(high) * .03, 1);
  const minimum = low - padding, range = high - low + 2 * padding;
  if (!Number.isFinite(range) || !Number.isFinite(minimum)) return '<p class="empty-state">Values exceed the chart range.</p>';
  const x = (date) => 78 + (Date.parse(date) - start) / Math.max(end - start, 86400000) * 700;
  const y = (value) => 226 - (value - minimum) / range * 200;
  const path = (key) => {
    let drawing = false;
    return series.map((point) => {
      if (!Number.isFinite(point[key])) { drawing = false; return ""; }
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command}${x(point.date).toFixed(2)} ${y(point[key]).toFixed(2)}`;
    }).join(" ");
  };
  const ticks = [0, .5, 1].map((ratio) => {
    const value = minimum + range * ratio;
    const position = y(value).toFixed(2);
    return `<line x1="78" x2="778" y1="${position}" y2="${position}" class="market-chart-grid"/><text x="68" y="${Number(position) + 4}" text-anchor="end">${escapeHtml(new Intl.NumberFormat(undefined, { maximumFractionDigits: 0, notation: "compact" }).format(value))}</text>`;
  }).join("");
  const last = valid.at(-1);
  return `<div class="portfolio-chart-legend"><span>— Total value</span><span>┄ Net deposits</span></div>
    <svg class="portfolio-value-chart" viewBox="0 0 800 265" role="img" aria-label="Portfolio value and net deposits in EUR over the recorded period">
      <desc>Use the date slider below to read each day's EUR totals. Gaps represent unavailable valuations.</desc>${ticks}
      <path d="${path("netContributions")}" class="portfolio-contributions-line"/><path d="${path("value")}" class="portfolio-value-line"/>
      <circle cx="${x(last.date).toFixed(2)}" cy="${y(last.value).toFixed(2)}" r="3" class="portfolio-value-dot"/>
      <text x="78" y="253">${escapeHtml(series[0].date)}</text><text x="778" y="253" text-anchor="end">${escapeHtml(series.at(-1).date)}</text>
    </svg>`;
}

function renderChartControls(series) {
  const input = element("portfolioChartDate");
  if (input) {
    input.disabled = !series.length;
    input.max = Math.max(0, series.length - 1);
    input.value = Math.max(0, series.length - 1);
  }
  updateChartReadout(series.length - 1);
}

function updateChartReadout(index) {
  const output = element("portfolioChartReadout");
  const point = latestReport?.series?.[index];
  if (output) output.textContent = point ? `${point.date} · value ${money(point.value)} · net deposits ${money(point.netContributions)}` : "";
  element("portfolioChartDate")?.setAttribute("aria-valuetext", point ? `${point.date}, portfolio value ${money(point.value)}` : "No dated values");
}
