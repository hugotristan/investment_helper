import assert from 'node:assert/strict';
import test from 'node:test';
globalThis.localStorage={getItem:()=>null,setItem:()=>{}};
globalThis.document={getElementById:()=>({}),querySelectorAll:()=>[]};
globalThis.window={setTimeout,clearTimeout};
const {scoreSeries,applyLearningSignal}=await import('../js/analysis/scoring.js');
const {TECHNICAL_WEIGHTS,TECHNICAL_SCORE_VERSION,recentTechnicalNews,dailyTurnoverUSD,technicalSignalFor}=await import('../js/analysis/technical-policy.js');
const {assessDataConfidence}=await import('../js/analysis/data-confidence.js');
const {sellSignalFor,holdSignalFor}=await import('../js/analysis/signals.js');
const {applyQuoteSnapshot}=await import('../js/data/market.js');
const {calculateHoldings}=await import('../js/analysis/holdings.js');
const {relativeStrengthIndex}=await import('../js/shared/math.js');
const {recordRecommendations,observeRecommendations}=await import('../js/analysis/recommendations.js');
const {state}=await import('../js/storage.js');
const {renderScanRow}=await import('../js/features/screener.js');
const {buildPortfolioReview}=await import('../js/features/portfolio.js');
const NOW=Date.now(),DAY=86400000;
function history(ticker='AUDIT',overrides={}) {
  const end=Date.UTC(new Date(NOW).getUTCFullYear(),new Date(NOW).getUTCMonth(),new Date(NOW).getUTCDate())-DAY;
  const prices=Array.from({length:260},(_,i)=>{const close=100+i*.25+Math.sin(i)*.8;return {date:new Date(end-(259-i)*DAY),close,high:close+2,low:close-2,volume:1000000+i*100};});
  return {ticker,currency:'USD',source:'Yahoo Finance chart',instrumentType:'EQUITY',prices,historyAsOf:prices.at(-1).date.toISOString(),splits:[],splitsComplete:true,...overrides};
}
const score=(series,news=[])=>scoreSeries(series,news,{now:NOW});
const article=(overrides={})=>({title:'Company growth and profit',description:'',sourceId:'reuters',source:'Reuters',sentiment:1,pubDate:new Date(NOW-DAY).toISOString(),link:'https://example.com/company',directTickers:['AUDIT'],...overrides});

