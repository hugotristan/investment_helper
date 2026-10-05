import { evaluateDataQuality, hasQualifiedSignal, isEtfSeries, validHistoryPoints } from "./data-quality.js";

const DAY_MS = 86400000;
const WINDOWS = [5, 21];
const MAX_ENTRIES = 1000;

// The journal records observations prospectively. Baselines are daily-series
// prices visible at recording, not trade fills or a reconstructed backtest.
export function recordRecommendations(journal, candidates, results, {
  now = Date.now(), complete = false, fresh = false
} = {}) {
  const entries = cleanJournal(journal, now);
  if (!complete || !fresh) return entries;
  const byTicker = resultMap(results);
  const benchmark = dailyHistory(byTicker.get("SPY"), now);
  if (!benchmark.ok) return entries;
  const seen = new Set(entries.map((entry) => entry.id));
  const recordedAt = new Date(now).toISOString();
  const recordedDate = recordedAt.slice(0, 10);
  for (const candidate of candidates || []) {
    if (!candidate || !hasQualifiedSignal(candidate) || candidate.score < 65
      || candidate.isFund || isEtfSeries(candidate)) continue;
    const ticker = String(candidate.ticker || "").toUpperCase();
    const id = `${ticker}|${recordedDate}`;
    if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) || ticker === "SPY" || seen.has(id)) continue;
    const stock = dailyHistory(byTicker.get(ticker), now);
    if (!stock.ok || stock.currency !== benchmark.currency) continue;
    const point = stock.points.at(-1);
    const comparison = benchmark.points.at(-1);
    if (point.day !== comparison.day) continue;
    const evidence = copyJson(candidate.evidence, []);
    if (!Array.isArray(evidence) || !evidence.length) continue;
    const entry = {
      id, ticker, name: String(candidate.name || ticker), recordedAt, recordedDate,
      currency: stock.currency,
      baseline: { price: point.close, asOf: point.date, currency: stock.currency },
      benchmark: { ticker: "SPY", price: comparison.close, asOf: comparison.date, currency: benchmark.currency },
      score: candidate.score,
      signal: String(candidate.setup?.signal || candidate.label || "Research signal"),
      evidence: evidence.slice(0, 5),
      reasons: stringArray(candidate.reasons), risks: stringArray(candidate.risks),
      horizon: String(candidate.horizon || candidate.setup?.timeframe || ""),
      invalidation: Number.isFinite(candidate.invalidation) ? candidate.invalidation : null,
      outcomes: Object.fromEntries(WINDOWS.map((sessions) => [sessions, emptyOutcome(sessions, "pending", "Waiting for later matched daily sessions.")]))
    };
    entries.push(entry);
    seen.add(id);
  }
  return sortAndBound(entries);
}

