import assert from 'node:assert/strict';import test from 'node:test';import {readFile} from 'node:fs/promises';
import {createLocalDatabase} from '../server/local-database.mjs';import {createPersistentMarketCache,createCompanyProvider,persistentMarket} from '../server/market-coverage.mjs';import {createApp} from '../server/worker.mjs';import {createMcpData} from '../server/mcp-data.mjs';import {createPortfolioBook} from '../js/analysis/portfolio-ledger.js';
const NOW=Date.parse('2026-11-13T12:00:00Z');
const history=ticker=>({ticker,currency:'USD',instrumentType:'EQUITY',source:'Yahoo Finance chart',splits:[],splitsComplete:true,prices:[{date:'2026-11-12',close:125}]});
const chart=ticker=>({chart:{result:[{meta:{symbol:ticker,currency:'USD',instrumentType:'EQUITY',dataGranularity:'1d',regularMarketPrice:126,regularMarketTime:Date.parse('2026-11-12T21:00Z')/1000},timestamp:[Date.parse('2026-11-12T14:30Z')/1000],indicators:{quote:[{close:[125]}]}}]}});
const financial=ticker=>({timeseries:{result:[{meta:{symbol:[ticker],type:['annualTotalRevenue']},annualTotalRevenue:[{asOfDate:'2026-03-31',periodType:'12M',currencyCode:'USD',reportedValue:{raw:1000}}]}]}});
const offline=async()=>{throw Error('Offline')};
function db(t){const DB=createLocalDatabase();t.after(()=>DB.close());return DB;}
async function records(DB,holdings=['TTWO'],watched=['MSFT']){const book=createPortfolioBook({now:NOW,startDate:'2026-01-01',holdings:holdings.map(ticker=>({id:ticker,kind:'position',ticker,label:ticker,shares:1,averageCost:100,currency:'USD'}))});await DB.prepare('INSERT INTO portfolio_books VALUES (?,?,?,?)').bind('owner',JSON.stringify(book),1,new Date(NOW).toISOString()).run();await DB.prepare('INSERT INTO watchlists VALUES (?,?,?,?)').bind('owner',JSON.stringify(watched),1,new Date(NOW).toISOString()).run();return book;}

