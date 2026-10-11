import test from "node:test";
import assert from "node:assert/strict";
import { buildVanguardFund, fetchVanguardFund, normalizeVanguardFund, VWCE_NAME, VANGUARD_HOLDINGS_URL } from "../js/data/vanguard-holdings.js";
import { updateFundHoldings } from "../scripts/update-fund-holdings.mjs";
import { createFundData } from "../server/fund-data.mjs";
import snapshot from "../js/data/fund-holdings-snapshot.js";
import { createApp } from "../server/worker.mjs";

const NOW=Date.parse("2026-10-12T12:00:00Z");
function fixture() {
  const rows=Array.from({length:1601},(_,i)=>({issuerName:`Issuer ${i}`,securityLongDescription:`Issuer ${i}`,bloombergIsoCountry:"US",
    icbIndustryDescription:"Technology",marketValuePercentage:99/1601,sedol1:`S${i}`,ticker:`A${i}`,securityType:"EQ.STOCK",effectiveDate:"2026-08-31"}));
  rows[0].issuerName=rows[1].issuerName="Alphabet Inc";rows[0].ticker="GOOG";rows[1].ticker="GOOGL";
  rows[2].issuerName="Taiwan Semiconductor Manufacturing Co Ltd";rows[2].bloombergIsoCountry="TW";rows[2].ticker="2330";
  // A foreign ticker resembling a US ticker must not identify the US issuer.
  rows[3].bloombergIsoCountry="CA";rows[3].ticker="GOOG";
  const page=(items,lastItemKey)=>({data:{funds:[{profile:{fundFullName:VWCE_NAME,fundCurrency:"USD",primarySectorEquityClassification:"ICB Sectors"}}],
    borHoldings:[{holdings:{items,lastItemKey,totalHoldings:1700}}]}});
  const cash=Array.from({length:99},()=>({securityType:"CRNY",effectiveDate:"2026-08-31",marketValuePercentage:1/99}));
  return [page(rows.slice(0,1500),"page-2"),page([...rows.slice(1500),...cash],null)];
}
test("issuer pages produce a full dated list, combine classes/ADRs and do not rescale residual value",()=>{
  const pages=fixture(),copy=structuredClone(pages),fund=buildVanguardFund(pages,{now:NOW});
  assert.ok(fund); assert.equal(fund.securityCount,1601); assert.equal(fund.holdings.length,1600);
  assert.ok(Math.abs(fund.coverage-.99)<1e-10);
  assert.deepEqual(fund.holdings.find(r=>r.name==="Alphabet Inc").tickers,["GOOG","GOOGL"]);
  assert.deepEqual(fund.holdings.find(r=>r.country==="TW").tickers,["TSM","2330.TW"]);
  assert.deepEqual(fund.holdings.find(r=>r.country==="CA").tickers,[]);
  assert.deepEqual(pages,copy);
});
test("unfinished/repeated/mixed-date pages and malformed positive weights are rejected",()=>{
  const pages=fixture();
  assert.equal(buildVanguardFund([pages[0]],{now:NOW}),null);
  for(const mutate of [p=>p[1].data.borHoldings[0].holdings.items[0].sedol1="S0",p=>p[1].data.borHoldings[0].holdings.items[0].effectiveDate="2026-09-01",
    p=>p[0].data.borHoldings[0].holdings.items[0].marketValuePercentage=-1,p=>p[0].data.funds[0].profile.fundCurrency="EUR",
    p=>p[0].data.borHoldings[0].holdings.items[0].sedol1=null,p=>p[1].data.borHoldings[0].holdings.items.pop()]) {
    const changed=structuredClone(pages);mutate(changed);assert.equal(buildVanguardFund(changed,{now:NOW}),null);
  }
  const zero=structuredClone(pages);zero[0].data.borHoldings[0].holdings.items[4]={marketValuePercentage:0,securityType:"EQ.STOCK",effectiveDate:"2026-08-31"};
  assert.ok(buildVanguardFund(zero,{now:NOW}));
});
test("public fetching follows every cursor, sends only the fixed issuer query, and bounds loops",async()=>{
  const pages=fixture(),calls=[];
  const fund=await fetchVanguardFund({now:NOW,fetchImpl:async(url,init)=>{
    const body=JSON.parse(init.body);calls.push(body);assert.equal(url,VANGUARD_HOLDINGS_URL);assert.equal(init.credentials,undefined);
    assert.equal(init.headers.Cookie,undefined);assert.deepEqual(body.variables.portIds,["9679"]);assert.equal(body.variables.securityTypes,null);
    return Response.json(pages[calls.length-1]);
  }});
  assert.equal(fund.securityCount,1601);assert.equal(calls[1].variables.lastItemKey,"page-2");
  await assert.rejects(fetchVanguardFund({now:NOW,fetchImpl:async()=>Response.json(pages[0])}),/pagination/);
  await assert.rejects(fetchVanguardFund({now:NOW,fetchImpl:async()=>new Response("x",{status:302})}),/unavailable/);
});
test("refresh outages retain the original snapshot date; stale/future sources are withheld",async()=>{
  const previous=buildVanguardFund(fixture(),{now:NOW});
  const result=await updateFundHoldings({previous,now:NOW,fetchImpl:async()=>{throw new Error("Offline");}});
  assert.equal(result.retained,true);assert.deepEqual(result.fund,previous);
  assert.equal(normalizeVanguardFund({...previous,asOf:"2026-02-31"},{now:NOW}),null);
  assert.equal(normalizeVanguardFund({...previous,asOf:"2026-10-13"},{now:NOW}),null);
  assert.equal(normalizeVanguardFund(previous,{now:Date.parse("2027-02-01")}),null);
  await assert.rejects(updateFundHoldings({previous,now:Date.parse("2027-02-01"),fetchImpl:async()=>{throw Error();}}),/No recent/);
});
test("the cloud fund cache coalesces requests and preserves a dated fallback without ledger access",async()=>{
  const pages=fixture();let requests=0;
  const service=createFundData({now:NOW,fetchImpl:async()=>Response.json(pages[(requests++)%2])});
  const [a,b]=await Promise.all([service.loadFunds(),service.loadFunds()]);
  assert.equal(requests,2);assert.deepEqual(a,b);await service.loadFunds();assert.equal(requests,2);
  const offline=createFundData({now:NOW,fetchImpl:async()=>{throw Error("Offline");}});
  assert.equal((await offline.loadFunds())[0].asOf,snapshot.asOf);
});
test("fund endpoint remains authenticated, accepts GET only, and never accepts supplied URLs",async()=>{
  const pages=fixture();let requests=0;
  const app=createApp({}, {now:NOW,fetchImpl:async()=>Response.json(pages[(requests++)%2])});
  const origin="https://investment.example",headers={"oai-authenticated-user-id":"owner"};
  assert.equal((await app.fetch(new Request(`${origin}/api/fund-holdings`))).status,401);
  assert.equal(requests,0);
  assert.equal((await app.fetch(new Request(`${origin}/api/fund-holdings?url=https://example.com`,{headers}))).status,400);
  assert.equal((await app.fetch(new Request(`${origin}/api/fund-holdings`,{method:"POST",headers}))).status,405);
  const response=await app.fetch(new Request(`${origin}/api/fund-holdings`,{headers}));
  assert.equal(response.status,200);assert.equal((await response.json()).funds[0].securityCount,1601);assert.equal(requests,2);
});
