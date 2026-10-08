import { broadFunds } from "../config/settings.js";
import { isEtfSeries } from "../analysis/data-quality.js";
import { loadFundamentalsSnapshot } from "../data/fundamentals.js";
import { escapeHtml } from "../shared/text.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const metrics = [
  ["revenue", "Annual revenue"], ["netIncome", "Annual net profit"],
  ["operatingCashFlow", "Operating cash flow"], ["freeCashFlow", "Free cash flow"],
  ["totalDebt", "Reported debt"], ["revenueGrowth", "Annual revenue growth"]
];

export async function renderFundamentals(item, snapshot, { now = Date.now() } = {}) {
  if (item.isFund || broadFunds.has(item.ticker) || isEtfSeries(item)) {
    return panel("Company fundamentals", '<p class="fundamentals-note">Not applicable to an ETF or fund. Corporate revenue, profit, and earnings dates describe companies; fund holdings require separate analysis.</p>');
  }
  const data = snapshot ?? await loadFundamentalsSnapshot();
  const record = data.byTicker?.[item.ticker];
  const verifier = earningsVerifier(item, record);
  const diagnostics = providerDiagnostics(data, item.ticker, record);
  if (record?.available !== true) {
    return panel("Company fundamentals", `${diagnostics.html}<p class="fundamentals-note">${escapeHtml(record?.reason || data.reason || "No supported company filing data is available for this ticker.")}</p>
      ${renderEarnings(record?.earnings, verifier, now)}`, '<span class="fundamentals-status is-unavailable">Unavailable</span>');
  }
  const retrieved = timestamp(record.retrievedAt);
  const stale = !Number.isFinite(retrieved) || now - retrieved >= 10 * DAY_MS || retrieved > now;
  const yahoo = isYahooRecord(record);
  const badge = `<span class="fundamentals-status${stale || diagnostics.retained ? " is-stale" : ""}">${stale ? "Snapshot stale or undated" : diagnostics.retained ? "Retained company data" : yahoo ? "Yahoo Finance company data" : "Reported company data"}</span>`;
  const grid = metrics.map(([key, label]) => renderMetric(record, key, label)).join("");
  const periodNote = yahoo ? "Source: Yahoo Finance. Its 12-month reporting periods are provider dates; SEC filing and fiscal-year dates are unavailable." : "Filed reporting periods are historical; retrieval time does not change them.";
  const note = `${stale ? "Refresh is needed. " : ""}Data retrieved ${dateLabel(record.retrievedAt)}. ${periodNote}`;
  return panel("Company fundamentals", `<p class="fundamentals-note">${escapeHtml(note)}</p>
    ${record.reason ? `<p class="fundamentals-note">${escapeHtml(record.reason)}</p>` : ""}
    <div class="fundamentals-grid">${grid}</div>
    ${renderValuation(item, record, now)}${diagnostics.html}${renderEarnings(record.earnings, verifier, now)}
    ${renderProvenance(record)}`, badge);
}

