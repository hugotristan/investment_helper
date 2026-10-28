import { calculateRetirementScenario } from "../analysis/retirement-scenario.js";
import { normalizeRetirementScenario, retirementMonthAfter } from "../analysis/retirement-assumptions.js";
import { calculatePortfolioTotals } from "../analysis/portfolio-totals.js";
import { portfolioToday, projectPortfolioBook } from "../analysis/portfolio-ledger.js";
import { getActivePortfolioBook } from "../portfolio-state.js";
import { cloudSession } from "../data/cloud-portfolio-store.js";
import { escapeHtml } from "../shared/text.js";
import { downloadReport } from "../shared/report-export.js";
import { parseDecimalInput } from "../shared/decimal.js";
import { euro, reportEmpty, reportTable } from "../shared/report-ui.js";

const fields = { retirementMonth: "Month", monthlyContribution: "Contribution", annualReturnPercent: "Return", annualInflationPercent: "Inflation", monthlyWithdrawal: "Withdrawal", withdrawalYears: "Years" };

function growthChart(model) {
  const rows = model.yearly, max = Math.max(1, ...rows.flatMap(row => [row.balance, row.realValue]));
  const end = model.rows.at(-1).elapsedMonths;
  const x = row => 80 + row.elapsedMonths / end * 780;
  const y = value => 220 - value / max * 180;
  const points = key => rows.map(row => `${x(row).toFixed(2)},${y(row[key]).toFixed(2)}`).join(" ");
  const marker = 80 + model.monthsToRetirement / end * 780;
  const ticks = [0, max / 2, max].map(value => `<line x1="80" y1="${y(value)}" x2="860" y2="${y(value)}" class="retirement-grid"/><text x="72" y="${y(value) + 4}" text-anchor="end">${escapeHtml(new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value))}</text>`).join("");
  return `<figure class="retirement-chart" tabindex="0" aria-label="Projected retirement balance, scroll for the full timeline"><svg viewBox="0 0 900 275" role="img" aria-label="Projected portfolio balance: future euros and purchasing power in today's euros. Retirement begins ${escapeHtml(model.assumptions.retirementMonth)}.">${ticks}
    <line x1="${marker}" y1="35" x2="${marker}" y2="220" class="retirement-marker"/>
    <polyline points="${points("balance")}" class="retirement-nominal"/><polyline points="${points("realValue")}" class="retirement-real"/>
    <text x="80" y="252">${model.from}</text><text x="860" y="252" text-anchor="end">${model.rows.at(-1).month}</text></svg>
    <figcaption><span class="retirement-key nominal">Future EUR</span><span class="retirement-key real">Today’s purchasing power</span><span>Dashed marker: retirement</span></figcaption></figure>`;
}

