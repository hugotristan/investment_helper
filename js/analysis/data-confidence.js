import {trustedSourceUniverse} from "../config/sources.js";
import { evaluateDataQuality, validHistoryPoints } from './data-quality.js';
import { recentTechnicalNews } from './technical-policy.js';

const DAY = 86400000;
const newsSources = new Set(trustedSourceUniverse.map(source=>source.id));
// This evaluates evidence coverage, age and provenance, never market direction.
// Financials affect Data Confidence only, not the Technical Score.
export function assessDataConfidence(item, {financial = null, now = Date.now()} = {}) {
  const prices = validHistoryPoints(item), quality = evaluateDataQuality(item,now);
  const reasons = [], components = [];
  const add = (name,weight,value,reason) => {
    components.push({name,weight,value:Math.max(0,Math.min(1,value)),reason});
    if (value < 1) reasons.push(reason);
  };
  const age = now-Date.parse(quality.asOf);
  const knownSource = /^Yahoo Finance\b/.test(item.source || '');
  const sourceFactor = knownSource ? /relay/i.test(item.source) ? .85 : 1 : .5;
  const historyFactor = !quality.eligible ? 0 : age <= 3*DAY ? 1 : .7;
  add('Daily price history',40,historyFactor*sourceFactor*(item.stale ? .6 : 1),
    !quality.eligible ? quality.reason : item.stale ? 'The latest price refresh failed; dated observations were retained.'
      : !knownSource ? 'The price source is not a recognized production adapter.' : 'Daily prices are more than three calendar days old.');
  const rangeRows = prices.slice(-14);
  const rangeCoverage = rangeRows.length ? rangeRows.filter(p => Number.isFinite(p.high) && Number.isFinite(p.low) && p.high >= p.low && p.low > 0).length/rangeRows.length : 0;
  add('Daily high/low ranges',10,rangeCoverage,'Some daily high/low observations are missing; ATR coverage is incomplete.');
  const volumeRows = prices.slice(-60);
  const volumeCoverage = volumeRows.length ? volumeRows.filter(p => Number.isFinite(p.volume) && p.volume >= 0).length/volumeRows.length : 0;
  const turnoverKnown = item.currency === 'USD' || Number.isFinite(item.averageDollarVolume);
  add('Trading volume and USD turnover',10,volumeCoverage*(turnoverKnown?1:.7), turnoverKnown ? 'Some completed-day volume observations are missing.' : 'USD turnover conversion is unavailable; native turnover is not treated as dollars.');
  const news = recentTechnicalNews(item.headlines || [],now);
  const publishers = new Set(news.map(row=>row.sourceId).filter(id=>newsSources.has(id)));
  const newsValue = news.length ? Math.min(1,publishers.size/3)*Math.max(...news.map(row=>row.freshnessWeight)) : 0;
  add('Dated news coverage',15,newsValue,news.length ? 'Recent news has limited publisher breadth or is aging.' : 'No dated news within fourteen days was verified; event risk is unknown.');
  if (!item.isFund && item.instrumentType !== 'ETF') {
    const keys = ['revenue','revenueGrowth','netIncome','operatingCashFlow','freeCashFlow','operatingCashFlowGrowth','freeCashFlowGrowth','totalDebt'];
    const eps = Number.isFinite(financial?.metrics?.dilutedEPS) || Number.isFinite(financial?.metrics?.basicEPS);
    const coverage = financial?.available ? (keys.filter(key=>Number.isFinite(financial.metrics?.[key])).length+Number(eps))/(keys.length+1) : 0;
    const periodAge = now-Date.parse(financial?.periodEnd), retrievalAge = now-Date.parse(financial?.retrievedAt);
    const validPeriod = Number.isFinite(periodAge) && periodAge >= 0 && periodAge <= 550*DAY;
    const validRetrieval = Number.isFinite(retrievalAge) && retrievalAge >= 0;
    const periodFactor = !validPeriod ? 0 : periodAge <= 450*DAY ? 1 : .5;
    const refreshFactor = !validRetrieval ? 0 : retrievalAge < 10*DAY && !financial?.stale && !financial?.refreshError ? 1 : .5;
    const source = ['SEC companyfacts','Yahoo Finance'].includes(financial?.provider) ? 1 : .5;
    add('Annual company financials',25,coverage*periodFactor*refreshFactor*source,
      !financial ? 'Company financials have not been checked for this view.' : !financial.available ? 'Company financial data is unavailable.'
        : !validPeriod ? 'The reporting period is missing, future-dated or over 550 days old.' : periodAge > 450*DAY ? 'The annual reporting period is over 450 days old.'
        : !validRetrieval || refreshFactor < 1 ? 'Financial retrieval is stale or its latest refresh failed.' : 'Some annual financial indicators or source provenance are missing.');
  }
  const total = components.reduce((sum,c)=>sum+c.weight,0);
  const value = Math.round(components.reduce((sum,c)=>sum+c.weight*c.value,0)/total*100);
  return {value,label:value>=80?'High':value>=60?'Moderate':value>=35?'Limited':'Low',
    meaning:'Evidence coverage, freshness and provenance; not the probability of a price rise.',
    financials: item.isFund || item.instrumentType==='ETF' ? 'not_applicable' : financial ? financial.available ? 'checked' : 'unavailable' : 'not_checked',
    components,missing:reasons,asOf:new Date(now).toISOString()};
}
