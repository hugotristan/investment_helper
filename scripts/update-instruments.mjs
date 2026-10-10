import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { INSTRUMENT_SOURCE, INSTRUMENT_SOURCE_URL, INSTRUMENT_MAX_ENTRIES, normalizeInstrumentCatalog } from "../js/data/ticker-search.js";
import { isBlockedAssetTicker } from "../js/shared/symbols.js";

const DEFAULT_OUTPUT = fileURLToPath(new URL("../data/instruments.json", import.meta.url));
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const REQUIRED_COLUMNS = ["Nasdaq Traded", "Symbol", "Security Name", "Listing Exchange", "ETF", "Test Issue"];

export function directoryTicker(symbol) {
  const ticker = String(symbol || "").trim().toUpperCase();
  // Yahoo uses a dash for US share classes (BRK.B -> BRK-B). Directory
  // preferred, warrant and unit suffixes are excluded by security type below.
  const canonical = /^[A-Z]{1,6}(?:\.[A-Z]{1,2})?$/.test(ticker) ? ticker.replaceAll(".", "-") : null;
  return canonical && !isBlockedAssetTicker(canonical) ? canonical : null;
}

export function parseInstrumentDirectory(text, { now = Date.now() } = {}) {
  if (typeof text !== "string" || text.length > 8 * 1024 * 1024) return null;
  const lines = text.trim().split(/\r?\n/);
  const columns = lines[0]?.split("|");
  if (!columns || REQUIRED_COLUMNS.some((column) => !columns.includes(column))) return null;
  const footer = lines.at(-1)?.match(/^File Creation Time: (\d{10}:\d{2})(?:\|.*)?$/);
  if (!footer || lines.length < 3 || lines.length > INSTRUMENT_MAX_ENTRIES + 2) return null;
  const sourceDate = footer[1];
  const year = Number(sourceDate.slice(4, 8)), month = Number(sourceDate.slice(0, 2)), date = Number(sourceDate.slice(2, 4));
  const parsedDate = new Date(Date.UTC(year, month - 1, date));
  if (parsedDate.getUTCFullYear() !== year || parsedDate.getUTCMonth() + 1 !== month || parsedDate.getUTCDate() !== date
    || Number(sourceDate.slice(8, 10)) > 23 || Number(sourceDate.slice(11)) > 59) return null;
  const entries = new Map();
  for (const line of lines.slice(1, -1)) {
    const values = line.split("|");
    if (values.length !== columns.length) return null;
    const row = Object.fromEntries(columns.map((name, index) => [name, values[index].trim()]));
    if (row["Nasdaq Traded"] !== "Y" || row["Test Issue"] !== "N" || !["Y", "N"].includes(row.ETF)) continue;
    const ticker = directoryTicker(row.Symbol), label = row["Security Name"];
    if (!ticker || !label || label.length > 300 || !/^[A-Z]$/.test(row["Listing Exchange"])) continue;
    const isEtf = row.ETF === "Y";
    if (/\b(?:exchange[- ]traded notes?|ETNs?)\b/i.test(label)) continue;
    if (!isEtf && (/\b(?:warrants?|units?|rights|preferred|preference|debentures?|bonds?|notes?)\b/i.test(label)
      || !/\b(?:common stock|ordinary shares?|common shares?|capital stock|depositary shares?|depositary receipts?|(?:new york )?registry shares?|registered shares?|shares of beneficial interest)\b/i.test(label))) continue;
    const short = label.replace(/\s+-\s+.*$/, "").replace(/\s+(?:Class [A-Z] )?(?:New )?(?:Common|Ordinary|Capital) (?:Stock|Shares?)\b.*$/i, "")
      .replace(/\s+(?:American )?Depositary (?:Shares?|Receipts?)\b.*$/i, "").trim();
    const company = short.replace(/\s*\(The\)\s*$/i, "").replace(/[, .]+$/, "").replace(/[,.]+(?=\s|$)/g, "")
      .replace(/(?:\s+(?:Incorporated|Corporation|Company|Limited|Holdings|Technologies|Technology|Systems|Inc\.?|Corp\.?|plc|Ltd\.?|Co\.?|N\.?V\.?|S\.?A\.?|AG))+$/i, "").trim();
    const aliases = [...new Set([row.Symbol !== ticker ? row.Symbol : null, short, company].filter((alias) => alias && alias !== label))];
    if (entries.has(ticker)) return null;
    entries.set(ticker, { ticker, label, type: isEtf ? "ETF" : "stock", exchange: row["Listing Exchange"], aliases });
  }
  return normalizeInstrumentCatalog({ schemaVersion: 1, source: INSTRUMENT_SOURCE, sourceUrl: INSTRUMENT_SOURCE_URL,
    sourceAsOf: sourceDate, generatedAt: new Date(now).toISOString(), entries: [...entries.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)) }, { now });
}