function providerDiagnostics(data, ticker, record) {
  const failures = Array.isArray(data.failures) ? data.failures : [];
  const ownFailure = failures.find((failure) => failure?.ticker === ticker);
  const failedUpdate = data.providerStatus === "partial" || data.providerStatus === "unavailable";
  const retained = record?.available === true && Boolean(ownFailure || data.providerStatus === "unavailable");
  const separateSec = data.secProviderStatus !== undefined || Array.isArray(data.secFailures);
  const messages = [];
  if (ownFailure || failedUpdate) {
    const failure = ownFailure || failures[0];
    const provider = separateSec ? "company fundamentals" : "SEC filing";
    const update = `The latest ${provider} refresh${data.providerStatus === "partial" ? " partially" : ""} failed.`;
    const error = failure?.reason ? ` ${failure.ticker ? `${failure.ticker}: ` : ""}${failure.reason}` : " The provider did not supply a successful update.";
    const retainedNote = retained ? ` Showing retained figures retrieved ${dateLabel(record.retrievedAt)}; this attempt did not refresh them.` : "";
    messages.push(`${update}${error} Last update attempt: ${dateLabel(data.generatedAt)}.${retainedNote}`);
  }
  if (separateSec) {
    const secFailures = Array.isArray(data.secFailures) ? data.secFailures : [];
    const ownSecFailure = secFailures.find((entry) => entry?.ticker === ticker);
    const failure = ownSecFailure || secFailures[0];
    const freshFallbackReason = timestamp(record?.retrievedAt) === timestamp(data.generatedAt) ? record?.fallbackReason : null;
    if (freshFallbackReason || failure || ["partial", "unavailable"].includes(data.secProviderStatus)) {
      const reason = ownSecFailure?.reason ? `${ticker}: ${ownSecFailure.reason}` : freshFallbackReason
        || (failure?.reason ? `${failure.ticker ? `${failure.ticker}: ` : ""}${failure.reason}` : "The SEC provider did not supply a successful update.");
      const fallback = isYahooRecord(record) && record.available ? " Displayed financial values come from Yahoo Finance." : "";
      messages.push(`SEC source warning: ${reason} Last update attempt: ${dateLabel(data.generatedAt)}.${fallback}`);
    }
  }
  if (data.indexStatus === "fallback" || data.indexStatus === "unavailable" || data.indexError) {
    const verification = data.indexVerifiedAt ? ` verified ${dateLabel(data.indexVerifiedAt)}` : "";
    const lookup = data.indexStatus === "live"
      ? `Issuer lookup returned usable live mappings with a warning.${data.indexSource ? ` Source: ${data.indexSource}${verification}.` : ""}`
      : data.indexStatus === "fallback" ? `Live issuer lookup is unavailable; using ${data.indexSource || "a verified saved issuer mapping"}${verification}.`
        : "Live issuer lookup is unavailable; no usable saved mapping was found.";
    messages.push(`${lookup}${data.indexError ? ` Lookup error: ${data.indexError}` : ""} Last update attempt: ${dateLabel(data.generatedAt)}.`);
  }
  return { retained, html: messages.map((message) => `<p class="fundamentals-note" role="status"><strong>Provider warning.</strong> ${escapeHtml(message)}</p>`).join("") };
}