test('persistent successful prices survive cache reconstruction; failed refresh preserves observation and has backoff',async t=>{const DB=db(t);let now=NOW,calls=0;const create=()=>persistentMarket({loadHistory:async ticker=>{calls++;if(calls>1)throw Error('429');return history(ticker)}},createPersistentMarketCache(DB,{now:()=>now}),()=>now);await create().loadHistory('TTWO');await create().loadHistory('TTWO');assert.equal(calls,1);now+=300001;const stale=await create().loadHistory('TTWO');assert.equal(stale.stale,true);assert.equal(stale.prices[0].close,125);await create().loadHistory('TTWO');assert.equal(calls,2);});
test('cache deduplicates requests and SWR shows cached values without waiting for refresh',async t=>{const DB=db(t);let now=NOW,calls=0,finish;const cache=createPersistentMarketCache(DB,{now:()=>now});await Promise.all([1,2,3].map(()=>cache.get('history:TTWO',async()=>{calls++;return history('TTWO')})));assert.equal(calls,1);now+=300001;let background;const refreshed=cache.get('history:TTWO',()=>new Promise(resolve=>{finish=resolve}),{background:p=>background=p});const value=await refreshed;assert.equal(value.stale,true);await new Promise(resolve=>setTimeout(resolve,0));finish(history('TTWO'));await background;});
test('on-demand untracked company uses Yahoo after SEC denial, caches partial annual metrics, and never writes watchlists',async t=>{const DB=db(t);await records(DB,[],[]);let calls=[];const cache=createPersistentMarketCache(DB,{now:()=>NOW});const provider=createCompanyProvider({DB,cache,now:()=>NOW,readAsset:async()=>null,fetchImpl:async url=>{calls.push(url);return String(url).includes('sec.gov')?new Response('',{status:403}):Response.json(financial('TTWO'))}});const first=await provider.company('TTWO');assert.equal(first.available,true);assert.equal(first.metrics.revenue,1000);assert.equal(first.metrics.netIncome,null);assert.equal(first.periodEnd,'2026-03-31');await provider.company('TTWO');assert.equal(calls.length,2);assert.equal((await DB.prepare('SELECT tickers FROM watchlists').first()).tickers,'[]');});
test('ETF classification comes from the instrument directory, not financial request failure',async t=>{const raw=JSON.parse(await readFile(new URL('../data/instruments.json',import.meta.url)));const etf=raw.entries.find(row=>row.type==='ETF'&&row.ticker!=='SPY');assert.ok(etf);let requests=0;const provider=createCompanyProvider({cache:createPersistentMarketCache(db(t),{now:()=>NOW}),now:()=>NOW,readAsset:async path=>path.includes('instruments')?raw:null,fetchImpl:async()=>{requests++;return new Response('',{status:429})}});assert.equal((await provider.company(etf.ticker)).unsupported,true);assert.equal(requests,0);});
test('company rate limits are explicit, negative cached, and do not become ETF errors',async t=>{const DB=db(t);let calls=0;const provider=createCompanyProvider({DB,cache:createPersistentMarketCache(DB,{now:()=>NOW}),now:()=>NOW,readAsset:async()=>null,fetchImpl:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}})}});const data=createMcpData({market:{loadHistory:offline},companyProvider:provider,now:()=>NOW,fetchImpl:offline});const result=await data.metrics(['TTWO']);assert.equal(result.companies[0].errors[0].code,'METRICS_UNAVAILABLE');assert.match(result.companies[0].errors[0].message,/429/);await data.metrics(['TTWO']);assert.equal(calls,2);});
test('large tracked lists page without dropping holdings or duplicating held/watchlist symbols',async t=>{const DB=db(t),watched=Array.from({length:89},(_,i)=>'S'+i);await records(DB,['TTWO'],['TTWO',...watched]);const data=createMcpData({market:{loadHistory:async ticker=>ticker==='S5'?Promise.reject(Error()):history(ticker)},now:()=>NOW,fetchImpl:offline});let offset=0,all=[];do{const value=await data.status({DB},'owner',null,{offset,batchSize:20});all.push(...value.inspectedTickers);assert.equal(value.pagination.totalTickers,90);offset=value.pagination.nextOffset;}while(offset!==null);assert.equal(all[0],'TTWO');assert.equal(new Set(all).size,90);});
test('background refresh covers newly purchased non-watchlist holding without modifying financial records',async t=>{const DB=db(t),book=await records(DB);let network=[];const app=createApp({}, {now:()=>NOW,fetchImpl:async url=>{network.push(String(url));if(String(url).includes('/chart/'))return Response.json(chart(decodeURIComponent(String(url).split('/chart/')[1].split('?')[0])));if(String(url).includes('timeseries/'))return Response.json(financial(decodeURIComponent(String(url).split('timeseries/')[1].split('?')[0])));return new Response('',{status:403});}});const background=[];const response=await app.fetch(new Request('https://example.test/api/session',{headers:{'oai-authenticated-user-id':'owner'}}),{DB},{waitUntil:p=>background.push(p)});assert.equal(response.status,200);await Promise.all(background);assert.ok(await DB.prepare('SELECT payload FROM market_cache WHERE key = ?').bind('history:TTWO').first());assert.ok(network.some(url=>url.includes('/chart/TTWO')));assert.deepEqual(JSON.parse((await DB.prepare('SELECT book FROM portfolio_books').first()).book),book);assert.equal((await DB.prepare('SELECT tickers FROM watchlists').first()).tickers,'["MSFT"]');});
test('on-demand price endpoint covers an untracked symbol and exposes original dated observation',async t=>{const DB=db(t);await records(DB,[],[]);const app=createApp({}, {now:()=>NOW,fetchImpl:async url=>String(url).includes('/chart/')?Response.json(chart('TTWO')):new Response('',{status:403})});const response=await app.fetch(new Request('https://example.test/api/market/history?ticker=ttwo',{headers:{'oai-authenticated-user-id':'owner'}}),{DB});assert.equal(response.status,200);const result=await response.json();assert.equal(result.ticker,'TTWO');assert.equal(result.quote.quoteTime,'2026-11-12T21:00:00.000Z');assert.equal((await DB.prepare('SELECT tickers FROM watchlists').first()).tickers,'[]');});
import {createRefreshAuthorization} from '../server/refresh-auth.mjs';
import {coveragePlan,acceptCoverageResults} from '../server/coverage-updater.mjs';
import {createPriceProviderFetch} from '../server/market-coverage.mjs';

