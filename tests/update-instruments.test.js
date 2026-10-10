import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryTicker, parseInstrumentDirectory, updateInstrumentSnapshot, runInstrumentUpdate } from "../scripts/update-instruments.mjs";

const now = Date.parse("2026-10-10T10:00:00.000Z");
const header = "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares";
const row = (symbol, name, { etf = "N", test = "N", traded = "Y", exchange = "Q" } = {}) => `${traded}|${symbol}|${name}|${exchange}|G|${etf}|100|${test}|N||${symbol}|N`;
const directory = (rows) => [header, ...rows, "File Creation Time: 1009202621:32|||||"].join("\r\n");
const good = directory([
  row("SNDK", "SanDisk Corporation - Common Stock"),
  row("WDC", "Western Digital Corporation - Common Stock"),
  row("ASML", "ASML Holding N.V. - New York Registry Shares"),
  row("BRK.B", "Berkshire Hathaway Inc. Class B Common Stock", { exchange: "N" }),
  row("SPY", "SPDR S&P 500 ETF Trust", { etf: "Y", exchange: "P" }),
  row("BND", "Vanguard Total Bond Market ETF", { etf: "Y", exchange: "P" }),
  row("STX", "Seagate Technology Holdings PLC - Ordinary Shares (Ireland)"),
  row("CSCO", "Cisco Systems, Inc. - Common Stock"),
  row("KO", "Coca-Cola Company (The) Common Stock"),
  row("ARM", "Arm Holdings plc - American Depositary Shares")
]);
const previous = parseInstrumentDirectory(good, { now });

test("directory includes common stocks, ADRs and ETFs with canonical US share-class symbols", () => {
  assert.equal(previous.entries.length, 10);
  assert.equal(previous.sourceAsOf, "1009202621:32");
  assert.equal(previous.generatedAt, new Date(now).toISOString());
  assert.equal(previous.entries.find(({ ticker }) => ticker === "ASML").type, "stock");
  assert.equal(previous.entries.find(({ ticker }) => ticker === "BND").type, "ETF");
  assert.ok(previous.entries.find(({ ticker }) => ticker === "BRK-B").aliases.includes("BRK.B"));
  assert.ok(previous.entries.find(({ ticker }) => ticker === "SNDK").aliases.includes("SanDisk"));
  assert.ok(previous.entries.find(({ ticker }) => ticker === "STX").aliases.includes("Seagate"));
  assert.ok(previous.entries.find(({ ticker }) => ticker === "CSCO").aliases.includes("Cisco"));
  assert.ok(previous.entries.find(({ ticker }) => ticker === "KO").aliases.includes("Coca-Cola"));
  assert.equal(directoryTicker("BRK.B"), "BRK-B");
  assert.equal(directoryTicker("SNDK"), "SNDK");
  assert.equal(directoryTicker("ABC$A"), null);
  assert.equal(directoryTicker("<script>"), null);
});

test("directory excludes test issues and securities outside ordinary stocks/ETFs", () => {
  const catalog = parseInstrumentDirectory(directory([
    row("SNDK", "SanDisk Corporation - Common Stock"),
    row("TEST", "Testing Inc Common Stock", { test: "Y" }),
    row("NOPE", "No Nasdaq Corp Common Stock", { traded: "N" }),
    row("UNIT", "Acquisition Corp Units"), row("RIGH", "Acquisition Corp Rights"),
    row("WARR", "Acquisition Corp Warrant"), row("PREF", "Issuer Preferred Stock"),
    row("DEBT", "Issuer Senior Notes"), row("ETNO", "Exchange Traded Notes", { etf: "Y" }),
    row("BTC", "Bitcoin Trust", { etf: "Y" }), row("BAD", "Unknown investment certificate")
  ]), { now });
  assert.deepEqual(catalog.entries.map(({ ticker }) => ticker), ["SNDK"]);
});

