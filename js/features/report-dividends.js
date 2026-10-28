import { dividendForecast } from "../analysis/dividend-forecast.js";
import { dividendPositionKey, isAccumulatingFund, nextDividendDate, normalizeDividendAssumptions } from "../analysis/dividend-assumptions.js";
import { portfolioToday, projectPortfolioBook } from "../analysis/portfolio-ledger.js";
import { getActivePortfolioBook } from "../portfolio-state.js";
import { getExchangeRate, loadExchangeRate } from "../data/exchange-rate.js";
import { loadPortfolioFx } from "../data/portfolio-history.js";
import { cloudSession } from "../data/cloud-portfolio-store.js";
import { escapeHtml } from "../shared/text.js";
import { portfolioMoney } from "../shared/portfolio-money.js";
import { downloadReport } from "../shared/report-export.js";
import { parseDecimalInput } from "../shared/decimal.js";
import { euro, reportEmpty, reportTable } from "../shared/report-ui.js";

const money = (value, currency, eurValue) => escapeHtml(portfolioMoney(value, currency, { eurValue }));
const quantity = value => new Intl.NumberFormat("en", { maximumFractionDigits: 8 }).format(value);

export function createDividendReportController({ document: doc = globalThis.document, window: win = globalThis.window,
  readBook = getActivePortfolioBook, save = (...args) => import("./portfolio-book.js").then(module => module.savePortfolioDividendAssumptions(...args)), now = Date.now,
  readRate = getExchangeRate, loadRate = loadExchangeRate, loadFx = loadPortfolioFx, session = cloudSession,
  download = downloadReport } = {}) {
  const el = id => doc?.getElementById(id);
  let current = null, bound = false, busy = false, dirty = false, revision = null, formBook = null, fxHistory = null, epoch = 0;
  const blocked = () => doc.documentElement?.dataset?.privateBlocked === "true";
  const say = text => { el("reportDividendStatus").textContent = text; };
  const holdings = book => projectPortfolioBook(book).holdings;

  function paymentFields() {
    const none = el("reportDividendFrequency").value === "none";
    el("reportDividendAmount").disabled = busy || none;
    el("reportDividendDate").disabled = busy || none;
    el("reportDividendAmount").required = !none;
    el("reportDividendDate").required = !none;
  }

  function loadForm() {
    const book = readBook();
    if (!book || blocked()) return;
    formBook = book; revision = book.updatedAt; dirty = false;
    const selected = el("reportDividendPosition").value;
    const plan = book.dividendAssumptions?.find(entry => dividendPositionKey(entry) === selected);
    const position = holdings(book).find(entry => dividendPositionKey(entry) === selected);
    el("reportDividendAmount").value = plan ? String(plan.amountPerShare) : "";
    el("reportDividendFrequency").value = plan?.frequency || "quarterly";
    el("reportDividendDate").value = plan ? nextDividendDate(plan, portfolioToday(now())) || "" : "";
    el("reportDividendDate").min = portfolioToday(now());
    el("reportDividendSave").disabled = busy || !position || !Number.isFinite(position.shares) || isAccumulatingFund(position.ticker);
    el("reportDividendRemove").disabled = busy || !plan;
    el("reportDividendPositionHint").textContent = position && Number.isFinite(position.shares) && !isAccumulatingFund(position.ticker)
      ? `${quantity(position.shares)} current shares · payment amounts in ${position.currency}`
      : "No eligible current share quantity for this assumption. You can remove it.";
    paymentFields();
  }

  function render({ force = false } = {}) {
    if (!el("reportDividendBody")) return;
    const book = blocked() ? null : readBook();
    el("reportDividendEditor").hidden = !book;
    el("reportDividendExport").disabled = true;
    if (!book) {
      epoch++; current = null; formBook = null; revision = null; dirty = false; fxHistory = null;
      el("reportDividendPosition").innerHTML = "";
      el("reportDividendAmount").value = ""; el("reportDividendDate").value = "";
      el("reportDividendPositionHint").textContent = ""; say("");
      el("reportDividendBody").innerHTML = reportEmpty("Start portfolio tracking to plan future dividends.");
      return;
    }
    current = dividendForecast(book, { now: now(), exchangeRate: readRate(), fxHistory });
    el("reportDividendExport").disabled = !current.rows.length;
    const notices = [
      current.missing.length ? `No assumption entered: ${current.missing.join(", ")}.` : "",
      current.accumulating.length ? `${current.accumulating.join(", ")}: accumulating ETF; dividends are reinvested within the fund, with no cash payment.` : "",
      current.noDividend.length ? `Marked as no cash dividend: ${current.noDividend.join(", ")}.` : "",
      current.inactive.length ? `No payment in this period: ${current.inactive.join(", ")}. Review expired one-off dates in the editor.` : "",
      current.unknownShares.length ? `Share quantities unavailable: ${current.unknownShares.join(", ")}.` : "",
      current.unheld.length ? "Assumptions for positions no longer held are excluded. Select them in the editor to remove them." : "",
    ].filter(Boolean);
    const scale = Math.max(1, ...current.months.map(month => month.value || 0));
    const chart = `<div class="report-funding-chart" role="img" aria-label="Projected monthly gross dividends in EUR">${current.months.map(month => `<div class="report-funding-row"><span>${escapeHtml(month.month)}</span><div><i class="gain" style="width:${Number.isFinite(month.value) ? (month.value / scale * 100).toFixed(4) : 0}%"></i></div><span>${euro(month.value)}</span></div>`).join("")}</div>`;
    const rows = current.rows.slice(0, 50).map(row => [escapeHtml(row.date), escapeHtml(row.ticker), quantity(row.shares),
      money(row.amountPerShare, row.currency, row.eur === null ? null : row.eur / row.shares), money(row.native, row.currency, row.eur), euro(row.eur)]);
    const fx = Object.entries(current.fxDates).map(([currency, date]) => `${currency}/EUR ${date}`).join(" · ");
    el("reportDividendBody").innerHTML = `<p class="data-note">${escapeHtml(current.from)} — ${escapeHtml(current.to)} · today’s share quantities held constant. Payment amounts and dates are your assumptions.</p>
      ${current.covered ? `<div class="portfolio-performance-summary dividend-summary"><article><span>Estimated gross EUR · entered assumptions</span><strong>${euro(current.total)}</strong></article><article><span>Expected payments</span><strong>${current.rows.length}</strong></article></div>${chart}` : '<p class="empty-state">Enter dividend assumptions below to build your forecast.</p>'}
      ${current.total === null ? '<p class="data-note">Some EUR estimates lack a recent exchange rate or a valid calculated amount. Affected totals are unavailable.</p>' : ""}
      ${notices.map(text => `<p class="data-note">${escapeHtml(text)}</p>`).join("")}
      ${current.rows.length ? `<details class="secondary-details"><summary>Payment estimates (${current.rows.length})</summary>${reportTable(["Expected date", "Position", "Shares", "Dividend / share", "Gross payment", "Gross EUR"], rows, "Projected gross payments")}${current.rows.length > 50 ? '<p class="data-note">First 50 payments shown. CSV includes every projected payment.</p>' : ""}</details>` : ""}
      <p class="data-note">Gross amounts exclude tax, fees and dividend changes. Future payments are not added to recorded cash. ${fx ? `EUR estimates hold reference FX constant: ${escapeHtml(fx)}.` : ""}</p>`;
    if (busy || dirty && !force) return;
    const selected = el("reportDividendPosition").value;
    const positions = holdings(book).filter(position => Number.isFinite(position.shares) && !isAccumulatingFund(position.ticker));
    const removable = (book.dividendAssumptions || []).filter(plan => !positions.some(position => dividendPositionKey(position) === dividendPositionKey(plan)));
    const options = [...positions.map(position => ({ ...position, held: true })), ...removable.map(plan => ({ ...plan, held: false }))];
    el("reportDividendEditor").hidden = !options.length;
    el("reportDividendPosition").innerHTML = options.map(position => `<option value="${escapeHtml(dividendPositionKey(position))}">${escapeHtml(position.ticker)} · ${escapeHtml(position.currency)}${position.held ? "" : " (remove only)"}</option>`).join("");
    el("reportDividendPosition").value = options.some(position => dividendPositionKey(position) === selected) ? selected : options[0] ? dividendPositionKey(options[0]) : "";
    loadForm();
  }

  async function refreshRates() {
    const book = readBook();
    if (!book || blocked()) return;
    const token = ++epoch;
    const currencies = new Set(holdings(book).map(position => position.currency));
    const [, historical] = await Promise.all([
      currencies.has("USD") ? loadRate().catch(() => null) : null,
      [...currencies].some(currency => !["USD", "EUR"].includes(currency)) ? loadFx().catch(() => null) : null,
    ]);
    if (token !== epoch || book !== readBook() || blocked()) return;
    fxHistory = historical; render();
  }

  async function persist(remove = false) {
    if (busy || !formBook || blocked()) return false;
    const key = el("reportDividendPosition").value;
    try {
      if (readBook()?.updatedAt !== revision) throw new TypeError("Your portfolio changed. Reload this editor before saving.");
      if (remove && !formBook.dividendAssumptions?.some(plan => dividendPositionKey(plan) === key)) throw new TypeError("No saved assumption for this position.");
      const next = (formBook.dividendAssumptions || []).filter(plan => dividendPositionKey(plan) !== key);
      if (!remove) {
        const position = holdings(formBook).find(holding => dividendPositionKey(holding) === key);
        if (!position || !Number.isFinite(position.shares)) throw new TypeError("Choose a currently held position with a share quantity.");
        const frequency = el("reportDividendFrequency").value;
        if (frequency !== "none" && (!el("reportDividendAmount").value.trim() || el("reportDividendDate").value < portfolioToday(now()))) {
          throw new TypeError("Enter a dividend per share and an expected payment date on or after today.");
        }
        const previous = formBook.dividendAssumptions?.find(plan => dividendPositionKey(plan) === key);
        const selectedDate = el("reportDividendDate").value;
        // Editing the amount must not replace a Jan 31 recurrence anchor with
        // a displayed Feb 28 date and shift every later payment to the 28th.
        const firstPaymentDate = previous?.frequency === frequency && selectedDate === nextDividendDate(previous, portfolioToday(now()))
          ? previous.firstPaymentDate : selectedDate;
        next.push({ ticker: position.ticker, currency: position.currency,
          amountPerShare: frequency === "none" ? 0 : parseDecimalInput(el("reportDividendAmount").value), frequency,
          firstPaymentDate: frequency === "none" ? null : firstPaymentDate });
      }
      const assumptions = normalizeDividendAssumptions(next);
      busy = true;
      for (const control of el("reportDividendForm").querySelectorAll("input,select,button")) control.disabled = true;
      const saved = await save(assumptions, revision);
      if (saved && !blocked() && readBook()) { dirty = false; say(remove ? "Assumption removed." : "Assumption saved."); }
      return Boolean(saved);
    } catch (error) { if (!blocked()) say(error.message || "The assumption could not be saved."); return false; }
    finally {
      busy = false;
      for (const control of el("reportDividendForm").querySelectorAll("input,select,button")) control.disabled = false;
      render({ force: !dirty }); paymentFields();
    }
  }

  function initialize() {
    if (!el("reportDividendBody") || bound) return;
    bound = true;
    el("reportDividendForm").addEventListener("submit", event => { event.preventDefault(); void persist(); });
    el("reportDividendForm").addEventListener("input", () => { dirty = true; });
    el("reportDividendPosition").addEventListener("change", () => { loadForm(); say(""); });
    el("reportDividendFrequency").addEventListener("change", () => { dirty = true; paymentFields(); });
    el("reportDividendRemove").addEventListener("click", () => { void persist(true); });
    el("reportDividendReload").addEventListener("click", () => { dirty = false; render({ force: true }); say("Editor reloaded."); });
    el("reportDividendExport").addEventListener("click", () => {
      if (blocked() || !readBook() || !current?.rows.length) return;
      download("dividend-forecast.csv", ["Expected date (assumption)", "Ticker", "Currency", "Current shares", "Dividend per share (gross assumption)", "Gross native payment", "Gross EUR estimate", "Repeat interval", "FX date", "Forecast from", "Forecast to"],
        current.rows.map(row => [row.date, row.ticker, row.currency, row.shares, row.amountPerShare, row.native, row.eur, row.frequency, row.fxDate, current.from, current.to]));
    });
    session?.subscribe?.(() => render());
    win?.addEventListener?.("hashchange", () => { if (win.location.hash === "#report-dividends") { render(); void refreshRates(); } });
    render(); void refreshRates();
  }
  return { initialize, render, refreshRates, persist, get current() { return current; } };
}

let controller;
export function initializeDividendReport() { controller ||= createDividendReportController(); controller.initialize(); }
export function refreshDividendReport() { controller?.render(); }
