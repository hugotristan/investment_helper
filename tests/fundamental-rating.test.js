import assert from 'node:assert/strict';import test from 'node:test';
import {deriveFundamentals,rateFundamentals,growthRate,ratio} from '../js/analysis/fundamental-rating.js';
import {normalizeYahooFinancials} from '../js/analysis/yahoo-fundamentals.js';
import {normalizeSecCompanyFacts} from '../js/analysis/fundamentals.js';
const NOW=Date.parse('2026-11-13T12:00Z');
function fixture(ticker='ACME'){
 const keys={revenue:100,netIncome:10,operatingIncome:20,operatingCashFlow:20,capitalExpenditures:5,freeCashFlow:15,dilutedEPS:10,debt:50,cash:20,currentAssets:200,currentLiabilities:100,equity:100,taxExpense:4,pretaxIncome:20,depreciation:5,interestExpense:5,dilutedShares:10,preferredStock:0,minorityInterest:0};
 const annualHistory=Array.from({length:6},(_,i)=>{const end=`${2020+i}-12-31`,factor=1.1**(i-5),values=Object.fromEntries(Object.entries(keys).map(([key,value])=>[key,key==='dilutedShares'?value*.99**(i-5):value*factor]));return {end,start:`${2020+i}-01-01`,periodType:'annual',currency:'USD',values,sources:Object.fromEntries(Object.keys(keys).map(key=>[key,[{provider:'SEC companyfacts',end,start:`${2020+i}-01-01`,filed:`${2021+i}-02-01`,unit:key==='dilutedShares'?'shares':key==='dilutedEPS'?'USD/shares':'USD'}]]))};});
 return {record:{ticker,available:true,provider:'SEC companyfacts',retrievedAt:'2026-11-12T12:00Z',currency:'USD',periodEnd:'2025-12-31',annualHistory,issuerMetadata:{sic:'3571',source:'SEC submissions',verifiedAt:'2026-11-12T12:00Z'}},item:{ticker,splitsComplete:true,splitHistoryFrom:'2020-01-01',splits:[],quote:{ticker,currency:'USD',price:100,marketCap:1000,quoteTime:'2026-11-12T21:00Z'}}};
}
const derive=f=>deriveFundamentals(f.record,f.item,{now:NOW});const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} vs ${b}`);
test('all financial formulas use aligned annual values and explicit market capitalization',()=>{
 const a=derive(fixture()),m=a.metrics,v=k=>m[k].value;
 near(v('ps'),10);near(v('pe'),10);near(v('fcfYield'),.015);near(v('evEbitda'),1030/25);near(v('netDebtEbitda'),1.2);near(v('currentRatio'),2);near(v('interestCoverage'),4);near(v('cash'),20);near(v('freeCashFlow'),15);near(v('operatingMargin'),.2);near(v('fcfMargin'),.15);near(v('netMargin'),.1);
 near(v('roic'),16/((130+130/1.1)/2));for(const key of ['revenueGrowth','epsGrowth','fcfGrowth','revenueCagr','epsCagr'])near(v(key),.1);near(v('peg'),1);assert.ok(v('dilution')<0);near(v('consistency'),1);
});
test('missing observations, placeholder market caps, invalid denominators and negative earnings never invent ratios',()=>{
 const f=fixture();f.item.quote.marketCap=0;f.record.annualHistory.at(-1).values.dilutedEPS=-1;f.record.annualHistory.at(-1).values.currentLiabilities=0;
 const a=derive(f);for(const key of ['ps','fcfYield','evEbitda','pe','peg','currentRatio'])assert.equal(a.metrics[key].value,null);
 assert.equal(ratio(1,0),null);assert.equal(growthRate(1,-1),null);
 delete f.record.annualHistory.at(-1).sources.revenue;assert.equal(derive(f).metrics.operatingMargin.value,null);
});
test('currency mismatch, future acquisition, filing dates and source-unit mismatches are withheld',()=>{
 let f=fixture();f.item.quote.currency='EUR';assert.equal(derive(f).metrics.pe.value,null);
 f=fixture();f.record.retrievedAt='2027-01-01';assert.equal(derive(f).metrics.revenueGrowth.value,null);assert.equal(derive(f).metrics.freeCashFlow.value,null);
 f=fixture();f.record.annualHistory.at(-1).sources.revenue[0].filed='2027-01-01';assert.equal(derive(f).metrics.ps.value,null);
 f=fixture();f.record.annualHistory.at(-1).sources.revenue[0].unit='EUR';assert.equal(derive(f).metrics.ps.value,null);
});
test('share splits and ADR ambiguity block per-share ratios and growth',()=>{
 const f=fixture();f.item.splits=[{date:'2026-05-01'}];let a=derive(f);assert.equal(a.metrics.pe.value,null);assert.equal(a.metrics.epsCagr.value,null);
 delete f.item.splits;f.item.quote.name='Example Sponsored ADR';a=derive(f);assert.equal(a.metrics.pe.value,null);
});
test('same-industry peer comparisons disclose family coverage and model weights',()=>{
 const a=derive(fixture());const peers=Array.from({length:6},(_,i)=>derive(fixture('PEER'+i)));
 const r=rateFundamentals(a,peers,{now:NOW});assert.equal(r.score,50);assert.equal(r.label,'Mixed');assert.equal(r.coverage,1);assert.equal(r.version,'fundamental-v1');assert.equal(r.comparisons.pe.peers,6);
 assert.equal(Object.values(r.categories).reduce((sum,c)=>sum+c.weight,0),100);
 assert.equal(rateFundamentals(a,peers.slice(0,4),{now:NOW}).score,null);
 assert.equal(rateFundamentals(a,peers.map(p=>({...p,sector:'28'})),{now:NOW}).score,null);
});
test('stale data, future classifications and financial institutions cannot receive corporate scores',()=>{
 const peers=Array.from({length:6},(_,i)=>derive(fixture('P'+i)));let f=fixture();f.record.retrievedAt='2026-01-01';assert.equal(rateFundamentals(derive(f),peers,{now:NOW}).score,null);
 f=fixture();f.record.issuerMetadata.sic='6021';assert.equal(derive(f).financial,true);assert.equal(rateFundamentals(derive(f),peers,{now:NOW}).score,null);
 f=fixture();f.record.issuerMetadata.verifiedAt='2027-01-01';assert.equal(derive(f).sector,null);
});
test('fiscal transitions and missing multi-year evidence do not manufacture CAGR or consistency',()=>{
 const f=fixture();f.record.annualHistory=f.record.annualHistory.slice(-2);const a=derive(f);assert.equal(a.metrics.consistency.value,null);assert.equal(a.metrics.revenueCagr.value,null);assert.equal(a.metrics.dilution.value,null);
});
test('Yahoo extra concepts retain periods, share units, source links and annual history',()=>{
 const types={annualTotalRevenue:100,annualOperatingIncome:20,annualCashAndCashEquivalents:10,annualDilutedAverageShares:5};
 const raw={timeseries:{result:Object.entries(types).map(([type,value])=>({meta:{symbol:['ACME'],type:[type]},[type]:[{asOfDate:'2025-12-31',periodType:'12M',currencyCode:'USD',reportedValue:{raw:value}}]}))}};
 const r=normalizeYahooFinancials(raw,{ticker:'ACME',retrievedAt:new Date(NOW).toISOString()});assert.equal(r.historyVersion,1);assert.equal(r.annualHistory[0].values.operatingIncome,20);assert.equal(r.annualHistory[0].sources.dilutedShares[0].unit,'shares');
});

test('splits inside a multi-year window block EPS CAGR and apparent dilution',()=>{const f=fixture();f.item.splits=[{date:'2023-06-01'}];const a=derive(f);assert.equal(a.metrics.epsCagr.value,null);assert.equal(a.metrics.dilution.value,null);const missing=fixture();missing.item.splitsComplete=false;assert.equal(derive(missing).metrics.pe.value,null);});
