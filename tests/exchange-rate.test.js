import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EXCHANGE_RATE_SOURCE, EXCHANGE_RATE_SOURCE_URL, EXCHANGE_RATE_MAX_AGE_MS,
  normalizeExchangeRate, loadExchangeRate, getExchangeRate } from "../js/data/exchange-rate.js";
import { buildExchangeRateSnapshot, updateExchangeRateSnapshot, runExchangeRateUpdate } from "../scripts/update-exchange-rate.mjs";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const raw = (overrides = {}) => ({ date: "2026-10-08", base: "USD", quote: "EUR", rate: 0.875, ...overrides });
const snapshot = (overrides = {}) => ({ schemaVersion: 1, available: true, ...raw(), source: EXCHANGE_RATE_SOURCE,
  sourceUrl: EXCHANGE_RATE_SOURCE_URL, retrievedAt: "2026-10-08T17:00:00.000Z", ...overrides });
const response = (payload) => ({ ok: true, status: 200, json: async () => payload });

test("normalizer preserves the actual dated USD-to-EUR reference rate and provenance without mutating input", () => {
  const input = snapshot();
  const normalized = normalizeExchangeRate(input, { now: NOW });
  assert.deepEqual(normalized, input);
  normalized.rate = 10;
  assert.equal(input.rate, 0.875);
  assert.equal(normalizeExchangeRate({ ...input, available: undefined }, { now: NOW }), null);
  const withoutAvailable = { ...input }; delete withoutAvailable.available;
  assert.equal(normalizeExchangeRate(withoutAvailable, { now: NOW }).available, true);
});

test("normalizer rejects wrong direction, fabricated/missing metadata and nonfinite or nonpositive rates", () => {
  for (const changes of [
    { schemaVersion: 2 }, { available: false }, { available: "true" }, { base: "EUR", quote: "USD" },
    { base: "usd" }, { quote: "GBP" }, { rate: 0 }, { rate: -0.9 }, { rate: Infinity }, { rate: NaN },
    { rate: "0.875" }, { rate: undefined }, { source: "Estimated" }, { source: null },
    { sourceUrl: "https://unrelated.example/rate" }, { sourceUrl: "javascript:alert(1)" }, { retrievedAt: null }
  ]) assert.equal(normalizeExchangeRate(snapshot(changes), { now: NOW }), null, JSON.stringify(changes));
  for (const input of [null, [], {}, "0.875"]) assert.equal(normalizeExchangeRate(input, { now: NOW }), null);
});

test("calendar validity, future timestamps, acquisition chronology and seven-day freshness are strict", () => {
  for (const changes of [
    { date: "2026-02-29" }, { date: "2026-09-31" }, { date: "2026-10-10" }, { date: "2026-10-8" },
    { date: "2026-10-01", retrievedAt: "2026-10-09T12:00:00.000Z" },
    { retrievedAt: "2026-10-09T12:00:00.001Z" }, { retrievedAt: "2026-10-07T17:00:00.000Z" },
    { retrievedAt: "2026-02-30T12:00:00.000Z" }, { retrievedAt: "2026-10-08T24:00:00Z" },
    { retrievedAt: "2026-10-08" }, { retrievedAt: "2026-10-08T17:00:00+00:00" }
  ]) assert.equal(normalizeExchangeRate(snapshot(changes), { now: NOW }), null, JSON.stringify(changes));
  const boundary = Date.parse("2026-10-09T00:00:00.000Z");
  const weekOld = snapshot({ date: "2026-10-02", retrievedAt: "2026-10-02T17:00:00.000Z" });
  assert.ok(normalizeExchangeRate(weekOld, { now: boundary }));
  assert.equal(boundary - Date.parse(weekOld.date), EXCHANGE_RATE_MAX_AGE_MS);
  assert.equal(normalizeExchangeRate(weekOld, { now: boundary + 1 }), null);
  assert.equal(normalizeExchangeRate(snapshot(), { now: NaN }), null);
});

test("publisher accepts the provider's explicit pair without inventing or inverting rates", () => {
  const built = buildExchangeRateSnapshot(raw(), { now: NOW });
  assert.deepEqual(built, snapshot({ retrievedAt: new Date(NOW).toISOString() }));
  assert.equal(buildExchangeRateSnapshot(raw({ base: "EUR", quote: "USD" }), { now: NOW }), null);
  assert.equal(buildExchangeRateSnapshot(raw({ rate: undefined }), { now: NOW }), null);
  assert.equal(buildExchangeRateSnapshot(raw({ date: "2026-10-10" }), { now: NOW }), null);
  assert.equal(buildExchangeRateSnapshot(raw({ date: "2026-09-30" }), { now: NOW }), null);
});

