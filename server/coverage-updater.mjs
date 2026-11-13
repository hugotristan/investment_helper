import {ApiError} from './request-body.mjs';
import {parseYahooChart,parseYahooQuote} from '../js/data/yahoo-chart.js';
import {normalizeStockHistory} from '../js/data/stock-history.js';
import {normalizeYahooFinancials} from '../js/analysis/yahoo-fundamentals.js';
const DAY=86400000;
export async function coveragePlan(env,userId,data,companyProvider,{now=Date.now()}={}) {
  const [p,w]=await Promise.all([data.portfolio(env,userId),data.watchlists(env,userId)]);
  if(p.status==='unavailable'||w.status==='unavailable')throw new ApiError(503,'COVERAGE_RECORDS_UNAVAILABLE','Tracked records are unavailable; no empty list was substituted.');
  const revision=`${p.revision}:${w.revision}`,all=[...new Set([...p.holdings.map(h=>h.ticker).filter(Boolean),...w.watchlists.flatMap(list=>list.tickers)])];
  const cursor=await env.DB.prepare('SELECT cursor,revision FROM coverage_scans WHERE user_id = ?').bind(userId+':github').first();
  const offset=cursor?.revision===revision&&cursor.cursor<all.length?cursor.cursor:0;
  const tickers=[];
  for(const ticker of all.slice(offset,offset+2)){
    const info=await companyProvider.identity(ticker);
    const fresh=async kind=>{const row=await env.DB.prepare('SELECT payload,expires_at FROM market_cache WHERE key = ?').bind(kind+':'+ticker).first();if(!row?.payload||row.expires_at<=now)return false;try{return kind!=="financial"||JSON.parse(row.payload).historyVersion===1;}catch{return false;}};
    tickers.push({ticker,type:info.type,needsPrice:!await fresh('history'),needsFinancial:info.type!=='ETF'&&!await fresh('financial')});
  }
  return {revision,offset,nextOffset:offset+tickers.length<all.length?offset+tickers.length:null,tickers};
}
export async function acceptCoverageResults(env,userId,input,data,companyProvider,{now=Date.now()}={}) {
  const plan=await coveragePlan(env,userId,data,companyProvider,{now});
  if(!input||Object.keys(input).some(key=>!['revision','offset','entries'].includes(key))||input.revision!==plan.revision||input.offset!==plan.offset||!Array.isArray(input.entries)||input.entries.length!==plan.tickers.length||new Set(input.entries.map(row=>row?.ticker)).size!==input.entries.length)throw new ApiError(409,'COVERAGE_CHANGED','The tracked list or scan cursor changed; retrieve a fresh batch.');
  let successes=0,failures=0;
  for(const entry of input.entries){
    const target=plan.tickers.find(row=>row.ticker===entry?.ticker);
    if(!target||Object.keys(entry).some(key=>!['ticker','chart','yahooFinancials','priceFailure','financialFailure','issuerMetadata'].includes(key)))throw new ApiError(400,'INVALID_COVERAGE_RESULT','Only the requested market-data batch can be cached.');
    for(const [kind,raw,needed] of [['history',entry.chart,target.needsPrice],['financial',entry.yahooFinancials,target.needsFinancial]]){
      if(!needed)continue;
      let record=null;
      if(raw&&kind==='history'){
        const parsed=parseYahooChart(raw,entry.ticker);
        if(parsed){parsed.quote=parseYahooQuote(raw,entry.ticker,{now});record=normalizeStockHistory(parsed,entry.ticker,{now});}
        if(record&&now-Date.parse(record.historyAsOf)>7*DAY)record=null;
      }else if(raw){const normalized=normalizeYahooFinancials(raw,{ticker:entry.ticker,retrievedAt:new Date(now).toISOString(),companyName:(await companyProvider.identity(entry.ticker)).companyName});if(normalized.available){record=normalized;const metadata=entry.issuerMetadata;if(metadata?.source==='SEC submissions'&&/^\d{4}$/.test(String(metadata.sic))&&metadata.tickers?.includes(entry.ticker))record.issuerMetadata={sic:String(metadata.sic),industry:String(metadata.sicDescription||'').slice(0,200),source:'SEC submissions',verifiedAt:new Date(now).toISOString()};}}
      const key=kind+':'+entry.ticker;
      if(record){
        await env.DB.prepare(`INSERT INTO market_cache(key,payload,succeeded_at,expires_at,retry_at,lease_until,error) VALUES(?,?,?,?,0,0,NULL) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,succeeded_at=excluded.succeeded_at,expires_at=excluded.expires_at,retry_at=0,lease_until=0,error=NULL`)
          .bind(key,JSON.stringify(record),now,now+(kind==='history'?300000:7*DAY)).run();successes++;
      }else{
        const status=entry[kind==='history'?'priceFailure':'financialFailure'];
        const message=raw?'Scheduled provider data failed identity, period or price validation.':`Scheduled Yahoo ${kind==='history'?'prices':'annual financials'} request failed${Number.isInteger(status)&&status>=400&&status<=599?' (HTTP '+status+')':''}; the last successful observation was retained.`;
        await env.DB.prepare(`INSERT INTO market_cache(key,expires_at,retry_at,lease_until,error) VALUES(?,0,?,0,?) ON CONFLICT(key) DO UPDATE SET expires_at=0,retry_at=excluded.retry_at,error=excluded.error`).bind(key,now+60000,message).run();failures++;
      }
    }
  }
  await env.DB.prepare(`INSERT INTO coverage_scans(user_id,cursor,revision,next_at) VALUES(?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET cursor=excluded.cursor,revision=excluded.revision,next_at=0`).bind(userId+':github',plan.nextOffset??0,plan.revision).run();
  return {successes,failures,complete:plan.nextOffset===null};
}
