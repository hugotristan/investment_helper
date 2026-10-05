export const RECOMMENDATION_STORE_KEY = "investment-helper-recommendations-v1";
const MAX_RECORDS = 1000;
const MAX_BYTES = 4 * 1024 * 1024;

export function loadRecommendationJournal(options = {}) {
  try {
    const storage = options.storage ?? globalThis.localStorage;
    if (!storage?.getItem) return failed("Browser storage is unavailable.");
    const raw = storage.getItem(RECOMMENDATION_STORE_KEY);
    if (raw === null || raw === undefined) return { entries: [], ok: true, error: "" };
    if (typeof raw !== "string" || raw.length > MAX_BYTES) return failed("The saved recommendation journal is too large or unreadable.");
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_RECORDS || !parsed.entries.every(validEntry)) {
      return failed("The saved recommendation journal has an unsupported or malformed format. It was left unchanged.");
    }
    const ids = new Set();
    const entries = parsed.entries.filter((entry) => {
      if (ids.has(entry.id)) return false;
      ids.add(entry.id);
      return true;
    });
    return { entries, ok: true, error: "" };
  } catch { return failed("The recommendation journal could not be read. Browser storage may be blocked."); }
}

export function saveRecommendationJournal(entries, options = {}) {
  const existing = loadRecommendationJournal(options);
  if (!existing.ok) return existing;
  if (!Array.isArray(entries) || !entries.every(validEntry)) {
    return { ...existing, ok: false, error: "Invalid recommendation data was not saved." };
  }
  try {
    const byId = new Map(existing.entries.map((entry) => [entry.id, entry]));
    for (const incoming of entries) {
      const original = byId.get(incoming.id);
      // Signal-time fields are immutable. Only observed outcomes may advance;
      // a matured outcome can never be rewritten by later rolling history.
      const outcomes = {};
      for (const horizon of ["5", "21"]) {
        outcomes[horizon] = original?.outcomes?.[horizon]?.status === "matured"
          ? original.outcomes[horizon] : validOutcome(incoming.outcomes[horizon], Number(horizon), original || incoming)
            ? incoming.outcomes[horizon] : original?.outcomes?.[horizon];
      }
      byId.set(incoming.id, original ? { ...original, outcomes } : incoming);
    }
    const merged = [...byId.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.ticker.localeCompare(b.ticker)).slice(-MAX_RECORDS);
    const raw = JSON.stringify({ schemaVersion: 1, entries: merged });
    if (raw.length > MAX_BYTES) return { ...existing, ok: false, error: "The recommendation journal exceeds browser storage limits. Export it before continuing." };
    const storage = options.storage ?? globalThis.localStorage;
    storage.setItem(RECOMMENDATION_STORE_KEY, raw);
    return { entries: JSON.parse(raw).entries, ok: true, error: "" };
  } catch { return { ...existing, ok: false, error: "The recommendation journal could not be saved. Existing records were kept; browser storage may be full or blocked." }; }
}

function validEntry(entry) {
  if (!entry || typeof entry !== "object" || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(entry.ticker || "")
    || !/^\d{4}-\d{2}-\d{2}$/.test(entry.recordedDate || "")) return false;
  const time = Date.parse(entry.recordedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== entry.recordedDate
    || entry.id !== `${entry.ticker}|${entry.recordedDate}` || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 100) return false;
  if (!validBaseline(entry.baseline) || !validBaseline(entry.benchmark) || entry.benchmark.ticker !== "SPY"
    || entry.baseline.currency !== entry.benchmark.currency || entry.currency !== entry.baseline.currency) return false;
  if (Date.parse(entry.baseline.asOf) > time || Date.parse(entry.benchmark.asOf) > time
    || new Date(entry.baseline.asOf).toISOString().slice(0, 10) !== new Date(entry.benchmark.asOf).toISOString().slice(0, 10)) return false;
  if (!Array.isArray(entry.evidence) || entry.evidence.length > 10
    || !entry.evidence.every((article) => article && validText(article.title, 5000) && validText(article.link, 5000))
    || !validTextArray(entry.reasons) || !validTextArray(entry.risks)) return false;
  return ["5", "21"].every((horizon) => validOutcome(entry.outcomes?.[horizon], Number(horizon), entry));
}

function validBaseline(value) {
  return value && Number.isFinite(value.price) && value.price > 0 && /^[A-Z]{3}$/.test(value.currency || "") && Number.isFinite(Date.parse(value.asOf));
}

function validOutcome(outcome, sessions, entry) {
  if (!outcome || !["pending", "unavailable", "matured"].includes(outcome.status) || outcome.sessions !== sessions) return false;
  if (outcome.status !== "matured") return true;
  const asOf = Date.parse(outcome.asOf);
  return ["stockPrice", "benchmarkPrice"].every((key) => Number.isFinite(outcome[key]) && outcome[key] > 0)
    && ["stockReturn", "benchmarkReturn", "excessReturn"].every((key) => Number.isFinite(outcome[key]))
    && Number.isFinite(asOf) && new Date(asOf).toISOString().slice(0, 10) > entry.recordedDate
    && asOf > Date.parse(entry.recordedAt) && Number.isFinite(Date.parse(outcome.observedAt)) && Date.parse(outcome.observedAt) >= asOf
    && Math.abs(outcome.stockReturn - (outcome.stockPrice / entry.baseline.price - 1)) < 1e-10
    && Math.abs(outcome.benchmarkReturn - (outcome.benchmarkPrice / entry.benchmark.price - 1)) < 1e-10
    && Math.abs(outcome.excessReturn - (outcome.stockReturn - outcome.benchmarkReturn)) < 1e-10;
}

function validTextArray(value) { return Array.isArray(value) && value.length <= 20 && value.every((text) => validText(text, 5000)); }
function validText(value, max) { return typeof value === "string" && value.length <= max; }

function failed(error) { return { entries: [], ok: false, error }; }
