import { getFundExposures } from "../data/fund-exposure.js";
import { FUND_MAX_AGE_DAYS } from "../data/vanguard-holdings.js";

// Current ETF values times dated issuer weights. Residual fund value is separate;
// no renormalization to 100%, and unknown stock identity stays unclassified.
export function calculateEtfExposure(analytics, { funds, now = Date.now() } = {}) {
  funds ??= getFundExposures({now});
  const companies = new Map(), reports = [], missingFunds = [], aliases = new Map(), validated = [];
  let unreported = 0, missingValue = false;
  for (const fund of funds) {
    const date = Date.parse(`${fund.asOf}T00:00:00Z`), ids=new Set();
    const coverage = fund.holdings?.reduce((sum,row)=>sum+row.weight,0);
    const ageDays = Math.floor((Number(now)-date)/86400000);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0,10)!==fund.asOf || ageDays<0 || ageDays>FUND_MAX_AGE_DAYS
      || !Array.isArray(fund.tickers) || !Array.isArray(fund.holdings) || coverage<=0 || coverage>1 || !Number.isFinite(coverage)
      || fund.holdings.some(row=>!row.id || ids.has(row.id) || (ids.add(row.id),false) || !Number.isFinite(row.weight)
        || row.weight<=0 || row.weight>1 || !Array.isArray(row.tickers))) continue;
    validated.push({...fund,coverage,ageDays});
    for (const row of fund.holdings) for (const ticker of row.tickers) {
      // Conflicting aliases are unresolved rather than arbitrarily assigned.
      if(!aliases.has(ticker))aliases.set(ticker,row);
      else if(aliases.get(ticker)?.id!==row.id)aliases.set(ticker,null);
    }
  }
  const ensure=(id,name,country="Unclassified",sector="Unclassified",tickers=[])=>{
    if(!companies.has(id))companies.set(id,{id,name,country,sector,tickers,direct:0,indirect:0,sources:[],contributions:[]});
    return companies.get(id);
  };
  for(const position of analytics.rows) {
    if(!Number.isFinite(position.value)||position.value<0){missingValue=true;continue;}
    if(position.assetType!=="ETFs") {
      const company=aliases.get(position.ticker);
      ensure(company?.id||`direct:${position.ticker}|${position.currency}`,company?.name||position.label,company?.country,company?.sector,company?.tickers||[position.ticker]).direct+=position.value;
      continue;
    }
    const fund=validated.find(f=>f.tickers.includes(position.ticker));
    if(!fund){unreported+=position.value;missingFunds.push(position.ticker);continue;}
    reports.push({ticker:position.ticker,value:position.value,coverage:fund.coverage,asOf:fund.asOf,ageDays:fund.ageDays,
      source:fund.source,sourceUrl:fund.sourceUrl,fullStockList:fund.fullStockList===true,
      securityCount:fund.securityCount||fund.holdings.length,companyCount:fund.holdings.length,fund});
    unreported+=position.value*Math.max(0,1-fund.coverage);
    for(const holding of fund.holdings) {
      const company=ensure(holding.id,holding.name,holding.country,holding.sector,holding.tickers), value=position.value*holding.weight;
      company.indirect+=value;
      company.sources.push(`${position.ticker} · ${fund.asOf}`);
      company.contributions.push({ticker:position.ticker,value,weight:holding.weight,asOf:fund.asOf});
    }
  }
  const weighted=value=>analytics.complete&&analytics.knownValue>0?value/analytics.knownValue:null;
  const sort=(a,b)=>b.value-a.value||a.name.localeCompare(b.name);
  const rows=[...companies.values()].map(row=>({...row,value:row.direct+row.indirect,weight:weighted(row.direct+row.indirect)})).sort(sort);
  const buckets=(key)=>{
    const map=new Map();
    for(const row of rows){const name=row[key]||"Unclassified";map.set(name,(map.get(name)||0)+row.value);}
    if(unreported>0)map.set("Unassigned ETF value",unreported);
    return [...map].map(([name,value])=>({name,label:name,value,weight:weighted(value)})).sort(sort);
  };
  const pairs=[];
  for(let a=0;a<reports.length;a++)for(let b=a+1;b<reports.length;b++) {
    const left=reports[a],right=reports[b],byId=new Map(left.fund.holdings.map(r=>[r.id,r.weight]));
    let sharedWeight=0,sharedCompanies=0;
    for(const row of right.fund.holdings)if(byId.has(row.id)){sharedWeight+=Math.min(byId.get(row.id),row.weight);sharedCompanies++;}
    pairs.push({left:left.ticker,right:right.ticker,leftDate:left.asOf,rightDate:right.asOf,sharedWeight,sharedCompanies,
      sameFund:left.fund===right.fund});
  }
  return {rows,reports:reports.map(({fund,...report})=>report),pairs,sectors:buckets("sector"),countries:buckets("country"),
    directOverlap:rows.filter(row=>row.direct>0&&row.indirect>0),missingFunds,unreported,missingValue,hasEtfs:analytics.hasEtfs,
    fullStockLists:reports.length>0&&reports.every(f=>f.fullStockList)&&missingFunds.length===0,
    completeValuation:analytics.complete,total:analytics.knownValue,unreportedWeight:weighted(unreported)};
}
