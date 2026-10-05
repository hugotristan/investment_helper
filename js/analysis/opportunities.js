import { broadFunds } from "../config/settings.js";
import { formatPercent } from "../shared/format.js";
import { hasQualifiedSignal, isEtfSeries } from "./data-quality.js";
import { sellSignalFor } from "./signals.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Research candidates require both a qualified technical setup and recent direct
// company evidence. A scan is allowed to return no candidate.
export function buildOpportunities(results, marketContext, { now = Date.now(), holdings = [] } = {}) {
  const asOf = new Date(now).toISOString();
  const exclusions = [];
  if (marketContext?.available !== true || !Number.isFinite(marketContext.score)) {
    return { candidates: [], exclusions, asOf,
      reason: "Market coverage is insufficient. Waiting for recent real equity and credit data before selecting a research candidate." };
  }
  if (marketContext.score < 45) {
    return { candidates: [], exclusions, asOf,
      reason: "Market conditions are defensive. No new research candidate passes the market regime check." };
  }

  const weights = holdingWeights(holdings);
  const candidates = [];
  const seen = new Set();
  const ordered = [...(results || [])].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.ticker.localeCompare(b.ticker));
  for (const item of ordered) {
    if (seen.has(item.ticker)) continue;
    seen.add(item.ticker);
    const evidence = directEvidence(item, now);
    const holdingWeight = weights.get(item.ticker) || 0;
    const rejection = exclusionFor(item, evidence, holdingWeight, now);
    if (rejection) {
      exclusions.push({ ticker: item.ticker, ...rejection });
      continue;
    }
    candidates.push({
      ...item, evidence,
      reasons: candidateReasons(item, evidence),
      risks: candidateRisks(item, evidence, holdingWeight),
      invalidation: item.setup?.invalidation ?? null,
      horizon: item.setup?.timeframe || "1 to 4 weeks",
      asOf: item.dataQuality.asOf,
      holdingWeight
    });
  }

  const selected = candidates.slice(0, 3);
  let reason = `${selected.length} stock${selected.length === 1 ? "" : "s"} pass the price, risk, market, and direct evidence checks.`;
  if (!selected.length) {
    const stockExclusions = exclusions.filter((item) => item.code !== "fund" && item.code !== "asset_type");
    if (!stockExclusions.length) reason = "No individual stocks were available to research. ETFs are excluded from these stock candidates.";
    else if (stockExclusions.every((item) => item.code === "data_quality")) reason = "No stock has qualified recent real price history. Sample, stale, and insufficient histories cannot produce a candidate.";
    else if (stockExclusions.some((item) => item.code === "evidence")) reason = "No qualified stock has recent dated direct company evidence alongside a passing setup. Broad sector or market stories are insufficient.";
    else if (stockExclusions.some((item) => item.code === "concentration")) reason = "No candidate passes all checks without adding to an already concentrated holding.";
    else reason = "No stock passes the current trend, signal strength, liquidity, and risk checks. Waiting for a stronger setup.";
  }
  return { candidates: selected, exclusions, reason, asOf };
}

function exclusionFor(item, evidence, holdingWeight, now) {
  if (item.isFund || broadFunds.has(item.ticker) || isEtfSeries(item)) {
    return { code: "fund", reason: "ETF or fund exposure is excluded from individual stock research candidates." };
  }
  const type = String(item.instrumentType || item.quote?.quoteType || "").toUpperCase();
  if (type && type !== "EQUITY") return { code: "asset_type", reason: "Only individual equities are eligible for these research candidates." };
  const historyTime = Date.parse(item.dataQuality?.asOf || "");
  if (!hasQualifiedSignal(item) || /^sample\b/i.test(String(item.source || ""))
    || !Number.isFinite(historyTime) || now - historyTime > 7 * DAY_MS || historyTime > now + DAY_MS) {
    return { code: "data_quality", reason: item.dataQuality?.reason || "Recent real daily price history is unavailable." };
  }
  if (item.score < 65) return { code: "score", reason: "Signal strength is below the 65/100 research threshold." };
  if (item.eventRisk?.level === "High") return { code: "event_risk", reason: "High event risk blocks a new research candidate." };
  if (!Number.isFinite(item.rsi14) || !Number.isFinite(item.volatility) || !Number.isFinite(item.averageDollarVolume)) {
    return { code: "risk_data", reason: "Momentum, volatility, or liquidity checks are unavailable." };
  }
  if (item.rsi14 > 75) return { code: "stretched", reason: "RSI above 75 indicates a stretched setup." };
  if (item.volatility > 0.5) return { code: "volatility", reason: "Annualized volatility exceeds the 50% research limit." };
  if (item.averageDollarVolume < 5000000) return { code: "liquidity", reason: "Average daily dollar liquidity is below $5 million." };
  if (!Number.isFinite(item.latest) || !Number.isFinite(item.sma200) || !Number.isFinite(item.sixMonth)
    || item.latest <= item.sma200 || item.sixMonth <= 0) {
    return { code: "trend", reason: "A positive 200-day trend and six-month momentum are both required." };
  }
  if (sellSignalFor(item)) return { code: "sell_signal", reason: "The current model identifies sell or trim triggers." };
  if (holdingWeight > 10) return { code: "concentration", reason: `This stock already represents ${holdingWeight.toFixed(1)}% of a tracked currency group; it is excluded from new research candidates.` };
  if (!evidence.length) return { code: "evidence", reason: "No dated direct company article with a usable link was found within the last 14 days." };
  return null;
}