test("fetcher calls only the ECB provider route and publishes its real date and retrieval time", async () => {
  const calls = [];
  const result = await updateExchangeRateSnapshot({ now: NOW, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return response(raw());
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, EXCHANGE_RATE_SOURCE_URL);
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(result.available, true);
  assert.equal(result.retained, false);
  assert.equal(result.snapshot.date, "2026-10-08");
  assert.equal(result.snapshot.retrievedAt, new Date(NOW).toISOString());
});

test("default publisher clock stamps successful acquisition after the response arrives", async () => {
  const originalNow = Date.now;
  let clock = NOW;
  Date.now = () => clock;
  try {
    const result = await updateExchangeRateSnapshot({ fetchImpl: async () => {
      clock += 1000;
      return response(raw());
    } });
    assert.equal(result.snapshot.retrievedAt, new Date(NOW + 1000).toISOString());
  } finally { Date.now = originalNow; }
});

test("HTTP429/5xx and network failures get one bounded retry; malformed data and HTTP4xx do not", async () => {
  for (const failure of [
    async () => ({ ok: false, status: 429, headers: { get: () => "30" } }),
    async () => ({ ok: false, status: 503 }),
    async () => { throw new TypeError("network unavailable"); }
  ]) {
    let count = 0; const waits = [];
    const result = await updateExchangeRateSnapshot({ now: NOW, wait: async (duration) => waits.push(duration),
      fetchImpl: async () => ++count === 1 ? failure() : response(raw()) });
    assert.equal(result.available, true);
    assert.equal(count, 2);
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 1000 && waits[0] <= 5000);
  }
  for (const failed of [
    () => ({ ok: false, status: 403 }), () => response(raw({ base: "EUR", quote: "USD" })),
    () => ({ ok: true, json: async () => { throw new SyntaxError("broken JSON"); } })
  ]) {
    let count = 0;
    const result = await updateExchangeRateSnapshot({ now: NOW, fetchImpl: async () => { count += 1; return failed(); },
      wait: async () => assert.fail("An invalid successful payload or HTTP403 must not retry") });
    assert.equal(count, 1);
    assert.equal(result.available, false);
    assert.equal(result.snapshot.rate, null);
  }
});

test("outage retention keeps original rate/date/retrieval metadata and never refreshes an expired prior rate", async () => {
  const previous = snapshot();
  const retained = await updateExchangeRateSnapshot({ previous, now: NOW, maxRetries: 0,
    fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(retained.retained, true);
  assert.deepEqual(retained.snapshot, previous);
  const expired = await updateExchangeRateSnapshot({ previous: snapshot({ date: "2026-10-01", retrievedAt: "2026-10-01T17:00:00.000Z" }),
    now: NOW, maxRetries: 0, fetchImpl: async () => response(raw({ rate: -1 })) });
  assert.equal(expired.available, false);
  assert.equal(expired.retained, false);
  assert.equal(expired.snapshot.rate, null);
  assert.equal(expired.snapshot.date, null);
  assert.equal(expired.snapshot.retrievedAt, null);
  assert.equal(normalizeExchangeRate(expired.snapshot, { now: NOW }), null);
  assert.deepEqual(previous, snapshot());
});

test("timeout aborts its request and returns an honest unavailable result rather than blocking price publishing", async () => {
  const result = await updateExchangeRateSnapshot({ now: NOW, timeoutMs: 5, maxRetries: 0,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
    }) });
  assert.equal(result.available, false);
  assert.match(result.reason, /timed out/);
});

async function temporaryOutput(t) {
  const directory = await mkdtemp(join(tmpdir(), "investment-helper-fx-"));
  const outputPath = join(directory, "exchange-rate.json");
  t.after(async () => { await unlink(outputPath).catch(() => {}); await rmdir(directory).catch(() => {}); });
  return { directory, outputPath };
}

test("atomic publication replaces the snapshot cleanly and leaves no temporary files", async (t) => {
  const { outputPath, directory } = await temporaryOutput(t);
  await writeFile(outputPath, "malformed prior JSON", "utf8");
  const result = await runExchangeRateUpdate({ outputPath, now: NOW, fetchImpl: async () => response(raw()) });
  assert.equal(result.available, true);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), result.snapshot);
  assert.deepEqual(await readdir(directory), ["exchange-rate.json"]);
});

test("publisher outage leaves a qualified previous file byte-for-byte unchanged and writes unavailable for stale data", async (t) => {
  const { outputPath } = await temporaryOutput(t);
  const previousText = `${JSON.stringify(snapshot(), null, 2)}\n`;
  await writeFile(outputPath, previousText, "utf8");
  const before = await stat(outputPath);
  const options = { outputPath, now: NOW, maxRetries: 0, fetchImpl: async () => ({ ok: false, status: 503 }) };
  const retained = await runExchangeRateUpdate(options);
  assert.equal(retained.retained, true);
  assert.equal(await readFile(outputPath, "utf8"), previousText);
  assert.equal((await stat(outputPath)).mtimeMs, before.mtimeMs);
  await writeFile(outputPath, JSON.stringify(snapshot({ date: "2026-09-30", retrievedAt: "2026-09-30T17:00:00.000Z" })), "utf8");
  const unavailable = await runExchangeRateUpdate(options);
  assert.equal(unavailable.available, false);
  const saved = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(saved.available, false);
  assert.equal(saved.rate, null);
  assert.equal(saved.date, null);
  assert.equal(saved.retrievedAt, null);
});

test("browser loads one same-origin snapshot, rechecks freshness and survives unavailable refreshes", async () => {
  const originalFetch = globalThis.fetch; const originalNow = Date.now;
  let clock = NOW; let calls = 0;
  Date.now = () => clock;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    assert.equal(String(url), new URL("../data/exchange-rate.json", import.meta.url).href);
    assert.equal(options.credentials, "same-origin");
    return response(snapshot());
  };
  try {
    const [first, second] = await Promise.all([loadExchangeRate(), loadExchangeRate()]);
    assert.equal(calls, 1);
    assert.deepEqual(first, second);
    first.rate = 999;
    assert.equal(getExchangeRate().rate, 0.875);
    assert.equal(getExchangeRate({ now: NOW + 8 * 86400000 }), null);
    clock += 10 * 60 * 1000;
    globalThis.fetch = async () => { calls += 1; throw new TypeError("offline"); };
    assert.equal((await loadExchangeRate()).retrievedAt, snapshot().retrievedAt);
    assert.equal(calls, 2);
    clock += 10 * 60 * 1000;
    globalThis.fetch = async () => { calls += 1; return response({ schemaVersion: 1, available: false, rate: null }); };
    assert.equal(await loadExchangeRate(), null);
    assert.equal(getExchangeRate(), null);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});
