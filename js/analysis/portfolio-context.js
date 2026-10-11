import { projectPortfolioBook } from "./portfolio-ledger.js";
import { calculateHoldings } from "./holdings.js";
import { holdingEurReturn } from "./portfolio-returns.js";
import { calculatePortfolioTotals } from "./portfolio-totals.js";
import { calculatePortfolioAnalytics } from "./portfolio-analytics.js";
import { calculatePortfolioPerformance } from "./portfolio-performance.js";
import { calculateEtfExposure } from "./etf-exposure.js";
import { normalizeExchangeRate } from "../data/exchange-rate.js";
import { normalizeStockHistory } from "../data/stock-history.js";
import { normalizeHistoricalFx } from "../data/portfolio-history.js";
import { positionOrganization } from "./portfolio-organization.js";

// All figures come from the same pure calculators used by Portfolio/Reports.
// Insights and the optional copyable summary use calculated facts, not the raw ledger.
export function buildAnalystContext({ book, revision, histories = {}, exchangeRate, fxHistory, includeNotes = false, now = Date.now() }) {
  const projection = projectPortfolioBook(book);
  const rate = normalizeExchangeRate(exchangeRate, { now });
  const sources = [{ id: "ledger", name: "Your recorded portfolio", url: "#portfolio", asOf: book.updatedAt }];
  if (rate) sources.push({ id: "fx", name: rate.source, url: rate.sourceUrl, asOf: rate.date });
  const historicalFx = normalizeHistoricalFx(fxHistory, { now });
  if (historicalFx) sources.push({ id: "historical-fx", name: historicalFx.source, url: historicalFx.sourceUrl,
    asOf: Object.values(historicalFx.byCurrency).flatMap((points) => points.map((point) => point.date)).sort().at(-1) });
  const qualified = {};
  for (const [ticker, raw] of Object.entries(histories)) {
    const history = normalizeStockHistory(raw, ticker, { now });
    if (history) {
      qualified[ticker] = history;
      sources.push({ id: `price-${ticker}`, name: `Yahoo Finance · ${ticker}`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/history/`,
        asOf: history.historyAsOf });
    }
  }
  const results = Object.values(qualified).map((history) => ({ ...history,
    dataQuality: { eligible: false, asOf: history.historyAsOf } }));
  const holdings = calculateHoldings(projection.holdings, results, { now }).holdings.map((holding) => {
    const annotation = positionOrganization(book.organization, holding);
    return { ...holding, eur: holdingEurReturn(holding, { eurCostBases: projection.eurCostBases, exchangeRate: rate }),
      annotation, groupName: book.organization?.groups.find((group) => group.id === annotation.groupId)?.name || "Ungrouped",
      analysis: { instrumentType: qualified[holding.ticker]?.instrumentType } };
  });
  const totals = calculatePortfolioTotals({ holdings, book, projection, exchangeRate: rate, now });
  const analytics = calculatePortfolioAnalytics(holdings);
  const performance = calculatePortfolioPerformance({ book, histories: qualified, fxHistory, now });
  const exposure = calculateEtfExposure(analytics, { now });
  const limitations = new Set([...totals.reasons, ...performance.reasons, ...projection.warnings]);
  limitations.add("Current values use dated quotes and reference FX; broker prices and conversion rates can differ.");
  limitations.add("Monthly returns use approximate Modified Dietz. SPY comparison is an EUR price return and excludes dividends.");
  limitations.add("This evidence does not include current company financials, news, price targets, taxes, or your risk tolerance.");
  if (projection.holdings.length > 40) limitations.add("Detailed evidence covers the first forty held positions. Price history checks cover at most fifty-nine portfolio tickers; incomplete totals and weights are withheld.");
  if (exposure.hasEtfs) limitations.add("ETF company exposure is partial: only Vanguard's dated VWCE top holdings are covered. Unreported companies are unknown, not zero.");
  const facts = [];
  const add = (id, label, value, unit, asOf, sourceIds, route) => {
    if (value === null || value === undefined || typeof value === "number" && !Number.isFinite(value) || facts.length >= 600) return;
    const display = typeof value !== "number" ? String(value) : unit === "EUR"
      ? new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(value)
      : unit === "percent" ? `${(value * 100).toFixed(2)}%` : unit === "rate" ? value.toFixed(6)
      : new Intl.NumberFormat("en-IE", { maximumFractionDigits: 8 }).format(value);
    facts.push({ id, label, value, unit, display, asOf, sourceIds: sourceIds.filter((id) => sources.some((source) => source.id === id)), route });
  };
  const latest = analytics.oldestPrice || book.updatedAt;
  const currentSources = ["ledger", "fx", ...holdings.map((holding) => `price-${holding.ticker}`)];
  add("money-in", "Money put in (deposits minus withdrawals, plus starting cash)", totals.contributed, "EUR", book.updatedAt, ["ledger"], "#portfolio");
  add("total-value", "Current holdings plus recorded cash", totals.totalValue, "EUR", latest, currentSources, "#portfolio");
  add("holdings-value", "Current holdings value, excluding cash", totals.holdingsValue, "EUR", latest, currentSources, "#report-allocation");
  add("cash", "Recorded EUR cash", totals.cashValue, "EUR", book.updatedAt, ["ledger"], "#portfolio");
  add("holding-count", "Number of held positions", holdings.length, "count", book.updatedAt, ["ledger"], "#portfolio");
  if (holdings.length && holdings.every((holding) => Number.isFinite(holding.eur.gain))) {
    add("held-gain", "Unrealized EUR gain on current holdings", holdings.reduce((sum, holding) => sum + holding.eur.gain, 0), "EUR", latest, currentSources, "#report-investments");
  }
  if (rate) add("usd-eur", "Current USD-to-EUR reference rate", rate.rate, "rate", rate.date, ["fx"], "#sources");
  if (analytics.concentration) {
    const { largest, topWeight, topCount } = analytics.concentration;
    add("largest-position", "Largest direct position", `${largest.ticker} (${largest.assetType})`, "text", latest, currentSources, "#report-allocation");
    add("largest-weight", "Largest direct position share of holdings", largest.weight, "percent", latest, currentSources, "#report-allocation");
    add("top-weight", `Largest ${topCount} positions share of holdings`, topWeight, "percent", latest, currentSources, "#report-allocation");
  }
  for (const [key, rows] of [["best", analytics.best], ["worst", analytics.worst]]) if (rows.length) {
    add(`${key}-position`, `${key === "best" ? "Highest" : "Lowest"} available unrealized percentage return position`, rows[0].ticker, "text", latest, currentSources, "#report-investments");
    add(`${key}-return`, `${key === "best" ? "Highest" : "Lowest"} available unrealized EUR percentage return`, rows[0].returnPercent, "percent", latest, currentSources, "#report-investments");
  }
  for (const [index, holding] of holdings.slice(0, 40).entries()) {
    const row = analytics.rows.find((row) => row.ticker === holding.ticker && row.currency === holding.currency);
    const id = `holding-${index}`;
    const label = `${holding.ticker} (${holding.currency})`;
    const provenance = ["ledger", `price-${holding.ticker}`, ...(holding.currency === "USD" ? ["fx"] : [])];
    add(`${id}-shares`, `${label} shares`, holding.shares, "shares", book.updatedAt, ["ledger"], "#portfolio");
    add(`${id}-cost`, `${label} recorded remaining EUR purchase cost`, holding.eur.costBasis, "EUR", book.updatedAt, ["ledger"], "#report-investments");
    add(`${id}-value`, `${label} current EUR value`, holding.eur.currentValue, "EUR", holding.asOf, provenance, "#portfolio");
    add(`${id}-gain`, `${label} unrealized EUR gain (includes FX effect)`, holding.eur.gain, "EUR", holding.asOf, provenance, "#report-investments");
    add(`${id}-return`, `${label} unrealized gain / recorded EUR purchase cost`, holding.eur.gainPercent, "percent", holding.asOf, provenance, "#report-investments");
    add(`${id}-weight`, `${label} share of current holdings (cash excluded)`, row?.weight, "percent", holding.asOf, currentSources, "#report-allocation");
    add(`${id}-group`, `${label} group`, holding.groupName, "text", book.updatedAt, ["ledger"], "#portfolio");
    add(`${id}-type`, `${label} asset type`, row?.assetType, "text", book.updatedAt, ["ledger"], "#report-allocation");
    if (holding.currency === "USD" && rate && Number.isFinite(holding.gain)) {
      const convertedGain = holding.gain * rate.rate;
      add(`${id}-native-gain-eur`, `${label} USD gain converted at current FX`, convertedGain, "EUR", holding.asOf, provenance, "#report-investments");
      if (Number.isFinite(holding.eur.gain)) add(`${id}-fx-difference`, `${label} EUR gain minus converted USD gain`, holding.eur.gain - convertedGain, "EUR", holding.asOf, provenance, "#report-investments");
    }
  }
  for (const [index, group] of analytics.allocations.groups.slice(0, 15).entries()) {
    add(`group-${index}-weight`, `${group.label} share of holdings`, group.weight, "percent", latest, currentSources, "#report-allocation");
  }
  const performanceSources = ["ledger", "historical-fx", ...Object.keys(qualified).map((ticker) => `price-${ticker}`)];
  const performanceLabels = { realizedGain: "Realized EUR gains on sold shares", unrealizedGain: "Unrealized EUR gain at period daily close",
    income: "Recorded EUR cash income", fees: "EUR fee subtotal (foreign fees use reference FX)", totalGain: "Total recorded EUR gain",
    return: "Approximate cash-flow-adjusted portfolio return", benchmarkReturn: "SPY EUR price return (excludes dividends)", excessReturn: "Portfolio return minus SPY EUR price return" };
  for (const [key, label] of Object.entries(performanceLabels)) {
    add(`performance-${key}`, `${label} · recorded period ending ${performance.endDate || "unavailable"}`, performance.summary[key],
      key.includes("Return") || key === "return" ? "percent" : "EUR", performance.endDate, performanceSources, "#portfolio-performance");
  }
  for (const month of performance.months.slice(-12)) {
    add(`month-${month.month}-return`, `${month.month} approximate cash-flow-adjusted return`, month.return, "percent", month.endDate, performanceSources, "#portfolio-performance");
    add(`month-${month.month}-gain`, `${month.month} change in value excluding external cash flow`, month.gain, "EUR", month.endDate, performanceSources, "#portfolio-performance");
    add(`month-${month.month}-flow`, `${month.month} deposits minus withdrawals`, month.netFlow, "EUR", month.endDate, ["ledger"], "#report-funding");
  }
  for (const fund of exposure.reports) {
    const id = `fund-${fund.ticker}`;
    sources.push({ id, name: fund.source, url: fund.sourceUrl, asOf: fund.asOf });
    add(`${id}-coverage`, `${fund.ticker} portion covered by published company weights`, fund.coverage, "percent", fund.asOf, [id], "#report-etf");
  }
  for (const [index, company] of exposure.rows.filter((row) => row.indirect > 0).slice(0, 12).entries()) {
    add(`company-${index}-weight`, `${company.name} known direct plus partial ETF exposure / total holdings`, company.weight, "percent", latest,
      [...currentSources, ...exposure.reports.map((fund) => `fund-${fund.ticker}`)], "#report-etf");
  }
  const notes = [];
  if (includeNotes) {
    let remaining = 12000;
    for (const holding of holdings.slice(0, 40)) if (holding.annotation.note && remaining > 0) {
      const text = holding.annotation.note.slice(0, remaining);
      notes.push({ ticker: holding.ticker, currency: holding.currency, text });
      remaining -= text.length;
    }
    if ((book.organization?.positions || []).reduce((sum, item) => sum + item.note.length, 0) > 12000) limitations.add("Position notes are limited to twelve thousand characters in this request.");
  }
  const month = performance.months.at(-1);
  return { generatedAt: new Date(now).toISOString(), portfolioRevision: revision, facts, sources,
    latestMonth: month ? { month: month.month, startDate: month.startDate, endDate: month.endDate, status: month.status,
      partial: month.startDate !== `${month.month}-01` || month.endDate < new Date(Date.UTC(Number(month.month.slice(0, 4)), Number(month.month.slice(5, 7)), 0)).toISOString().slice(0, 10) } : null,
    limitations: [...limitations].map((value) => typeof value === "string" ? value : JSON.stringify(value)).slice(0, 35), notes };
}

