import { calculatePortfolioAnalytics } from "../analysis/portfolio-analytics.js";
import { calculateEtfExposure } from "../analysis/etf-exposure.js";
import { getFundExposures, loadFundExposures } from "../data/fund-exposure.js";
import { escapeHtml } from "../shared/text.js";
import { downloadReport } from "../shared/report-export.js";
import { reportElement, reportHtml, reportEmpty, reportTable, reportBars, euro, reportPercent } from "../shared/report-ui.js";

export function exposureReportRows(model, view = "companies", search = "") {
  const query=search.trim().toLowerCase();
  const names=new Intl.DisplayNames(["en"],{type:"region"});
  const rows=view==="sectors"?model.sectors:view==="countries"?model.countries.map(row=>({
    ...row,name:/^[A-Z]{2}$/.test(row.name)?names.of(row.name):row.name
  })):model.rows;
  return rows.filter(row=>`${row.name} ${row.country||""} ${row.sector||""} ${row.tickers?.join(" ")||""}`.toLowerCase().includes(query));
}
export function etfCsvRows(model, view = "companies", search = "") {
  const rows=exposureReportRows(model,view,search);
  return view==="companies" ? {
    headers:["Company","Country","Sector","Direct EUR","Estimated ETF EUR","Combined EUR","Weight fraction","Fund and weight date"],
    rows:[...rows.map(row=>[row.name,row.country,row.sector,row.direct,row.indirect,row.value,row.weight,row.sources.join("; ")]),
      ["Unassigned ETF value","","",null,model.unreported,model.unreported,model.unreportedWeight,"Not assigned to companies"]]
  } : {headers:[view==="countries"?"Country":"Sector","Value EUR","Weight fraction","Fund weight dates"],
    rows:rows.map(row=>[row.name,row.value,row.weight,model.reports.map(fund=>`${fund.ticker}: ${fund.asOf}`).join("; ")])};
}

