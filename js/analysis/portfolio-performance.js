import { portfolioToday, validatePortfolioBook } from "./portfolio-ledger.js";
import { historicalRate, normalizeHistoricalFx } from "../data/portfolio-history.js";

const DAY = 86400000;
const MAX_PRICE_AGE = 7 * DAY;
const CASH_TOLERANCE = 1e-7;
const FUNDING = new Set(["deposit", "withdrawal"]);
const PRICE_SOURCE = "Yahoo Finance published snapshot";
const METHOD_SOURCE = "https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/";

// Rates are ratios (0.1 means 10%). Gains use recorded EUR settlements, while
// the return series measures growth from the opening market value, not cost.
export function calculatePortfolioPerformance({ book, histories = {}, fxHistory = null, now = Date.now(),
  benchmark = "SPY", from, to } = {}) {
  const reasons = new Set();
  const methodology = {
    returnMethod: "Monthly Modified Dietz (approximate), geometrically linked",
    cashFlowTiming: "end-of-day",
    benchmarkMethod: `${benchmark} EUR price return; dividends excluded`,
    gainScope: "Cost-basis gains through endDate; opening foreign costs use estimated start-date FX",
    returnScope: "startDate through endDate", openingCostEstimated: false, feesEstimated: false,
    inactivePeriods: "Covered periods with no capital exposure stay visible and are excluded from return linking.",
    sourceUrl: METHOD_SOURCE
  };
  const result = { currency: "EUR", startDate: null, endDate: null, trackingStartDate: null,
    returnStartDate: null, comparisonStartDate: null,
    summary: { currentValue: null, realizedGain: null, unrealizedGain: null, income: null, fees: null,
      netContributions: null, totalGain: null, return: null, benchmarkReturn: null, excessReturn: null,
      openingValue: null, selectedPeriodGain: null, selectedPeriodNetFlow: null },
    series: [], months: [], holdings: [], reasons: [], methodology };
  const finish = () => { result.reasons = [...reasons]; return result; };
  let today;
  try { today = portfolioToday(now); }
  catch { reasons.add("The reporting date is invalid."); return finish(); }
  const validation = validatePortfolioBook(book, { now });
  if (!validation.ok) { reasons.add(validation.error || "The portfolio ledger is unavailable."); return finish(); }
  const ledger = validation.book;
  const normalizedFx = normalizeHistoricalFx(fxHistory, { now });
  const first = ledger.settings.startDate;
  // Match the published price pipeline: the current UTC daily bar is excluded,
  // including the interval after midnight in Tallinn but before UTC midnight.
  const utcToday = new Date(now).toISOString().slice(0, 10);
  const lastCompleted = [shiftDay(today, -1), shiftDay(utcToday, -1)].sort()[0];
  const last = to === undefined ? lastCompleted : validDay(to) && to < lastCompleted ? to : lastCompleted;
  const selectedStart = from === undefined ? first : validDay(from) && from > first ? from : first;
  if (from !== undefined && !validDay(from) || to !== undefined && !validDay(to)
    || first > last || selectedStart > last) {
    reasons.add("Choose a reporting period with at least one completed calendar day."); return finish();
  }
  if ((time(last) - time(first)) / DAY > 50000) {
    reasons.add("The tracking period exceeds the supported daily reporting range."); return finish();
  }
  result.startDate = selectedStart; result.endDate = last; result.trackingStartDate = first;
  methodology.returnScope = `${selectedStart} through ${last}`;

  const entries = ledger.transactions.map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index);
  const positions = new Map();
  const cash = new Map();
  let cashComplete = true;
  let income = 0;
  let fees = 0;
  let standaloneFees = 0;
  let contributions = 0;
  let openingCash = 0;
  let flowCursor = 0;
  const flows = [];
  const priceCache = new Map();
  const splitAcquisition = new Map();
  for (const holding of ledger.openingHoldings) if (holding.kind === "position") {
    splitAcquisition.set(`${holding.ticker}|${holding.currency}`, first);
  }
  for (const entry of entries) if (entry.type === "buy") {
    const key = `${entry.ticker}|${entry.currency}`;
    if (!splitAcquisition.has(key)) splitAcquisition.set(key, entry.date);
  }
  const unsupportedActions = new Set();
  for (const [key, acquired] of splitAcquisition) {
    const ticker = key.split("|")[0];
    const history = histories?.[ticker];
    if (history?.source === PRICE_SOURCE && (history.splitsComplete === false || !Array.isArray(history.splits)
      || history.splits.some((split) => {
        const date = dayOf(split?.date);
        return !date || date >= acquired && date <= last;
      }))) {
      unsupportedActions.add(key);
      reasons.add(`${ticker} share quantities and gains need complete, recorded corporate actions.`);
    }
  }

  const convert = (amount, currency, date) => {
    if (!Number.isFinite(amount)) return null;
    const observed = historicalRate(normalizedFx, currency, date, { now });
    if (!observed) { reasons.add(`Historical ${currency}-to-EUR rates are missing or too old for part of the period.`); return null; }
    const converted = amount * observed.rate;
    if (!Number.isFinite(converted)) { reasons.add("Portfolio amounts exceed the supported number range."); return null; }
    return converted;
  };
  const settlement = (entry) => {
    if (entry.cashCurrency) return convert(entry.cashAmount, entry.cashCurrency, entry.date);
    if (entry.currency === "EUR" && ledger.settings.baseCurrency === "EUR") {
      return entry.type === "buy" ? entry.amount + entry.fee : entry.type === "sell" ? entry.amount - entry.fee : entry.amount;
    }
    reasons.add("Foreign transactions need their actual converted cash amounts before performance can be calculated.");
    return null;
  };
  const historyFor = (ticker, currency, acquired = null) => {
    const key = `${ticker}|${currency}|${acquired || "benchmark"}`;
    if (priceCache.has(key)) return priceCache.get(key);
    const history = Object.hasOwn(histories || {}, ticker) ? histories[ticker] : null;
    let prices = null;
    if (!history || history.ticker !== ticker || history.currency !== currency || history.source !== PRICE_SOURCE
      || !Array.isArray(history.prices) || history.prices.length > 1600) {
      reasons.add(`Real daily ${ticker} prices in ${currency} are unavailable.`);
    } else if (acquired && (history.splitsComplete === false || !Array.isArray(history.splits))) {
      reasons.add(`${ticker} split history is incomplete; its historical valuation is unavailable.`);
    } else if (acquired && history.splits.some((split) => {
      const date = dayOf(split?.date);
      return !date || date >= acquired && date <= today;
    })) {
      reasons.add(`${ticker} has a split after acquisition. Record-adjusted quantities are required before historical valuation.`);
    } else {
      const byDay = new Map();
      for (const point of history.prices) {
        const date = dayOf(point?.date);
        if (date && date < today && Number.isFinite(point.close) && point.close > 0) byDay.set(date, point.close);
      }
      prices = [...byDay].sort(([a], [b]) => a.localeCompare(b));
    }
    priceCache.set(key, prices);
    return prices;
  };
  const priceAt = (ticker, currency, date, acquired = null) => {
    const prices = historyFor(ticker, currency, acquired);
    if (!prices) return null;
    // Binary search never borrows a later quote to fill missing early history.
    let low = 0; let high = prices.length - 1; let match = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (prices[middle][0] <= date) { match = middle; low = middle + 1; } else high = middle - 1;
    }
    if (match < 0 || time(date) - time(prices[match][0]) > MAX_PRICE_AGE) {
      reasons.add(`${ticker} daily price history does not cover the whole reporting period.`); return null;
    }
    return convert(prices[match][1], currency, date);
  };
  const positionFor = (ticker, currency) => {
    const key = `${ticker}|${currency}`;
    if (!positions.has(key)) positions.set(key, { ticker, currency, shares: 0, costBasis: 0, realizedGain: 0 });
    return positions.get(key);
  };
  const applyCash = (entry) => {
    const cashCurrency = entry.cashCurrency || entry.currency;
    let amount = entry.cashCurrency ? entry.cashAmount : entry.type === "buy" ? entry.amount + entry.fee
      : entry.type === "sell" ? entry.amount - entry.fee : entry.amount;
    if (["buy", "withdrawal", "fee"].includes(entry.type)) amount = -amount;
    cash.set(cashCurrency, add(cash.has(cashCurrency) ? cash.get(cashCurrency) : 0, amount));
    if (!entry.cashCurrency && entry.currency !== ledger.settings.baseCurrency) cashComplete = false;
  };
  const apply = (entry) => {
    const euros = settlement(entry);
    applyCash(entry);
    if (entry.type === "buy" || entry.type === "sell") {
      const position = positionFor(entry.ticker, entry.currency);
      if (unsupportedActions.has(`${entry.ticker}|${entry.currency}`)) {
        position.costBasis = null; position.realizedGain = null;
      }
      if (entry.type === "buy") {
        position.shares = add(position.shares, entry.quantity);
        position.costBasis = add(position.costBasis, euros);
      } else {
        const quantity = Math.min(entry.quantity, position.shares);
        const disposedCost = position.costBasis === null ? null : position.costBasis * quantity / position.shares;
        position.realizedGain = add(position.realizedGain, subtract(euros, disposedCost));
        const remaining = position.shares - quantity;
        position.shares = remaining <= Number.EPSILON * 8 * Math.max(position.shares, quantity) ? 0 : remaining;
        position.costBasis = position.shares === 0 ? 0 : subtract(position.costBasis, disposedCost);
      }
      let tradeFee = 0;
      if (entry.fee > 0) {
        if (entry.currency !== "EUR") methodology.feesEstimated = true;
        const nativeNet = entry.type === "buy" ? entry.amount + entry.fee : entry.amount - entry.fee;
        tradeFee = entry.currency === "EUR" ? entry.fee : euros !== null && nativeNet > 0
          ? finite(euros * entry.fee / nativeNet) : convert(entry.fee, entry.currency, entry.date);
      }
      fees = add(fees, tradeFee);
    } else if (entry.type === "dividend") income = add(income, euros);
    else if (entry.type === "fee") { standaloneFees = add(standaloneFees, euros); fees = add(fees, euros); }
    else if (entry.type === "opening_cash") { openingCash = add(openingCash, euros); contributions = add(contributions, euros); }
    else if (FUNDING.has(entry.type)) {
      const amount = entry.type === "withdrawal" && euros !== null ? -euros : euros;
      contributions = add(contributions, amount); flows.push({ date: entry.date, amount });
    }
  };

  for (const holding of ledger.openingHoldings) {
    if (holding.kind === "manual") { reasons.add("Amount-only opening holdings cannot support performance tracking."); cashComplete = false; continue; }
    const position = positionFor(holding.ticker, holding.currency);
    position.shares = add(position.shares, holding.shares);
    position.costBasis = add(position.costBasis, convert(holding.shares * holding.averageCost, holding.currency, first));
    if (unsupportedActions.has(`${holding.ticker}|${holding.currency}`)) { position.costBasis = null; position.realizedGain = null; }
    if (holding.currency !== "EUR") methodology.openingCostEstimated = true;
  }
  // Opening cash belongs to the baseline; deposits on the same day remain flows.
  for (const entry of entries.filter(({ type }) => type === "opening_cash")) apply(entry);
  const remainingEntries = entries.filter(({ type }) => type !== "opening_cash");
  const valuation = (date) => {
    let value = 0;
    let valid = cashComplete && unsupportedActions.size === 0;
    for (const [currency, amount] of cash) {
      if (amount === null) { valid = false; reasons.add("Portfolio amounts exceed the supported number range."); continue; }
      if (amount < -CASH_TOLERANCE) { valid = false; reasons.add("Recorded cash is negative during the period. Funding history may be incomplete."); }
      value = add(value, convert(Math.abs(amount) <= CASH_TOLERANCE ? 0 : amount, currency, date));
    }
    for (const [key, position] of positions) if (position.shares > 0) {
      const price = priceAt(position.ticker, position.currency, date, splitAcquisition.get(key));
      value = add(value, price === null ? null : price * position.shares);
    }
    if (value === null) reasons.add("At least one valuation is unavailable; incomplete intervals are not treated as zero.");
    return valid ? value : null;
  };
  const openingValue = valuation(first);
  result.summary.openingValue = openingValue;
  const daily = [];
  for (let date = first; date <= last; date = shiftDay(date, 1)) {
    while (flowCursor < remainingEntries.length && remainingEntries[flowCursor].date <= date) apply(remainingEntries[flowCursor++]);
    const value = valuation(date);
    daily.push({ date, value, netContributions: contributions, openingCash });
  }
  const endValue = daily.at(-1).value;
  result.summary.currentValue = endValue;
  result.summary.income = income; result.summary.fees = fees; result.summary.netContributions = contributions;

  let realized = 0; let unrealized = 0;
  for (const [key, position] of positions) {
    const price = position.shares > 0 ? priceAt(position.ticker, position.currency, last, splitAcquisition.get(key)) : 0;
    const currentValue = price === null ? null : finite(price * position.shares);
    const unrealizedGain = subtract(currentValue, position.costBasis);
    result.holdings.push({ ...position, currentValue, unrealizedGain });
    realized = add(realized, position.realizedGain); unrealized = add(unrealized, unrealizedGain);
  }
  result.summary.realizedGain = realized; result.summary.unrealizedGain = unrealized;
  result.summary.totalGain = subtract(add(add(realized, unrealized), income), standaloneFees);
  if (ledger.openingHoldings.some(({ kind }) => kind === "manual")) {
    result.summary.realizedGain = null; result.summary.unrealizedGain = null; result.summary.totalGain = null;
  }

  const selectedIndex = daily.findIndex(({ date }) => date === selectedStart);
  const baselineValue = selectedIndex === 0 ? openingValue : daily[selectedIndex - 1].value;
  const boundary = shiftDay(selectedStart, -1);
  const selectedFlows = flows.filter(({ date }) => date >= selectedStart && date <= last);
  const flowByDate = new Map();
  for (const { date, amount } of selectedFlows) flowByDate.set(date, add(flowByDate.has(date) ? flowByDate.get(date) : 0, amount));
  const benchmarkCurrency = histories?.[benchmark]?.currency;
  const benchmarkPrice = (date) => benchmarkCurrency ? priceAt(benchmark, benchmarkCurrency, date) : null;
  const chosenDays = daily.slice(selectedIndex);
  let exposureIndex = baselineValue === 0 ? chosenDays.findIndex(({ date, value }) => value === null || value > 0
    || flowByDate.has(date) && flowByDate.get(date) !== 0) : 0;
  if (exposureIndex > 0 && chosenDays[exposureIndex].value === null) exposureIndex = 0;
  const returnStart = exposureIndex >= 0 ? chosenDays[exposureIndex].date : null;
  result.returnStartDate = returnStart; result.comparisonStartDate = returnStart;
  if (returnStart) methodology.returnScope = `${returnStart} through ${last}`;
  const benchmarkBaselineDate = exposureIndex > 0 || selectedIndex === 0 ? returnStart : boundary;
  const benchmarkBaseline = benchmarkBaselineDate ? benchmarkPrice(benchmarkBaselineDate) : null;
  if (!benchmarkCurrency) reasons.add(`${benchmark} benchmark history is unavailable.`);
  let linked = 1; let linkedComplete = true;
  let monthBoundary = boundary; let monthStartValue = baselineValue;
  let monthStart = selectedStart;
  let monthNetFlow = 0; let monthFlowDateWeight = 0; let periodNetFlow = 0;
  let monthCovered = true; let benchmarkCovered = true; let monthBenchmarkCovered = true;
  let monthExposure = monthStartValue !== null && monthStartValue > 0;
  let previousValue = baselineValue;
  for (const point of chosenDays) {
    if (exposureIndex > 0 && point.date === returnStart) {
      monthBoundary = shiftDay(returnStart, -1); monthStart = returnStart; monthStartValue = previousValue;
      monthNetFlow = 0; monthFlowDateWeight = 0; monthCovered = true; monthBenchmarkCovered = true;
    }
    const days = (time(point.date) - time(monthBoundary)) / DAY;
    const flow = flowByDate.has(point.date) ? flowByDate.get(point.date) : 0;
    monthNetFlow = add(monthNetFlow, flow); periodNetFlow = add(periodNetFlow, flow);
    monthFlowDateWeight = add(monthFlowDateWeight, flow === null ? null : finite(flow * days));
    const netFlow = monthNetFlow;
    const weightedFlow = subtract(netFlow, monthFlowDateWeight === null ? null : monthFlowDateWeight / days);
    const gain = subtract(subtract(point.value, monthStartValue), netFlow);
    const denominator = add(monthStartValue, weightedFlow);
    monthCovered = monthCovered && point.value !== null;
    monthExposure = monthExposure || previousValue !== null && previousValue > 0;
    const covered = monthCovered;
    const monthReturn = covered && gain !== null && denominator !== null && denominator > 0 ? finite(gain / denominator) : null;
    const cumulativeReturn = returnStart && point.date >= returnStart && linkedComplete && monthReturn !== null
      ? finite(linked * (1 + monthReturn) - 1) : null;
    const benchmarkValue = returnStart && point.date >= returnStart ? benchmarkPrice(point.date) : null;
    if (returnStart && point.date >= returnStart) {
      benchmarkCovered = benchmarkCovered && benchmarkValue !== null;
      monthBenchmarkCovered = monthBenchmarkCovered && benchmarkValue !== null;
    }
    const benchmarkReturn = benchmarkCovered && benchmarkBaseline !== null && benchmarkBaseline > 0 && benchmarkValue !== null
      ? finite(benchmarkValue / benchmarkBaseline - 1) : null;
    result.series.push({ date: point.date, value: point.value, netContributions: point.netContributions,
      growth: subtract(subtract(point.value, baselineValue), periodNetFlow), return: cumulativeReturn, benchmarkReturn });
    if (point.date === last || shiftDay(point.date, 1).slice(0, 7) !== point.date.slice(0, 7)) {
      const noExposure = covered && !monthExposure && monthStartValue === 0 && denominator === 0 && gain === 0;
      const monthBenchmarkStart = returnStart && point.date >= returnStart
        ? benchmarkPrice(monthStart <= returnStart ? benchmarkBaselineDate : monthBoundary) : null;
      result.months.push({ month: point.date.slice(0, 7), startDate: monthStart, endDate: point.date,
        startValue: monthStartValue, endValue: point.value, netFlow, gain: covered ? gain : null, return: monthReturn,
        status: noExposure ? "no-exposure" : monthReturn === null ? "unavailable" : "complete",
        benchmarkReturn: monthBenchmarkCovered && monthBenchmarkStart !== null && monthBenchmarkStart > 0 && benchmarkValue !== null
          ? finite(benchmarkValue / monthBenchmarkStart - 1) : null });
      if (!noExposure) {
        if (monthReturn === null || !Number.isFinite(linked * (1 + monthReturn))) linkedComplete = false;
        else linked *= 1 + monthReturn;
      }
      monthBoundary = point.date; monthStart = shiftDay(point.date, 1); monthStartValue = point.value;
      monthNetFlow = 0; monthFlowDateWeight = 0; monthCovered = true; monthBenchmarkCovered = true;
      monthExposure = point.value !== null && point.value > 0;
    }
    previousValue = point.value;
  }
  result.summary.return = result.series.at(-1)?.return ?? null;
  result.summary.benchmarkReturn = result.series.at(-1)?.benchmarkReturn ?? null;
  result.summary.excessReturn = subtract(result.summary.return, result.summary.benchmarkReturn);
  result.summary.selectedPeriodNetFlow = periodNetFlow;
  result.summary.selectedPeriodGain = subtract(subtract(endValue, baselineValue), result.summary.selectedPeriodNetFlow);
  if (result.summary.return === null) reasons.add("The complete-period return is unavailable: a valuation, funding amount, or positive invested-capital denominator is missing.");
  if (methodology.openingCostEstimated) reasons.add("Opening foreign-currency cost basis uses estimated start-date reference FX; original converted purchase costs are not recorded.");
  return finish();
}

function finite(value) { return Number.isFinite(value) ? value : null; }
function add(a, b) { return a === null || b === null ? null : finite(a + b); }
function subtract(a, b) { return a === null || b === null ? null : finite(a - b); }
function time(value) { return Date.parse(`${value}T00:00:00Z`); }
function validDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(time(value)) && new Date(time(value)).toISOString().slice(0, 10) === value;
}
function dayOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}
function shiftDay(value, amount) { return new Date(time(value) + amount * DAY).toISOString().slice(0, 10); }
