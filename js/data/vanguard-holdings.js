// Same public GraphQL query used by Vanguard's holdings spreadsheet. No account,
// portfolio, cookies or visitor-supplied URLs are sent to the issuer.
export const VANGUARD_HOLDINGS_URL = "https://www.vanguard.co.uk/gpx/graphql";
export const VANGUARD_FUND_URL = "https://www.vanguard.co.uk/professional/product/etf/equity/9679/ftse-all-world-ucits-etf-usd-accumulating";
export const VWCE_TICKERS = ["VWCE.DE", "VWCE.AS", "VWCE.MI", "VWRP.L", "VWRA.L", "VWRA.S"];
export const VWCE_NAME = "Vanguard FTSE All-World UCITS ETF (USD) Accumulating";
export const FUND_MAX_AGE_DAYS = 120;
const MAX_SECURITIES = 12000, MAX_BYTES = 4 * 1024 * 1024;
const TYPES = ["EQ.DRCPT", "EQ.ETF", "EQ.FSH", "EQ.PREF", "EQ.PSH", "EQ.REIT", "EQ.STOCK", "EQ.RIGHT", "EQ.WRT", "MF.MF"];
const QUERY = `query FundsHoldingsQuery($portIds: [String!], $securityTypes: [String!], $lastItemKey: String) {
  funds(portIds: $portIds) { profile { fundFullName fundCurrency primarySectorEquityClassification } }
  borHoldings(portIds: $portIds) { holdings(limit: 1500, securityTypes: $securityTypes, lastItemKey: $lastItemKey) {
    items { issuerName securityLongDescription gicsSectorDescription icbIndustryDescription marketValuePercentage
      sedol1 ticker securityType effectiveDate bloombergIsoCountry }
    totalHoldings lastItemKey
  } }
}`;
const text = (value, max = 180) => typeof value === "string" && value.trim().length <= max ? value.trim() : "";
const day = (value, now) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value && Date.parse(value) <= now;
export const issuerId = (name, country) => `issuer:${country}:${name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;

// These aliases were already verified for the former top-ten snapshot. Local
// Taiwanese shares and the US ADR represent the same issuer. Other foreign
// tickers are not treated as US symbols solely because their text matches.
const TSMC = "Taiwan Semiconductor Manufacturing Co Ltd";
function tickerAliases(row) {
  if (row.issuerName === TSMC && row.bloombergIsoCountry === "TW") return ["TSM", "2330.TW"];
  if (row.bloombergIsoCountry !== "US") return [];
  const ticker = text(row.ticker, 30).replaceAll("/", "-");
  return /^[A-Z][A-Z0-9.-]{0,29}$/.test(ticker) ? [ticker] : [];
}

export function buildVanguardFund(pages, { now = Date.now() } = {}) {
  if (!Array.isArray(pages) || !pages.length || pages.length > 8) return null;
  const companies = new Map(), securities = new Set();
  let asOf = null, rowCount = 0, itemCount = 0, portfolioWeight = 0, expectedTotal = null;
  for (const [index, page] of pages.entries()) {
    if (page?.errors?.length || page?.data?.funds?.length !== 1 || page?.data?.borHoldings?.length !== 1) return null;
    const profile = page.data.funds[0].profile, holdings = page.data.borHoldings[0].holdings;
    if (profile?.fundFullName !== VWCE_NAME || profile.fundCurrency !== "USD" || profile.primarySectorEquityClassification !== "ICB Sectors"
      || !Array.isArray(holdings?.items) || !holdings.items.length || holdings.items.length > 1500
      || !Number.isInteger(holdings.totalHoldings) || holdings.totalHoldings < holdings.items.length || holdings.totalHoldings > MAX_SECURITIES
      || Boolean(holdings.lastItemKey) !== (index < pages.length - 1)) return null;
    expectedTotal ??= holdings.totalHoldings;
    if (expectedTotal !== holdings.totalHoldings) return null;
    for (const row of holdings.items) {
      const name = text(row.issuerName) || text(row.securityLongDescription), country = text(row.bloombergIsoCountry, 2);
      const security = text(row.sedol1, 12);
      if (!text(row.securityType,30) || typeof row.marketValuePercentage !== "number" || !Number.isFinite(row.marketValuePercentage)
        || row.marketValuePercentage < -100 || row.marketValuePercentage > 100 || !day(row.effectiveDate, Number(now))) return null;
      itemCount++; portfolioWeight += row.marketValuePercentage / 100;
      asOf ??= row.effectiveDate;
      if (asOf !== row.effectiveDate || itemCount > MAX_SECURITIES) return null;
      if (!TYPES.includes(row.securityType)) continue; // Cash/FX/derivatives stay outside company exposure.
      rowCount++;
      if (row.marketValuePercentage < 0) return null;
      // The issuer includes closed zero-weight rows without security metadata.
      // They contribute no exposure; incomplete positive-weight rows fail closed.
      if (row.marketValuePercentage === 0) continue;
      if (!name || !/^[A-Z]{2}$/.test(country) || !security) return null;
      // A repeated page or security cannot silently inflate fund exposure.
      if (securities.has(security)) return null;
      securities.add(security);
      const id = issuerId(name, country), sector = text(row.icbIndustryDescription, 80) || "Unclassified";
      if (!companies.has(id)) companies.set(id, { id, name, country, sector, tickers: [], weight: 0, securities: 0 });
      const company = companies.get(id);
      if (company.sector !== sector) company.sector = "Unclassified";
      company.weight += row.marketValuePercentage / 100; company.securities++;
      company.tickers = [...new Set([...company.tickers, ...tickerAliases({ ...row, issuerName: name })])];
    }
  }
  // Fetch the unfiltered portfolio so the issuer's total proves no pages are missing.
  if (itemCount !== expectedTotal || portfolioWeight < .98 || portfolioWeight > 1.02) return null;
  const holdings = [...companies.values()].filter((row) => row.weight > 0).sort((a,b) => b.weight-a.weight || a.id.localeCompare(b.id));
  const coverage = holdings.reduce((sum, row) => sum + row.weight, 0);
  if (rowCount < 1000 || coverage < 0.9 || coverage > 1 || !holdings.length) return null;
  return normalizeVanguardFund({ schemaVersion: 1, tickers: VWCE_TICKERS, name: VWCE_NAME, asOf,
    source: "Vanguard", sourceUrl: VANGUARD_FUND_URL, endpoint: VANGUARD_HOLDINGS_URL,
    retrievedAt: new Date(now).toISOString(), fullStockList: true, securityCount: rowCount,
    providerItemCount: itemCount, providerTotalCount: expectedTotal, holdings }, { now });
}

export function normalizeVanguardFund(raw, { now = Date.now() } = {}) {
  const clock = Number(now);
  if (!raw || raw.schemaVersion !== 1 || raw.name !== VWCE_NAME || raw.source !== "Vanguard" || raw.sourceUrl !== VANGUARD_FUND_URL
    || raw.endpoint !== VANGUARD_HOLDINGS_URL || raw.fullStockList !== true || !day(raw.asOf, clock)
    || clock - Date.parse(raw.asOf) > FUND_MAX_AGE_DAYS * 86400000 || !day(raw.retrievedAt?.slice(0,10), clock)
    || !Number.isFinite(Date.parse(raw.retrievedAt)) || Date.parse(raw.retrievedAt) > clock || Date.parse(raw.retrievedAt) < Date.parse(raw.asOf)
    || !Array.isArray(raw.tickers) || JSON.stringify(raw.tickers) !== JSON.stringify(VWCE_TICKERS)
    || !Number.isInteger(raw.securityCount) || raw.securityCount < 1000 || raw.securityCount > MAX_SECURITIES
    || !Number.isInteger(raw.providerTotalCount) || raw.providerTotalCount < raw.securityCount || raw.providerTotalCount > MAX_SECURITIES
    || raw.providerItemCount !== raw.providerTotalCount
    || !Array.isArray(raw.holdings) || !raw.holdings.length || raw.holdings.length > raw.securityCount) return null;
  const seen = new Set(), aliases = new Map(); let coverage = 0, count = 0;
  for (const row of raw.holdings) {
    if (!text(row.name) || !/^[A-Z]{2}$/.test(row.country) || row.id !== issuerId(row.name, row.country) || seen.has(row.id)
      || !text(row.sector,80) || !Number.isInteger(row.securities) || row.securities < 1 || !Number.isFinite(row.weight)
      || row.weight <= 0 || row.weight > 1 || !Array.isArray(row.tickers) || row.tickers.length > 30
      || row.tickers.some((ticker) => !/^[A-Z0-9][A-Z0-9.^-]{0,30}$/.test(ticker))) return null;
    seen.add(row.id); coverage += row.weight; count += row.securities;
    for (const ticker of row.tickers) {
      if (aliases.has(ticker) && aliases.get(ticker) !== row.id) return null;
      aliases.set(ticker,row.id);
    }
  }
  if (coverage < .9 || coverage > 1 || count > raw.securityCount) return null;
  return { ...raw, coverage };
}

async function boundedJson(response) {
  if (!response.ok || response.status >= 300) throw new Error("Fund holdings source unavailable.");
  const reader = response.body.getReader(), parts=[]; let size=0;
  try { while (true) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength;
    if(size>MAX_BYTES) throw new Error("Fund holdings response too large."); parts.push(value); } }
  catch(error) { await reader.cancel().catch(()=>{}); throw error; }
  const bytes=new Uint8Array(size); let offset=0; for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function fetchVanguardFund({ fetchImpl = (url, init) => globalThis.fetch(url, init), now = Date.now(), timeoutMs = 6000 } = {}) {
  const pages=[], cursors=new Set(); let cursor=null;
  do {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(VANGUARD_HOLDINGS_URL,{ method:"POST", redirect:"manual", signal:controller.signal,
        headers:{"Content-Type":"application/json","X-Consumer-ID":"uk2"},
        body:JSON.stringify({query:QUERY,variables:{portIds:["9679"],securityTypes:null,lastItemKey:cursor}}) });
      const page=await boundedJson(response), list=page?.data?.borHoldings?.[0]?.holdings;
      if(page.errors?.length || !list?.items?.length) throw new Error("Invalid fund holdings response.");
      pages.push(page); cursor=list.lastItemKey;
      if(cursor && (typeof cursor !== "string" || cursor.length > 4096 || cursors.has(cursor)) || pages.length > 8) throw new Error("Invalid fund pagination.");
      if(cursor)cursors.add(cursor);
    } finally {clearTimeout(timer);}
  } while(cursor);
  const fund=buildVanguardFund(pages,{now});
  if(!fund)throw new Error("Incomplete or invalid fund holdings.");
  return fund;
}
