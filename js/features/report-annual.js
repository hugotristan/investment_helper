import { annualSummaryYears, calculateAnnualSummary } from "../analysis/annual-summary.js";
import { portfolioToday } from "../analysis/portfolio-ledger.js";
import { subscribePortfolioPerformance } from "./portfolio-performance.js";
import { getActivePortfolioBook } from "../portfolio-state.js";
import { cloudSession } from "../data/cloud-portfolio-store.js";
import { escapeHtml } from "../shared/text.js";
import { downloadReport } from "../shared/report-export.js";
import { euro, reportEmpty, reportPercent, reportTable } from "../shared/report-ui.js";

export function createAnnualReportController({ document: doc = globalThis.document, window: win = globalThis.window,
  readBook = getActivePortfolioBook, subscribe = subscribePortfolioPerformance, session = cloudSession,
  now = Date.now, download = downloadReport } = {}) {
  const el = id => doc?.getElementById(`reportAnnual${id}`);
  const blocked = () => doc.documentElement?.dataset?.privateBlocked === "true";
  const active = () => !win || win.location.hash === "#report-annual";
  let initialized = false, inputs = null, current = null, selected = null, cached = null, historyFailed = false;

  function clear() {
    current = null; inputs = null; cached = null; selected = null; historyFailed = false;
    el("Year").innerHTML = ""; el("Export").disabled = true;
    el("Body").innerHTML = reportEmpty("Start portfolio tracking to see an annual summary.");
  }

  function render() {
    if (!el("Body")) return;
    const book = blocked() ? null : readBook();
    if (!book) { clear(); return; }
    if (!active()) { current = null; el("Export").disabled = true; return; }
    const years = annualSummaryYears(book, now());
    if (!years.includes(selected)) selected = years[0];
    el("Year").innerHTML = years.map(year => `<option value="${year}">${year}</option>`).join("");
    el("Year").value = String(selected);
    const usable = inputs?.book === book ? inputs : null, day = portfolioToday(now());
    if (!cached || cached.book !== book || cached.inputs !== usable || cached.year !== selected || cached.day !== day) {
      current = calculateAnnualSummary({ book, year: selected, histories: usable?.histories ?? (historyFailed ? {} : null), fxHistory: usable?.fxHistory ?? null, now: now() });
      cached = { book, inputs: usable, year: selected, day, report: current };
    } else current = cached.report;
    el("Export").disabled = Boolean(current.error);
    if (current.error) { el("Body").innerHTML = reportEmpty(current.error); return; }
    const m = current, period = m.yearToDate ? "Year to date" : m.completeYear ? "Full year" : "Partial year";
    const metrics = [["Opening value", euro(m.openingValue)], [m.to !== `${m.year}-12-31` ? "Latest completed-day value" : "Year-end value", euro(m.closingValue)],
      ["Period gain", euro(m.gain)], ["Adjusted return · approximate", reportPercent(m.return)]];
    const details = [["Deposits", m.deposits], ["Withdrawals", m.withdrawals], ["Net funding", m.netFunding], ["Starting cash · included in opening value", m.openingCash],
      [m.incomeEstimated ? "Cash dividends · EUR estimate" : "Recorded cash dividends", m.income], [m.feesEstimated ? "Recorded fees · EUR estimate" : "Recorded fees", m.fees],
      ["Gains realized on sales in this period", m.realizedGain], ["Unrealized gain at opening", m.unrealizedOpening], ["Unrealized gain at end", m.unrealizedClosing], ["Change in unrealized gain", m.unrealizedChange]];
    if (Number.isFinite(m.otherValuationChanges) && Math.abs(m.otherValuationChanges) >= 0.005) details.push(["Other valuation changes · e.g. cash FX", m.otherValuationChanges]);
    const scale = Math.max(1, ...m.months.map(row => Math.abs(row.gain || 0)));
    const chart = `<div class="report-gain-chart" role="img" aria-label="Monthly EUR portfolio gain after deposits and withdrawals">${m.months.map(row => `<div><span>${row.month}</span><div class="report-gain-track"><i class="${row.gain < 0 ? "loss" : "gain"}" style="${row.gain < 0 ? "right:50%" : "left:50%"};width:${Number.isFinite(row.gain) ? (Math.abs(row.gain) / scale * 50).toFixed(4) : 0}%"></i></div><strong>${euro(row.gain)}</strong></div>`).join("")}</div>`;
    el("Body").innerHTML = `<p class="data-note">${period} · ${m.from} — ${m.to} · EUR daily closes, including recorded cash.${m.partialTracking ? " Tracking began during this year." : ""}</p>
      ${m.historyReady ? "" : '<p class="data-note">Loading price and currency history. Recorded activity remains visible.</p>'}
      ${historyFailed ? '<p class="data-note">Price or currency history could not be loaded. Recorded activity remains visible.</p>' : ""}
      <div class="portfolio-performance-summary">${metrics.map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("")}</div>
      <p class="data-note">${m.transactions} recorded transactions · deposits ${euro(m.deposits)} · withdrawals ${euro(m.withdrawals)} · cash dividends ${euro(m.income)} · fees ${euro(m.fees)}${m.feesEstimated ? " (EUR estimate)" : ""}.</p>
      ${chart}<details class="secondary-details"><summary>Funding, income and gains</summary><dl class="portfolio-performance-breakdown">${details.map(([label, value]) => `<div><dt>${label}</dt><dd>${euro(value)}</dd></div>`).join("")}</dl>
      <p class="data-note">Period gain = closing value − opening value − deposits + withdrawals. Realized sale gains can include gains from earlier years; the change in unrealized gains offsets those carried amounts. Trade fees are already in costs and proceeds; the fee subtotal is not deducted again. Only recorded cash dividends are included.</p></details>
      ${m.openingCostEstimated ? '<p class="data-note">Foreign opening-position cost uses estimated tracking-date FX. Cost-basis gain details inherit that estimate.</p>' : ""}
      <details class="secondary-details"><summary>Monthly results</summary>${reportTable(["Month", "End value", "Deposits", "Withdrawals", "Gain", "Approx. return", "Dividends", "Fees"], m.months.map(row => [row.month, euro(row.endValue), euro(row.deposits), euro(row.withdrawals), euro(row.gain), row.status === "no-exposure" ? "No invested capital" : reportPercent(row.return), euro(row.income), euro(row.fees)]), "Annual summary · monthly results")}</details>
      <details class="secondary-details"><summary>Dates and calculation limits</summary><p class="data-note">Year-end means the dated daily close carried forward by at most seven days, with dated reference FX. The current UTC daily bar is excluded. The adjusted return links the existing monthly Modified Dietz returns and is approximate; a partial year is not annualized. Opening positions begin at their tracking-date value. Foreign opening costs and fee allocations may be estimates. Missing valuations, converted cash, funding or corporate actions leave affected results unavailable. EUR funding totals require recorded EUR settlements. Dividends and fees are recorded activity, not tax calculations. This report does not change the ledger.</p><p class="data-note"><a href="https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/" target="_blank" rel="noopener noreferrer">Return calculation reference · GIPS handbook ↗</a></p>
      ${m.reasons.length ? `<ul>${m.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : ""}</details>`;
  }

  function acceptInputs(_report, value) {
    if (blocked() || !readBook()) { clear(); return; }
    const nextInputs = value?.book === readBook() ? value : null;
    const nextFailed = !nextInputs && Boolean(_report?.reasons?.length);
    if (inputs !== nextInputs || historyFailed !== nextFailed) cached = null;
    inputs = nextInputs; historyFailed = nextFailed;
    render();
  }

  function initialize() {
    if (initialized || !el("Body")) return;
    initialized = true;
    el("Year").addEventListener("change", () => { selected = Number(el("Year").value); render(); });
    el("Export").addEventListener("click", () => {
      if (blocked() || !readBook() || !current || current.error || cached?.book !== readBook()) return;
      const m = current;
      const headers = ["Record", "Year", "From", "To", "Coverage", "Month", "Opening value EUR", "Closing value EUR", "Deposits EUR", "Withdrawals EUR", "Net funding EUR", "Starting cash EUR", "Gain EUR", "Approximate return fraction", "Cash dividends EUR", "Fees EUR", "Fees estimated", "Realized sale gains EUR", "Unrealized opening EUR", "Unrealized closing EUR", "Unrealized change EUR", "Other valuation changes EUR", "Valuation status", "Income estimated", "Opening foreign costs estimated"];
      const coverage = m.yearToDate ? "Year to date" : m.completeYear ? "Full year" : "Partial year";
      download(`annual-summary-${m.year}.csv`, headers, [["Summary", m.year, m.from, m.to, coverage, "", m.openingValue, m.closingValue, m.deposits, m.withdrawals, m.netFunding, m.openingCash, m.gain, m.return, m.income, m.fees, m.feesEstimated, m.realizedGain, m.unrealizedOpening, m.unrealizedClosing, m.unrealizedChange, m.otherValuationChanges, m.historyReady ? "See calculation limits" : "Loading history", m.incomeEstimated, m.openingCostEstimated],
        ...m.months.map(row => ["Month", m.year, row.from, row.to, coverage, row.month, row.startValue, row.endValue, row.deposits, row.withdrawals, row.netFunding, row.openingCash, row.gain, row.return, row.income, row.fees, row.feesEstimated, null, null, null, null, null, row.status, row.incomeEstimated, m.openingCostEstimated])]);
    });
    subscribe(acceptInputs);
    session?.subscribe?.(value => { if (["UNAUTHORIZED", "ACCOUNT_CHANGED"].includes(value?.errorCode)) { clear(); return; } render(); });
    win?.addEventListener?.("hashchange", render);
    render();
  }
  return { initialize, render, acceptInputs, get current() { return current; } };
}

let controller;
export function initializeAnnualReport() { controller ||= createAnnualReportController(); controller.initialize(); }
export function refreshAnnualReport() { controller?.render(); }
