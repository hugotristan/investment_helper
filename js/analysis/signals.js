import { formatPercent } from "../shared/format.js";

export function buildSellGuidance(results) {
  const sell = [];
  const hold = [];

  results.forEach((item) => {
    const sellSignal = sellSignalFor(item);
    const holdSignal = holdSignalFor(item);
    if (sellSignal) sell.push(sellSignal);
    else if (holdSignal) hold.push(holdSignal);
  });

  return {
    sell: sell.sort((a, b) => b.urgency - a.urgency).slice(0, 6),
    hold: hold.sort((a, b) => b.conviction - a.conviction).slice(0, 6)
  };
}

export function sellSignalFor(item) {
  const triggers = [];
  if (item.score <= 44) triggers.push(`Low total model score: ${item.score}/100.`);
  if (item.latest < item.sma200 && item.sixMonth < 0) triggers.push(`Below 200-day average with ${formatPercent(item.sixMonth)} six-month momentum.`);
  if (item.latest < item.sma50 && item.volumePressure > 0.12) triggers.push(`Fell below the 50-day average while recent volume is ${formatPercent(item.volumePressure)} above baseline.`);
  if (item.oneMonth < -0.06 && item.threeMonth < 0) triggers.push(`Short-term trend is breaking: 1M ${formatPercent(item.oneMonth)}, 3M ${formatPercent(item.threeMonth)}.`);
  if (Number.isFinite(item.rsi14) && item.rsi14 < 40 && item.macd?.histogram < 0) triggers.push(`RSI ${item.rsi14.toFixed(0)} and negative MACD show weakening momentum.`);
  if (item.drawdown < -0.22) triggers.push(`Large drawdown from recent high: ${formatPercent(item.drawdown)}.`);
  if (item.eventRisk?.level === "High") triggers.push(`High event risk: ${item.eventRisk.hits.join(", ") || "major headline risk"}.`);
  if (!item.isFund && item.volatility > 0.5) triggers.push(`Single-stock volatility is high at ${formatPercent(item.volatility)} annualized.`);
  if (item.outlookSourceCount >= 1 && item.outlookScore < -0.15) triggers.push(`Trusted outlook tone is negative across ${item.outlookSourceCount} source${item.outlookSourceCount === 1 ? "" : "s"}.`);
  if (item.headlineSourceCount >= 2 && item.headlineScore < -0.2) triggers.push(`Recent headline tone is negative across ${item.headlineSourceCount} sources.`);
  if (item.scoreDelta <= -8) triggers.push(`Model score dropped ${Math.abs(item.scoreDelta)} points since the previous scan.`);

  const urgent = item.score <= 40 || triggers.length >= 3;
  if (!urgent && triggers.length < 2) return null;

  return {
    ticker: item.ticker,
    label: urgent ? "Sell / reduce" : "Trim / review",
    score: item.score,
    urgency: triggers.length * 10 + (100 - item.score),
    reason: triggers[0],
    detail: triggers.slice(1, 3).join(" "),
    className: "sell-item-danger"
  };
}

export function holdSignalFor(item) {
  const reasons = [];
  if (item.score >= 65) reasons.push(`Strong model score: ${item.score}/100.`);
  if (item.latest > item.sma50 && item.latest > item.sma200) reasons.push("Price is above both 50-day and 200-day averages.");
  if (item.sixMonth > 0) reasons.push(`Six-month momentum is positive at ${formatPercent(item.sixMonth)}.`);
  if (Number.isFinite(item.rsi14) && item.rsi14 >= 45 && item.rsi14 <= 70) reasons.push(`RSI ${item.rsi14.toFixed(0)} is healthy without being stretched.`);
  if (item.eventRisk?.level === "Low") reasons.push("No major event-risk blocker was detected.");
  if (item.outlookSourceCount >= 1 && item.outlookScore >= 0.05) reasons.push(`Trusted outlook tone is constructive across ${item.outlookSourceCount} source${item.outlookSourceCount === 1 ? "" : "s"}.`);
  if (item.isFund && item.score >= 58) reasons.push("Broad ETF exposure reduces single-company risk.");
  if (item.scoreDelta >= 5) reasons.push(`Model score improved ${item.scoreDelta} points since the previous scan.`);

  if (item.score < 58 || reasons.length < 2) return null;

  return {
    ticker: item.ticker,
    label: "Do not sell / hold",
    score: item.score,
    conviction: reasons.length * 10 + item.score,
    reason: reasons[0],
    detail: reasons.slice(1, 3).join(" "),
    className: "sell-item-hold"
  };
}
