import { TECHNICAL_SCORE_VERSION, TECHNICAL_WEIGHTS, MIN_DAILY_TURNOVER_USD, dailyTurnoverUSD, recentTechnicalNews, technicalSignalFor } from './technical-policy.js';
import { assessDataConfidence } from './data-confidence.js';
import { broadFunds } from "../config/settings.js";
import { evaluateDataQuality, hasQualifiedSignal, isEtfSeries, validHistoryPoints } from "./data-quality.js";
import { compactMoney, formatNumber, formatPercent } from "../shared/format.js";
import { average, averageTrueRange, bollingerBands, clamp, dailyReturns, macdSignal, relativeStrengthIndex, returnOver, stdev } from "../shared/math.js";
import { unique } from "../shared/text.js";
import { latestLearningPoint } from "../storage.js";

export function scoreSeries(series, headlines = [], {now = Date.now(), fxReference = null} = {}) {
  // Recover a v1 cached quote overlay conservatively. Original OHLC/volume were
  // not saved, so those observations cannot be reconstructed from the quote.
  if (series.dailyClose && series.prices?.length) {
    const saved = series.dailyClose, last = series.prices.at(-1);
    if (saved.currency !== series.currency || !Number.isFinite(saved.price) || saved.price <= 0
      || Date.parse(saved.asOf) !== new Date(last.date).getTime()) {
      return unavailableSignal(series,headlines,{eligible:false,asOf:null,reason:'The original completed daily bar is unavailable; refresh price history.'},isEtfSeries(series));
    }
    series = {...series,prices:series.prices.map((point,index)=>index===series.prices.length-1 ? {...point,close:saved.price,high:null,low:null,volume:null} : point)};
  }
  const initialQuality = evaluateDataQuality(series,now);
  if (initialQuality.eligible) {
    const today = new Date(now).toISOString().slice(0,10);
    const completed = validHistoryPoints(series).filter(point=>new Date(point.date).toISOString().slice(0,10)<today);
    if (completed.length !== validHistoryPoints(series).length) series = {...series,prices:completed,historyAsOf:completed.at(-1)?.date || null};
  }
  const dataQuality = evaluateDataQuality(series,now);
  const isFund = broadFunds.has(series.ticker) || isEtfSeries(series);
  if (!dataQuality.eligible) return unavailableSignal(series, headlines, dataQuality, isFund);
  const recentHeadlines = recentTechnicalNews(headlines,now);
  const outlooks = recentHeadlines.filter((headline) => headline.kind === "outlook");
  const newsHeadlines = recentHeadlines.filter((headline) => headline.kind !== "outlook");
  const prices = validHistoryPoints(series);
  const closes = prices.map((point) => point.close);
  const highs = prices.map((point) => Number.isFinite(point.high) ? point.high : point.close);
  const lows = prices.map((point) => Number.isFinite(point.low) ? point.low : point.close);
  const latest = closes.at(-1);
  const quoteTime = new Date(series.quote?.quoteTime || '').getTime();
  const quoteUsable = Number.isFinite(series.quote?.price) && series.quote.price>0
    && (!series.currency || series.quote.currency===series.currency)
    && (!series.quote.ticker || series.quote.ticker===series.ticker)
    && Number.isFinite(quoteTime) && quoteTime<=now && now-quoteTime<=7*86400000
    && quoteTime>=Date.parse(dataQuality.asOf);
  const sma20 = average(closes.slice(-20));
  const sma50 = average(closes.slice(-50));
  const sma200 = average(closes.slice(-200));
  const previousSma50 = average(closes.slice(-100, -50));
  const oneWeek = returnOver(closes, 5);
  const oneDay = quoteUsable && Number.isFinite(series.quote?.dayChangePercent) ? series.quote.dayChangePercent : returnOver(closes, 1);
  const oneMonth = returnOver(closes, 21);
  const threeMonth = returnOver(closes, 63);
  const sixMonth = returnOver(closes, 126);
  const returns = dailyReturns(closes);
  const volatility = stdev(returns) * Math.sqrt(252);
  const high = Math.max(...highs.slice(-252));
  const low52Week = Math.min(...lows.slice(-252));
  const drawdown = high ? latest / high - 1 : 0;
  const recentVolumes = prices.slice(-60), shortVolumes = prices.slice(-10);
  const validVolume = point => Number.isFinite(point.volume) && point.volume >= 0;
  const volumeAvailable = recentVolumes.every(validVolume) && shortVolumes.every(validVolume);
  const averageVolume60 = volumeAvailable ? average(recentVolumes.filter(validVolume).map(p=>p.volume)) : null;
  const averageNativeTurnover = volumeAvailable ? latest*averageVolume60 : null;
  const averageDollarVolume = dailyTurnoverUSD(averageNativeTurnover,series.currency,fxReference,now);
  const shortVolume = volumeAvailable ? average(shortVolumes.filter(validVolume).map(p=>p.volume)) : null;
  const volumePressure = !volumeAvailable ? null : averageVolume60 > 0 ? shortVolume/averageVolume60-1 : 0;
  const sentiment = rows => rows.length ? rows.reduce((sum,row)=>sum+(Number.isFinite(row.sentiment)?row.sentiment:0)*row.freshnessWeight,0)/rows.reduce((sum,row)=>sum+row.freshnessWeight,0) : null;
  const headlineScore = sentiment(newsHeadlines);
  const headlineSourceCount = unique(newsHeadlines.map(row=>row.sourceId).filter(Boolean)).length;
  const outlookScore = sentiment(outlooks);
  const outlookSourceCount = unique(outlooks.map(row=>row.sourceId).filter(Boolean)).length;
  const yearOutlooks = outlooks.filter(row=>row.horizon==='recent-year');
  const yearOutlookScore = sentiment(yearOutlooks);
  const yearOutlookSourceCount = unique(yearOutlooks.map(row=>row.sourceId).filter(Boolean)).length;
  const rsi14 = relativeStrengthIndex(closes, 14);
  const macd = macdSignal(closes);
  const bands = bollingerBands(closes, 20);
  const rangeAvailable = prices.slice(-14).filter(p=>Number.isFinite(p.high) && Number.isFinite(p.low) && p.high>=p.low && p.low>0).length === 14;
  const atrValue = rangeAvailable ? averageTrueRange(prices,14) : null;
  const atrPercent = rangeAvailable ? atrValue/latest : null;
  const support = Math.min(...lows.slice(-60));
  const resistance = Math.max(...highs.slice(-60));
  const sma50Slope = previousSma50 ? sma50 / previousSma50 - 1 : 0;
  const eventRisk = recentHeadlines.length ? detectEventRisk(recentHeadlines) : {score:null,level:'Unknown',hits:[]};

  const trendRaw = (latest > sma20 ? 0.2 : 0) + (latest > sma50 ? 0.35 : 0) + (latest > sma200 ? 0.45 : 0);
  const momentumRaw = clamp((oneMonth + 0.08) / 0.22, 0, 1) * 0.35 + clamp((threeMonth + 0.1) / 0.35, 0, 1) * 0.3 + clamp((sixMonth + 0.15) / 0.5, 0, 1) * 0.35;
  const riskRaw = 1 - clamp((volatility - 0.12) / 0.55, 0, 1);
  const drawdownRaw = 1 - clamp(Math.abs(Math.min(drawdown, 0)) / 0.35, 0, 1);
  const volumeRaw = volumeAvailable ? clamp((volumePressure + 0.15) / 0.45, 0, 1) : null;
  const liquidityRaw = Number.isFinite(averageDollarVolume) ? clamp(Math.log10(Math.max(averageDollarVolume,1))/9,0,1) : null;
  const rsiRaw = Number.isFinite(rsi14) ? rsi14 > 75 ? 0.35 : rsi14 >= 45 && rsi14 <= 70 ? 1 : rsi14 >= 35 && rsi14 < 45 ? 0.65 : rsi14 < 30 ? 0.45 : 0.55 : 0.5;
  const macdRaw = macd.histogram > 0 ? 0.72 + clamp(macd.histogram / Math.max(latest * 0.02, 1), 0, 0.28) : 0.45 + clamp(macd.histogram / Math.max(latest * 0.02, 1), -0.35, 0);
  const bollingerRaw = Number.isFinite(bands.position) ? bands.position > 1.05 ? 0.42 : bands.position >= 0.35 && bands.position <= 0.85 ? 0.9 : bands.position < 0.15 ? 0.55 : 0.66 : 0.5;
  const atrRiskRaw = rangeAvailable ? 1 - clamp((atrPercent - 0.018) / 0.06, 0, 1) : null;
  const technicalRaw = average([rsiRaw,macdRaw,bollingerRaw,atrRiskRaw]);
  const headlineRaw = headlineScore === null ? null : clamp((headlineScore+1)/2,0,1);
  const sourceRaw = clamp(headlineSourceCount / 6, 0, 1);
  const outlookRaw = outlookScore === null ? null : clamp((outlookScore+1)/2,0,1);
  const eventRiskRaw = eventRisk.score === null ? null : 1-clamp(eventRisk.score/100,0,1);

  const rawParts = {trend:trendRaw,momentum:momentumRaw,rsi:rsiRaw,macd:macdRaw,
    bollinger:bollingerRaw,atr:atrRiskRaw,volatility:riskRaw,drawdown:drawdownRaw,volume:volumeRaw,liquidity:liquidityRaw};
  const scoreBreakdown = Object.entries(TECHNICAL_WEIGHTS).map(([key,weight])=>({key,weight,raw:rawParts[key],available:Number.isFinite(rawParts[key])}));
  const scoreCoverage = scoreBreakdown.filter(part=>part.available).reduce((sum,part)=>sum+part.weight,0);
  const score = Math.round(clamp(scoreBreakdown.reduce((sum,part)=>sum+(part.available?part.raw*part.weight:0),0)/scoreCoverage*100,0,100));
  const categories = buildCategoryScores({
    trendRaw, momentumRaw, technicalRaw, headlineRaw, outlookRaw, yearOutlookScore,
    liquidityRaw, riskRaw, drawdownRaw, eventRiskRaw, sourceRaw
  });
  const setup = buildTradeSetup({
    latest, sma50, sma200, support, resistance, atrValue, atrPercent, rsi14, macd,
    volumePressure, averageDollarVolume, eventRisk, score, isFund, rangeAvailable
  });

  const result = {
    ...series,
    prices,
    dataQuality,
    score, scoreVersion:TECHNICAL_SCORE_VERSION, scoreCoverage, scoreBreakdown, provisional:scoreCoverage<100,
    currentPrice:quoteUsable ? series.quote.price : latest, currentPriceAsOf:quoteUsable ? new Date(quoteTime).toISOString() : dataQuality.asOf,
    currentPriceSource:quoteUsable ? series.quote.source : series.source, technicalAsOf:dataQuality.asOf,
    averageNativeTurnover, turnoverCurrency:series.currency, volumeAvailable, rangeAvailable,
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
    label: null,
    reasons: buildReasons({ latest, sma20, sma50, sma200, sma50Slope, oneMonth, threeMonth, sixMonth, volatility, drawdown, volumePressure, headlineScore, headlineSourceCount, outlookScore, outlookSourceCount, yearOutlookScore, yearOutlookSourceCount, rsi14, macd, averageDollarVolume, eventRisk, isFund }),
    flags: buildFlags({ latest, sma200, sixMonth, volatility, drawdown, atrPercent, averageDollarVolume, eventRisk, isFund })
  };
  const signal = technicalSignalFor(result);
  result.label = signal.label; result.signalKey = signal.key; result.setup.signal = signal.label;
  result.dataConfidence = assessDataConfidence(result,{now});
  return result;

}

