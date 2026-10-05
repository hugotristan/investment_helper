const DAY_MS = 86400000;
const ANNUAL_FORMS = /^(10-K|20-F|40-F)(\/A)?$/;
const TAGS = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
  capitalExpenditures: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  dilutedEPS: ["EarningsPerShareDiluted"],
  basicEPS: ["EarningsPerShareBasic"]
};
export const FUNDAMENTAL_METRICS = ["revenue", "netIncome", "operatingCashFlow", "capitalExpenditures", "freeCashFlow", "totalDebt", "revenueGrowth", "netIncomeGrowth", "operatingCashFlowGrowth", "freeCashFlowGrowth", "dilutedEPS", "basicEPS"];

export function emptyFundamentals(ticker, reason, { cik = null, status = "unavailable" } = {}) {
  return { ticker, cik, companyName: null, available: false, status, reason, currency: null,
    periodEnd: null, fiscalYear: null, retrievedAt: null,
    metrics: Object.fromEntries(FUNDAMENTAL_METRICS.map((key) => [key, null])),
    metricSources: Object.fromEntries(FUNDAMENTAL_METRICS.map((key) => [key, []])), earnings: null };
}

// Companyfacts repeats comparative periods in subsequent filings. Select by the
// actual accounting period, then keep the latest filed restatement for each tag.
export function normalizeSecCompanyFacts(companyFacts, { ticker = "", cik = companyFacts?.cik, retrievedAt = new Date().toISOString() } = {}) {
  const acquisitionTime = Date.parse(retrievedAt);
  const normalizedCik = String(cik || "").replace(/^0+/, "") || null;
  const record = emptyFundamentals(ticker, "No supported annual US-GAAP facts were available.", { cik: normalizedCik });
  record.companyName = companyFacts?.entityName || null;
  record.retrievedAt = new Date(acquisitionTime).toISOString();
  companyFacts = { ...companyFacts, cik: normalizedCik };
  const all = Object.values(TAGS).flatMap((tags) => annualFacts(companyFacts, tags, acquisitionTime));
  if (!all.length) return record;
  const periodEnd = all.map((entry) => entry.end).sort().at(-1);
  const current = all.filter((entry) => entry.end === periodEnd);
  const currency = chooseCurrency(current);
  if (!currency) return record;
  const annualEndTimes = [...new Set(all.filter((entry) => entry.currency === currency).map((entry) => entry.end))]
    .filter((end) => {
      const days = (Date.parse(periodEnd) - Date.parse(end)) / DAY_MS;
      return days >= 335 && days <= 400;
    }).sort();
  const previousEnd = annualEndTimes.at(-1) || null;
  const currentMetrics = periodMetrics(companyFacts, periodEnd, currency, acquisitionTime);
  const previousMetrics = previousEnd ? periodMetrics(companyFacts, previousEnd, currency, acquisitionTime) : null;
  for (const key of ["revenue", "netIncome", "operatingCashFlow", "capitalExpenditures", "freeCashFlow", "dilutedEPS", "basicEPS"]) {
    record.metrics[key] = currentMetrics.values[key];
    record.metricSources[key] = currentMetrics.sources[key];
  }
  const debt = debtForPeriod(companyFacts, periodEnd, currency, acquisitionTime);
  record.metrics.totalDebt = debt.value;
  record.metricSources.totalDebt = debt.sources;
  for (const [growth, value] of [["revenueGrowth", "revenue"], ["netIncomeGrowth", "netIncome"], ["operatingCashFlowGrowth", "operatingCashFlow"], ["freeCashFlowGrowth", "freeCashFlow"]]) {
    const latest = currentMetrics.values[value];
    const previous = previousMetrics?.values[value];
    // Negative/zero baselines do not yield a meaningful ordinary growth ratio.
    const currentDuration = durationDays(currentMetrics.sources[value]?.[0]);
    const previousDuration = durationDays(previousMetrics?.sources[value]?.[0]);
    if (Number.isFinite(latest) && Number.isFinite(previous) && previous > 0
      && Number.isFinite(currentDuration) && Number.isFinite(previousDuration) && Math.abs(currentDuration - previousDuration) <= 14) {
      record.metrics[growth] = latest / previous - 1;
      record.metricSources[growth] = currentMetrics.sources[value].concat(previousMetrics.sources[value]);
    }
  }
  record.available = Object.values(record.metrics).some(Number.isFinite);
  record.status = record.available ? "available" : "unavailable";
  record.reason = record.available ? "Annual reported fundamentals; missing concepts remain unavailable." : record.reason;
  record.currency = currency;
  record.periodEnd = periodEnd;
  // Comparative facts inherit the filing's fy; the accounting period alone
  // cannot prove an issuer's fiscal-year label (especially January year ends).
  record.fiscalYear = null;
  record.retrievedAt = new Date(acquisitionTime).toISOString();
  return record;
}

