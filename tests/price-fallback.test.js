import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leewayInstrument, parseLeewayQuote, createLeewayQuoteFallback, createPriceFallbackBudget } from "../scripts/price-fallback.mjs";

const NOW = Date.parse("2026-10-13T14:00:00Z");
const record = { ticker: "VWCE.DE", currency: "EUR", instrumentType: "ETF", source: "Yahoo Finance published snapshot" };
const instrument = leewayInstrument("VWCE.DE", record);
const quote = () => ({ code: "VWCE.XETRA", timestamp: (NOW - 20 * 60000) / 1000, gmtoffset: 0,
  datetime: new Date(NOW - 20 * 60000).toISOString(), close: 173, previousClose: 173, high: 174, low: 172, volume: 1000 });
const cleanBudget = async directory => {
  await unlink(join(directory, "counter.json")).catch(() => {});
  await unlink(join(directory, "counter.json.tmp")).catch(() => {});
  await rmdir(directory);
};

test("provider mappings keep verified exchange, currency and share identity; unknown units/listings are skipped", () => {
  assert.equal(instrument.symbol, "VWCE.XETRA");
  assert.equal(leewayInstrument("NOKIA.HE", { ...record, ticker: "NOKIA.HE", instrumentType: "EQUITY" }).symbol, "NOKIA.HE");
  assert.equal(leewayInstrument("NOK", { ...record, ticker: "NOK", currency: "USD", instrumentType: "EQUITY" }).symbol, "NOK.US");
  for (const value of [{ ...record, currency: "USD" }, { ...record, source: "sample" }, { ...record, ticker: "OTHER.DE" }, { ...record, instrumentType: "INDEX" }]) {
    assert.equal(leewayInstrument("VWCE.DE", value), null);
  }
  assert.equal(leewayInstrument("VWRP.L", { ...record, ticker: "VWRP.L", currency: "GBp" }), null);
  assert.equal(leewayInstrument("^VIX", { ...record, ticker: "^VIX", currency: "USD" }), null);
});

test("quotes retain the provider time and delayed source, including zero change; malformed/future/stale replies fail", () => {
  const value = parseLeewayQuote(quote(), instrument, { now: NOW });
  assert.equal(value.price, 173);
  assert.equal(value.dayChangePercent, 0);
  assert.equal(value.currency, "EUR");
  assert.equal(value.quoteTime, quote().datetime);
  assert.equal(value.source, "Leeway delayed quote");
  for (const patch of [{ code: "VWCE.US" }, { currency: "USD" }, { close: 0 }, { close: "173" },
    { timestamp: NOW / 1000 + 1 }, { timestamp: NOW / 1000 - 8 * 86400 }, { datetime: "wrong" }, { gmtoffset: 3600 }]) {
    assert.equal(parseLeewayQuote({ ...quote(), ...patch }, instrument, { now: NOW }), null);
  }
});

test("unconfigured or exhausted fallbacks send nothing; enabled requests use only the fixed ticker endpoint and secret", async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    const address = new URL(url);
    assert.equal(address.origin, "https://api.leeway.tech");
    assert.equal(address.pathname, "/api/v1/public/live/VWCE.XETRA");
    assert.equal(address.searchParams.get("apitoken"), "fixture-key");
    assert.equal(init.redirect, "manual");
    assert(!/Cookie|quantity|cashAmount|costBasis/i.test(JSON.stringify(init.headers)));
    return Response.json(quote());
  };
  assert.equal(await createLeewayQuoteFallback({ fetchImpl })("VWCE.DE", record), null);
  assert.equal(await createLeewayQuoteFallback({ token: "fixture-key", fetchImpl })("VWCE.DE", record), null);
  assert.equal(calls, 0);
  const value = await createLeewayQuoteFallback({ token: "fixture-key", reserve: async () => true, fetchImpl, now: () => NOW })("VWCE.DE", record);
  assert.equal(value.source, "Leeway delayed quote");
  assert.equal(calls, 1);
});

test("401/403/429 stop later attempts without exposing provider messages or retrying; bad bodies stay unavailable", async () => {
  for (const status of [401, 403, 429]) {
    let count = 0;
    const fallback = createLeewayQuoteFallback({ token: "fixture-key", reserve: async () => true,
      fetchImpl: async () => { count += 1; return new Response("private provider error", { status }); } });
    assert.equal(await fallback("VWCE.DE", record), null);
    assert.equal(await fallback("VWCE.DE", record), null);
    assert.equal(count, 1);
  }
  for (const response of [new Response("{bad"), new Response("a".repeat(32769)), Response.json(quote(), { status: 302 })]) {
    assert.equal(await createLeewayQuoteFallback({ token: "fixture-key", reserve: async () => true,
      fetchImpl: async () => response, now: () => NOW })("VWCE.DE", record), null);
  }
});

test("persisted daily budget serializes concurrent calls, survives re-opening, and resets only on a new UTC day", async t => {
  const directory = await mkdtemp(join(tmpdir(), "quote-budget-"));
  t.after(() => cleanBudget(directory));
  const path = join(directory, "counter.json");
  let clock = NOW;
  await createPriceFallbackBudget(path, { now: () => clock, configured: false });
  const first = await createPriceFallbackBudget(path, { now: () => clock, configured: true });
  assert.equal((await Promise.all(Array.from({ length: 50 }, () => first.reserve()))).filter(Boolean).length, 40);
  assert.equal(JSON.parse(await readFile(path, "utf8")).used, 40);
  const reopened = await createPriceFallbackBudget(path, { now: () => clock, configured: true });
  assert.equal(await reopened.reserve(), false);
  clock += 86400000;
  assert.equal(await reopened.reserve(), true);
  assert.equal(JSON.parse(await readFile(path, "utf8")).used, 1);
});

test("configured cache loss or invalid budget pauses quotes instead of silently granting more requests", async t => {
  const directory = await mkdtemp(join(tmpdir(), "quote-budget-missing-"));
  t.after(() => cleanBudget(directory));
  const path = join(directory, "counter.json");
  const missing = await createPriceFallbackBudget(path, { now: () => NOW, configured: true });
  assert.equal(await missing.reserve(), false);
  await writeFile(path, "not json");
  const corrupt = await createPriceFallbackBudget(path, { now: () => NOW, configured: true });
  assert.equal(await corrupt.reserve(), false);
});
