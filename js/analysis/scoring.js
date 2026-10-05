import { broadFunds } from "../config/settings.js";
import { evaluateDataQuality, hasQualifiedSignal, isEtfSeries, validHistoryPoints } from "./data-quality.js";
import { compactMoney, formatNumber, formatPercent } from "../shared/format.js";
import { average, averageTrueRange, bollingerBands, clamp, dailyReturns, macdSignal, relativeStrengthIndex, returnOver, stdev } from "../shared/math.js";
import { unique } from "../shared/text.js";
import { latestLearningPoint } from "../storage.js";

export function scoreSeries(series, headlines) {
  const dataQuality = evaluateDataQuality(series);
  const isFund = broadFunds.has(series.ticker) || isEtfSeries(series);
  if (!dataQuality.eligible) return unavailableSignal(series, headlines, dataQuality, isFund);
  const outlooks = headlines.filter((headline) => headline.kind === "outlook");
  const newsHeadlines = headlines.filter((headline) => headline.kind !== "outlook");
  const prices = validHistoryPoints(series);
  const closes = prices.map((point) => point.close);
  const highs = prices.map((point) => Number.isFinite(point.high) ? point.high : point.close);
  const lows = prices.map((point) => Number.isFinite(point.low) ? point.low : point.close);
  const latest = closes.at(-1);
  const sma20 = average(closes.slice(-20));
  const sma50 = average(closes.slice(-50));
  const sma200 = average(closes.slice(-200));
  const previousSma50 = average(closes.slice(-100, -50));
  const oneWeek = returnOver(closes, 5);
  const oneDay = Number.isFinite(series.quote?.dayChangePercent) ? series.quote.dayChangePercent : returnOver(closes, 1);
  const oneMonth = returnOver(closes, 21);
  const threeMonth = returnOver(closes, 63);
  const sixMonth = returnOver(closes, 126);
  const returns = dailyReturns(closes);
  const volatility = stdev(returns) * Math.sqrt(252);
  const high = series.quote?.high52Week || Math.max(...highs.slice(-252));
  const low52Week = series.quote?.low52Week || Math.min(...lows.slice(-252));
  const drawdown = high ? latest / high - 1 : 0;
  const volumes = prices.map((point) => point.volume).filter((volume) => Number.isFinite(volume) && volume > 0);
  const averageVolume60 = series.quote?.averageVolume || average(volumes.slice(-60));
  const averageDollarVolume = latest * averageVolume60;
  const volumePressure = average(volumes.slice(-10)) / Math.max(average(volumes.slice(-60)), 1) - 1;
  const headlineScore = newsHeadlines.length ? average(newsHeadlines.map((headline) => headline.sentiment)) : headlines.length ? average(headlines.map((headline) => headline.sentiment)) : 0;
  const headlineSourceCount = unique(newsHeadlines.map((headline) => headline.sourceId)).length;
  const outlookScore = outlooks.length ? average(outlooks.map((outlook) => outlook.sentiment)) : 0;
  const outlookSourceCount = unique(outlooks.map((outlook) => outlook.sourceId)).length;
  const yearOutlooks = outlooks.filter((outlook) => outlook.horizon === "recent-year");
  const yearOutlookScore = yearOutlooks.length ? average(yearOutlooks.map((outlook) => outlook.sentiment)) : 0;
  const yearOutlookSourceCount = unique(yearOutlooks.map((outlook) => outlook.sourceId)).length;
  const rsi14 = relativeStrengthIndex(closes, 14);
  const macd = macdSignal(closes);
  const bands = bollingerBands(closes, 20);
  const atrValue = averageTrueRange(prices, 14);
  const atrPercent = latest ? atrValue / latest : 0;
  const support = Math.min(...lows.slice(-60));
  const resistance = Math.max(...highs.slice(-60));
  const sma50Slope = previousSma50 ? sma50 / previousSma50 - 1 : 0;
  const eventRisk = detectEventRisk(headlines);

  const trendRaw = (latest > sma20 ? 0.2 : 0) + (latest > sma50 ? 0.35 : 0) + (latest > sma200 ? 0.45 : 0);
  const momentumRaw = clamp((oneMonth + 0.08) / 0.22, 0, 1) * 0.35 + clamp((threeMonth + 0.1) / 0.35, 0, 1) * 0.3 + clamp((sixMonth + 0.15) / 0.5, 0, 1) * 0.35;
  const riskRaw = 1 - clamp((volatility - 0.12) / 0.55, 0, 1);
  const drawdownRaw = 1 - clamp(Math.abs(Math.min(drawdown, 0)) / 0.35, 0, 1);
  const volumeRaw = clamp((volumePressure + 0.15) / 0.45, 0, 1);
  const liquidityRaw = clamp(Math.log10(Math.max(averageDollarVolume, 1)) / 9, 0, 1);
  const rsiRaw = Number.isFinite(rsi14) ? rsi14 > 75 ? 0.35 : rsi14 >= 45 && rsi14 <= 70 ? 1 : rsi14 >= 35 && rsi14 < 45 ? 0.65 : rsi14 < 30 ? 0.45 : 0.55 : 0.5;
  const macdRaw = macd.histogram > 0 ? 0.72 + clamp(macd.histogram / Math.max(latest * 0.02, 1), 0, 0.28) : 0.45 + clamp(macd.histogram / Math.max(latest * 0.02, 1), -0.35, 0);
  const bollingerRaw = Number.isFinite(bands.position) ? bands.position > 1.05 ? 0.42 : bands.position >= 0.35 && bands.position <= 0.85 ? 0.9 : bands.position < 0.15 ? 0.55 : 0.66 : 0.5;
  const atrRiskRaw = 1 - clamp((atrPercent - 0.018) / 0.06, 0, 1);
  const technicalRaw = average([trendRaw, momentumRaw, rsiRaw, macdRaw, bollingerRaw, atrRiskRaw]);
  const headlineRaw = clamp((headlineScore + 1) / 2, 0, 1);
  const sourceRaw = clamp(headlineSourceCount / 6, 0, 1);
  const outlookRaw = clamp((outlookScore + 1) / 2, 0, 1);
  const outlookBreadthRaw = clamp(outlookSourceCount / 4, 0, 1);
  const diversificationRaw = isFund ? 1 : 0.48;
  const eventRiskRaw = 1 - clamp(eventRisk.score / 100, 0, 1);

  let score = (
    trendRaw * 18 +
    momentumRaw * 17 +
    technicalRaw * 14 +
    riskRaw * 11 +
    drawdownRaw * 9 +
    headlineRaw * 7 +
    sourceRaw * 4 +
    volumeRaw * 5 +
    liquidityRaw * 5 +
    eventRiskRaw * 5 +
    diversificationRaw * 5
  );

  if (outlooks.length) {
    score += (outlookRaw - 0.5) * 12;
    score += outlookScore >= 0 ? outlookBreadthRaw * 2 : -outlookBreadthRaw;
  }

  if (yearOutlooks.length) {
    const yearBreadthRaw = clamp(yearOutlookSourceCount / 4, 0, 1);
    score += clamp(yearOutlookScore * 6, -5, 5);
    score += yearOutlookScore >= 0 ? yearBreadthRaw * 1.5 : -yearBreadthRaw * 1.5;
  }

  if (!isFund) score -= 4;
  if (volatility > 0.65) score -= 8;
  if (latest < sma200 && sixMonth < 0) score -= 8;
  if (eventRisk.level === "High") score -= 8;
  if (liquidityRaw < 0.38 && !isFund) score = Math.min(score, 44);
  score = Math.round(clamp(score, 0, 100));
  const categories = buildCategoryScores({
    trendRaw, momentumRaw, technicalRaw, headlineRaw, outlookRaw, yearOutlookScore,
    liquidityRaw, riskRaw, drawdownRaw, eventRiskRaw, sourceRaw
  });
  const setup = buildTradeSetup({
    latest, sma50, sma200, support, resistance, atrValue, atrPercent, rsi14, macd,
    volumePressure, averageDollarVolume, eventRisk, score, isFund
  });

  return {
    ...series,
    prices,
    dataQuality,
    score,
    latest,
    oneDay,
    sma20,
    sma50,
    sma200,
    sma50Slope,
    oneWeek,
    oneMonth,
    threeMonth,
    sixMonth,
    volatility,
    drawdown,
    high52Week: high,
    low52Week,
    support,
    resistance,
    rsi14,
    macd,
    bollinger: bands,
    atrValue,
    atrPercent,
    averageVolume60,
    averageDollarVolume,
    volumePressure,
    headlineScore,
    headlineSourceCount,
    outlookScore,
    outlookSourceCount,
    yearOutlookScore,
    yearOutlookSourceCount,
    headlines,
    outlooks,
    yearOutlooks,
    isFund,
    categories,
    eventRisk,
    setup,
    scoreDelta: 0,
    label: scoreLabel(score),
    reasons: buildReasons({ latest, sma20, sma50, sma200, sma50Slope, oneMonth, threeMonth, sixMonth, volatility, drawdown, volumePressure, headlineScore, headlineSourceCount, outlookScore, outlookSourceCount, yearOutlookScore, yearOutlookSourceCount, rsi14, macd, averageDollarVolume, eventRisk, isFund }),
    flags: buildFlags({ latest, sma200, sixMonth, volatility, drawdown, atrPercent, averageDollarVolume, eventRisk, isFund })
  };
}