export function observeRecommendations(journal, results, { now = Date.now() } = {}) {
  const byTicker = resultMap(results);
  const benchmarkItem = byTicker.get("SPY");
  const benchmark = dailyHistory(benchmarkItem, now);
  const today = new Date(now).toISOString().slice(0, 10);
  const entries = cleanJournal(journal, now).map((entry) => {
    const item = byTicker.get(entry.ticker);
    const stock = dailyHistory(item, now);
    const outcomes = {};
    for (const sessions of WINDOWS) {
      const previous = entry.outcomes?.[sessions];
      if (validMatureOutcome(previous, entry, sessions, now)) {
        outcomes[sessions] = previous;
        continue;
      }
      const blocked = !stock.ok ? stock.reason : !benchmark.ok ? benchmark.reason
        : stock.currency !== entry.currency || benchmark.currency !== entry.currency
          ? "Current stock and SPY currencies no longer match the recorded baseline."
          : stock.points[0].day > entry.recordedDate || benchmark.points[0].day > entry.recordedDate
            ? "History no longer covers the start of tracking; the original session horizon cannot be reconstructed." : null;
      if (blocked) {
        outcomes[sessions] = emptyOutcome(sessions, "unavailable", blocked);
        continue;
      }
      const benchmarkDays = new Map(benchmark.points.map((point) => [point.day, point]));
      const recordedTime = Date.parse(entry.recordedAt);
      const matched = stock.points.filter((point) => {
        const comparison = benchmarkDays.get(point.day);
        return comparison && point.day > entry.recordedDate && point.day < today
          && Date.parse(point.date) > recordedTime && Date.parse(comparison.date) > recordedTime;
      });
      const splitLimit = matched[Math.min(sessions, matched.length) - 1]?.day;
      const splitReason = splitLimit && (splitAfterBaseline(item, entry.baseline.asOf, splitLimit)
        || splitAfterBaseline(benchmarkItem, entry.benchmark.asOf, splitLimit));
      if (splitReason) {
        outcomes[sessions] = emptyOutcome(sessions, "unavailable", splitReason, Math.min(matched.length, sessions));
        continue;
      }
      if (matched.length < sessions) {
        outcomes[sessions] = emptyOutcome(sessions, "pending", `Waiting for ${sessions} matched settled sessions; ${matched.length} are available.`, matched.length);
        continue;
      }
      const point = matched[sessions - 1];
      const comparison = benchmarkDays.get(point.day);
      const stockReturn = point.close / entry.baseline.price - 1;
      const benchmarkReturn = comparison.close / entry.benchmark.price - 1;
      if (![stockReturn, benchmarkReturn, stockReturn - benchmarkReturn].every(Number.isFinite)) {
        outcomes[sessions] = emptyOutcome(sessions, "unavailable", "Price return exceeds the supported numeric range.", sessions);
        continue;
      }
      outcomes[sessions] = {
        status: "matured", reason: null, sessions, observedSessions: sessions,
        observedAt: new Date(now).toISOString(), asOf: point.date, sessionDate: point.day,
        stockPrice: point.close, benchmarkPrice: comparison.close,
        stockReturn, benchmarkReturn, excessReturn: stockReturn - benchmarkReturn
      };
    }
    return { ...entry, outcomes };
  });
  const summary = { recorded: entries.length };
  for (const sessions of WINDOWS) {
    const matured = entries.map((entry) => entry.outcomes[sessions]).filter((outcome) => outcome.status === "matured");
    summary[`matured${sessions}`] = matured.length;
    summary[`averageExcess${sessions}`] = matured.length ? matured.reduce((sum, outcome) => sum + outcome.excessReturn, 0) / matured.length : null;
    summary[`outperformanceRate${sessions}`] = matured.length ? matured.filter((outcome) => outcome.excessReturn > 0).length / matured.length : null;
  }
  return { entries, summary };
}

function dailyHistory(item, now) {
  const fail = (reason) => ({ ok: false, reason });
  if (!item) return fail("Stock or SPY daily history is unavailable.");
  if (!item.currency) return fail("Daily price currency is unavailable.");
  let points = validHistoryPoints(item).map((point) => ({ ...point }));
  const last = points.at(-1);
  if (!last) return fail("Stock or SPY daily history is unavailable.");
  const overlay = /\+\s*Yahoo intraday\b/i.test(String(item.source || ""));
  if (overlay || item.dailyClose) {
    const snapshot = item.dailyClose;
    const time = timestamp(snapshot?.asOf);
    if (!snapshot || snapshot.currency !== item.currency || !Number.isFinite(snapshot.price) || snapshot.price <= 0
      || !Number.isFinite(time) || time > now || time !== timestamp(last.date)) {
      return fail("The original daily price before the intraday quote update is unavailable.");
    }
    points[points.length - 1] = { ...last, close: snapshot.price, date: new Date(time) };
  }
  if (points.some((point) => timestamp(point.date) > now)) return fail("Future-dated daily prices cannot be observed.");
  const quality = evaluateDataQuality({ ...item, prices: points }, now);
  if (!quality.eligible) return fail(quality.reason);
  if (timestamp(quality.asOf) !== timestamp(points.at(-1).date)) return fail("Daily history timestamps are inconsistent.");
  points = points.map((point) => ({ date: new Date(point.date).toISOString(), day: new Date(point.date).toISOString().slice(0, 10), close: point.close }));
  return { ok: true, currency: item.currency, points };
}

