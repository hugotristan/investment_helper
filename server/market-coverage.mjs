import { ApiError, readBoundedText } from './request-body.mjs';
import { normalizeStockHistory } from '../js/data/stock-history.js';
import { normalizeSecCompanyFacts } from '../js/analysis/fundamentals.js';
import { normalizeYahooFinancials, YAHOO_ANNUAL_TYPES } from '../js/analysis/yahoo-fundamentals.js';
import { broadFunds } from '../js/config/settings.js';
import { VWCE_TICKERS } from '../js/data/vanguard-holdings.js';

const DAY = 86400000;
const pending = new WeakMap();
// D1 leases deduplicate across isolates; failed attempts never replace good data.
export function createPersistentMarketCache(DB, { now = Date.now } = {}) {
  const requests = DB && (pending.get(DB) || new Map());
  if (DB && !pending.has(DB)) pending.set(DB, requests);
  async function get(key, loader, { ttl = 300000, background, validate = value => !!value } = {}) {
    if (!DB) return { value: await loader(), stale: false };
    const row = await DB.prepare('SELECT * FROM market_cache WHERE key = ?').bind(key).first();
    let value;
    try { value = row?.payload && JSON.parse(row.payload); if (!validate(value)) value = null; } catch { value = null; }
    if (value && row.expires_at > now()) return { value, stale: false, fetchedAt:row.succeeded_at };
    const retained = error => {
      if (value) return { value, stale: true, fetchedAt:row?.succeeded_at, error: error || row?.error || 'Refresh is pending.' };
      throw new ApiError(503, 'PROVIDER_UNAVAILABLE', error || row?.error || 'A provider refresh is pending; retry shortly.');
    };
    if (row?.retry_at > now()) return retained();
    if (requests.has(key)) return value && background ? retained() : requests.get(key);
    const refresh = (async () => {
      const claimed = await DB.prepare(`INSERT INTO market_cache (key, expires_at, retry_at, lease_until) VALUES (?, 0, 0, ?)
        ON CONFLICT(key) DO UPDATE SET lease_until = excluded.lease_until WHERE market_cache.lease_until <= ? AND market_cache.retry_at <= ?`)
        .bind(key, now() + 25000, now(), now()).run();
      if (!claimed.meta.changes) return retained('Another request is refreshing this ticker.');
      try {
        const next = await loader();
        if (!validate(next)) throw new ApiError(503, 'INVALID_MARKET_DATA', 'The provider returned no validated market data.');
        // A provider may return a dated fallback. Persist it without pretending a refresh succeeded.
        const stale = next.stale === true;
        const fetchedAt = stale ? row?.succeeded_at || Date.parse(next.quote?.quoteTime || next.historyAsOf) || now() : now();
        await DB.prepare(`UPDATE market_cache SET payload = ?, succeeded_at = ?, expires_at = ?, retry_at = ?, lease_until = 0, error = ? WHERE key = ?`)
          .bind(JSON.stringify(next), fetchedAt, now() + (stale ? 30000 : ttl), stale ? now() + 30000 : 0,
            stale ? 'The latest provider refresh failed; retained dated data.' : null, key).run();
        return { value: next, stale, fetchedAt, error: stale ? 'The latest provider refresh failed; retained dated data.' : null };
      } catch (error) {
        const message = error instanceof ApiError ? error.message : 'The provider refresh failed; no successful data was overwritten.';
        await DB.prepare('UPDATE market_cache SET retry_at = ?, lease_until = 0, error = ? WHERE key = ?').bind(now() + 60000, message, key).run();
        return retained(message);
      }
    })().finally(() => requests.delete(key));
    requests.set(key, refresh);
    if (value && background) { background(refresh.catch(() => {})); return retained('Refreshing the cached observation in the background.'); }
    return refresh;
  }
  return { get };
}