function directEvidence(item, now) {
  const seen = new Set();
  return [...(item.headlines || []), ...(item.outlooks || [])]
    .filter((article) => {
      if (!article.directTickers?.includes(item.ticker) || !article.title || !usableUrl(article.link)) return false;
      const time = articleTime(article.pubDate);
      return Number.isFinite(time) && now - time <= 14 * DAY_MS && time <= now + DAY_MS;
    })
    .map((article) => ({ ...article, pubDate: new Date(articleTime(article.pubDate)).toISOString() }))
    .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate) || String(a.link).localeCompare(String(b.link)))
    .filter((article) => {
      const key = canonicalUrl(article.link);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 3);
}

function candidateReasons(item, evidence) {
  const technical = (item.reasons || []).filter((reason) => /^(Above (?:200|50)-day|50-day average is rising|Six-month momentum|RSI|MACD|Liquidity screen)/.test(reason));
  const fallback = ["Price is above the 200-day average.", `Six-month momentum is positive at ${formatPercent(item.sixMonth)}.`];
  const reasons = [...new Set(technical.concat(fallback))].slice(0, 2);
  const story = evidence[0];
  return reasons.concat(`Direct company coverage: ${story.source || "Linked source"} — ${story.title}`);
}

function candidateRisks(item, evidence, holdingWeight) {
  const risks = (item.flags || []).filter((risk) => !/^No major risk flag/.test(risk));
  if (item.eventRisk?.level === "Medium") risks.unshift("Matched headlines indicate medium event risk; verify the event before acting.");
  if (holdingWeight > 0) risks.unshift(`Already ${holdingWeight.toFixed(1)}% of a tracked currency group; further exposure increases concentration.`);
  if (evidence.some((article) => Number.isFinite(article.sentiment) && article.sentiment < 0)) risks.unshift("Recent direct company coverage includes negative or cautious language.");
  return [...new Set(risks.concat([
    "Single-stock exposure can lose value even when the technical setup is strong.",
    "Headline matching is rule-based; read the original company coverage.",
    "Signal strength is not a calibrated probability or a backtested return forecast."
  ]))].slice(0, 3);
}

function holdingWeights(holdings) {
  const amounts = new Map();
  for (const holding of holdings || []) {
    if (!Number.isFinite(holding.amount) || holding.amount <= 0) continue;
    const ticker = String(holding.ticker || "").toUpperCase();
    amounts.set(ticker, (amounts.get(ticker) || 0) + holding.amount);
  }
  const total = [...amounts.values()].reduce((sum, amount) => sum + amount, 0);
  if (total) return new Map([...amounts].map(([ticker, amount]) => [ticker, amount / total * 100]));
  const grouped = new Map();
  for (const holding of holdings || []) {
    if (!Number.isFinite(holding.weight) || holding.weight <= 0) continue;
    const ticker = String(holding.ticker || "").toUpperCase();
    const key = `${ticker}|${holding.currency || ""}`;
    grouped.set(key, (grouped.get(key) || 0) + holding.weight);
  }
  const weights = new Map();
  for (const [key, weight] of grouped) {
    const ticker = key.split("|")[0];
    weights.set(ticker, Math.max(weights.get(ticker) || 0, weight));
  }
  return weights;
}

function articleTime(value) {
  const text = String(value || "");
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  if (compact) {
    const [, year, month, day, hour, minute, second] = compact.map(Number);
    const time = Date.UTC(year, month - 1, day, hour, minute, second);
    const date = new Date(time);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second ? time : NaN;
  }
  return text ? Date.parse(text) : NaN;
}

function usableUrl(value) {
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
}

function canonicalUrl(value) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  return url.toString();
}