function buildCategoryScores(parts) {
  const recentYearRaw = parts.yearOutlookScore === null ? null : clamp((parts.yearOutlookScore+1)/2,0,1);
  return {
    trend: Math.round(parts.trendRaw * 100),
    momentum: Math.round(parts.momentumRaw * 100),
    technical: Math.round(parts.technicalRaw * 100),
    news: parts.headlineRaw === null && parts.outlookRaw === null ? null : Math.round(average([parts.headlineRaw,parts.outlookRaw])*100),
    recentYear: recentYearRaw === null ? null : Math.round(recentYearRaw*100),
    liquidity: parts.liquidityRaw === null ? null : Math.round(parts.liquidityRaw*100),
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
  const riskLevel = !data.rangeAvailable ? "Range data incomplete" : data.eventRisk.level === "High" || data.atrPercent > 0.055 || data.score < 45
    ? "High"
    : data.atrPercent > 0.03 || data.eventRisk.level === "Medium"
      ? "Medium"
      : "Lower";
  const timeframe = data.score >= 70 ? "1 day to 4 weeks" : data.score >= 55 ? "1 to 4 weeks" : "Conditions need review";
  return {
    signal: signalForScore(data.score, data.eventRisk.level),
    confidence: null, // Retired: dataConfidence is a separate evidence-quality indicator.
    timeframe,
    entryZone: data.rangeAvailable ? `${formatNumber(entryLow)}-${formatNumber(Math.max(entryLow, entryHigh))}` : "Range data unavailable",
    invalidation: data.rangeAvailable ? invalidation : null,
    riskLevel,
    support: data.support,
    resistance: data.resistance,
    note: data.eventRisk.level === "High" ? "Recent event risk needs review; this is not a trade recommendation." : "Entry is a signal zone, not a guaranteed fill."
  };
}

function signalForScore(score,eventRiskLevel) {
  return technicalSignalFor({score,dataQuality:{eligible:true},eventRisk:{level:eventRiskLevel}}).label;
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
  if (!previous || previous.scoreVersion !== item.scoreVersion || previous.scoreCoverage !== item.scoreCoverage || !Number.isFinite(previous.score)) return { ...item, rawScore:item.score, scoreDelta:0, scoreComparison:{comparable:false,reason:"No previous scan with the same score version and available input weights."} };
  const rawScore = item.score;
  const scoreDelta = rawScore - previous.score;

  return {
    ...item,
    rawScore,
    scoreDelta, scoreComparison:{comparable:true},
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
    ...series, ...unavailable, dataQuality, isFund, score: null, scoreVersion:TECHNICAL_SCORE_VERSION, scoreCoverage:0, rawScore: null, scoreDelta: 0,
    dataConfidence:assessDataConfidence({...series,isFund,headlines}),
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
  if (data.averageDollarVolume >= MIN_DAILY_TURNOVER_USD) reasons.push(`Liquidity screen passed with about ${compactMoney(data.averageDollarVolume)} average daily dollar volume.`);
  if (data.headlineScore > 0.1) reasons.push("Current headline tone is positive.");
  if (data.headlineSourceCount >= 3) reasons.push(`${data.headlineSourceCount} distinct publishers mention this ticker or its market context.`);
  if (data.outlookSourceCount >= 2 && data.outlookScore > 0.05) reasons.push(`${data.outlookSourceCount} trusted outlook sources are constructive on this exposure or its market theme.`);
  if (data.outlookSourceCount >= 2 && data.outlookScore < -0.05) reasons.push(`${data.outlookSourceCount} trusted outlook sources are cautious on this exposure or its market theme.`);
  if (data.yearOutlookSourceCount >= 2 && data.yearOutlookScore > 0.05) reasons.push(`${data.yearOutlookSourceCount} recent-year research sources support this stock or sector theme.`);
  if (data.yearOutlookSourceCount >= 2 && data.yearOutlookScore < -0.05) reasons.push(`${data.yearOutlookSourceCount} recent-year research sources are cautious on this stock or sector theme.`);
  if (data.eventRisk?.level === "Low") reasons.push("No major event-risk blocker was detected in matched headlines.");

  if (!reasons.length) reasons.push("No strong positive signal stands out today.");
  return reasons;
}

function buildFlags(data) {
  const flags = [];
  if (data.latest < data.sma200) flags.push("Below 200-day average: long-term trend may be weak.");
  if (data.sixMonth < 0) flags.push(`Negative six-month momentum at ${formatPercent(data.sixMonth)}.`);
  if (data.volatility > 0.45) flags.push(`High volatility at ${formatPercent(data.volatility)} annualized.`);
  if (data.atrPercent > 0.05) flags.push(`ATR risk is high at ${formatPercent(data.atrPercent)} of price.`);
  if (Number.isFinite(data.averageDollarVolume) && data.averageDollarVolume < MIN_DAILY_TURNOVER_USD) flags.push(`Liquidity warning: only about ${compactMoney(data.averageDollarVolume)} average daily dollar volume.`);
  if (["High","Medium"].includes(data.eventRisk?.level)) flags.push(`${data.eventRisk.level} event risk detected${data.eventRisk.hits.length ? `: ${data.eventRisk.hits.join(", ")}` : ""}.`);
  if (data.drawdown < -0.18) flags.push(`Still ${formatPercent(data.drawdown)} below its recent high.`);
  if (data.eventRisk?.level === "Unknown") flags.push("Recent news coverage is unavailable; event risk is unknown.");
  if (!Number.isFinite(data.averageDollarVolume)) flags.push("USD turnover is unavailable; check trading volume and currency conversion.");
  if (!flags.length) flags.push("No major risk flag, but all market investments can lose money.");
  return flags;
}
