import { average, clamp, roundPercent } from "../shared/math.js";
import { hasQualifiedSignal } from "./data-quality.js";

export function buildModelAllocation(results, marketContext) {
  results = results.filter(hasQualifiedSignal);
  const candidates = results.filter((item) => item.score >= 58);
  const funds = candidates.filter((item) => item.isFund).slice(0, 2);
  const stocks = candidates.filter((item) => !item.isFund).slice(0, 4);
  const averageScore = average(results.map((item) => item.score));
  const forecastScore = marketContext?.score ?? 50;
  const marketCash = averageScore >= 78 ? 8 : averageScore >= 68 ? 12 : averageScore >= 58 ? 22 : 40;
  const forecastCash = forecastScore >= 68 ? -6 : forecastScore >= 56 ? -2 : forecastScore < 34 ? 18 : forecastScore < 45 ? 10 : 0;
  let cash = clamp(marketCash + forecastCash, 5, 65);
  const profile = { fund: 0.62, maxStock: 16 };
  const investable = 100 - cash;
  const fundBudget = investable * profile.fund;
  const stockBudget = investable - fundBudget;
  const actions = [];

  if (funds.length) {
    const totalFundScore = funds.reduce((sum, item) => sum + item.score, 0);
    funds.forEach((item) => actions.push(modelAction(item, (fundBudget * item.score) / totalFundScore)));
  } else {
    cash += fundBudget;
  }

  if (stocks.length) {
    const totalStockScore = stocks.reduce((sum, item) => sum + item.score, 0);
    stocks.forEach((item) => actions.push(modelAction(item, Math.min(profile.maxStock, (stockBudget * item.score) / totalStockScore))));
  } else {
    cash += stockBudget;
  }

  const allocated = actions.reduce((sum, action) => sum + action.percent, 0);
  actions.push({
    kind: "cash",
    ticker: "Cash",
    percent: roundPercent(clamp(100 - allocated, 0, 100)),
    label: "Hold back",
    reason: Number.isFinite(marketContext?.score)
      ? `Reserve adjusted for market regime: ${marketContext.label}.`
      : !results.length ? "No instruments have qualified recent price history; no allocation signal is available."
      : "Reserve for volatility, bad fills, and better entries if the deep scans weaken."
  });

  const avoid = [...results].reverse().find((item) => item.score < 55 || item.flags.some((flag) => flag.includes("Below 200-day") || flag.includes("High volatility"))) || results.at(-1);
  return {
    actions: normalizeActions(actions),
    avoid: {
      ticker: avoid?.ticker || "-",
      text: avoid ? `${avoid.label} (${avoid.score}/100). ${avoid.flags[0] || "The model sees stronger alternatives today."}` : "No avoid candidate found."
    }
  };
}

function modelAction(item, percent) {
  const outlook = item.outlooks[0];
  const headline = item.headlines[0];
  return {
    kind: "invest",
    ticker: item.ticker,
    percent: roundPercent(percent),
    label: item.label,
    signal: item.setup?.signal || item.label,
    setup: item.setup,
    reason: outlook
      ? `${item.label}. Trusted outlook: ${outlook.source}: ${outlook.title}`
      : headline ? `${item.label}. ${headline.source}: ${headline.title}` : `${item.label}. ${item.reasons[0] || "Score is stronger than watchlist average."}`
  };
}

function normalizeActions(actions) {
  const live = actions.filter((action) => action.percent > 0);
  const diff = roundPercent(100 - live.reduce((sum, action) => sum + action.percent, 0));
  const cash = live.find((action) => action.kind === "cash");
  if (cash) cash.percent = roundPercent(cash.percent + diff);
  return live.filter((action) => action.percent > 0);
}
