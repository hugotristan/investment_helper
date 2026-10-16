import test from "node:test";
import assert from "node:assert/strict";
import { renderEtfReport } from "../js/features/report-etf.js";
import { VWCE_EXPOSURE } from "../js/data/fund-exposure.js";

test("full ETF report stays paged/searchable, changes grouping and clears after private access is blocked",async(t)=>{
  // Exercise the saved issuer snapshot at its retrieval date, not the host date.
  t.mock.method(Date,"now",()=>Date.parse(VWCE_EXPOSURE.retrievedAt));
  const ids=["reportEtfBody","reportEtfExport","reportEtfView","reportEtfSearch","reportEtfPrevious","reportEtfNext","reportEtfPages","reportEtfPageStatus"];
  const nodes=new Map(ids.map(id=>[id,{value:"",innerHTML:"",textContent:"",hidden:false,disabled:false,handlers:{},addEventListener(type,handler){this.handlers[type]=handler;}}]));
  const doc={documentElement:{dataset:{cloudMode:"browser",privateBlocked:"false"}},getElementById:id=>nodes.get(id)};
  const previous=globalThis.document;globalThis.document=doc;
  try {
    nodes.get("reportEtfView").value="companies";
    const holdings=[{ticker:"VWCE.DE",currency:"EUR",kind:"structured",eur:{currentValue:10000},analysis:{instrumentType:"ETF"}},
      {ticker:"MSFT",currency:"USD",kind:"structured",eur:{currentValue:500},analysis:{instrumentType:"EQUITY"}}];
    renderEtfReport(holdings);await Promise.resolve();
    assert.match(nodes.get("reportEtfPageStatus").textContent,/Showing 1–25 of/);
    assert.equal(nodes.get("reportEtfPages").hidden,false);
    assert.ok((nodes.get("reportEtfBody").innerHTML.match(/<tr>/g)||[]).length<40);
    assert.match(nodes.get("reportEtfBody").innerHTML,/Stocks also held through ETFs \(1\)/);
    nodes.get("reportEtfNext").handlers.click();assert.match(nodes.get("reportEtfPageStatus").textContent,/Showing 26–50/);
    nodes.get("reportEtfSearch").value="MSFT";nodes.get("reportEtfSearch").handlers.input();
    assert.match(nodes.get("reportEtfPageStatus").textContent,/Showing 1–1 of 1/);assert.match(nodes.get("reportEtfBody").innerHTML,/Microsoft Corp/);
    nodes.get("reportEtfView").value="countries";nodes.get("reportEtfView").handlers.change();
    assert.equal(nodes.get("reportEtfSearch").value,"");assert.match(nodes.get("reportEtfBody").innerHTML,/United States/);
    doc.documentElement.dataset.privateBlocked="true";renderEtfReport([]);await Promise.resolve();
    assert.equal(nodes.get("reportEtfExport").disabled,true);assert.equal(nodes.get("reportEtfPages").hidden,true);
    assert.doesNotMatch(nodes.get("reportEtfBody").innerHTML,/Microsoft Corp|10,000/);
  } finally {globalThis.document=previous;}
});