test('v2 scores use each price/volume component once and expose exact weights and available coverage',()=>{
  const item=score(history());
  assert.equal(Object.values(TECHNICAL_WEIGHTS).reduce((a,b)=>a+b,0),100);
  assert.equal(item.scoreVersion,TECHNICAL_SCORE_VERSION);
  assert.equal(item.scoreCoverage,100);
  assert.equal(new Set(item.scoreBreakdown.map(row=>row.key)).size,item.scoreBreakdown.length);
  assert.equal(item.score,Math.round(item.scoreBreakdown.reduce((sum,row)=>sum+row.weight*row.raw,0)));
  assert.equal(item.scoreBreakdown.some(row=>row.key==='technical'),false);
});
test('news absence, positive headlines and company fundamentals cannot change the price-based Technical Score',()=>{
  const raw=history(),without=score(raw),positive=score(raw,[article()]);
  assert.equal(without.score,positive.score);
  assert.equal(without.score,score({...raw,fundamentals:{revenueGrowth:-.9,totalDebt:1e12}}).score);
  assert.equal(without.headlineScore,null);assert.equal(without.eventRisk.level,'Unknown');
  assert.equal(without.categories.news,null);
});
test('old, undated, future and duplicate articles cannot inflate current sentiment or event risk',()=>{
  const bad=article({title:'bankruptcy default hack',sentiment:-1,pubDate:new Date(NOW-15*DAY).toISOString()});
  const item=score(history(),[bad,article({pubDate:''}),article({pubDate:new Date(NOW+DAY).toISOString()})]);
  assert.equal(item.eventRisk.level,'Unknown');assert.equal(item.headlineSourceCount,0);
  assert.equal(recentTechnicalNews([article(),article({link:'https://example.com/company?utm_source=duplicate'})],NOW).length,1);
  const recent=article({pubDate:new Date(NOW-DAY).toISOString()}),old=article({link:'https://example.com/older',pubDate:new Date(NOW-13*DAY).toISOString(),sentiment:-1});
  assert.ok(score(history(),[recent,old]).headlineScore>0);
});
test('missing volume is unavailable rather than zero, creates a provisional score and never applies the old 44 cap',()=>{
  const item=score(history('AUDIT',{prices:history().prices.map(p=>({...p,volume:undefined}))}));
  assert.equal(item.volumePressure,null);assert.equal(item.averageDollarVolume,null);
  assert.equal(item.scoreCoverage,88);assert.equal(item.provisional,true);assert.ok(item.score>44);
  assert.ok(item.dataConfidence.missing.some(reason=>/volume/i.test(reason)));
  const zero=score(history('AUDIT',{prices:history().prices.map(p=>({...p,volume:0}))}));
  assert.equal(zero.volumeAvailable,true);assert.equal(zero.averageDollarVolume,0);
});
test('USD turnover thresholds use actual validated currency conversion and exclude unsupported/stale rates',()=>{
  const rate={base:'USD',quote:'EUR',rate:.8,date:new Date(NOW-DAY).toISOString().slice(0,10)};
  assert.equal(dailyTurnoverUSD(4000000,'EUR',rate,NOW),5000000);
  assert.equal(dailyTurnoverUSD(4000000,'EUR',null,NOW),null);
  assert.equal(dailyTurnoverUSD(4000000,'GBP',rate,NOW),null);
  assert.equal(dailyTurnoverUSD(4000000,'EUR',{...rate,date:'2020-01-01'},NOW),null);
  const usd=history(),eur={...usd,currency:'EUR',prices:usd.prices.map(p=>({...p,close:p.close*.8,high:p.high*.8,low:p.low*.8}))};
  const converted=scoreSeries(eur,[],{now:NOW,fxReference:rate});
  assert.ok(Math.abs(converted.averageDollarVolume-score(usd).averageDollarVolume)<1e-6);
});
test('ETF classification never adds diversification points, including concentrated unknown ETFs',()=>{
  const stock=score(history()),fund=score(history('CONCENTRATED',{instrumentType:'ETF'}));
  assert.equal(stock.score,fund.score);
  assert.equal(fund.reasons.some(reason=>/Broad ETF|reduces single-company/.test(reason)),false);
  assert.equal(fund.dataConfidence.financials,'not_applicable');
});
test('quotes do not alter daily SMA/RSI/MACD/volume or the Technical Score; portfolio valuations still use the dated quote',()=>{
  const raw=history(),before=JSON.stringify(raw);
  const quote={ticker:raw.ticker,currency:'USD',price:300,dayChangePercent:.02,volume:2,quoteTime:new Date(NOW),source:'Yahoo Finance chart quote'};
  const overlay=applyQuoteSnapshot(raw,new Map([[raw.ticker,quote]]));
  assert.equal(JSON.stringify(raw),before);assert.deepEqual(overlay.prices,raw.prices);
  const a=score(raw),b=score(overlay);
  for(const field of ['sma20','sma50','sma200','rsi14','score','volumePressure'])assert.equal(b[field],a[field]);
  assert.deepEqual(b.macd,a.macd);assert.equal(b.currentPrice,300);
  assert.equal(calculateHoldings([{kind:'position',ticker:'AUDIT',currency:'USD',shares:2,averageCost:100}],[b],{now:NOW}).holdings[0].currentValue,600);
});
test('today\'s unfinished bar is excluded and flat RSI is neutral',()=>{
  const raw=history(),extra={date:new Date(NOW),close:999,high:1000,low:998,volume:1};
  assert.equal(score({...raw,prices:[...raw.prices,extra],historyAsOf:extra.date.toISOString()}).score,score(raw).score);
  assert.equal(relativeStrengthIndex(Array(30).fill(100)),50);
});
test('missing high/low data withholds ATR and reference ranges instead of claiming accurate risk',()=>{
  const raw=history();raw.prices.at(-1).high=undefined;
  const item=score(raw);assert.equal(item.atrValue,null);assert.equal(item.scoreCoverage,95);
  assert.equal(item.setup.invalidation,null);assert.equal(item.setup.entryZone,'Range data unavailable');
});
test('Data Confidence responds to coverage, staleness, provenance and financial reporting periods, not financial performance',()=>{
  const item=score(history());const record={available:true,provider:'SEC companyfacts',periodEnd:new Date(NOW-300*DAY).toISOString().slice(0,10),retrievedAt:new Date(NOW-DAY).toISOString(),metrics:Object.fromEntries(['revenue','revenueGrowth','netIncome','operatingCashFlow','freeCashFlow','operatingCashFlowGrowth','freeCashFlowGrowth','totalDebt','dilutedEPS'].map(k=>[k,1]))};
  const fresh=assessDataConfidence(item,{financial:record,now:NOW});
  const badBusiness={...record,metrics:Object.fromEntries(Object.keys(record.metrics).map(key=>[key,-100]))};
  assert.equal(assessDataConfidence(item,{financial:badBusiness,now:NOW}).value,fresh.value);
  assert.ok(assessDataConfidence(item,{financial:{...record,periodEnd:'2020-01-01'},now:NOW}).value<fresh.value);
  assert.ok(assessDataConfidence({...item,stale:true},{financial:record,now:NOW}).value<fresh.value);
  assert.ok(assessDataConfidence({...item,source:'unverified'},{financial:record,now:NOW}).value<fresh.value);
  assert.match(fresh.meaning,/not the probability/);
});
test('canonical technical labels agree in setup, scanner, guidance and portfolio review',()=>{
  const item=score(history());
  assert.equal(item.label,item.setup.signal);assert.equal(item.label,technicalSignalFor(item).label);
  const guidance=sellSignalFor(item)||holdSignalFor(item);if(guidance)assert.equal(guidance.label,item.label);
  assert.ok(renderScanRow(item).includes(item.label));
  state.holdings=[{id:'synthetic',kind:'position',ticker:item.ticker,currency:'USD',shares:1,averageCost:100,label:item.ticker}];
  const review=buildPortfolioReview([item],{available:true,score:50});
  assert.equal(review.holdings[0].review.label,item.label);state.holdings=[];
  assert.doesNotMatch(item.label,/\bbuy\b|\bsell\b|\bhold\b/i);
  assert.equal(item.setup.confidence,null);
});
test('legacy scores never generate cross-version score deltas; comparable v2 scans do',()=>{
  const item=score(history());state.learningHistory=[{scores:[{ticker:item.ticker,score:1}]}];
  assert.equal(applyLearningSignal(item).scoreDelta,0);assert.equal(applyLearningSignal(item).scoreComparison.comparable,false);
  state.learningHistory=[{scores:[{ticker:item.ticker,score:item.score-2,scoreVersion:item.scoreVersion,scoreCoverage:item.scoreCoverage}]}];
  assert.equal(applyLearningSignal(item).scoreDelta,2);state.learningHistory=[];
});
test('recommendation reports preserve original v1 records and separate model-version summaries',()=>{
  const item=score(history()),spy=score(history('SPY'));
  const candidate={...item,score:80,evidence:[article()],reasons:[],risks:[]};
  const entries=recordRecommendations([], [candidate],[item,spy],{now:NOW,complete:true,fresh:true});
  assert.equal(entries.length,1);assert.equal(entries[0].scoreVersion,TECHNICAL_SCORE_VERSION);
  const old={...entries[0],id:'OLD|'+entries[0].recordedDate,ticker:'OLD',signal:'Buy signal'};delete old.scoreVersion;
  const before=JSON.stringify(old),report=observeRecommendations([old,entries[0]],[],{now:NOW});
  assert.equal(JSON.stringify(old),before);assert.equal(report.entries.find(entry=>entry.ticker==='OLD').signal,'Buy signal');
  assert.equal(report.summary.byModel['legacy-v1'].recorded,1);assert.equal(report.summary.byModel['technical-v2'].recorded,1);
});
