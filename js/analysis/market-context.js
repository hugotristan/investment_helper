import { marketProxyTickers } from "../config/settings.js";
import { formatNumber, formatPercent } from "../shared/format.js";
import { average, clamp, returnOver } from "../shared/math.js";
import { evaluateDataQuality, validHistoryPoints } from "./data-quality.js";

export function analyzeMarketContext(proxySeries) {
  const qualified = proxySeries.filter((proxy) => evaluateDataQuality(proxy.series).eligible);
  const byTicker = new Map(qualified.map((proxy) => [proxy.ticker, proxy]));
  const metric = (ticker, days) => {
    const proxy = byTicker.get(ticker);
    return proxy ? returnOver(validHistoryPoints(proxy.series).map((point) => point.close), days) : null;
  };
  const latest = (ticker) => byTicker.has(ticker) ? validHistoryPoints(byTicker.get(ticker).series).at(-1)?.close : null;
  const liveCount = qualified.length;
  const equityTickers = ["SPY", "QQQ", "IWM", "VTI"].filter((ticker) => byTicker.has(ticker));
  const available = equityTickers.length >= 2 && byTicker.has("HYG") && byTicker.has("LQD");
  const asOfTimes = qualified.map((proxy) => new Date(evaluateDataQuality(proxy.series).asOf).getTime());
  const asOf = asOfTimes.length ? new Date(Math.min(...asOfTimes)).toISOString() : null;
  const coverage = Math.round(liveCount / marketProxyTickers.length * 100);
  if (!available) {
    return {
      eligible: false, available: false, score: null, confidence: null, coverage,
      label: "Market regime unavailable", horizon: "Unavailable", liveCount, total: marketProxyTickers.length,
      dataQuality: { eligible: false, label: "Insufficient market coverage",
        reason: "At least two qualified equity proxies and both HYG and LQD credit proxies are required.", asOf },
      evidence: [`${liveCount}/${marketProxyTickers.length} proxies have recent real daily history.`],
      risks: ["Sample, stale, and insufficient histories are excluded. No market regime signal is available."],
      metrics: { equityOneMonth: null, equityThreeMonth: null, breadth: null, creditRisk: null,
        ratePressure: null, dollarPressure: null, oilPressure: null, goldSafetyBid: null, vix: null }
    };
  }
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
  if (ratePressure !== null) score += ratePressure * 70;
  if (dollarPressure !== null) score -= dollarPressure * 70;
  if (vix) score -= (vix - 20) * 1.15;
  if (oilPressure !== null && ratePressure !== null && oilPressure > 0.08 && ratePressure < 0) score -= 4;
  if (goldSafetyBid !== null && goldSafetyBid > 0.07 && equityOneMonth < 0) score -= 4;
  score = Math.round(clamp(score, 0, 100));

  // Coverage describes available inputs, not a probability of a correct forecast.
  const confidence = coverage;
  const label = score >= 68 ? "Bullish / risk-on" : score >= 56 ? "Mildly bullish" : score >= 45 ? "Neutral / choppy" : score >= 34 ? "Bearish / defensive" : "High-risk bearish";
  const horizon = "next session to 4 weeks";
  const evidence = [
    `Equity trend: 1M ${formatPercent(equityOneMonth)}, 3M ${formatPercent(equityThreeMonth)}, breadth ${(breadth * 100).toFixed(0)}%.`,
    `Credit appetite: HYG minus LQD over 1M is ${formatPercent(creditRisk)}.`,
    ratePressure !== null ? `Rate pressure: TLT 1M is ${formatPercent(ratePressure)}.` : "Rate pressure: qualified TLT data unavailable.",
    vix ? `Volatility: VIX is ${formatNumber(vix)}.` : "Volatility: qualified VIX data unavailable.",
    dollarPressure !== null ? `Dollar pressure: UUP 1M is ${formatPercent(dollarPressure)}.` : "Dollar pressure: qualified UUP data unavailable.",
    `Commodity/safety check: USO ${oilPressure !== null ? formatPercent(oilPressure) : "unavailable"}, GLD ${goldSafetyBid !== null ? formatPercent(goldSafetyBid) : "unavailable"}.`
  ];
  const risks = [
    score >= 56 && vix > 24 ? "Bullish score is capped by elevated volatility." : "",
    score >= 56 && ratePressure !== null && ratePressure < -0.04 ? "Rising-rate pressure could weaken equity multiples." : "",
    score < 45 && breadth > 0.5 ? "Some equity breadth remains positive, so bearish signal is not unanimous." : "",
    liveCount < marketProxyTickers.length ? `${marketProxyTickers.length - liveCount} unavailable proxy series were excluded from this regime signal.` : ""
  ].filter(Boolean);

  return {
    eligible: true,
    available: true,
    coverage,
    dataQuality: { eligible: true, label: "Qualified market coverage", reason: "Equity and credit coverage support a market regime signal.", asOf },
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
