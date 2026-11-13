import { clamp } from '../shared/math.js';

export const TECHNICAL_SCORE_VERSION = 'technical-v2';
export const LEGACY_SCORE_VERSION = 'legacy-v1';
export const MIN_DAILY_TURNOVER_USD = 5000000;
export const TECHNICAL_WEIGHTS = Object.freeze({ trend:22, momentum:22, rsi:6, macd:6,
  bollinger:5, atr:5, volatility:12, drawdown:10, volume:6, liquidity:6 });
export const TECHNICAL_EXPLANATION = 'Technical Score v2 uses completed daily prices and trading activity. It does not measure business quality or whether a company is undervalued.';
const DAY = 86400000;

export function articleTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  return Date.parse(compact ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z` : value);
}

// Long-horizon articles remain visible as context; only dated evidence from the
// last fourteen days can affect present news/risk checks. Duplicate URLs count once.
export function recentTechnicalNews(articles = [], now = Date.now()) {
  const seen = new Set();
  return articles.flatMap(article => {
    const time = articleTimestamp(article?.pubDate);
    if (!Number.isFinite(time) || time > now || now-time > 14*DAY) return [];
    let key;
    try {
      const url = new URL(article.link);
      if (!['https:','http:'].includes(url.protocol)) return [];
      for (const name of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(name)) url.searchParams.delete(name);
      url.hash = ''; key = url.href;
    } catch { key = `${article.sourceId || ''}:${article.title || ''}`; }
    if (seen.has(key)) return [];
    seen.add(key);
    return [{...article, freshnessWeight:clamp(1-(now-time)/(21*DAY),1/3,1)}];
  });
}

export function technicalReviewReasons(item) {
  const reasons = [];
  if (item.score <= 44) reasons.push('The Technical Score is below 45.');
  if (item.latest < item.sma200 && item.sixMonth < 0) reasons.push('Price is below SMA200 with negative six-month momentum.');
  if (item.latest < item.sma50 && Number.isFinite(item.volumePressure) && item.volumePressure > .12) reasons.push('Price is below SMA50 with elevated completed-day volume.');
  if (item.oneMonth < -.06 && item.threeMonth < 0) reasons.push('One-month and three-month momentum are weak.');
  if (Number.isFinite(item.rsi14) && item.rsi14 < 40 && item.macd?.histogram < 0) reasons.push('RSI and MACD show weakening momentum.');
  if (item.drawdown < -.22) reasons.push('Price is more than 22% below its recent high.');
  if (item.eventRisk?.level === 'High') reasons.push('Recent matched news requires an event-risk review.');
  if (item.volatility > .5) reasons.push('Annualized historical volatility exceeds 50%.');
  if (item.outlookSourceCount >= 1 && item.outlookScore < -.15) reasons.push('Recent outlook tone is negative.');
  if (item.headlineSourceCount >= 2 && item.headlineScore < -.2) reasons.push('Recent headline tone is negative across multiple publishers.');
  return reasons;
}

export function technicalSignalFor(item) {
  if (item?.dataQuality?.eligible !== true || !Number.isFinite(item.score)) return {key:'unavailable',label:'Technical data unavailable'};
  const review = technicalReviewReasons(item);
  if (item.eventRisk?.level === 'High' || item.score <= 40 || review.length >= 2) return {key:'review',label:'Technical risk review'};
  if (item.provisional) return {key:'provisional',label:'Provisional technical conditions'};
  if (item.score >= 75) return {key:'favorable',label:'Favorable technical setup'};
  if (item.score >= 60) return {key:'constructive',label:'Constructive technical trend'};
  if (item.score >= 45) return {key:'mixed',label:'Mixed technical conditions'};
  return {key:'weak',label:'Weak technical conditions'};
}

export function dailyTurnoverUSD(nativeTurnover, currency, reference, now = Date.now()) {
  if (!Number.isFinite(nativeTurnover) || nativeTurnover < 0) return null;
  if (currency === 'USD') return nativeTurnover;
  // Only the supported, dated ECB USD->EUR reference is used. No unlabelled FX assumptions.
  const time = Date.parse(reference?.date);
  if (currency !== 'EUR' || reference?.base !== 'USD' || reference?.quote !== 'EUR'
    || !Number.isFinite(reference.rate) || reference.rate <= 0 || !Number.isFinite(time)
    || time > now || now-time > 7*DAY) return null;
  return nativeTurnover/reference.rate;
}