export async function updateInstrumentSnapshot({ fetchImpl = globalThis.fetch, previous = null, now,
  timeoutMs = 15000, maxRetries = 1, minimumEntries = 3000, wait = sleep } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 1
    || !Number.isInteger(minimumEntries) || minimumEntries < 1 || minimumEntries > INSTRUMENT_MAX_ENTRIES) throw new TypeError("Invalid symbol-directory refresh bounds.");
  const clock = () => now === undefined ? Date.now() : now;
  let reason = "The Nasdaq symbol directory could not be retrieved.", attempts = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    attempts += 1;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryable = true, delay = 1000;
    try {
      const response = await fetchImpl(INSTRUMENT_SOURCE_URL, { headers: { Accept: "text/plain" }, signal: controller.signal });
      if (!response.ok) {
        reason = `The Nasdaq symbol directory returned HTTP ${response.status}.`;
        retryable = response.status === 429 || response.status >= 500 && response.status <= 599;
        const seconds = Number(response.headers?.get?.("retry-after"));
        if (seconds > 0) delay = Math.min(5000, Math.max(1000, seconds * 1000));
      } else {
        const snapshot = parseInstrumentDirectory(await response.text(), { now: clock() });
        if (snapshot && snapshot.entries.length >= minimumEntries) return { snapshot, status: "updated", retained: false, available: true, reason: null, attempts, count: snapshot.entries.length };
        reason = "The Nasdaq symbol directory has invalid or incomplete stock and ETF coverage.";
        retryable = false;
      }
    } catch (error) {
      reason = error?.name === "AbortError" ? "The Nasdaq symbol directory request timed out." : "The Nasdaq symbol directory request failed.";
    } finally { clearTimeout(timer); }
    if (!retryable || attempt >= maxRetries) break;
    await wait(delay);
  }
  const retained = normalizeInstrumentCatalog(previous, { now: clock() });
  const snapshot = retained || { schemaVersion: 1, available: false, source: INSTRUMENT_SOURCE, sourceUrl: INSTRUMENT_SOURCE_URL, generatedAt: null, sourceAsOf: null, entries: [], reason };
  return { snapshot, status: retained ? "retained" : "unavailable", retained: !!retained, available: !!retained, reason, attempts, count: retained?.entries.length || 0 };
}

export async function runInstrumentUpdate({ outputPath = DEFAULT_OUTPUT, ...options } = {}) {
  let previous = null;
  try { previous = JSON.parse(await readFile(outputPath, "utf8")); } catch { /* No dated fallback available. */ }
  const result = await updateInstrumentSnapshot({ ...options, previous });
  if (!result.retained) {
    await mkdir(dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
    try { await writeFile(temporary, `${JSON.stringify(result.snapshot)}\n`, "utf8"); await rename(temporary, outputPath); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const { snapshot, ...diagnostics } = await runInstrumentUpdate(); console.log(JSON.stringify(diagnostics)); }
  catch (error) { console.warn(JSON.stringify({ status: "publish_failed", reason: error?.message || "The symbol directory could not be published." })); }
}
