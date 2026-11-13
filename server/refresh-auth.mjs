import {ApiError,readBoundedText} from './request-body.mjs';
const ISSUER='https://token.actions.githubusercontent.com';
const REPO='hugotristan/investment_helper';
const WORKFLOW=`${REPO}/.github/workflows/pages.yml@refs/heads/main`;
const bytes=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
// Accept only GitHub-signed, short-lived tokens for this repository's main workflow.
// This authority can refresh public observations, never write a financial record.
export function createRefreshAuthorization({fetchImpl=(url,init)=>globalThis.fetch(url,init),now=Date.now}={}) {
  let keys,until=0,pending;
  return async request=>{
    try {
      const token=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]{1,16000})$/)?.[1];
      if(!token)throw Error();
      const [header,payload,signature,...extra]=token.split('.');if(extra.length||!signature)throw Error();
      const h=JSON.parse(new TextDecoder().decode(bytes(header))),c=JSON.parse(new TextDecoder().decode(bytes(payload)));
      const sec=now()/1000;
      if(h.alg!=='RS256'||typeof h.kid!=='string'||h.kid.length>200||h.jku||h.x5u||h.crit||c.iss!==ISSUER||c.aud!==new URL(request.url).origin
        ||c.repository!==REPO||c.repository_id!=='1398295266'||c.repository_owner_id!=='181466766'||c.workflow_ref!==WORKFLOW
        ||c.ref!=='refs/heads/main'||!['push','schedule','workflow_dispatch'].includes(c.event_name)||typeof c.sub!=='string'||!c.sub
        ||![c.exp,c.iat,c.nbf].every(Number.isFinite)||c.exp<=sec||c.nbf>sec+30||c.iat>sec+30||sec-c.iat>600||c.exp-c.iat>600)throw Error();
      if(!keys||until<now()){
        pending ||= (async()=>{const r=await fetchImpl(`${ISSUER}/.well-known/jwks`,{signal:AbortSignal.timeout(5000),redirect:'manual'});if(!r.ok)throw Error();const raw=JSON.parse(await readBoundedText(r,64000));if(!Array.isArray(raw.keys)||raw.keys.length>30)throw Error();keys=raw.keys;until=now()+300000;})().finally(()=>pending=null);
        await pending;
      }
      const jwk=keys.find(key=>key.kid===h.kid&&key.kty==='RSA'&&key.alg==='RS256'&&key.use==='sig');if(!jwk)throw Error();
      const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
      if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,bytes(signature),new TextEncoder().encode(header+'.'+payload)))throw Error();
      return true;
    }catch{throw new ApiError(403,'REFRESH_FORBIDDEN','A valid, scoped GitHub Actions identity is required. No portfolio records were changed.');}
  };
}