test("directory rejects truncated responses, duplicate identities and invalid creation dates", () => {
  assert.equal(parseInstrumentDirectory(good.replace(header, "unexpected|header"), { now }), null);
  assert.equal(parseInstrumentDirectory(good.split("\r\n").slice(0, -1).join("\r\n"), { now }), null);
  assert.equal(parseInstrumentDirectory(good.replace("1009202621:32", "0230202621:32"), { now }), null);
  assert.equal(parseInstrumentDirectory(good.replace("1009202621:32", "1009202625:32"), { now }), null);
  assert.equal(parseInstrumentDirectory(directory([row("AAA", "Acme Common Stock"), row("AAA", "Acme Common Stock")]), { now }), null);
  assert.equal(parseInstrumentDirectory(good.replace("G|N|100|N|N||SNDK|N", "G|N"), { now }), null);
});

test("successful directory refresh reports source coverage without touching scan universe", async () => {
  let calls = 0;
  const result = await updateInstrumentSnapshot({ fetchImpl: async (url, options) => {
    calls += 1; assert.match(url, /nasdaqtrader\.com\/dynamic\/SymDir\/nasdaqtraded\.txt$/);
    assert.equal(options.headers.Accept, "text/plain"); assert.ok(options.signal);
    return { ok: true, text: async () => good };
  }, now, minimumEntries: 1 });
  assert.equal(calls, 1);
  assert.equal(result.status, "updated"); assert.equal(result.count, 10);
  assert.deepEqual(result.snapshot, previous);
});

test("HTTP failure and suspiciously small coverage retain original dated snapshot", async () => {
  for (const response of [{ ok: false, status: 403 }, { ok: true, text: async () => good }]) {
    let calls = 0;
    const result = await updateInstrumentSnapshot({ fetchImpl: async () => { calls += 1; return response; }, previous, now: now + 86400000, wait: async () => {} });
    assert.equal(calls, 1); assert.equal(result.status, "retained");
    assert.deepEqual(result.snapshot, previous);
    assert.equal(result.snapshot.generatedAt, previous.generatedAt);
  }
});

test("transient failures have one bounded retry, permanent failures never retry", async () => {
  const delays = []; let calls = 0;
  const result = await updateInstrumentSnapshot({ fetchImpl: async () => {
    calls += 1; return calls === 1 ? { ok: false, status: 429, headers: { get: () => "999" } } : { ok: true, text: async () => good };
  }, now, minimumEntries: 1, wait: async (delay) => { delays.push(delay); } });
  assert.equal(calls, 2); assert.deepEqual(delays, [5000]); assert.equal(result.status, "updated");
  let aborted = false;
  const timeout = await updateInstrumentSnapshot({ now, maxRetries: 0, timeoutMs: 1, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; const error = new Error("timeout"); error.name = "AbortError"; reject(error); });
  }) });
  assert.equal(aborted, true); assert.equal(timeout.status, "unavailable"); assert.match(timeout.reason, /timed out/);
  await assert.rejects(updateInstrumentSnapshot({ maxRetries: 2 }), TypeError);
});

test("publication writes fresh data atomically and leaves retained file bytes unchanged", async () => {
  const folder = await mkdtemp(join(tmpdir(), "instrument-publisher-")), outputPath = join(folder, "instruments.json");
  try {
    const bytes = `${JSON.stringify(previous, null, 2)}\n`;
    await writeFile(outputPath, bytes, "utf8");
    const retained = await runInstrumentUpdate({ outputPath, now, fetchImpl: async () => ({ ok: false, status: 403 }) });
    assert.equal(retained.status, "retained"); assert.equal(await readFile(outputPath, "utf8"), bytes);
    const updated = await runInstrumentUpdate({ outputPath, now: now + 86400000, minimumEntries: 1, fetchImpl: async () => ({ ok: true, text: async () => good }) });
    assert.equal(updated.status, "updated");
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), updated.snapshot);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
