export const FUNDAMENTAL_MODEL = Object.freeze({version:'fundamental-v1',weights:{valuation:30,profitability:30,growth:25,resilience:15},minimumCoverage:.75,minimumCategoryCoverage:.5,minimumPeers:5});
const DAY=86400000;
const finite=Number.isFinite;
export function growthRate(current,previous,years=1){return finite(current)&&finite(previous)&&current>0&&previous>0&&years>0?(current/previous)**(1/years)-1:null;}
export function ratio(n,d){return finite(n)&&finite(d)&&d>0?n/d:null;}
export function industryGroup(metadata){return metadata?.source==='SEC submissions'&&/^\d{4}$/.test(String(metadata.sic))?String(metadata.sic).slice(0,2):null;}
const FORMULAS={ps:'Market capitalization / annual revenue',pe:'Dated quote price / annual diluted EPS',fcfYield:'Annual FCF / market capitalization',evEbitda:'(Market capitalization + debt - cash + preferred equity + minority interest) / (operating income + D&A)',peg:'Annual P/E / historical EPS growth in percentage points; not forecast PEG',netDebtEbitda:'(Debt - cash) / EBITDA',currentRatio:'Current assets / current liabilities',cash:'Reported cash and equivalents',interestCoverage:'Operating income / interest expense',roic:'Operating income × (1 - reported effective tax rate) / average beginning/ending (debt + equity - cash)',operatingMargin:'Operating income / revenue',freeCashFlow:'Reported FCF, or matching-period operating cash flow less capex',fcfMargin:'FCF / revenue',netMargin:'Net income / revenue',revenueGrowth:'Revenue / prior-year revenue - 1',revenueCagr:'(Revenue / revenue three comparable years earlier)^(1/3) - 1',epsGrowth:'EPS / prior-year EPS - 1',epsCagr:'(EPS / EPS three comparable years earlier)^(1/3) - 1',fcfGrowth:'FCF / prior-year FCF - 1',dilution:'(Diluted weighted-average shares / shares 3–5 years earlier)^(1/elapsed years) - 1',consistency:'Fraction of 3–5 comparable years with both positive income and FCF'};
const METRICS={ps:['P/S','valuation',false],pe:['Annual P/E','valuation',false],fcfYield:['FCF yield','valuation',true],evEbitda:['EV/EBITDA','valuation',false],peg:['Historical PEG (diagnostic)','diagnostic',false],netDebtEbitda:['Net debt / EBITDA','resilience',false],currentRatio:['Current ratio','resilience',true],cash:['Cash and equivalents','diagnostic',true],interestCoverage:['Interest coverage','resilience',true],roic:['ROIC','profitability',true],operatingMargin:['Operating margin','profitability',true],freeCashFlow:['Free cash flow','diagnostic',true],fcfMargin:['FCF margin','profitability',true],netMargin:['Net profit margin','diagnostic',true],revenueGrowth:['Revenue growth (1Y)','growth',true],revenueCagr:['Revenue CAGR (3Y)','growth',true],epsGrowth:['EPS growth (1Y)','growth',true],epsCagr:['EPS CAGR (3Y)','growth',true],fcfGrowth:['FCF growth (1Y)','growth',true],dilution:['Diluted share CAGR (3–5Y)','growth',false],consistency:['Positive income and FCF years','profitability',true]};
export function deriveFundamentals(record,item={}, {now=Date.now()}={}){
 const warnings=[],history=(record?.annualHistory||[]).filter(row=>Date.parse(row.end)<=now&&row.currency===record.currency&&['annual','provider_12M'].includes(row.periodType)).sort((a,b)=>a.end.localeCompare(b.end));
 // Retain non-overlapping, comparable fiscal intervals; transitions are not
 // silently counted as multiple years of consistency.
 const coherent=[];let cursor=history.at(-1);while(cursor){coherent.unshift(cursor);cursor=history.filter(r=>r.periodType===cursor.periodType&&(Date.parse(cursor.end)-Date.parse(r.end))/DAY>=335&&(Date.parse(cursor.end)-Date.parse(r.end))/DAY<=400).at(-1);}history.splice(0,history.length,...coherent);
 const current=history.at(-1);const legacy=record?.metrics||{};
 const row=current||{end:record?.periodEnd,currency:record?.currency,values:{...legacy,debt:legacy.totalDebt},sources:record?.metricSources||{}};
 const value=key=>{const sources=row.sources?.[key];return Date.parse(record?.retrievedAt)<=now&&finite(row.values?.[key])&&Array.isArray(sources)&&sources.length&&sources.every(s=>s.end===row.end&&s.unit===(key==='dilutedShares'?'shares':key==='dilutedEPS'?record.currency+'/shares':record.currency)&&(!s.filed||Date.parse(s.filed)<=now))?row.values[key]:null;};
 const values=Object.fromEntries(['revenue','netIncome','operatingIncome','operatingCashFlow','capitalExpenditures','freeCashFlow','dilutedEPS','debt','cash','currentAssets','currentLiabilities','equity','taxExpense','pretaxIncome','depreciation','interestExpense','dilutedShares','preferredStock','minorityInterest'].map(k=>[k,value(k)]));
 const prior=years=>history.filter(r=>{const days=(Date.parse(row.end)-Date.parse(r.end))/DAY;return r.periodType===row.periodType&&days>=years*335&&days<=years*400;}).at(-1);
 const before=prior(1),three=prior(3);
 const historical=(r,key)=>{if(Date.parse(record?.retrievedAt)>now)return null;const sources=r?.sources?.[key];return sources?.length&&sources.every(s=>s.end===r.end&&s.unit===(key==='dilutedShares'?'shares':key==='dilutedEPS'?record.currency+'/shares':record.currency)&&(!s.filed||Date.parse(s.filed)<=now))&&finite(r.values?.[key])?r.values[key]:null;};
 const quote=item.quote||{},qtime=Date.parse(quote.quoteTime),quoteValid=quote.ticker===record?.ticker&&quote.currency===record?.currency&&finite(quote.price)&&quote.price>0&&qtime<=now&&now-qtime<=7*DAY;
 const split=(item.splits||[]).some(s=>Date.parse(s.date)>Date.parse(row.end)&&Date.parse(s.date)<=now);
 const adr=/depositary|\bADR\b|\bADS\b/i.test(quote.name||'');
 const marketCap=quoteValid&&finite(quote.marketCap)&&quote.marketCap>0?quote.marketCap:null;
 const eps=split||adr?null:values.dilutedEPS;
 if(split||adr)warnings.push('Per-share valuation/growth requires split or ADR-basis verification.');
 const ebitda=finite(values.operatingIncome)&&finite(values.depreciation)&&values.depreciation>=0?values.operatingIncome+values.depreciation:null;
 const netDebt=finite(values.debt)&&values.debt>=0&&finite(values.cash)&&values.cash>=0?values.debt-values.cash:null;
 // Missing preferred interests are never silently assumed to be zero.
 const enterpriseValue=marketCap!==null&&netDebt!==null&&values.preferredStock>=0&&finite(values.preferredStock)&&values.minorityInterest>=0&&finite(values.minorityInterest)?marketCap+netDebt+values.preferredStock+values.minorityInterest:null;
 const taxRate=ratio(values.taxExpense,values.pretaxIncome);
 const invested=v=>v&&[v.debt,v.equity,v.cash].every(finite)?v.debt+v.equity-v.cash:null;
 const capital=invested(values),oldCapital=before?invested(Object.fromEntries(['debt','equity','cash'].map(k=>[k,historical(before,k)]))):null;
 const nopat=finite(taxRate)&&taxRate>=0&&taxRate<=1&&finite(values.operatingIncome)?values.operatingIncome*(1-taxRate):null;
 const capAverage=capital>0&&oldCapital>0?(capital+oldCapital)/2:null;
 const epsGrowth=split||adr?null:growthRate(eps,historical(before,'dilutedEPS'));
 const oldest=history.filter(r=>{const days=(Date.parse(row.end)-Date.parse(r.end))/DAY;return r.periodType===row.periodType&&days>=3*335&&days<=5*400&&historical(r,'dilutedShares')>0;})[0];
 const dilutionYears=oldest?(Date.parse(row.end)-Date.parse(oldest.end))/(365.25*DAY):null;
 const consistent=history.slice(-5).filter(r=>finite(historical(r,'netIncome'))&&finite(historical(r,'freeCashFlow')));
 const pe=quoteValid&&eps>0?quote.price/eps:null;
 const computed={ps:ratio(marketCap,values.revenue),pe,fcfYield:ratio(values.freeCashFlow,marketCap),evEbitda:ratio(enterpriseValue,ebitda),peg:epsGrowth>0?ratio(pe,epsGrowth*100):null,
 netDebtEbitda:ratio(netDebt,ebitda),currentRatio:ratio(values.currentAssets,values.currentLiabilities),cash:values.cash,interestCoverage:ratio(values.operatingIncome,values.interestExpense),roic:ratio(nopat,capAverage),operatingMargin:ratio(values.operatingIncome,values.revenue),freeCashFlow:values.freeCashFlow,fcfMargin:ratio(values.freeCashFlow,values.revenue),netMargin:ratio(values.netIncome,values.revenue),
 revenueGrowth:growthRate(values.revenue,historical(before,'revenue')),revenueCagr:growthRate(values.revenue,historical(three,'revenue'),3),epsGrowth,epsCagr:split||adr?null:growthRate(eps,historical(three,'dilutedEPS'),3),fcfGrowth:growthRate(values.freeCashFlow,historical(before,'freeCashFlow')),dilution:oldest?growthRate(values.dilutedShares,historical(oldest,'dilutedShares'),dilutionYears):null,
 consistency:consistent.length>=3?consistent.filter(r=>historical(r,'netIncome')>0&&historical(r,'freeCashFlow')>0).length/consistent.length:null};
 const stale=!record?.available||!finite(Date.parse(record.retrievedAt))||Date.parse(record.retrievedAt)>now||now-Date.parse(record.retrievedAt)>10*DAY||!finite(Date.parse(row.end))||now-Date.parse(row.end)>550*DAY||record.stale===true;
 const sector=Date.parse(record?.issuerMetadata?.verifiedAt)<=now?industryGroup(record?.issuerMetadata):null,financial=sector!==null&&+sector>=60&&+sector<=67;
 const metrics=Object.fromEntries(Object.entries(METRICS).map(([key,[label,category,higher]])=>[key,{key,label,category,higher,formula:FORMULAS[key],value:finite(computed[key])?computed[key]:null,periodEnd:row.end||null,periodType:row.periodType||'annual',currency:record?.currency||null,source:record?.provider||null,sources:row.sources||{},reason:finite(computed[key])?null:'Required validated inputs, comparable periods or a meaningful positive denominator are unavailable.'}]));
 if(stale)warnings.push('Financial acquisition or reporting period is stale, missing or future-dated.');
 if(!sector)warnings.push('A verified industry classification is unavailable. No universal sector thresholds were substituted.');
 if(financial)warnings.push('Financial institution: corporate debt, working-capital and ROIC ratios are not comparable. A bank/insurer-specific model is required.');
 if(sector&&['10','12','13','14','28','29','33','37'].includes(sector))warnings.push('Cyclical industry: spot earnings and single-year valuation may overstate sustainable profitability. Inspect multi-year history.');
 if(values.netIncome<0)warnings.push('Reported net income is negative; a positive earnings multiple is not meaningful.');
 if(values.freeCashFlow<0)warnings.push('Reported free cash flow is negative.');
 return {ticker:record?.ticker||item.ticker,metrics,values,history,sector,financial,stale,warnings,reportingPeriod:row.end,asOf:new Date(now).toISOString(),retrievedAt:record?.retrievedAt||null};
}
// Peer ranking is descriptive within the cached same-SIC group, not a population-wide fair value estimate.
export function rateFundamentals(analysis,peers=[],{now=Date.now(),model=FUNDAMENTAL_MODEL}={}){
 const groups={valuation:[['pe','ps','evEbitda'],['fcfYield']],profitability:[['roic'],['operatingMargin','fcfMargin'],['consistency']],growth:[['revenueGrowth','revenueCagr','epsGrowth','epsCagr','fcfGrowth'],['dilution']],resilience:[['netDebtEbitda','interestCoverage'],['currentRatio']]};
 const categories={},comparisons={};
 const eligible=peers.filter(p=>p.ticker!==analysis.ticker&&p.sector===analysis.sector&&!p.stale&&!p.financial&&Date.parse(p.retrievedAt)<=now&&Math.abs(Date.parse(p.reportingPeriod)-Date.parse(analysis.reportingPeriod))<=400*DAY);
 for(const [category,families] of Object.entries(groups)){
  const familyScores=families.map(keys=>{const scores=[];for(const key of keys){const metric=analysis.metrics[key];if(!finite(metric.value))continue;const sample=eligible.map(p=>p.metrics[key]?.value).filter(finite);if(sample.length<model.minimumPeers)continue;
   const percentile=sample.reduce((sum,v)=>sum+(metric.higher?(metric.value>v?1:metric.value===v?.5:0):(metric.value<v?1:metric.value===v?.5:0)),0)/sample.length*100;
   comparisons[key]={score:percentile,median:[...sample].sort((a,b)=>a-b)[Math.floor(sample.length/2)],peers:sample.length,industry:analysis.sector,contribution:'Averaged within a correlated metric family, then within its category.'};scores.push(percentile);
  }return scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null;});
  const available=familyScores.filter(finite);
  for(const keys of families){const used=keys.filter(key=>comparisons[key]);for(const key of used)comparisons[key].contributionPoints=model.weights[category]/Math.max(1,available.length)/used.length*comparisons[key].score/100;}
  categories[category]={weight:model.weights[category],coverage:available.length/families.length,score:available.length?available.reduce((a,b)=>a+b,0)/available.length:null};
 }
 const coverage=Object.values(categories).reduce((sum,c)=>sum+c.weight*c.coverage,0)/100;
 const credible=!analysis.stale&&!analysis.financial&&!!analysis.sector&&coverage>=model.minimumCoverage&&Object.values(categories).every(c=>c.coverage>=model.minimumCategoryCoverage);
 const score=credible?Math.round(Object.values(categories).reduce((sum,c)=>sum+c.weight*c.score,0)/100):null;
 return {version:model.version,score,status:score===null?'Insufficient Data':'available',label:score===null?'Insufficient Data':score>=70?'Attractive for further research':score>=40?'Mixed':'Unattractive on current fundamentals',coverage,metricCoverage:Object.values(analysis.metrics).filter(m=>m.value!==null).length+'/'+Object.keys(analysis.metrics).length,categories,comparisons,peerCount:eligible.length,
 strengths:Object.entries(comparisons).filter(([,c])=>c.score>=70).map(([key])=>analysis.metrics[key].label+' compares favorably within the observed industry sample.'),weaknesses:Object.entries(comparisons).filter(([,c])=>c.score<30).map(([key])=>analysis.metrics[key].label+' compares unfavorably within the observed industry sample.'),warnings:analysis.warnings};
}