function periodMetrics(companyFacts, periodEnd, currency, acquisitionTime) {
  const values = {};
  const sources = {};
  for (const [key, tags] of Object.entries(TAGS)) {
    const entry = chooseFact(annualFacts(companyFacts, tags, acquisitionTime)
      .filter((fact) => fact.end === periodEnd && fact.currency === currency), tags);
    const usable = entry && (key !== "capitalExpenditures" || entry.val >= 0);
    values[key] = usable ? entry.val : null;
    sources[key] = usable ? [provenance(entry, companyFacts.cik)] : [];
  }
  const cashFlowSource = sources.operatingCashFlow[0];
  const capexSource = sources.capitalExpenditures[0];
  const hasCashFlow = Number.isFinite(values.operatingCashFlow) && Number.isFinite(values.capitalExpenditures)
    && cashFlowSource.start === capexSource.start && cashFlowSource.end === capexSource.end && cashFlowSource.unit === capexSource.unit;
  values.freeCashFlow = hasCashFlow ? values.operatingCashFlow - values.capitalExpenditures : null;
  sources.freeCashFlow = hasCashFlow ? sources.operatingCashFlow.concat(sources.capitalExpenditures) : [];
  return { values, sources };
}

function debtForPeriod(companyFacts, periodEnd, currency, acquisitionTime) {
  // Liabilities include payables, taxes and other obligations; they are never a
  // substitute for debt. Require complete reported current/non-current pieces.
  const fact = (tag) => chooseFact(instantFacts(companyFacts, tag, acquisitionTime)
    .filter((entry) => entry.end === periodEnd && entry.currency === currency), [tag]);
  const current = fact("DebtCurrent");
  const noncurrent = fact("LongTermDebtNoncurrent");
  const longCurrent = fact("LongTermDebtCurrent");
  const short = fact("ShortTermBorrowings");
  const entries = current && noncurrent ? [current, noncurrent]
    : longCurrent && noncurrent && short ? [longCurrent, noncurrent, short] : [];
  if (!entries.length || entries.some((entry) => entry.val < 0)) return { value: null, sources: [] };
  return { value: entries.reduce((sum, entry) => sum + entry.val, 0), sources: entries.map((entry) => provenance(entry, companyFacts.cik)) };
}

export function annualFacts(companyFacts, tags, acquisitionTime = Date.now()) {
  return tags.flatMap((tag) => factsForTag(companyFacts, tag, acquisitionTime).filter((entry) => {
    const duration = (Date.parse(entry.end) - Date.parse(entry.start)) / DAY_MS + 1;
    const eps = tag === "EarningsPerShareDiluted" || tag === "EarningsPerShareBasic";
    return duration >= 335 && duration <= 400 && (eps ? /^[A-Z]{3}\/shares$/.test(entry.unit) : /^[A-Z]{3}$/.test(entry.unit));
  }));
}

function instantFacts(companyFacts, tag, acquisitionTime) {
  return factsForTag(companyFacts, tag, acquisitionTime)
    .filter((entry) => (!entry.start || entry.start === entry.end) && /^[A-Z]{3}$/.test(entry.unit));
}

function factsForTag(companyFacts, tag, acquisitionTime) {
  const concept = companyFacts?.facts?.["us-gaap"]?.[tag];
  const latest = new Map();
  for (const [unit, facts] of Object.entries(concept?.units || {})) {
    for (const fact of facts) {
      if (!ANNUAL_FORMS.test(String(fact.form || "")) || !Number.isFinite(fact.val)
        || !validDate(fact.end) || !validDate(fact.filed)
        || (fact.start && !validDate(fact.start)) || !/^\d{10}-\d{2}-\d{6}$/.test(String(fact.accn || ""))
        || Date.parse(fact.end) > acquisitionTime || Date.parse(fact.filed) > acquisitionTime + DAY_MS) continue;
      const entry = { ...fact, tag, unit, currency: unit.split("/")[0] };
      const key = `${unit}|${fact.start || ""}|${fact.end}`;
      const previous = latest.get(key);
      if (!previous || fact.filed > previous.filed || fact.filed === previous.filed && fact.accn > previous.accn) latest.set(key, entry);
    }
  }
  return [...latest.values()];
}

function chooseFact(facts, tags) {
  return [...facts].sort((a, b) => b.filed.localeCompare(a.filed) || tags.indexOf(a.tag) - tags.indexOf(b.tag)
    || b.accn.localeCompare(a.accn) || String(a.start || "").localeCompare(String(b.start || "")))[0] || null;
}

function durationDays(source) {
  return source?.start && source?.end ? (Date.parse(source.end) - Date.parse(source.start)) / DAY_MS + 1 : NaN;
}

function chooseCurrency(facts) {
  for (const metric of ["revenue", "netIncome", "operatingCashFlow", "dilutedEPS", "basicEPS", "capitalExpenditures"]) {
    const fact = chooseFact(facts.filter((entry) => TAGS[metric].includes(entry.tag)), TAGS[metric]);
    if (fact) return fact.currency;
  }
  return null;
}

function provenance(entry, cik) {
  const accession = entry.accn;
  return { tag: entry.tag, unit: entry.unit, start: entry.start || null, end: entry.end, filed: entry.filed,
    accession, value: entry.val,
    url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${accession}-index.html` };
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
