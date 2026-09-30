import { marketProxyTickers } from "../config/settings.js";
import { formatNumber, formatPercent } from "../shared/format.js";
import { average, clamp, returnOver } from "../shared/math.js";

export function analyzeMarketContext(proxySeries) {
  const byTicker = new Map(proxySeries.map((proxy) => [proxy.ticker, proxy]));
  const metric = (ticker, days) => {
    const values = byTicker.get(ticker)?.series?.prices?.map((point) => point.close) || [];
    return returnOver(values, days);
  };
  const latest = (ticker) => byTicker.get(ticker)?.series?.prices?.at(-1)?.close || 0;
  const liveCount = proxySeries.filter((proxy) => proxy.series.source !== "sample").length;
  const equityTickers = ["SPY", "QQQ", "IWM", "VTI"];
  const equityOneMonth = average(equityTickers.map((ticker) => metric(ticker, 21)));
  const equityThreeMonth = average(equityTickers.map((ticker) => metric(ticker, 63)));
  const breadth = equityTickers.filter((ticker) => metric(ticker, 21) > 0).length / equityTickers.length;
  const creditRisk = metric("HYG", 21) - metric("LQD", 21);
  const ratePressure = metric("TLT", 21);
  const dollarPressure = metric("UUP", 21);
  const oilPressure = metric("USO", 21);
  const goldSafetyBid = metric("GLD", 21);
  const vix = latest("^VIX");

  let score = 50;
  score += equityOneMonth * 210;
  score += equityThreeMonth * 95;
  score += (breadth - 0.5) * 28;
  score += creditRisk * 260;
  score += ratePressure * 70;
  score -= dollarPressure * 70;
  if (vix) score -= (vix - 20) * 1.15;
  if (oilPressure > 0.08 && ratePressure < 0) score -= 4;
  if (goldSafetyBid > 0.07 && equityOneMonth < 0) score -= 4;
  score = Math.round(clamp(score, 0, 100));

  const confidence = Math.round(clamp(35 + liveCount * 4.5 + Math.abs(score - 50) * 0.55, 25, 92));
  const label = score >= 68 ? "Bullish / risk-on" : score >= 56 ? "Mildly bullish" : score >= 45 ? "Neutral / choppy" : score >= 34 ? "Bearish / defensive" : "High-risk bearish";
  const horizon = "next session to 4 weeks";
  const evidence = [
    `Equity trend: 1M ${formatPercent(equityOneMonth)}, 3M ${formatPercent(equityThreeMonth)}, breadth ${(breadth * 100).toFixed(0)}%.`,
    `Credit appetite: HYG minus LQD over 1M is ${formatPercent(creditRisk)}.`,
    `Rate pressure: TLT 1M is ${formatPercent(ratePressure)}.`,
    vix ? `Volatility: VIX is ${formatNumber(vix)}.` : "Volatility: VIX data unavailable, confidence reduced.",
    `Dollar pressure: UUP 1M is ${formatPercent(dollarPressure)}.`,
    `Commodity/safety check: USO ${formatPercent(oilPressure)}, GLD ${formatPercent(goldSafetyBid)}.`
  ];
  const risks = [
    score >= 56 && vix > 24 ? "Bullish score is capped by elevated volatility." : "",
    score >= 56 && ratePressure < -0.04 ? "Rising-rate pressure could weaken equity multiples." : "",
    score < 45 && breadth > 0.5 ? "Some equity breadth remains positive, so bearish signal is not unanimous." : "",
    liveCount < marketProxyTickers.length ? `${marketProxyTickers.length - liveCount} proxy series used fallback data.` : ""
  ].filter(Boolean);

  return {
    score,
    confidence,
    label,
    horizon,
    evidence,
    risks,
    liveCount,
    total: marketProxyTickers.length,
    metrics: { equityOneMonth, equityThreeMonth, breadth, creditRisk, ratePressure, dollarPressure, oilPressure, goldSafetyBid, vix }
  };
}
