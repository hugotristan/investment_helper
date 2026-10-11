import test from "node:test";
import assert from "node:assert/strict";
import { calculateEtfExposure } from "../js/analysis/etf-exposure.js";
import snapshot from "../js/data/fund-holdings-snapshot.js";
import { exposureReportRows, etfCsvRows } from "../js/features/report-etf.js";
const funds = [{ tickers: ["FUND"], asOf: "2026-08-31", source: "Issuer", sourceUrl: "https://example.com", holdings: [{ id: "issuer", name: "Issuer", tickers: ["ABC", "XYZ"], weight: .2 }] }];
const input = { complete: true, hasEtfs: true, knownValue: 1100, rows: [{ ticker: "FUND", assetType: "ETFs", value: 1000 }, { ticker: "ABC", assetType: "Stocks", value: 100 }, { ticker: "XYZ", assetType: "Stocks", value: 0 }] };
test("look-through combines share classes, conserves value, and labels unreported constituents", () => {
  const copy = structuredClone(input);
  const result = calculateEtfExposure(input, { funds, now: Date.parse("2026-10-11") });
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].value, 300); assert.equal(result.unreported, 800);
  assert.equal(result.rows[0].value + result.unreported, 1100);
  assert.equal(result.rows[0].weight, 300 / 1100); assert.deepEqual(input, copy);
});
test("future or unsupported fund data remains unreported, and incomplete valuation withholds weights", () => {
  const result = calculateEtfExposure(input, { funds, now: Date.parse("2026-08-01") });
  assert.equal(result.unreported, 1000); assert.deepEqual(result.missingFunds, ["FUND"]);
  const incomplete = calculateEtfExposure({ ...input, complete: false }, { funds, now: Date.parse("2026-10-11") });
  assert.equal(incomplete.rows[0].weight, null); assert.equal(incomplete.unreportedWeight, null);
});
test("full VWCE look-through conserves EUR value in companies, sectors and countries",()=>{
  const analytics={complete:true,hasEtfs:true,knownValue:10300,rows:[{ticker:"VWCE.DE",assetType:"ETFs",value:10000},{ticker:"TSM",assetType:"Stocks",value:300}]};
  const report=calculateEtfExposure(analytics,{funds:[snapshot],now:Date.parse("2026-10-12")});
  assert.ok(report.fullStockLists);assert.ok(report.rows.length>1000);assert.equal(report.reports[0].securityCount,snapshot.securityCount);
  const sum=rows=>rows.reduce((s,r)=>s+r.value,0),near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7);
  near(sum(report.rows)+report.unreported,10300);near(sum(report.sectors),10300);near(sum(report.countries),10300);
  near(report.unreported,10000*(1-snapshot.coverage));
  assert.equal(report.directOverlap.length,1);assert.ok(report.directOverlap[0].tickers.includes("2330.TW"));
  assert.equal(report.directOverlap[0].direct,300);assert.equal(report.directOverlap[0].country,"TW");
  assert.equal(exposureReportRows(report,"companies","TSM").length,1);
  assert.equal(exposureReportRows(report,"countries","Taiwan").length,1);
  const csv=etfCsvRows(report,"companies");assert.ok(csv.rows.length>3500);assert.equal(csv.rows.at(-1)[0],"Unassigned ETF value");
});
test("ETF pair overlap adds smaller issuer weights, identifies same-fund listings and withholds stale data",()=>{
  const second={...funds[0],tickers:["OTHER"],holdings:[{...funds[0].holdings[0],weight:.1},{id:"other",name:"Other",tickers:["NEW"],weight:.8}]};
  const report=calculateEtfExposure({...input,knownValue:2100,rows:[...input.rows,{ticker:"OTHER",assetType:"ETFs",value:1000}]},{funds:[...funds,second],now:Date.parse("2026-10-11")});
  assert.equal(report.pairs[0].sharedWeight,.1);assert.equal(report.pairs[0].sharedCompanies,1);assert.equal(report.directOverlap[0].value,400);
  const same=calculateEtfExposure({complete:true,hasEtfs:true,knownValue:1000,rows:[{ticker:"VWCE.DE",assetType:"ETFs",value:500},{ticker:"VWCE.AS",assetType:"ETFs",value:500}]},{funds:[snapshot],now:Date.parse("2026-10-12")});
  assert.equal(same.pairs[0].sameFund,true);assert.ok(Math.abs(same.pairs[0].sharedWeight-snapshot.coverage)<1e-10);
  const stale=calculateEtfExposure(input,{funds,now:Date.parse("2027-02-01")});assert.equal(stale.unreported,1000);
});
