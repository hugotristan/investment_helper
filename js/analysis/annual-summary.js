import { portfolioToday, validatePortfolioBook } from "./portfolio-ledger.js";
import { calculatePortfolioPerformance } from "./portfolio-performance.js";
import { transactionCash } from "./portfolio-reports.js";
import { historicalRate, normalizeHistoricalFx } from "../data/portfolio-history.js";

const finite = value => Number.isFinite(value) ? value : null;
const difference = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? finite(a - b) : null;
const sum = values => values.every(Number.isFinite) ? finite(values.reduce((total, value) => total + value, 0)) : null;
const shiftDay = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function annualSummaryYears(book, now = Date.now()) {
  const checked = validatePortfolioBook(book, { now });
  if (!checked.ok) return [];
  const start = Number(checked.book.settings.startDate.slice(0, 4)), end = Number(portfolioToday(now).slice(0, 4));
  return Array.from({ length: end - start + 1 }, (_, index) => end - index);
}

// An annual wrapper around the existing daily-close/Modified Dietz model.
// Activity is summed within the selected dates even when valuations are absent.
export function calculateAnnualSummary({ book, year, histories = null, fxHistory = null, now = Date.now() } = {}) {
  const checked = validatePortfolioBook(book, { now });
  const years = annualSummaryYears(book, now);
  if (!checked.ok || !Number.isInteger(year) || !years.includes(year)) {
    return { error: checked.error || "Choose a year within your recorded tracking history.", months: [] };
  }
  const ledger = checked.book, today = portfolioToday(now), utcToday = new Date(now).toISOString().slice(0, 10);
  const from = [ledger.settings.startDate, `${year}-01-01`].sort().at(-1);
  const to = [`${year}-12-31`, shiftDay(today, -1), shiftDay(utcToday, -1)].sort()[0];
  if (from > to) return { year, from, to, error: "This year has no completed tracking days yet.", months: [] };
  const reasons = new Set(), fx = normalizeHistoricalFx(fxHistory, { now });
  const entries = ledger.transactions.filter(entry => entry.date >= from && entry.date <= to);
  const settled = entry => {
    const cash = transactionCash(entry);
    if (cash.eurAmount !== null) return Math.abs(cash.eurAmount);
    if (entry.cashCurrency) {
      const rate = historicalRate(fx, entry.cashCurrency, entry.date, { now });
      if (rate) return finite(Math.abs(cash.amount) * rate.rate);
    }
    reasons.add("Some income or fees need a recorded EUR cash amount or dated currency rate."); return null;
  };
  const fee = entry => {
    if (entry.type === "fee") return { amount: settled(entry), estimated: entry.cashCurrency && entry.cashCurrency !== "EUR" };
    if (!["buy", "sell"].includes(entry.type) || !entry.fee) return { amount: 0, estimated: false };
    if (entry.currency === "EUR") return { amount: entry.fee, estimated: false };
    const euros = settled(entry), nativeNet = entry.amount + (entry.type === "buy" ? entry.fee : -entry.fee);
    if (euros !== null && nativeNet > 0) return { amount: finite(euros * entry.fee / nativeNet), estimated: true };
    const rate = historicalRate(fx, entry.currency, entry.date, { now });
    return { amount: rate ? finite(entry.fee * rate.rate) : null, estimated: true };
  };
  const activity = items => {
    let incomeEstimated = false;
    const amount = type => sum(items.filter(entry => entry.type === type).map(entry => {
      const cash = transactionCash(entry); return cash.eurAmount === null ? null : Math.abs(cash.eurAmount);
    }));
    const deposits = amount("deposit"), withdrawals = amount("withdrawal");
    const fees = items.map(fee);
    const income = sum(items.filter(entry => entry.type === "dividend").map(entry => {
        const amount = settled(entry);
        if (amount !== null && entry.cashCurrency && entry.cashCurrency !== "EUR") incomeEstimated = true;
        return amount;
      }));
    return { deposits, withdrawals, netFunding: difference(deposits, withdrawals), openingCash: amount("opening_cash"),
      income, incomeEstimated, fees: sum(fees.map(item => item.amount)),
      standaloneFees: sum(items.filter(entry => entry.type === "fee").map(settled)), feesEstimated: fees.some(item => item.estimated),
      transactions: items.length };
  };
  const totals = activity(entries);
  if (totals.netFunding === null) reasons.add("Funding totals need the actual recorded EUR settlement; affected totals remain unavailable.");
  let performance = null, baseline = null;
  if (histories !== null) {
    const throughBook = { ...ledger, transactions: ledger.transactions.filter(entry => entry.date <= to) };
    performance = calculatePortfolioPerformance({ book: throughBook, histories, fxHistory, now, from, to });
    // For a first tracking year, value only the opening snapshot and cash,
    // before first-day deposits/trades. For later years use Dec 31's snapshot.
    const baselineBook = from === ledger.settings.startDate
      ? { ...ledger, transactions: ledger.transactions.filter(entry => entry.type === "opening_cash") }
      : { ...ledger, transactions: ledger.transactions.filter(entry => entry.date < from) };
    baseline = calculatePortfolioPerformance({ book: baselineBook, histories, fxHistory, now,
      to: from === ledger.settings.startDate ? from : shiftDay(from, -1) });
    for (const reason of [...performance.reasons, ...baseline.reasons]) {
      if (reason !== "SPY benchmark history is unavailable.") reasons.add(reason);
    }
  }
  const months = [];
  for (let month = Number(from.slice(5, 7)); month <= Number(to.slice(5, 7)); month++) {
    const key = `${year}-${String(month).padStart(2, "0")}`, row = performance?.months.find(row => row.month === key);
    const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    months.push({ month: key, from: row?.startDate || (month === Number(from.slice(5, 7)) ? from : `${key}-01`),
      to: row?.endDate || (month === Number(to.slice(5, 7)) ? to : lastDay),
      ...activity(entries.filter(entry => entry.date.startsWith(key))),
      startValue: row?.startValue ?? null, endValue: row?.endValue ?? null, gain: row?.gain ?? null,
      return: row?.return ?? null, status: row?.status || (histories === null ? "loading" : "unavailable") });
  }
  const openingValue = performance?.months[0]?.startValue ?? null, closingValue = performance?.summary.currentValue ?? null;
  const realizedGain = entries.some(entry => entry.type === "sell")
    ? difference(performance?.summary.realizedGain, baseline?.summary.realizedGain) : 0;
  const unrealizedOpening = baseline?.summary.unrealizedGain ?? null, unrealizedClosing = performance?.summary.unrealizedGain ?? null;
  const unrealizedChange = difference(unrealizedClosing, unrealizedOpening);
  const gain = performance?.summary.selectedPeriodGain ?? null;
  const components = sum([realizedGain, unrealizedChange, totals.income, totals.standaloneFees === null ? null : -totals.standaloneFees]);
  return { year, from, to, yearToDate: year === Number(today.slice(0, 4)), partialTracking: from !== `${year}-01-01`,
    completeYear: from === `${year}-01-01` && to === `${year}-12-31`, historyReady: histories !== null,
    ...totals, openingValue, closingValue, gain, return: performance?.summary.return ?? null, realizedGain,
    unrealizedOpening, unrealizedClosing, unrealizedChange, otherValuationChanges: difference(gain, components),
    openingCostEstimated: Boolean(performance?.methodology.openingCostEstimated),
    months, reasons: [...reasons], error: null };
}