function buildCategoryScores(parts) {
  const recentYearRaw = clamp((parts.yearOutlookScore + 1) / 2, 0, 1);
  return {
    trend: Math.round(parts.trendRaw * 100),
    momentum: Math.round(parts.momentumRaw * 100),
    technical: Math.round(parts.technicalRaw * 100),
    news: Math.round(((parts.headlineRaw * 0.55) + (parts.outlookRaw * 0.3) + (parts.sourceRaw * 0.15)) * 100),
    recentYear: Math.round(recentYearRaw * 100),
    liquidity: Math.round(parts.liquidityRaw * 100),
    risk: Math.round(average([parts.riskRaw, parts.drawdownRaw, parts.eventRiskRaw]) * 100)
  };
}

function buildTradeSetup(data) {
  const stopBuffer = data.atrValue || data.latest * 0.025;
  const supportStop = Number.isFinite(data.support) ? data.support - stopBuffer * 0.35 : data.latest - stopBuffer;
  const movingStop = Math.min(data.sma50 || data.latest, data.sma200 || data.latest) - stopBuffer * 0.25;
  const invalidation = Math.max(0, Math.min(supportStop, movingStop));
  const entryLow = Math.max(invalidation, data.latest - stopBuffer * 0.35);
  const entryHigh = data.score >= 70 ? data.latest + stopBuffer * 0.45 : Math.min(data.latest + stopBuffer * 0.2, data.resistance || data.latest + stopBuffer * 0.2);
  const riskLevel = data.eventRisk.level === "High" || data.atrPercent > 0.055 || data.score < 45
    ? "High"
    : data.atrPercent > 0.03 || data.eventRisk.level === "Medium"
      ? "Medium"
      : "Lower";
  const timeframe = data.score >= 70 ? "1 day to 4 weeks" : data.score >= 55 ? "1 to 4 weeks" : "Now / avoid new buys";
  return {
    signal: signalForScore(data.score, data.eventRisk.level),
    confidence: Math.round(clamp(data.score - (data.eventRisk.level === "High" ? 10 : data.eventRisk.level === "Medium" ? 5 : 0), 0, 100)),
    timeframe,
    entryZone: `${formatNumber(entryLow)}-${formatNumber(Math.max(entryLow, entryHigh))}`,
    invalidation,
    riskLevel,
    support: data.support,
    resistance: data.resistance,
    note: data.eventRisk.level === "High" ? "Event risk is high; avoid new entries unless the setup improves." : "Entry is a signal zone, not a guaranteed fill."
  };
}

