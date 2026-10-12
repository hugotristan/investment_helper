import { projectPortfolioBook, portfolioToday } from "./portfolio-ledger.js";
import { normalizeExchangeRate } from "../data/exchange-rate.js";
import { historicalRate } from "../data/portfolio-history.js";
import { DIVIDEND_INTERVALS, dividendDateAfterMonths, dividendPositionKey, isAccumulatingFund,
  nextDividendDate, normalizeDividendAssumptions } from "./dividend-assumptions.js";

export function dividendForecast(book, { now = Date.now(), exchangeRate = null, fxHistory = null } = {}) {
  const from = portfolioToday(now), until = dividendDateAfterMonths(from, 12);
  const to = new Date(Date.parse(until) - 86400000).toISOString().slice(0, 10);
  const positions = projectPortfolioBook(book).holdings;
  const plans = normalizeDividendAssumptions(book.dividendAssumptions || []);
  const rate = normalizeExchangeRate(exchangeRate, { now });
  const rows = [], missing = [], accumulating = [], inactive = [], unknownShares = [], noDividend = [], fxDates = new Map();
  const months = new Map();
  for (let date = `${from.slice(0, 7)}-01`; date < until; date = dividendDateAfterMonths(date, 1)) {
    months.set(date.slice(0, 7), { month: date.slice(0, 7), value: 0, payments: 0 });
  }
  let total = 0, covered = 0;
  for (const position of positions) {
    const key = dividendPositionKey(position);
    if (isAccumulatingFund(position.ticker)) { accumulating.push(position.ticker); continue; }
    if (!Number.isFinite(position.shares) || position.shares <= 0) { unknownShares.push(position.ticker); continue; }
    const plan = plans.find(entry => dividendPositionKey(entry) === key);
    if (!plan) { missing.push(`${position.ticker} (${position.currency})`); continue; }
    covered++;
    if (plan.frequency === "none") { noDividend.push(position.ticker); continue; }
    const first = nextDividendDate(plan, from);
    if (!first || first >= until) { inactive.push(`${position.ticker} (${position.currency})`); continue; }
    const conversion = position.currency === "EUR" ? { rate: 1, date: null }
      : position.currency === "USD" ? rate : historicalRate(fxHistory, position.currency, from, { now });
    if (conversion?.date) fxDates.set(position.currency, conversion.date);
    const interval = DIVIDEND_INTERVALS[plan.frequency];
    // Use the original anchor after finding the first event; re-clamping that
    // event would drift end-of-month payment dates across later months.
    const originalMonth = Number(plan.firstPaymentDate.slice(0, 4)) * 12 + Number(plan.firstPaymentDate.slice(5, 7));
    const firstMonth = Number(first.slice(0, 4)) * 12 + Number(first.slice(5, 7));
    const offset = firstMonth - originalMonth;
    for (let step = 0; step < 13; step++) {
      const date = step === 0 ? first : dividendDateAfterMonths(plan.firstPaymentDate, offset + step * interval);
      if (date >= until || step > 0 && interval === 0) break;
      const native = position.shares * plan.amountPerShare;
      const eur = Number.isFinite(native) && native >= 0 && (native === 0 || conversion)
        ? native === 0 ? 0 : native * conversion.rate : null;
      const value = Number.isFinite(eur) ? eur : null;
      rows.push({ date, ticker: position.ticker, currency: position.currency, shares: position.shares,
        amountPerShare: plan.amountPerShare, native: Number.isFinite(native) ? native : null,
        eur: value, frequency: plan.frequency, fxDate: conversion?.date || null });
      const month = months.get(date.slice(0, 7));
      month.payments++;
      month.value = month.value === null || value === null || !Number.isFinite(month.value + value) ? null : month.value + value;
      total = total === null || value === null || !Number.isFinite(total + value) ? null : total + value;
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
  return { from, to, rows, months: [...months.values()], total, covered, missing, accumulating: [...new Set(accumulating)],
    noDividend, unknownShares, inactive, fxDates: Object.fromEntries(fxDates),
    unheld: plans.filter(plan => !positions.some(position => dividendPositionKey(position) === dividendPositionKey(plan))) };
}