function splitAfterBaseline(item, baselineAsOf, endDay) {
  const baselineDay = baselineAsOf.slice(0, 10);
  const splitEvents = Array.isArray(item?.splits) ? item.splits.map((event) => [null, event])
    : Object.entries(item?.splits || {});
  for (const [key, event] of splitEvents) {
    const time = timestamp(event?.date ?? event?.asOf ?? key);
    if (!Number.isFinite(time)) return "Split event timing is unavailable; price returns cannot be compared safely.";
    const day = new Date(time).toISOString().slice(0, 10);
    if (day > baselineDay && day <= endDay) return "A stock or SPY split occurred after the baseline; unadjusted price returns are unavailable.";
  }
  return null;
}

function cleanJournal(journal, now) {
  const seen = new Set();
  const entries = [];
  for (const entry of Array.isArray(journal) ? journal : []) {
    const time = timestamp(entry?.recordedAt);
    if (!Number.isFinite(time) || time > now || typeof entry.ticker !== "string"
      || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(entry.ticker)
      || entry.recordedDate !== new Date(time).toISOString().slice(0, 10)
      || entry.id !== `${entry.ticker}|${entry.recordedDate}` || seen.has(entry.id)
      || !validBaseline(entry.baseline, entry.currency, time)
      || !validBaseline(entry.benchmark, entry.currency, time) || entry.benchmark.ticker !== "SPY"
      || entry.baseline.asOf.slice(0, 10) !== entry.benchmark.asOf.slice(0, 10)) continue;
    const cloned = copyJson(entry, null);
    if (!cloned) continue;
    seen.add(entry.id);
    entries.push(cloned);
  }
  return sortAndBound(entries);
}

function validBaseline(baseline, currency, recordedTime) {
  const time = timestamp(baseline?.asOf);
  return typeof baseline?.asOf === "string" && typeof currency === "string" && Boolean(currency)
    && baseline.currency === currency && Number.isFinite(baseline.price) && baseline.price > 0
    && Number.isFinite(time) && time <= recordedTime && recordedTime - time <= 7 * DAY_MS;
}

function validMatureOutcome(outcome, entry, sessions, now) {
  const time = timestamp(outcome?.asOf);
  const observedTime = timestamp(outcome?.observedAt);
  return outcome?.status === "matured" && outcome.sessions === sessions
    && Number.isFinite(outcome.stockPrice) && outcome.stockPrice > 0
    && Number.isFinite(outcome.benchmarkPrice) && outcome.benchmarkPrice > 0
    && Number.isFinite(outcome.stockReturn) && Number.isFinite(outcome.benchmarkReturn) && Number.isFinite(outcome.excessReturn)
    && Math.abs(outcome.stockReturn - (outcome.stockPrice / entry.baseline.price - 1)) < 1e-10
    && Math.abs(outcome.benchmarkReturn - (outcome.benchmarkPrice / entry.benchmark.price - 1)) < 1e-10
    && Math.abs(outcome.excessReturn - (outcome.stockReturn - outcome.benchmarkReturn)) < 1e-10
    && Number.isFinite(time) && time > timestamp(entry.recordedAt)
    && Number.isFinite(observedTime) && observedTime >= time && observedTime <= now
    && new Date(time).toISOString().slice(0, 10) > entry.recordedDate
    && new Date(time).toISOString().slice(0, 10) < new Date(now).toISOString().slice(0, 10);
}

function emptyOutcome(sessions, status, reason, observedSessions = 0) {
  return { status, reason, sessions, observedSessions, observedAt: null, asOf: null,
    stockPrice: null, benchmarkPrice: null, stockReturn: null, benchmarkReturn: null, excessReturn: null };
}

function resultMap(results) {
  return new Map((results || []).filter(Boolean).map((item) => [String(item.ticker || "").toUpperCase(), item]));
}

function sortAndBound(entries) {
  return entries.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id)).slice(-MAX_ENTRIES);
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 10) : [];
}

function copyJson(value, fallback) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; }
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const number = Number(value);
    return number < 1e12 ? number * 1000 : number;
  }
  return new Date(value).getTime();
}