function signalForScore(score, eventRiskLevel) {
  if (eventRiskLevel === "High" && score < 72) return "Avoid new buys";
  if (score >= 76) return "Buy signal";
  if (score >= 62) return "Hold / buy-watch";
  if (score >= 48) return "Watch";
  if (score >= 38) return "Avoid new buys";
  return "Sell / reduce";
}

function detectEventRisk(headlines) {
  const text = headlines.map((item) => `${item.title} ${item.description || ""}`).join(" ").toLowerCase();
  const highTerms = ["earnings miss", "guidance cut", "sec lawsuit", "antitrust lawsuit", "trading suspension", "hack", "exploit", "delisting", "bankruptcy", "default"];
  const mediumTerms = ["earnings", "rate decision", "fed decision", "cpi", "ppi", "jobs report", "lawsuit", "probe", "regulation", "merger", "acquisition", "etf outflow", "sanctions"];
  const highHits = highTerms.filter((term) => text.includes(term));
  const mediumHits = mediumTerms.filter((term) => text.includes(term));
  const score = Math.min(100, highHits.length * 38 + mediumHits.length * 18);
  return {
    score,
    level: score >= 55 ? "High" : score >= 24 ? "Medium" : "Low",
    hits: unique(highHits.concat(mediumHits)).slice(0, 5)
  };
}