let current=null, controls=null, page=0, epoch=0;
const PAGE_SIZE=25, blocked=()=>globalThis.document?.documentElement?.dataset?.privateBlocked==="true";
function bindControls() {
  const button=reportElement("reportEtfExport");
  if (!button || controls?.button===button) return;
  controls={button,view:reportElement("reportEtfView"),search:reportElement("reportEtfSearch"),
    previous:reportElement("reportEtfPrevious"),next:reportElement("reportEtfNext")};
  controls.view?.addEventListener("change",()=>{page=0; if(controls.search)controls.search.value="";draw();});
  controls.search?.addEventListener("input",()=>{page=0;draw();});
  controls.previous?.addEventListener("click",()=>{page=Math.max(0,page-1);draw();});
  controls.next?.addEventListener("click",()=>{page++;draw();});
  button.addEventListener("click",()=>{
    if(!current?.hasEtfs||blocked())return;
    const csv=etfCsvRows(current,controls.view?.value,controls.search?.value);
    downloadReport(`etf-${controls.view?.value||"companies"}.csv`,csv.headers,csv.rows);
  });
}
export function renderEtfReport(holdings) {
  if(!reportElement("reportEtfBody"))return;
  const ticket=++epoch;
  bindControls();
  const analytics=blocked()?null:calculatePortfolioAnalytics(holdings);
  current=analytics?calculateEtfExposure(analytics,{funds:getFundExposures()}):null;
  draw();
  if(!current?.hasEtfs)return;
  void loadFundExposures().then(funds=>{
    if(ticket!==epoch||blocked())return;
    current=calculateEtfExposure(analytics,{funds});draw();
  });
}
function draw() {
  if(!controls)return;
  if(blocked())current=null;
  controls.button.disabled=!current?.hasEtfs;
  const pages=reportElement("reportEtfPages");
  if(!current?.hasEtfs){reportHtml("reportEtfBody",reportEmpty("No ETF holdings are recorded."));if(pages)pages.hidden=true;return;}
  const view=controls.view?.value||"companies", search=controls.search?.value||"";
  const rows=exposureReportRows(current,view,search);
  page=Math.min(page,Math.max(0,Math.ceil(rows.length/PAGE_SIZE)-1));
  const slice=rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE), group=view!=="companies";
  const sourceList=current.reports.map(fund=>`<li><strong>${escapeHtml(fund.ticker)}</strong> · ${fund.fullStockList?`${fund.securityCount.toLocaleString("en")} published securities / ${fund.companyCount.toLocaleString("en")} companies`:"Published company weights"} · ${reportPercent(fund.coverage)} of fund value · ${escapeHtml(fund.asOf)} (${fund.ageDays} days old). <a href="${escapeHtml(fund.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(fund.source)} ↗</a></li>`).join("");
  const coverage=current.reports.map(fund=>`<p class="data-note"><strong>${escapeHtml(fund.ticker)}</strong> · ${fund.companyCount.toLocaleString("en")} companies · ${reportPercent(fund.coverage)} coverage · weights dated ${escapeHtml(fund.asOf)}</p>`).join("");
  const overlaps=current.directOverlap;
  const overlap=overlaps.length?`<details class="secondary-details"><summary>Stocks also held through ETFs (${overlaps.length})</summary>${reportTable(["Company","Direct EUR","Via ETFs · estimate EUR","Combined EUR","Share of holdings"],overlaps.map(row=>[escapeHtml(row.name),euro(row.direct),euro(row.indirect),euro(row.value),reportPercent(row.weight)]),"Your direct stocks and their additional ETF exposure")}</details>`:"";
  const pairs=current.pairs.length?`<details class="secondary-details"><summary>Overlap between ETF positions</summary><p class="data-note">For each shared company, add the smaller of its two fund weights. This measures published company overlap; it excludes unassigned fund value.</p>${reportTable(["ETF pair","Shared companies","Weight overlap","Weight dates"],current.pairs.map(pair=>[escapeHtml(`${pair.left} / ${pair.right}${pair.sameFund?" · same fund, different listing":""}`),String(pair.sharedCompanies),reportPercent(pair.sharedWeight),escapeHtml(`${pair.leftDate} / ${pair.rightDate}`)]),"Overlap from the dated issuer stock lists")}</details>`:"";
  const table=group?reportTable([view==="countries"?"Country":"Sector","Estimated EUR exposure","Share of holdings"],slice.map(row=>[escapeHtml(row.name),euro(row.value),reportPercent(row.weight)]),"Direct and ETF exposure by "+view)
    :reportTable(["Company","Direct EUR","Via ETFs · estimate EUR","Combined EUR","Share of holdings"],slice.map(row=>[escapeHtml(row.name),euro(row.direct),euro(row.indirect),euro(row.value),reportPercent(row.weight)]),"Company exposure · share classes and matched ADRs combined");
  reportHtml("reportEtfBody",`<p class="data-note">Direct stocks plus companies held through ETFs. ETF amounts use your current EUR fund value and dated issuer weights. Cash in your portfolio is excluded.</p>
    ${coverage}
    ${current.reports.length?`<details class="secondary-details"><summary>Fund data and coverage</summary><ul class="data-note">${sourceList}</ul><p class="data-note">Fund holdings change between reports. Countries and sectors follow the issuer's classifications; unmatched direct stocks remain unclassified. Fund weights are not rescaled to 100%.</p></details>`:""}
    ${current.missingFunds.length?`<p class="data-note">No recent verified stock list for ${escapeHtml(current.missingFunds.join(", "))}. Their fund value remains unassigned.</p>`:""}
    ${current.missingValue?'<p class="data-note">Some holdings have no current EUR value. Complete portfolio weights are unavailable.</p>':""}
    <p class="data-note">${euro(current.unreported)} of ETF value is outside the company list${current.missingFunds.length ? "." : " (fund cash, other instruments and rounding)."}</p>
    ${overlap}${pairs}
    ${rows.length?reportBars(rows.slice(0,12).map(row=>({...row,label:row.name}))):'<p class="empty-state">No matching exposure.</p>'}
    ${table}`);
  if(pages)pages.hidden=rows.length<=PAGE_SIZE;
  if(controls.previous)controls.previous.disabled=page===0;
  if(controls.next)controls.next.disabled=(page+1)*PAGE_SIZE>=rows.length;
  const status=reportElement("reportEtfPageStatus");
  if(status)status.textContent=`Showing ${rows.length?page*PAGE_SIZE+1:0}–${Math.min(rows.length,(page+1)*PAGE_SIZE)} of ${rows.length.toLocaleString("en")}`;
}
