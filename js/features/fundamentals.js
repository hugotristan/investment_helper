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
  if (record?.available !== true) {
    return panel("Company fundamentals", `<p class="fundamentals-note">${escapeHtml(record?.reason || data.reason || "No supported company filing data is available for this ticker.")}</p>
      ${renderEarnings(record?.earnings, verifier, now)}`, '<span class="fundamentals-status is-unavailable">Unavailable</span>');
  }
  const retrieved = timestamp(record.retrievedAt);
  const stale = !Number.isFinite(retrieved) || now - retrieved >= 10 * DAY_MS || retrieved > now;
  const badge = `<span class="fundamentals-status${stale ? " is-stale" : ""}">${stale ? "Snapshot stale or undated" : "Reported company data"}</span>`;
  const grid = metrics.map(([key, label]) => renderMetric(record, key, label)).join("");
  const note = `${stale ? "Refresh is needed. " : ""}Data retrieved ${dateLabel(record.retrievedAt)}. Filed reporting periods are historical; retrieval time does not change them.`;
  return panel("Company fundamentals", `<p class="fundamentals-note">${escapeHtml(note)}</p>
    ${record.reason ? `<p class="fundamentals-note">${escapeHtml(record.reason)}</p>` : ""}
    <div class="fundamentals-grid">${grid}</div>
    ${renderValuation(item, record, now)}${renderEarnings(record.earnings, verifier, now)}
    ${renderProvenance(record)}`, badge);
}

function renderMetric(record, key, label) {
  const value = record.metrics?.[key];
  const sources = record.metricSources?.[key] || [];
  const current = [...sources].sort((a, b) => timestamp(b.end) - timestamp(a.end) || timestamp(b.filed) - timestamp(a.filed))[0];
  const available = Number.isFinite(value);
  const display = !available ? "Unavailable" : key.endsWith("Growth")
    ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`
    : `${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)} ${current?.unit || record.currency || ""}`.trim();
  const period = current?.end || record.periodEnd;
  return `<div class="fundamental-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(display)}</strong>
    <small>${available ? `${record.fiscalYear ? `FY ${escapeHtml(record.fiscalYear)} · ` : ""}Period ended ${escapeHtml(dateLabel(period))}` : "Not reported or unsupported"}</small>
    ${available ? `<small>Filed ${escapeHtml(dateLabel(current?.filed))} · ${safeLink(current?.url, "SEC filing") || "Source unavailable"}</small>` : ""}</div>`;
}

function renderValuation(item, record, now) {
  const eps = annualEps(record);
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
    note = `Quote ${decimal(quote.price)} ${quote.currency} as of ${dateLabel(quote.quoteTime)} divided by reported annual ${eps.kind} EPS. This uses annual earnings, not trailing twelve months. Later share splits may require EPS adjustment.`;
  }
  return `<div class="fundamentals-valuation"><div><span>Annual EPS</span><strong>${eps ? `${escapeHtml(decimal(eps.value))} ${escapeHtml(eps.currency)}` : "Unavailable"}</strong>
    <small>${eps ? `${escapeHtml(eps.kind)} · year ended ${escapeHtml(dateLabel(record.periodEnd))}` : "No matching annual share-based filing fact"}</small></div>
    <div><span>Price / reported annual EPS</span><strong>${escapeHtml(ratio)}</strong><small>${escapeHtml(note)}</small></div></div>`;
}

function annualEps(record) {
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
  const labels = new Map(metrics.concat([["capitalExpenditures", "Capital expenditures"], ["dilutedEPS", "Diluted EPS"], ["basicEPS", "Basic EPS"],
    ["netIncomeGrowth", "Net profit growth"], ["operatingCashFlowGrowth", "Operating cash flow growth"], ["freeCashFlowGrowth", "Free cash flow growth"]]));
  const rows = Object.entries(record.metricSources || {}).flatMap(([key, sources]) => (Array.isArray(sources) ? sources : []).map((source) => `<div class="fundamentals-source">
    <strong>${escapeHtml(labels.get(key) || key)}</strong><span>${escapeHtml(source.tag)} · ${escapeHtml(source.unit)} · ${source.start ? `${escapeHtml(dateLabel(source.start))} – ` : ""}${escapeHtml(dateLabel(source.end))}</span>
    <span>Filed ${escapeHtml(dateLabel(source.filed))} · ${safeLink(source.url, source.accession || "SEC filing") || "Source link unavailable"}</span></div>`));
  return `<details class="fundamentals-provenance"><summary>Reporting periods &amp; SEC filing sources (${rows.length})</summary>
    <p class="fundamentals-note">Free cash flow is operating cash flow less capital expenditures. Growth compares reported annual periods. Debt includes only debt facts available in the filings.</p>
    ${rows.length ? rows.join("") : '<p class="fundamentals-note">No filing provenance is available.</p>'}</details>`;
}

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