export function applyLearningSignal(item) {
  if (!hasQualifiedSignal(item)) return { ...item, rawScore: null, scoreDelta: 0 };
  const previous = latestLearningPoint(item.ticker);
  if (!previous || !Number.isFinite(previous.score)) return { ...item, rawScore: item.score, scoreDelta: 0 };
  const rawScore = item.score;
  const scoreDelta = rawScore - previous.score;

  return {
    ...item,
    rawScore,
    scoreDelta,
    reasons: [
      ...item.reasons,
      scoreDelta >= 5
        ? `Score improved ${scoreDelta} points since the previous local scan.`
        : scoreDelta <= -5
          ? `Score weakened ${Math.abs(scoreDelta)} points since the previous local scan.`
          : "Score change from the previous local scan is small."
    ]
  };
}

export function stableRankSort(a, b) {
  const qualifiedA = hasQualifiedSignal(a);
  const qualifiedB = hasQualifiedSignal(b);
  if (qualifiedA !== qualifiedB) return qualifiedA ? -1 : 1;
  if (qualifiedA && a.score !== b.score) return b.score - a.score;
  return a.ticker.localeCompare(b.ticker);
}

function unavailableSignal(series, headlines, dataQuality, isFund) {
  const unavailable = Object.fromEntries([
    "latest", "oneDay", "sma20", "sma50", "sma200", "sma50Slope", "oneWeek", "oneMonth",
    "threeMonth", "sixMonth", "volatility", "drawdown", "high52Week", "low52Week", "support",
    "resistance", "rsi14", "atrValue", "atrPercent", "averageVolume60", "averageDollarVolume",
    "volumePressure", "headlineScore", "outlookScore", "yearOutlookScore"
  ].map((key) => [key, null]));
  const outlooks = headlines.filter((headline) => headline.kind === "outlook");
  return {
    ...series, ...unavailable, dataQuality, isFund, score: null, rawScore: null, scoreDelta: 0,
    headlines, outlooks, yearOutlooks: outlooks.filter((item) => item.horizon === "recent-year"),
    headlineSourceCount: unique(headlines.filter((item) => item.kind !== "outlook").map((item) => item.sourceId)).length,
    outlookSourceCount: unique(outlooks.map((item) => item.sourceId)).length,
    yearOutlookSourceCount: unique(outlooks.filter((item) => item.horizon === "recent-year").map((item) => item.sourceId)).length,
    categories: {}, macd: { macd: null, signal: null, histogram: null }, bollinger: { position: null },
    eventRisk: { score: null, level: "Unknown", hits: [] },
    label: "Data unavailable", reasons: [dataQuality.reason], flags: [dataQuality.reason],
    setup: { signal: "Data unavailable", confidence: null, timeframe: "Unavailable", entryZone: "Unavailable",
      invalidation: null, riskLevel: "Unavailable", support: null, resistance: null, note: dataQuality.reason }
  };
}