function renderMetric(record, key, label) {
  const value = record.metrics?.[key];
  const sources = record.metricSources?.[key] || [];
  const current = [...sources].sort((a, b) => timestamp(b.end) - timestamp(a.end) || timestamp(b.filed) - timestamp(a.filed))[0];
  const available = Number.isFinite(value);
  const yahoo = isYahooRecord(record);
  const display = !available ? "Unavailable" : key.endsWith("Growth")
    ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`
    : `${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)} ${current?.unit || record.currency || ""}`.trim();
  const period = current?.end || record.periodEnd;
  const periodLabel = yahoo ? `Provider ${current?.periodType || record.periodType || "unknown"} period ended ${dateLabel(period)}`
    : `${record.fiscalYear ? `FY ${record.fiscalYear} · ` : ""}Period ended ${dateLabel(period)}`;
  const sourceLabel = yahoo ? safeLink(current?.url, "Yahoo Finance") || "Yahoo Finance source link unavailable"
    : `Filed ${escapeHtml(dateLabel(current?.filed))} · ${safeLink(current?.url, "SEC filing") || "Source unavailable"}`;
  return `<div class="fundamental-metric"><span>${escapeHtml(yahoo ? label.replace(/^Annual /, "12-month ") : label)}</span><strong>${escapeHtml(display)}</strong>
    <small>${available ? escapeHtml(periodLabel) : "Not reported or unsupported"}</small>
    ${available ? `<small>${sourceLabel}</small>` : ""}</div>`;
}

function renderValuation(item, record, now) {
  const eps = annualEps(record, now);
  const quote = item.quote;
  const quoteTime = timestamp(quote?.quoteTime);
  const recentQuote = Number.isFinite(quote?.price) && quote.price > 0 && Number.isFinite(quoteTime) && quoteTime <= now && now - quoteTime <= 7 * DAY_MS;
  let ratio = "Unavailable";
  let note = "Annual EPS is unavailable; a P/E ratio cannot be derived.";
  if (eps && eps.value <= 0) {
    ratio = "Not meaningful";
    note = "Annual earnings per share are nonpositive, so a positive P/E ratio is not meaningful.";
  } else if (eps && !recentQuote) {
    note = "A recent real quote with a stated currency is required to derive P/E.";
  } else if (eps && quote.currency !== eps.currency) {
    note = `Quote currency ${quote.currency || "unknown"} does not match annual EPS currency ${eps.currency}; no conversion is assumed.`;
  } else if (eps) {
    ratio = `${(quote.price / eps.value).toFixed(1)}×`;
    const basis = eps.provider === "Yahoo Finance" ? `Yahoo Finance diluted EPS for its 12-month reporting period ended ${dateLabel(eps.end)}.`
      : `reported annual ${eps.kind} EPS. This uses annual earnings, not trailing twelve months.`;
    note = `Quote ${decimal(quote.price)} ${quote.currency} as of ${dateLabel(quote.quoteTime)} divided by ${basis} Later share splits may require EPS adjustment.`;
  }
  const yahoo = isYahooRecord(record);
  const epsPeriod = yahoo ? `diluted · provider 12M period ended ${dateLabel(eps?.end)}` : `${eps?.kind} · year ended ${dateLabel(record.periodEnd)}`;
  const unavailableNote = yahoo ? "No matching provider 12M diluted EPS fact" : "No matching annual share-based filing fact";
  return `<div class="fundamentals-valuation"><div><span>${yahoo ? "Provider 12-month EPS" : "Annual EPS"}</span><strong>${eps ? `${escapeHtml(decimal(eps.value))} ${escapeHtml(eps.currency)}` : "Unavailable"}</strong>
    <small>${escapeHtml(eps ? epsPeriod : unavailableNote)}</small></div>
    <div><span>${yahoo ? "Price / provider 12-month EPS" : "Price / reported annual EPS"}</span><strong>${escapeHtml(ratio)}</strong><small>${escapeHtml(note)}</small></div></div>`;
}

function annualEps(record, now) {
  if (isYahooRecord(record)) {
    const value = record.metrics?.dilutedEPS;
    const source = (record.metricSources?.dilutedEPS || []).find((fact) => fact.provider === "Yahoo Finance" && fact.periodType === "12M"
      && fact.end === record.periodEnd && /^[A-Z]{3}\/shares$/.test(String(fact.unit || ""))
      && fact.unit.split("/")[0] === record.currency && Number.isFinite(timestamp(fact.end)) && timestamp(fact.end) <= now);
    return Number.isFinite(value) && source && record.periodType === "12M"
      ? { value, kind: "diluted", provider: "Yahoo Finance", end: source.end, currency: record.currency } : null;
  }
  for (const [key, kind] of [["dilutedEPS", "diluted"], ["basicEPS", "basic"]]) {
    const value = record.metrics?.[key];
    if (!Number.isFinite(value)) continue;
    const source = (record.metricSources?.[key] || []).find((fact) => {
      const duration = timestamp(fact.end) - timestamp(fact.start);
      return fact.end === record.periodEnd && /^[A-Z]{3}\/shares$/i.test(String(fact.unit || "")) && duration >= 300 * DAY_MS && duration <= 400 * DAY_MS;
    });
    if (source) return { value, kind, currency: source.unit.split("/")[0].toUpperCase() };
  }
  return null;
}

function renderEarnings(earnings, verifier, now) {
  const sourceLink = safeLink(earnings?.sourceUrl, earnings?.source || "Earnings source");
  const date = String(earnings?.date || "");
  const time = timestamp(date);
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date
    && time >= today && ["confirmed", "estimated"].includes(earnings?.status) && sourceLink;
  return `<div class="earnings-status"><span>Upcoming earnings</span><strong>${valid ? `${escapeHtml(dateLabel(date))} · ${escapeHtml(earnings.status)}` : "Unverified"}</strong>
    <p>${valid ? `${earnings.status === "estimated" ? "Estimated timing; verify with investor relations." : "Confirmed by the linked source."} ${sourceLink}` : "No sourced upcoming date is available. Check the company's investor relations calendar."}</p>${verifier}</div>`;
}

function renderProvenance(record) {
  const yahoo = isYahooRecord(record);
  const labels = new Map(metrics.concat([["capitalExpenditures", "Capital expenditures"], ["dilutedEPS", "Diluted EPS"], ["basicEPS", "Basic EPS"],
    ["netIncomeGrowth", "Net profit growth"], ["operatingCashFlowGrowth", "Operating cash flow growth"], ["freeCashFlowGrowth", "Free cash flow growth"]]));
  const rows = Object.entries(record.metricSources || {}).flatMap(([key, sources]) => (Array.isArray(sources) ? sources : []).map((source) => `<div class="fundamentals-source">
    <strong>${escapeHtml(yahoo ? (labels.get(key) || key).replace(/^Annual /, "12-month ") : labels.get(key) || key)}</strong><span>${escapeHtml(source.tag)} · ${escapeHtml(source.unit)} · ${yahoo ? `Provider ${escapeHtml(source.periodType || record.periodType || "unknown")} period ended ` : source.start ? `${escapeHtml(dateLabel(source.start))} – ` : ""}${escapeHtml(dateLabel(source.end))}</span>
    <span>${yahoo ? safeLink(source.url, "Yahoo Finance") || "Yahoo Finance source link unavailable" : `Filed ${escapeHtml(dateLabel(source.filed))} · ${safeLink(source.url, source.accession || "SEC filing") || "Source link unavailable"}`}</span>
    ${source.transformation ? `<span>${escapeHtml(source.transformation)}</span>` : ""}</div>`));
  const explanation = yahoo ? "Yahoo Finance supplies the provider reporting periods and values. SEC filing dates, accessions, and exact fiscal-year dates are unavailable. Growth compares matching provider periods; debt and free cash flow use the provider's reported values."
    : "Free cash flow is operating cash flow less capital expenditures. Growth compares reported annual periods. Debt includes only debt facts available in the filings.";
  return `<details class="fundamentals-provenance"><summary>Reporting periods &amp; ${yahoo ? "Yahoo Finance" : "SEC filing"} sources (${rows.length})</summary>
    <p class="fundamentals-note">${explanation}</p>
    ${rows.length ? rows.join("") : '<p class="fundamentals-note">No source provenance is available.</p>'}</details>`;
}

function isYahooRecord(record) { return record?.provider === "Yahoo Finance"; }

function earningsVerifier(item, record) {
  const name = record?.companyName || item.quote?.name || item.ticker;
  return `${safeLink(`https://www.google.com/search?q=${encodeURIComponent(`${name} investor relations earnings calendar`)}`, "Find investor relations calendar ↗")}
    ${safeLink("https://www.nasdaq.com/market-activity/earnings", "Nasdaq earnings calendar · external verification ↗")}`;
}

function panel(title, content, badge = "") {
  return `<section class="fundamentals-panel"><div class="fundamentals-head"><h4>${escapeHtml(title)}</h4>${badge}</div>${content}</section>`;
}

function safeLink(value, label) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` : "";
  } catch { return ""; }
}

function dateLabel(value) {
  const time = timestamp(value);
  return Number.isFinite(time) ? new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Date unavailable";
}

function timestamp(value) {
  return value === undefined || value === null || value === "" ? NaN : new Date(value).getTime();
}

function decimal(value) {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
