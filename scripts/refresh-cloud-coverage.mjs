import {createYahooPriceFetcher} from './update-prices.mjs';
import {createYahooFetcher} from './yahoo-fundamentals.mjs';
const origin='https://investment-helper.ingrvi.chatgpt.site';
const oidcURL=new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
if(oidcURL.protocol!=='https:'||!oidcURL.hostname.endsWith('.actions.githubusercontent.com'))throw Error('GitHub identity endpoint unavailable');
let token,until=0;
async function call(path,body){
  if(!token||Date.now()>until){oidcURL.searchParams.set('audience',origin);const r=await fetch(oidcURL,{headers:{Authorization:`Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('GitHub identity acquisition failed');token=(await r.json()).value;if(typeof token!=='string')throw Error('GitHub identity unavailable');until=Date.now()+240000;}
  const r=await fetch(origin+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw Error(`Private market-cache refresh returned HTTP ${r.status}; no financial record writes were requested.`);
  return r.json();
}
const prices=createYahooPriceFetcher({maxRetries:1,timeoutMs:7000}),financials=createYahooFetcher({timeoutMs:7000});
const started=Date.now();let successes=0,failures=0,priceRetryAt=0,financialRetryAt=0;
for(let batch=0;batch<160&&Date.now()-started<25*60000;batch++){
  const plan=await call('/api/market/refresh');
  if(!Array.isArray(plan.tickers)||plan.tickers.length>2)throw Error('Invalid bounded coverage plan');
  const entries=[];
  for(const target of plan.tickers){
    const entry={ticker:target.ticker};
    if(target.needsPrice){if(Date.now()<priceRetryAt)entry.priceFailure=429;else try{entry.chart=await prices(target.ticker);}catch(error){entry.priceFailure=error.status||503;priceRetryAt=Date.now()+([403,429].includes(error.status)?300000:30000);}}
    if(target.needsFinancial){if(Date.now()<financialRetryAt)entry.financialFailure=429;else try{entry.yahooFinancials=await financials(target.ticker);}catch(error){entry.financialFailure=error.status||503;financialRetryAt=Date.now()+([403,429].includes(error.status)?300000:30000);}}
    entries.push(entry);await new Promise(resolve=>setTimeout(resolve,600));
  }
  const result=await call('/api/market/refresh-results',{revision:plan.revision,offset:plan.offset,entries});
  successes+=result.successes;failures+=result.failures;
  if(result.complete){console.log(`Tracked market-data scan completed; ${successes} successful updates, ${failures} explicit provider failures. Details remain in private coverage diagnostics.`);process.exit(0);}
}
throw Error('Bounded scan paused; its persistent cursor will resume next run. No financial records were changed.');