export function createRetirementReportController({ document: doc = globalThis.document, window: win = globalThis.window,
  readBook = getActivePortfolioBook, save = (...args) => import("./portfolio-book.js").then(module => module.savePortfolioRetirementScenario(...args)),
  session = cloudSession, now = Date.now, download = downloadReport } = {}) {
  const el = id => doc?.getElementById(`reportRetirement${id}`);
  let bound = false, busy = false, dirty = false, revision = null, preview = null, current = null, valuation = null, valuationBook = null;
  const blocked = () => doc.documentElement?.dataset?.privateBlocked === "true";
  const say = text => { el("Status").textContent = text; };
  const readForm = () => normalizeRetirementScenario(Object.fromEntries(Object.entries(fields).map(([key, id]) => {
    const value = el(id).value;
    if (!value.trim()) throw new TypeError("Complete every scenario field; enter zero for no contribution or withdrawal.");
    return [key, key === "retirementMonth" ? value : parseDecimalInput(value)];
  })));

  function loadForm(book) {
    revision = book.updatedAt; dirty = false;
    const assumptions = book.retirementScenario;
    for (const [key, id] of Object.entries(fields)) el(id).value = assumptions ? String(assumptions[key]) : key === "withdrawalYears" ? "30" : "";
    const from = portfolioToday(now()).slice(0, 7);
    el("Month").min = from; el("Month").max = retirementMonthAfter(from, 720);
  }

  function render({ force = false } = {}) {
    if (!el("Body")) return;
    const book = blocked() ? null : readBook();
    el("Editor").hidden = !book; el("Export").disabled = true;
    if (!book) {
      current = null; preview = null; valuation = null; valuationBook = null; revision = null; dirty = false;
      for (const id of Object.values(fields)) el(id).value = "";
      say(""); el("Body").innerHTML = reportEmpty("Start portfolio tracking to plan retirement scenarios."); return;
    }
    el("Remove").disabled = busy || !book.retirementScenario;
    if (!busy && (!dirty || force)) loadForm(book);
    current = null;
    const value = valuationBook === book && valuation?.valueComplete ? valuation.totalValue : null;
    const assumptions = preview || book.retirementScenario;
    const starting = `<p class="report-total">${euro(value)} <span>current portfolio value · holdings and recorded cash</span></p>`;
    if (value === null) {
      const reasons = valuationBook === book ? valuation?.reasons || [] : [];
      el("Body").innerHTML = starting + `<p class="data-note">A complete EUR valuation is needed before projecting this portfolio. ${escapeHtml(reasons.join(" "))}</p>`; return;
    }
    if (!assumptions) { el("Body").innerHTML = starting + '<p class="empty-state">Enter assumptions below, then calculate a preview.</p>'; return; }
    try { current = calculateRetirementScenario(value, assumptions, { now: now() }); }
    catch (error) { el("Body").innerHTML = starting + `<p class="data-note">${escapeHtml(error.message)}</p>`; return; }
    el("Export").disabled = false;
    const m = current;
    const outcome = !assumptions.monthlyWithdrawal ? "No withdrawals entered."
      : m.firstShortfallMonth ? `First month with an unfunded withdrawal: ${m.firstShortfallMonth}.`
      : `The projected balance covers the entered withdrawals for ${assumptions.withdrawalYears} years after retirement.`;
    el("Body").innerHTML = starting + `<p class="data-note">${preview ? "Unsaved preview" : "Saved assumptions"} · retirement ${escapeHtml(assumptions.retirementMonth)} · effective annual return ${assumptions.annualReturnPercent}% · inflation ${assumptions.annualInflationPercent}%</p>
      <div class="portfolio-performance-summary retirement-summary"><article><span>At retirement · future EUR</span><strong>${euro(m.retirementValue)}</strong></article><article><span>At retirement · today’s purchasing power</span><strong>${euro(m.retirementRealValue)}</strong></article></div>
      ${growthChart(m)}<p class="report-total-note">${escapeHtml(outcome)} Remaining at ${m.rows.at(-1).month}: ${euro(m.endValue)} (${euro(m.endRealValue)} in today’s euros).</p>
      <details class="secondary-details"><summary>Yearly balances</summary>${reportTable(["Month", "Phase", "Future EUR", "Today’s EUR", "Added EUR", "Withdrawn EUR"], m.yearly.map(row => [row.month, row.phase, euro(row.balance), euro(row.realValue), euro(row.contributed), euro(row.withdrawn)]), "Projected yearly retirement balances")}</details>
      <details class="secondary-details"><summary>Calculation assumptions</summary><p class="data-note">Starts ${m.from}. Every step is one full monthly period; the retirement month is approximate to the month. All current holdings and cash earn your fixed effective annual return, compounded monthly. Contributions are fixed future EUR, added after growth, and stop at retirement. Withdrawals start the following month and rise with inflation from the amount you entered in today’s EUR. Unfunded amounts are reported; the balance stops at zero. Dividends are included in the assumed total return and are not added again. Tax, fees, pensions and variable market returns are not calculated. No recorded cash or transactions are changed.</p><p class="data-note"><a href="https://www.investor.gov/financial-tools-calculators/calculators/compound-interest-calculator" target="_blank" rel="noopener noreferrer">Compound interest calculator · Investor.gov ↗</a></p></details>`;
  }

  function updateHoldings(holdings, exchangeRate) {
    const book = blocked() ? null : readBook();
    valuationBook = book;
    valuation = book ? calculatePortfolioTotals({ holdings, book, projection: projectPortfolioBook(book), exchangeRate, now: now() }) : null;
    render();
  }

  function calculatePreview() {
    if (blocked() || !readBook() || busy) return false;
    try {
      const next = readForm();
      calculateRetirementScenario(valuationBook === readBook() && valuation?.valueComplete ? valuation.totalValue : null, next, { now: now() });
      preview = next; dirty = true; render(); say("Preview calculated. Save assumptions to sync them across devices."); return true;
    } catch (error) { say(error.message); return false; }
  }

  async function persist(remove = false) {
    if (blocked() || !readBook() || busy) return false;
    try {
      if (readBook().updatedAt !== revision) throw new TypeError("Your portfolio changed. Reload this editor before saving.");
      const assumptions = remove ? null : readForm();
      if (assumptions) calculateRetirementScenario(0, assumptions, { now: now() });
      busy = true;
      for (const control of el("Form").querySelectorAll("input,button")) control.disabled = true;
      const saved = await save(assumptions, revision);
      if (saved && !blocked() && readBook()) { dirty = false; preview = null; say(remove ? "Saved scenario removed." : "Assumptions saved."); }
      return Boolean(saved);
    } catch (error) { if (!blocked()) say(error.message); return false; }
    finally {
      busy = false;
      for (const control of el("Form").querySelectorAll("input,button")) control.disabled = false;
      render();
    }
  }

  function initialize() {
    if (!el("Body") || bound) return;
    bound = true;
    el("Form").addEventListener("submit", event => { event.preventDefault(); calculatePreview(); });
    el("Form").addEventListener("input", () => { dirty = true; say("Draft changed. Calculate a preview or save to update the figures."); });
    el("Save").addEventListener("click", () => { void persist(); });
    el("Remove").addEventListener("click", () => { void persist(true); });
    el("Reload").addEventListener("click", () => { preview = null; dirty = false; render({ force: true }); say("Editor reloaded."); });
    el("Export").addEventListener("click", () => {
      if (blocked() || !readBook() || !current) return;
      const m = current, a = m.assumptions;
      download("retirement-scenario.csv", ["Month", "Phase", "Projected EUR", "Today's EUR", "Contribution EUR", "Requested withdrawal EUR", "Funded withdrawal EUR", "Unfunded withdrawal EUR", "Total added EUR", "Total withdrawn EUR", "Growth EUR", "Starting EUR", "Retirement month", "Monthly contribution EUR", "Effective annual return %", "Annual inflation %", "Monthly withdrawal in today's EUR", "Withdrawal years"],
        m.rows.map(row => [row.month, row.phase, row.balance, row.realValue, row.contribution, row.requestedWithdrawal, row.actualWithdrawal, row.shortfall, row.contributed, row.withdrawn, row.growth, m.initialValue, a.retirementMonth, a.monthlyContribution, a.annualReturnPercent, a.annualInflationPercent, a.monthlyWithdrawal, a.withdrawalYears]));
    });
    session?.subscribe?.(() => render());
    win?.addEventListener?.("hashchange", () => { if (win.location.hash === "#report-retirement") render(); });
    render();
  }
  return { initialize, render, updateHoldings, calculatePreview, persist, get current() { return current; } };
}

let controller;
export function initializeRetirementReport() { controller ||= createRetirementReportController(); controller.initialize(); }
export function renderRetirementReport(holdings, exchangeRate) { controller?.updateHoldings(holdings, exchangeRate); }