function buildReasons(data) {
  const reasons = [];
  if (data.latest > data.sma200) reasons.push("Above 200-day average: long-term trend is positive.");
  if (data.latest > data.sma50) reasons.push("Above 50-day average: near-term trend is positive.");
  if (data.sma50Slope > 0) reasons.push(`50-day average is rising (${formatPercent(data.sma50Slope)} vs prior 50-day average).`);
  if (data.sixMonth > 0) reasons.push(`Six-month momentum is ${formatPercent(data.sixMonth)}.`);
  if (Number.isFinite(data.rsi14) && data.rsi14 >= 45 && data.rsi14 <= 70) reasons.push(`RSI ${data.rsi14.toFixed(0)} is constructive without being extremely overbought.`);
  if (data.macd?.histogram > 0) reasons.push("MACD momentum is positive.");
  if (data.volumePressure > 0.08) reasons.push(`Recent volume is ${formatPercent(data.volumePressure)} above its 60-day baseline.`);
  if (data.averageDollarVolume > 5000000) reasons.push(`Liquidity screen passed with about ${compactMoney(data.averageDollarVolume)} average daily dollar volume.`);
  if (data.headlineScore > 0.1) reasons.push("Current headline tone is positive.");
  if (data.headlineSourceCount >= 3) reasons.push(`${data.headlineSourceCount} independent sources mention this ticker or its market context.`);
  if (data.outlookSourceCount >= 2 && data.outlookScore > 0.05) reasons.push(`${data.outlookSourceCount} trusted outlook sources are constructive on this exposure or its market theme.`);
  if (data.outlookSourceCount >= 2 && data.outlookScore < -0.05) reasons.push(`${data.outlookSourceCount} trusted outlook sources are cautious on this exposure or its market theme.`);
  if (data.yearOutlookSourceCount >= 2 && data.yearOutlookScore > 0.05) reasons.push(`${data.yearOutlookSourceCount} recent-year research sources support this stock or sector theme.`);
  if (data.yearOutlookSourceCount >= 2 && data.yearOutlookScore < -0.05) reasons.push(`${data.yearOutlookSourceCount} recent-year research sources are cautious on this stock or sector theme.`);
  if (data.eventRisk?.level === "Low") reasons.push("No major event-risk blocker was detected in matched headlines.");
  if (data.isFund) reasons.push("Broad ETF exposure reduces single-company risk.");
  if (!reasons.length) reasons.push("No strong positive signal stands out today.");
  return reasons;
}

function buildFlags(data) {
  const flags = [];
  if (data.latest < data.sma200) flags.push("Below 200-day average: long-term trend may be weak.");
  if (data.sixMonth < 0) flags.push(`Negative six-month momentum at ${formatPercent(data.sixMonth)}.`);
  if (data.volatility > 0.45) flags.push(`High volatility at ${formatPercent(data.volatility)} annualized.`);
  if (data.atrPercent > 0.05) flags.push(`ATR risk is high at ${formatPercent(data.atrPercent)} of price.`);
  if (data.averageDollarVolume < 5000000 && !data.isFund) flags.push(`Liquidity warning: only about ${compactMoney(data.averageDollarVolume)} average daily dollar volume.`);
  if (data.eventRisk?.level !== "Low") flags.push(`${data.eventRisk.level} event risk detected${data.eventRisk.hits.length ? `: ${data.eventRisk.hits.join(", ")}` : ""}.`);
  if (data.drawdown < -0.18) flags.push(`Still ${formatPercent(data.drawdown)} below its recent high.`);
  if (!data.isFund) flags.push("Single-stock exposure adds company-specific risk.");
  if (!flags.length) flags.push("No major risk flag, but all market investments can lose money.");
  return flags;
}

function scoreLabel(score) {
  if (score >= 75) return "Strong buy-model candidate";
  if (score >= 60) return "Buy-model candidate";
  if (score >= 45) return "Watch only";
  return "Avoid today";
}