export function createCompanyProvider({ cache, readAsset, fetchImpl = (url, init) => globalThis.fetch(url, init), now = Date.now, DB, resolveHistory }) {
  let instruments, indexRequest, indexUntil=0;
  const queues = new Map(), starts = new Map(), cooldowns = new Map();
  async function providerJson(provider, url, limit = 12000000) {
    const prior = queues.get(provider) || Promise.resolve();
    const work = prior.catch(() => {}).then(async () => {
      if ((cooldowns.get(provider) || 0) > now()) throw new ApiError(503, 'PROVIDER_BACKOFF', `${provider} is in rate-limit backoff; retry later.`);
      const delay = Math.max(0, 600 - (now() - (starts.get(provider) || 0)));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      // Coordinate the rate gate across isolates as well as this request queue.
      if (DB) {
        const gate = await DB.prepare(`INSERT INTO market_cache (key, expires_at, retry_at, lease_until) VALUES (?, 0, 0, ?)
          ON CONFLICT(key) DO UPDATE SET lease_until = excluded.lease_until WHERE market_cache.lease_until <= ?`)
          .bind(`provider:${provider}`, now() + 600, now()).run();
        if (!gate.meta.changes) throw new ApiError(503, 'PROVIDER_BUSY', `${provider} request rate is bounded; retry shortly.`);
      }
      starts.set(provider, now());
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
      try {
        const r = await fetchImpl(url, { headers: { Accept: 'application/json', ...(provider === 'SEC' ? {'User-Agent':'investment-helper https://github.com/hugotristan/investment_helper'} : {}) }, signal: controller.signal, redirect: 'manual' });
        if (!r.ok) {
          if (r.status === 429 || r.status === 403) {
            const retry = Number(r.headers.get('retry-after'));
            const until = now() + Math.min(1800000, Math.max(60000, Number.isFinite(retry) ? retry * 1000 : 300000));
            cooldowns.set(provider, until);
            if (DB) await DB.prepare('UPDATE market_cache SET lease_until = ? WHERE key = ?').bind(until, `provider:${provider}`).run();
          }
          throw new ApiError(503, 'PROVIDER_HTTP_ERROR', `${provider} returned HTTP ${r.status}${r.status === 403 ? ' (access denied)' : r.status === 429 ? ' (rate limited)' : ''}.`);
        }
        return JSON.parse(await readBoundedText(r, limit));
      } finally { clearTimeout(timer); }
    });
    queues.set(provider, work); return work;
  }
  async function identity(ticker) {
    instruments ||= readAsset('data/instruments.json').then(raw => raw?.schemaVersion === 1 && raw.sourceUrl === 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt' && Date.parse(raw.generatedAt) <= now() && Array.isArray(raw.entries) && raw.entries.length <= 20000 ? raw : null).catch(() => null);
    const entry = (await instruments)?.entries.find(item => item.ticker === ticker);
    const history = !entry && resolveHistory ? await resolveHistory(ticker).catch(() => null) : null;
    return { ticker, companyName: typeof entry?.label === 'string' ? entry.label.slice(0,300) : ticker, exchange: entry?.exchange || null,
      type: broadFunds.has(ticker) || VWCE_TICKERS.includes(ticker) || entry?.type === 'ETF' || history?.instrumentType === 'ETF' ? 'ETF' : entry || history?.instrumentType === 'EQUITY' ? 'stock' : 'unknown' };
  }
  async function issuerIndex() {
    if (now() >= indexUntil) { indexRequest = null; indexUntil = now()+300000; }
    indexRequest ||= cache.get('sec:index', () => providerJson('SEC', 'https://www.sec.gov/files/company_tickers.json', 4000000),
      {ttl:30*DAY, validate:value => value && typeof value === 'object' && Object.values(value).some(row => typeof row?.ticker === 'string' && Number.isInteger(row.cik_str))})
      .then(result => result.value).catch(async () => {
        const saved = await readAsset('data/sec-tickers.json');
        if (Date.parse(saved?.verifiedAt) <= now() && now()-Date.parse(saved.verifiedAt) <= 30*DAY) return saved.companyTickers;
        return null;
      });
    return indexRequest;
  }
  async function company(ticker, {background} = {}) {
    const info = await identity(ticker);
    if (info.type === 'ETF') return { ...info, unsupported:true };
    const result = await cache.get(`financial:${ticker}`, async () => {
      const failures = [];
      const index = await issuerIndex();
      const issuer = Object.values(index || {}).find(row => row.ticker === ticker.replace(/\./g, '-'));
      if (issuer) {
        try {
          const cik = String(issuer.cik_str).replace(/^0+/, '');
          const facts = await providerJson('SEC', `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik.padStart(10,'0')}.json`);
          if (String(facts.cik).replace(/^0+/, '') !== cik) throw new Error('Issuer mismatch');
          const record = normalizeSecCompanyFacts(facts, {ticker, cik, retrievedAt:new Date(now()).toISOString()});
          if (record.available) return {...record, provider:'SEC companyfacts'};
          failures.push('SEC: no supported annual company facts.');
        } catch(error) { failures.push(error instanceof ApiError ? error.message : 'SEC company facts failed validation.'); }
      } else failures.push('SEC issuer mapping is unavailable; no unverified CIK was requested.');
      try {
        const url = new URL(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}`);
        url.search = new URLSearchParams({symbol:ticker,type:YAHOO_ANNUAL_TYPES.join(','),period1:String(Math.floor(Date.UTC(new Date(now()).getUTCFullYear()-5,0,1)/1000)),period2:String(Math.floor(now()/1000))});
        const raw = await providerJson('Yahoo financials', url.href, 4000000);
        const record = normalizeYahooFinancials(raw, {ticker,retrievedAt:new Date(now()).toISOString()});
        if (record.available) return {...record, companyName:info.companyName, provider:'Yahoo Finance'};
        failures.push('Yahoo financials: no supported annual financial statements.');
      } catch(error) { failures.push(error instanceof ApiError ? error.message : 'Yahoo financials failed.'); }
      throw new ApiError(503,'METRICS_UNAVAILABLE',failures.join(' '));
    }, {ttl:7*DAY, background, validate:record => record?.ticker === ticker && record.available === true && Number.isFinite(Date.parse(record.retrievedAt)) && Date.parse(record.retrievedAt)<=now()});
    return { ...info, ...result.value, stale:result.stale, refreshError:result.error };
  }
  return { company, identity };
}

export function persistentMarket(market, cache, now = Date.now) {
  return { ...market, async loadHistory(ticker, options = {}) {
    const result = await cache.get(`history:${ticker}`, () => market.loadHistory(ticker), {ttl:5*60000, ...options,
      validate:value => !!normalizeStockHistory(value,ticker,{now:now()})});
    return {...result.value, ...(Number.isFinite(result.fetchedAt) ? {lastSuccessfulFetchAt:new Date(result.fetchedAt).toISOString()} : {}), ...(result.stale ? {stale:true,refreshError:result.error} : {})};
  }};
}

// Yahoo chart calls share one paced queue and a durable provider-wide backoff.
export function createPriceProviderFetch(DB, {fetchImpl = (url,init) => globalThis.fetch(url,init),now = Date.now} = {}) {
  let queue=Promise.resolve(), last=0, failures=0;
  return (url,init) => {
    if (!/^https:\/\/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\//.test(String(url))) return fetchImpl(url,init);
    const run=queue.catch(()=>{}).then(async()=>{
      if (DB) {
        const gate=await DB.prepare('SELECT lease_until FROM market_cache WHERE key = ?').bind('provider:Yahoo prices').first();
        if(gate?.lease_until>now()+1000)return new Response('',{status:429,headers:{'retry-after':String(Math.ceil((gate.lease_until-now())/1000))}});
      }
      const delay=Math.max(0,500-(now()-last));if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      if(DB){const claim=await DB.prepare(`INSERT INTO market_cache(key,expires_at,retry_at,lease_until) VALUES(?,0,0,?) ON CONFLICT(key) DO UPDATE SET lease_until=excluded.lease_until WHERE market_cache.lease_until <= ?`).bind('provider:Yahoo prices',now()+500,now()).run();if(!claim.meta.changes)return new Response('',{status:503});}
      last=now();const response=await fetchImpl(url,init);
      if(response.status===429){failures++;const seconds=Number(response.headers.get('retry-after'));const until=now()+Math.min(1800000,Math.max(30000*2**Math.min(failures,6),Number.isFinite(seconds)?seconds*1000:0));
        if(DB)await DB.prepare(`INSERT INTO market_cache(key,expires_at,retry_at,lease_until) VALUES(?,0,0,?) ON CONFLICT(key) DO UPDATE SET lease_until=excluded.lease_until`).bind('provider:Yahoo prices',until).run();
      }else if(response.ok)failures=0;
      return response;
    });queue=run;return run;
  };
}