test('scheduled runner plan includes un-watched holdings, retains organization and resumes the entire union',async t=>{
  const DB=db(t);const book=await records(DB,['TTWO'],['MSFT','VICR']);
  const data=createMcpData({market:{loadHistory:offline},now:()=>NOW,fetchImpl:offline});
  const company={identity:async ticker=>({ticker,type:'stock',companyName:ticker})};
  const plan=await coveragePlan({DB},'owner',data,company,{now:NOW});
  assert.deepEqual(plan.tickers.map(row=>row.ticker),['TTWO','MSFT']);
  const result=await acceptCoverageResults({DB},'owner',{revision:plan.revision,offset:plan.offset,entries:plan.tickers.map(({ticker})=>({ticker,chart:chart(ticker),yahooFinancials:financial(ticker)}))},data,company,{now:NOW});
  assert.equal(result.successes,4);assert.equal(result.complete,false);
  const next=await coveragePlan({DB},'owner',data,company,{now:NOW});assert.deepEqual(next.tickers.map(row=>row.ticker),['VICR']);
  assert.equal((await DB.prepare('SELECT revision FROM portfolio_books').first()).revision,1);
  assert.deepEqual(JSON.parse((await DB.prepare('SELECT book FROM portfolio_books').first()).book),book);
});
test('scheduled batches isolate failed symbols and reject wrong-issuer data without replacing good caches',async t=>{
  const DB=db(t);await records(DB,['TTWO'],['MSFT']);
  const data=createMcpData({market:{loadHistory:offline},now:()=>NOW,fetchImpl:offline});
  const company={identity:async ticker=>({ticker,type:'stock'})};const plan=await coveragePlan({DB},'owner',data,company,{now:NOW});
  const result=await acceptCoverageResults({DB},'owner',{revision:plan.revision,offset:0,entries:[{ticker:'TTWO',chart:chart('MSFT'),priceFailure:429,financialFailure:403},{ticker:'MSFT',chart:chart('MSFT'),yahooFinancials:financial('MSFT')}]},data,company,{now:NOW});
  assert.equal(result.successes,2);assert.equal(result.failures,2);
  const failed=await DB.prepare('SELECT * FROM market_cache WHERE key = ?').bind('history:TTWO').first();assert.equal(failed.payload,null);assert.match(failed.error,/validation/);
  assert.ok((await DB.prepare('SELECT payload FROM market_cache WHERE key = ?').bind('history:MSFT').first()).payload);
});
test('scheduled refresh requires an authentic scoped token; forks, wrong audience, expired tokens and altered signatures fail',async()=>{
  const origin='https://investment-helper.ingrvi.chatgpt.site';
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
  const claims={iss:'https://token.actions.githubusercontent.com',aud:origin,sub:'repo:hugotristan/investment_helper:environment:github-pages',repository:'hugotristan/investment_helper',repository_id:'1398295266',repository_owner_id:'181466766',workflow_ref:'hugotristan/investment_helper/.github/workflows/pages.yml@refs/heads/main',ref:'refs/heads/main',event_name:'schedule',iat:NOW/1000-1,nbf:NOW/1000-1,exp:NOW/1000+299};
  const sign=async(overrides={})=>{const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key'})).toString('base64url'),payload=Buffer.from(JSON.stringify({...claims,...overrides})).toString('base64url');const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(header+'.'+payload));return header+'.'+payload+'.'+Buffer.from(signature).toString('base64url');};
  let reads=0;const verify=createRefreshAuthorization({now:()=>NOW,fetchImpl:async()=>{reads++;return Response.json({keys:[jwk]})}});
  const request=token=>new Request(origin+'/api/market/refresh',{method:'POST',headers:{Authorization:'Bearer '+token}});
  assert.equal(await verify(request(await sign())),true);
  for(const override of [{aud:'https://other.site'},{repository_id:'999'},{ref:'refs/heads/evil'},{event_name:'pull_request'},{exp:NOW/1000-1}])await assert.rejects(()=>sign(override).then(token=>verify(request(token))),error=>error.code==='REFRESH_FORBIDDEN');
  const valid=await sign();await assert.rejects(()=>verify(request(valid.slice(0,-10)+'0000000000')));assert.equal(reads,1);
  const app=createApp({}, {now:()=>NOW});const denied=await app.fetch(request('invalid'),{});assert.equal(denied.status,403);
});
test('provider-wide price backoff survives fetcher reconstruction and prevents another outbound request',async t=>{
  const DB=db(t);let calls=0;const fetchImpl=async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}})};
  const url='https://query1.finance.yahoo.com/v8/finance/chart/TTWO';
  await createPriceProviderFetch(DB,{fetchImpl,now:()=>NOW})(url);
  const result=await createPriceProviderFetch(DB,{fetchImpl,now:()=>NOW})(url.replace('TTWO','MSFT'));
  assert.equal(result.status,429);assert.equal(calls,1);
});
test('an unlisted international ETF is recognized from validated market identity, without company-provider guesses',async t=>{
  let requested=0;
  const provider=createCompanyProvider({cache:createPersistentMarketCache(db(t),{now:()=>NOW}),now:()=>NOW,readAsset:async()=>null,
    resolveHistory:async ticker=>({...history(ticker),instrumentType:'ETF'}),fetchImpl:async()=>{requested++;throw Error();}});
  const result=await provider.company('FUND.L');assert.equal(result.unsupported,true);assert.equal(requested,0);
});
test('an older provider response cannot downgrade a newer persistent observation',async t=>{
  const DB=db(t);let now=NOW;
  const cache=createPersistentMarketCache(DB,{now:()=>now});
  await cache.get('history:TTWO',async()=>history('TTWO'));
  now+=300001;
  const retained=await cache.get('history:TTWO',async()=>({...history('TTWO'),historyAsOf:'2026-11-10T00:00:00Z',prices:[{date:'2026-11-10',close:100}]}));
  assert.equal(retained.stale,true);assert.equal(retained.value.prices[0].close,125);
});
test('international names and exchanges are retained from validated quotes when the directory has no listing',async t=>{
  const provider=createCompanyProvider({cache:createPersistentMarketCache(db(t),{now:()=>NOW}),now:()=>NOW,readAsset:async()=>null,
    resolveHistory:async ticker=>({...history(ticker),instrumentType:'ETF',quote:{name:'Example international fund',exchange:'XETRA'}})});
  const info=await provider.identity('EXAMPLE.DE');assert.equal(info.companyName,'Example international fund');assert.equal(info.exchange,'XETRA');
});
