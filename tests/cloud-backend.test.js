import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, mkdtemp, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { createApp } from "../server/worker.mjs";
import { createMarketAssetReader } from "../server/market-data.mjs";
import { createLocalDatabase } from "../server/local-database.mjs";
import { createPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { normalizeStockHistory } from "../js/data/stock-history.js";
import { parseYahooChart, parseYahooQuote } from "../js/data/yahoo-chart.js";
import { normalizeExchangeRate, EXCHANGE_RATE_SOURCE_URL } from "../js/data/exchange-rate.js";
import { historicalRate, normalizeHistoricalFx, PORTFOLIO_FX_SOURCE_URL } from "../js/data/portfolio-history.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const ORIGIN = "https://investment-helper.example.chatgpt.site";
const assets = { "index.html": "<html>Investment helper</html>", "styles.css": "body{color:gray}",
  "app.js": "export const app=true;", "js/app.js": "export const app=true;", "data/prices.json": "{}", "server/private.mjs": "secret",
  "package.json": "secret", ".openai/hosting.json": "secret", "api/missing": "secret" };
const makeBook = (label = "Apple") => createPortfolioBook({ now: NOW, startDate: "2020-01-01", holdings: [
  { id: "opening-aapl", kind: "position", ticker: "AAPL", label, shares: 2, averageCost: 100, currency: "USD" },
] });

async function sqliteBinding(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  for (const file of (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  }
  const calls = [];
  return {
    calls, sqlite,
    prepare(sql) {
      assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP)\b/i, "Request handling never changes migration-owned tables");
      assert.equal(sql.includes(";"), false, "One statement per D1 prepare");
      return { bind(...values) { calls.push({ sql, values }); return {
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      }; } };
    },
  };
}

function request(path, { user = "owner-one", method = "GET", value, body, headers = {} } = {}) {
  const fields = { ...(user === null ? {} : { "oai-authenticated-user-id": user, "x-expected-user-id": user }), ...headers };
  const init = { method, headers: fields };
  if (value !== undefined) { init.body = JSON.stringify(value); fields["content-type"] ??= "application/json"; }
  if (body !== undefined) { init.body = body; init.duplex = "half"; }
  return new Request(ORIGIN + path, init);
}
async function response(app, env, path, options) {
  const value = await app.fetch(request(path, options), env);
  assert.equal(value.headers.get("cache-control"), "private, no-store");
  assert.equal(value.headers.get("x-content-type-options"), "nosniff");
  assert.equal(value.headers.get("access-control-allow-origin"), null);
  return { status: value.status, headers: value.headers, data: await value.json() };
}

test("development D1 adapter applies generated migrations once and preserves data on reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "investment-cloud-test-"));
  const filename = join(directory, "preview.sqlite");
  t.after(async () => { await unlink(filename); await rmdir(directory); });
  const app = createApp(assets, { now: NOW });
  let DB = createLocalDatabase(filename);
  try {
    const saved = await response(app, { DB }, "/api/portfolio", { method: "PUT", value: { book: makeBook(), expectedRevision: 0 } });
    assert.equal(saved.status, 200);
    assert.equal(await DB.prepare("SELECT COUNT(*) AS count FROM local_migrations").first("count"), 2);
    assert.equal((await DB.prepare("SELECT user_id FROM portfolio_books").all()).results[0].user_id, "owner-one");
  } finally { DB.close(); }
  DB = createLocalDatabase(filename);
  try {
    assert.equal((await response(app, { DB }, "/api/portfolio")).data.revision, 1);
    assert.equal(await DB.prepare("SELECT COUNT(*) AS count FROM local_migrations").first("count"), 2);
    assert.equal((await DB.prepare("UPDATE watchlists SET revision = revision WHERE user_id = ?").bind("none").run()).meta.changes, 0);
  } finally { DB.close(); }
});

test("development migrations reject a changed applied hash without altering saved records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "investment-cloud-test-"));
  const filename = join(directory, "preview.sqlite");
  t.after(async () => { await unlink(filename); await rmdir(directory); });
  const DB = createLocalDatabase(filename);
  try {
    await DB.prepare("INSERT INTO watchlists (user_id, tickers, revision, updated_at) VALUES (?, ?, ?, ?)")
      .bind("synthetic-owner", '["AAPL"]', 1, new Date(NOW).toISOString()).run();
    await DB.prepare("UPDATE local_migrations SET hash = ?").bind("changed-hash").run();
  } finally { DB.close(); }
  assert.throws(() => createLocalDatabase(filename), /An applied migration changed/);
  const check = new DatabaseSync(filename);
  try { assert.equal(check.prepare("SELECT tickers FROM watchlists WHERE user_id = ?").get("synthetic-owner").tickers, '["AAPL"]'); }
  finally { check.close(); }
});

test("health reveals no user data and session requires trusted Sites identity", async () => {
  const app = createApp(assets, { now: NOW });
  assert.deepEqual((await response(app, {}, "/api/health", { user: null })).data,
    { ok: true, cloud: true, storageAvailable: false });
  const anonymous = await response(app, {}, "/api/session", { user: null });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.data.code, "SIGN_IN_REQUIRED");
  assert.deepEqual((await response(app, {}, "/api/session")).data,
    { cloud: true, authMode: "chatgpt", userId: "owner-one", storageAvailable: false });
  assert.equal((await response(app, {}, "/api/session", { user: "invalid user" })).status, 401);
});

test("portfolio and watchlist return 503 with missing or failed DB, never a fake empty save", async () => {
  const app = createApp(assets, { now: NOW });
  for (const path of ["/api/portfolio", "/api/watchlist"]) {
    assert.equal((await response(app, {}, path)).status, 503);
    assert.equal((await response(app, { DB: { prepare() { throw new Error("database detail should stay private"); } } }, path)).status, 503);
  }
  assert.equal((await response(app, {}, "/api/portfolio", { method: "PUT", value: { book: makeBook(), expectedRevision: 0 } })).status, 503);
});

test("portfolio round trips validated native settlement data and separates authenticated users", async (t) => {
  const DB = await sqliteBinding(t);
  const app = createApp(assets, { now: NOW });
  const book = makeBook();
  book.transactions = [
    { id: "fund", type: "deposit", date: "2020-01-01", currency: "EUR", amount: 1000, note: "", cashCurrency: "EUR", cashAmount: 1000 },
    { id: "purchase", type: "buy", date: "2020-01-02", currency: "USD", ticker: "MSFT", quantity: 1, price: 330, fee: 1, note: "", cashCurrency: "EUR", cashAmount: 300 },
  ];
  assert.deepEqual((await response(app, { DB }, "/api/portfolio")).data, { book: null, revision: 0, updatedAt: null, userId: "owner-one" });
  const save = await response(app, { DB }, "/api/portfolio", { method: "PUT", value: { book, expectedRevision: 0 } });
  assert.equal(save.status, 200);
  assert.equal(save.data.revision, 1);
  assert.equal(save.data.updatedAt, new Date(NOW).toISOString());
  assert.equal(save.data.book.transactions[1].cashAmount, 300);
  assert.deepEqual((await response(app, { DB }, "/api/portfolio")).data, save.data);
  assert.deepEqual((await response(app, { DB }, "/api/portfolio", { user: "owner-two" })).data,
    { book: null, revision: 0, updatedAt: null, userId: "owner-two" });
  const other = await response(app, { DB }, "/api/portfolio", { user: "owner-two", method: "PUT", value: { book: makeBook("Other"), expectedRevision: 0 } });
  assert.equal(other.status, 200);
  assert.equal((await response(app, { DB }, "/api/portfolio")).data.book.openingHoldings[0].label, "Apple");
  assert(DB.calls.every(({ values }) => values.includes("owner-one") || values.includes("owner-two")));
});

test("portfolio CAS prevents concurrent first imports and concurrent stale edits from overwriting", async (t) => {
  const DB = await sqliteBinding(t);
  const app = createApp(assets, { now: NOW });
  const write = (label, revision) => response(app, { DB }, "/api/portfolio", { method: "PUT", value: { book: makeBook(label), expectedRevision: revision } });
  const initial = await Promise.all([write("Initial A", 0), write("Initial B", 0)]);
  assert.deepEqual(initial.map((x) => x.status).sort(), [200, 409]);
  const edits = await Promise.all([write("Edit A", 1), write("Edit B", 1)]);
  assert.deepEqual(edits.map((x) => x.status).sort(), [200, 409]);
  const winner = edits.find((x) => x.status === 200);
  assert.equal(winner.data.revision, 2);
  assert.deepEqual((await response(app, { DB }, "/api/portfolio")).data, winner.data);
  assert.equal((await write("Stale initial", 0)).status, 409);
  assert.equal((await write("Unknown ahead", 9)).status, 409);
  assert.equal((await response(app, { DB }, "/api/portfolio", { user: "new-owner", method: "PUT", value: { book: makeBook(), expectedRevision: 1 } })).status, 409);
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS count FROM portfolio_books").get().count, 1);
});

test("watchlist distinguishes unsaved from intentionally empty, validates symbols and uses independent CAS", async (t) => {
  const DB = await sqliteBinding(t);
  const app = createApp(assets, { now: NOW });
  const write = (tickers, revision = 0, user = "owner-one") => response(app, { DB }, "/api/watchlist", { user, method: "PUT", value: { tickers, expectedRevision: revision } });
  assert.deepEqual((await response(app, { DB }, "/api/watchlist")).data, { tickers: null, revision: 0, updatedAt: null, userId: "owner-one" });
  const initial = await Promise.all([write(["SNDK", "BRK-B", "VWCE.DE"]), write(["MSFT"])]);
  assert.deepEqual(initial.map((x) => x.status).sort(), [200, 409]);
  assert.equal((await write([], 1)).status, 200);
  assert.deepEqual((await response(app, { DB }, "/api/watchlist")).data,
    { tickers: [], revision: 2, updatedAt: new Date(NOW).toISOString(), userId: "owner-one" });
  assert.equal((await write(["AAPL"], 1)).status, 409);
  assert.equal((await write(["AAPL"], 0, "owner-two")).status, 200);
  for (const tickers of [["AAPL", "AAPL"], ["aapl"], ["BTC-USD"], ["^GSPC"], ["https://example.com"], Array(91).fill("AAPL"), null]) {
    assert.equal((await write(tickers, 2)).status, 400);
  }
  assert.equal((await response(app, { DB }, "/api/portfolio")).data.revision, 0);
});

test("identity never comes from body, revisions and invalid books cannot change saved rows", async (t) => {
  const DB = await sqliteBinding(t);
  const app = createApp(assets, { now: NOW });
  const cases = [
    { book: makeBook(), expectedRevision: -1 }, { book: makeBook(), expectedRevision: 0.5 },
    { book: makeBook(), expectedRevision: "0" }, { book: makeBook(), expectedRevision: Number.MAX_SAFE_INTEGER },
    { book: makeBook(), expectedRevision: 0, userId: "owner-two" },
    { book: { ...makeBook(), secret: "unsupported" }, expectedRevision: 0 },
    { book: null, expectedRevision: 0 },
  ];
  for (const value of cases) assert.equal((await response(app, { DB }, "/api/portfolio", { method: "PUT", value })).status, 400);
  assert.equal((await response(app, { DB }, "/api/portfolio", { user: null, method: "PUT", value: { book: makeBook(), expectedRevision: 0 } })).status, 401);
  assert.equal(DB.calls.length, 0);
});

test("an account switch fails before personal reads or saves and returns the new trusted identity", async (t) => {
  const DB = await sqliteBinding(t);
  const app = createApp(assets, { now: NOW });
  for (const path of ["/api/portfolio", "/api/watchlist"]) {
    const read = await response(app, { DB }, path, { user: "owner-two", headers: { "x-expected-user-id": "owner-one" } });
    assert.equal(read.status, 409);
    assert.equal(read.data.code, "ACCOUNT_CHANGED");
    assert.equal(read.data.userId, "owner-two");
    assert.equal(read.headers.get("x-portfolio-user-id"), "owner-two");
    const write = await response(app, { DB }, path, { user: "owner-two", method: "PUT",
      value: path === "/api/portfolio" ? { book: makeBook(), expectedRevision: 0 } : { tickers: ["AAPL"], expectedRevision: 0 },
      headers: { "x-expected-user-id": "owner-one" } });
    assert.equal(write.status, 409);
    assert.equal(write.data.code, "ACCOUNT_CHANGED");
  }
  const noExpectedIdentity = new Request(ORIGIN + "/api/portfolio", { method: "PUT", headers: {
    "oai-authenticated-user-id": "owner-one", "content-type": "application/json" },
    body: JSON.stringify({ book: makeBook(), expectedRevision: 0 }) });
  const denied = await app.fetch(noExpectedIdentity, { DB });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).code, "ACCOUNT_CHANGED");
  assert.equal(DB.calls.length, 0);
});

test("same-origin JSON saves succeed while cross-origin, null-origin and form posts are rejected", async (t) => {
  const DB = await sqliteBinding(t);
  const app = createApp(assets, { now: NOW });
  const value = { book: makeBook(), expectedRevision: 0 };
  for (const headers of [{ origin: "https://attacker.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }]) {
    assert.equal((await response(app, { DB }, "/api/portfolio", { method: "PUT", value, headers })).status, 403);
  }
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/json; charset=latin1"]) {
    assert.equal((await response(app, { DB }, "/api/portfolio", { method: "PUT", value, headers: { "content-type": type } })).status, 415);
  }
  assert.equal((await response(app, { DB }, "/api/portfolio", { method: "PUT", value,
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json; charset=UTF-8" } })).status, 200);
});

test("bounded streaming rejects misleading lengths, multibyte oversized bodies and malformed JSON", async (t) => {
  const DB = await sqliteBinding(t);
  const app = createApp(assets, { now: NOW });
  for (const body of ["{", "{\"book\":", ""]) {
    assert.equal((await response(app, { DB }, "/api/portfolio", { method: "PUT", body, headers: { "content-type": "application/json" } })).status, 400);
  }
  assert.equal((await response(app, { DB }, "/api/portfolio", { method: "PUT", body: "{}",
    headers: { "content-type": "application/json", "content-length": String(1024 * 1024 + 1) } })).status, 413);
  const bytes = new TextEncoder().encode('"' + "€".repeat(350000) + '"');
  let offset = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { if (offset >= bytes.length) return controller.close(); controller.enqueue(bytes.slice(offset, offset += 16000)); },
    cancel() { cancelled = true; },
  });
  assert.equal((await response(app, { DB }, "/api/portfolio", { method: "PUT", body: stream,
    headers: { "content-type": "application/json", "content-length": "2" } })).status, 413);
  assert.equal(cancelled, true);
  assert.equal(DB.calls.length, 0);
});

test("SQL identity parameters prevent injection and corrupt saved payloads fail closed", async (t) => {
  const DB = await sqliteBinding(t);
  const app = createApp(assets, { now: NOW });
  const user = "attacker'OR'1'='1";
  assert.equal((await response(app, { DB }, "/api/portfolio", { user, method: "PUT", value: { book: makeBook(), expectedRevision: 0 } })).status, 200);
  assert.equal((await response(app, { DB }, "/api/portfolio")).data.book, null);
  DB.sqlite.prepare("UPDATE portfolio_books SET book = ? WHERE user_id = ?").run('{"invalid":true}', user);
  const corrupt = await response(app, { DB }, "/api/portfolio", { user });
  assert.equal(corrupt.status, 503);
  assert.equal(corrupt.data.code, "STORAGE_UNAVAILABLE");
});

test("static allowlist supports GET and HEAD with private headers and never exposes server/config or falls back for APIs", async () => {
  const app = createApp(assets, { now: NOW });
  for (const path of ["/", "/app.js", "/js/app.js", "/styles.css", "/data/prices.json"]) {
    const result = await app.fetch(request(path));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.equal((await app.fetch(request(path, { method: "HEAD" }))).body, null);
  }
  for (const path of ["/server/private.mjs", "/package.json", "/.openai/hosting.json", "/api/missing", "/api", "/missing"]) {
    assert.equal((await app.fetch(request(path))).status, 404);
  }
  assert.equal((await app.fetch(request("/", { method: "POST" }))).status, 405);
  const preflight = await response(app, {}, "/api/portfolio", { method: "OPTIONS" });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers.get("allow"), "GET, PUT");
});

test("large embedded public assets retain gzip encoding and correct content type", async () => {
  const text = '{"schemaVersion":1,"byTicker":{}}';
  const app = createApp({ ...assets, "data/prices.json": { encoding: "gzip-base64",
    data: gzipSync(text).toString("base64"), contentType: "application/json; charset=utf-8" } });
  const result = await app.fetch(request("/data/prices.json"));
  assert.equal(result.headers.get("content-encoding"), "gzip");
  assert.equal(result.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(gunzipSync(new Uint8Array(await result.arrayBuffer())).toString(), text);
  const head = await app.fetch(request("/data/prices.json", { method: "HEAD" }));
  assert.equal(head.headers.get("content-encoding"), "gzip");
  assert.equal(head.body, null);
});

const yahooChart = (ticker = "SNDK", overrides = {}) => ({ chart: { result: [{
  meta: { symbol: ticker, currency: "USD", instrumentType: "EQUITY", dataGranularity: "1d",
    regularMarketPrice: 115, regularMarketTime: Date.parse("2026-10-09T20:00:00Z") / 1000, ...overrides.meta },
  timestamp: ["2026-10-07", "2026-10-08", "2026-10-09"].map((date) => Date.parse(date + "T13:30:00Z") / 1000),
  indicators: { quote: [{ close: [100, 110, 115], high: [101, 111, 116], low: [99, 109, 114], volume: [100, 200, 300] }] },
  ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "meta")),
}] } });

test("server history has existing client provenance, fixed Yahoo endpoint, bounded identity and deduplicated cache", async () => {
  const calls = [];
  const app = createApp(assets, { now: NOW, fetchImpl: async (url, options) => {
    calls.push(String(url));
    assert.equal(Object.hasOwn(options, "credentials"), false);
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { Accept: "application/json" });
    return Response.json(yahooChart());
  } });
  const result = await Promise.all([response(app, {}, "/api/market/history?ticker=SNDK"), response(app, {}, "/api/market/history?ticker=SNDK")]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "https://query1.finance.yahoo.com/v8/finance/chart/SNDK?range=5y&interval=1d&events=splits");
  assert(result.every((value) => value.status === 200));
  const history = normalizeStockHistory(result[0].data, "SNDK", { now: NOW });
  assert.equal(history.prices.length, 3);
  assert.equal(history.source, "Yahoo Finance chart");
  assert.equal(history.quote.price, 115);
  assert.equal(history.splitsComplete, true);
  assert.equal((await response(app, {}, "/api/market/history?ticker=SNDK")).status, 200);
  assert.equal(calls.length, 1);
  for (const path of ["/api/market/history?ticker=https://evil.example", "/api/market/history?ticker=SNDK&url=https://evil.example", "/api/market/history?ticker=SNDK&ticker=AAPL", "/api/market/history"]) {
    assert.equal((await response(app, {}, path)).status, 400);
  }
  assert.equal((await response(app, {}, "/api/market/history?ticker=SNDK", { user: null })).status, 401);
  assert.equal(calls.length, 1);
});

test("server history rejects mismatched identity, wrong intervals, oversized replies and unsupported instruments", async () => {
  for (const fixture of [yahooChart("WRONG"), yahooChart("SNDK", { meta: { instrumentType: "CRYPTOCURRENCY" } }),
    yahooChart("SNDK", { meta: { dataGranularity: "1m" } }), yahooChart("SNDK", { timestamp: [NOW / 1000 + 1] }),
    yahooChart("SNDK", { timestamp: Array(1601).fill(1) })]) {
    const app = createApp(assets, { now: NOW, fetchImpl: async () => Response.json(fixture) });
    assert.equal((await response(app, {}, "/api/market/history?ticker=SNDK")).status, 503);
  }
  const app = createApp(assets, { now: NOW, fetchImpl: async () => new Response("{}", { headers: { "content-length": String(4 * 1024 * 1024 + 1) } }) });
  assert.equal((await response(app, {}, "/api/market/history?ticker=SNDK")).status, 503);
});

test("blocked Yahoo requests share one fresh fixed public publisher fallback without changing its dates", async () => {
  const calls = [];
  const snapshot = { schemaVersion: 1, generatedAt: new Date(NOW - 60000).toISOString(), byTicker: {} };
  for (const ticker of ["SNDK", "AAPL"]) {
    const parsed = parseYahooChart(yahooChart(ticker), ticker);
    parsed.source = "Yahoo Finance published snapshot";
    parsed.quote = parseYahooQuote(yahooChart(ticker), ticker, { now: NOW });
    snapshot.byTicker[ticker] = JSON.parse(JSON.stringify(parsed));
  }
  const app = createApp(assets, { now: NOW, fetchImpl: async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://query1.finance.yahoo.com")) return new Response("Rate limited", { status: 429 });
    assert.equal(String(url), "https://hugotristan.github.io/investment_helper/data/prices.json");
    return Response.json(snapshot);
  } });
  const values = await Promise.all([response(app, {}, "/api/market/history?ticker=SNDK"), response(app, {}, "/api/market/history?ticker=AAPL")]);
  assert(values.every((value) => value.status === 200));
  assert.equal(calls.filter((url) => url.includes("github.io")).length, 1);
  assert.equal(values[0].data.source, "Yahoo Finance published snapshot");
  assert.equal(values[0].data.historyAsOf, "2026-10-09T13:30:00.000Z");
  assert.equal(values[0].data.quote.quoteTime, "2026-10-09T20:00:00.000Z");
  assert.equal((await response(app, {}, "/api/market/history?ticker=SNDK")).status, 200);
  assert.equal(calls.length, 3);
  const stale = createApp(assets, { now: NOW, fetchImpl: async (url) => String(url).includes("query1")
    ? new Response("Rate limited", { status: 429 }) : Response.json({ ...snapshot, generatedAt: "2026-01-01T00:00:00Z" }) });
  assert.equal((await response(stale, {}, "/api/market/history?ticker=SNDK")).status, 503);
});

test("server limits simultaneous public history provider requests to three", async () => {
  let active = 0, peak = 0;
  const app = createApp(assets, { now: NOW, fetchImpl: async (url) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    const ticker = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
    return Response.json(yahooChart(ticker));
  } });
  const result = await Promise.all(["AAPL", "SNDK", "MSFT", "TSM", "NVDA", "GOOGL"].map((ticker) => response(app, {}, "/api/market/history?ticker=" + ticker)));
  assert.equal(peak, 3);
  assert(result.every((value) => value.status === 200));
});

test("server FX uses current validated ECB rate with fixed URL and shared cache; malformed rates fail closed", async () => {
  let calls = 0;
  const app = createApp(assets, { now: NOW, fetchImpl: async (url) => {
    calls += 1;
    assert.equal(url, EXCHANGE_RATE_SOURCE_URL);
    return Response.json({ base: "USD", quote: "EUR", rate: 0.89238, date: "2026-10-09" });
  } });
  const values = await Promise.all([response(app, {}, "/api/exchange-rate"), response(app, {}, "/api/exchange-rate")]);
  assert.equal(calls, 1);
  assert(values.every((value) => value.status === 200));
  assert.equal(normalizeExchangeRate(values[0].data, { now: NOW }).rate, 0.89238);
  assert.equal((await response(app, {}, "/api/exchange-rate")).status, 200);
  assert.equal(calls, 1);
  for (const raw of [{ base: "EUR", quote: "USD", rate: 1.12, date: "2026-10-09" },
    { base: "USD", quote: "EUR", rate: 0.8, date: "2026-01-01" },
    { base: "USD", quote: "EUR", rate: 0.8, date: "2026-10-11" }]) {
    const invalid = createApp(assets, { now: NOW, fetchImpl: async () => Response.json(raw) });
    assert.equal((await response(invalid, {}, "/api/exchange-rate")).status, 503);
  }
});

function fxFixture() {
  const start = Date.parse("2021-10-03");
  const last = Date.parse("2026-10-09");
  return ["USD", "GBP", "JPY", "CHF", "CAD", "AUD"].flatMap((quote, currencyIndex) =>
    Array.from({ length: 201 }, (_, index) => ({ base: "EUR", quote, rate: 1.1 + currencyIndex,
      date: new Date(start + Math.floor((last - start) / 86400000 * index / 200) * 86400000).toISOString().slice(0, 10) })));
}

test("historical FX requests five years of fixed ECB pairs, inverts native rates and preserves observation dates", async () => {
  const calls = [];
  const app = createApp(assets, { now: NOW, fetchImpl: async (url) => {
    calls.push(String(url));
    const provider = new URL(url);
    assert.equal(provider.origin + provider.pathname, PORTFOLIO_FX_SOURCE_URL);
    assert.equal(provider.searchParams.get("base"), "eur");
    assert.equal(provider.searchParams.get("quotes"), "usd,gbp,jpy,chf,cad,aud");
    assert.equal(provider.searchParams.get("from"), "2021-10-03");
    assert.equal(provider.searchParams.get("to"), "2026-10-10");
    return Response.json(fxFixture());
  } });
  const values = await Promise.all([response(app, {}, "/api/portfolio-fx"), response(app, {}, "/api/portfolio-fx")]);
  assert(values.every((value) => value.status === 200));
  assert.equal(calls.length, 1);
  const snapshot = normalizeHistoricalFx(values[0].data, { now: NOW });
  assert.equal(snapshot.byCurrency.USD.length, 201);
  assert.equal(snapshot.byCurrency.USD.at(-1).date, "2026-10-09");
  assert.equal(historicalRate(snapshot, "USD", "2026-10-10", { now: NOW }).rate, 1 / 1.1);
  assert.equal((await response(app, {}, "/api/portfolio-fx")).status, 200);
  assert.equal(calls.length, 1);
  for (const fixture of [fxFixture().filter((row) => row.quote !== "USD"),
    [{ base: "EUR", quote: "USD", rate: 0, date: "2026-10-09" }],
    [...fxFixture(), { base: "EUR", quote: "USD", rate: 1.1, date: "2026-10-11" }]]) {
    const invalid = createApp(assets, { now: NOW, fetchImpl: async () => Response.json(fixture) });
    assert.equal((await response(invalid, {}, "/api/portfolio-fx")).status, 503);
  }
});

function publishedFixture(tickers = ["VWCE.DE", "MSFT"]) {
  return { schemaVersion: 1, generatedAt: "2026-10-09T21:00:00.000Z", byTicker: Object.fromEntries(tickers.map((ticker) => {
    const chart = yahooChart(ticker, { meta: { currency: ticker === "VWCE.DE" ? "EUR" : "USD",
      instrumentType: ticker === "VWCE.DE" ? "ETF" : "EQUITY" } });
    const history = parseYahooChart(chart, ticker);
    history.source = "Yahoo Finance published snapshot";
    history.quote = parseYahooQuote(chart, ticker, { now: NOW });
    return [ticker, JSON.parse(JSON.stringify(history))];
  })) };
}

function currentFxFixture() {
  return { schemaVersion: 1, available: true, base: "USD", quote: "EUR", rate: 0.89238, date: "2026-10-09",
    source: "ECB reference rate via Frankfurter", sourceUrl: EXCHANGE_RATE_SOURCE_URL, retrievedAt: "2026-10-09T21:00:00.000Z" };
}

function publishedFxFixture() {
  return { schemaVersion: 1, source: "ECB reference rates via Frankfurter", sourceUrl: PORTFOLIO_FX_SOURCE_URL,
    generatedAt: "2026-10-09T21:00:00.000Z", byCurrency: Object.fromEntries(["USD", "GBP", "JPY", "CHF", "CAD", "AUD"].map((currency) =>
      [currency, fxFixture().filter((row) => row.quote === currency).map((row) => ({ date: row.date, rate: 1 / row.rate }))])) };
}

const embeddedJson = (value) => ({ encoding: "gzip-base64", data: gzipSync(JSON.stringify(value)).toString("base64"), contentType: "application/json" });

test("default market fetch resolves the current global method with its receiver", async () => {
  const original = globalThis.fetch;
  const app = createApp(assets, { now: NOW });
  const calls = [];
  try {
    // Install after app construction: Workers must resolve request-time fetch,
    // and host APIs may reject detached calls even when Node accepts them.
    globalThis.fetch = function (url, init) {
      assert.equal(this, globalThis);
      if (Object.hasOwn(init, "credentials")) throw new TypeError("The credentials field on RequestInitializerDict is not implemented.");
      assert.deepEqual(init.headers, { Accept: "application/json" });
      calls.push(String(url));
      return Promise.resolve(Response.json(yahooChart("MSFT")));
    };
    const result = await response(app, {}, "/api/market/history?ticker=MSFT");
    assert.equal(result.status, 200);
    assert.equal(result.data.ticker, "MSFT");
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; }
});

test("current and historical FX use fixed public snapshots during live provider outages without changing dates", async () => {
  const calls = [], diagnostics = [];
  const app = createApp(assets, { now: NOW, reportFailure: (details) => diagnostics.push(details), fetchImpl: async (url, init) => {
    calls.push(String(url));
    assert.deepEqual(init.headers, { Accept: "application/json" });
    assert.equal(Object.hasOwn(init, "credentials"), false);
    assert.equal(init.redirect, "error");
    if (String(url).startsWith("https://api.frankfurter.dev/")) return new Response("Blocked", { status: 503 });
    if (String(url) === "https://hugotristan.github.io/investment_helper/data/exchange-rate.json") return Response.json(currentFxFixture());
    assert.equal(String(url), "https://hugotristan.github.io/investment_helper/data/portfolio-fx.json");
    return Response.json(publishedFxFixture());
  } });
  const [current, history] = await Promise.all([response(app, {}, "/api/exchange-rate"), response(app, {}, "/api/portfolio-fx")]);
  assert.equal(current.status, 200);
  assert.equal(current.data.date, "2026-10-09");
  assert.equal(current.data.retrievedAt, "2026-10-09T21:00:00.000Z");
  assert.equal(history.status, 200);
  assert.equal(history.data.generatedAt, "2026-10-09T21:00:00.000Z");
  assert.equal(history.data.byCurrency.USD.at(-1).date, "2026-10-09");
  assert.equal(calls.length, 4);
  assert.deepEqual(diagnostics.map(({ provider, reason, status }) => ({ provider, reason, status })), [
    { provider: "ecb-current", reason: "http", status: 503 }, { provider: "ecb-history", reason: "http", status: 503 },
  ]);
  assert.equal((await response(app, {}, "/api/exchange-rate")).status, 200);
  assert.equal((await response(app, {}, "/api/portfolio-fx")).status, 200);
  assert.equal(calls.length, 4);
});

test("network runtime failures recover from bounded compressed embedded public prices and rates", async () => {
  const diagnostics = [], calls = [];
  const app = createApp({ ...assets, "data/prices.json": embeddedJson(publishedFixture()),
    "data/exchange-rate.json": embeddedJson(currentFxFixture()), "data/portfolio-fx.json": embeddedJson(publishedFxFixture()) },
  { now: NOW, reportFailure: (details) => diagnostics.push(details), fetchImpl: async (url) => {
    calls.push(String(url));
    throw new TypeError("Illegal invocation: untrusted private text must not be echoed");
  } });
  const paths = ["/api/market/history?ticker=VWCE.DE", "/api/market/history?ticker=MSFT", "/api/exchange-rate", "/api/portfolio-fx"];
  for (const path of paths) assert.equal((await response(app, {}, path, { user: null })).status, 401);
  assert.equal(calls.length, 0);
  const [vwce, msft, current, historical] = await Promise.all(paths.map((path) => response(app, {}, path)));
  assert.equal(vwce.status, 200);
  assert.equal(vwce.data.currency, "EUR");
  assert.equal(vwce.data.source, "Yahoo Finance published snapshot");
  assert.equal(vwce.data.historyAsOf, "2026-10-09T13:30:00.000Z");
  assert.equal(msft.status, 200);
  assert.equal(msft.data.currency, "USD");
  assert.equal(current.status, 200);
  assert.equal(current.data.date, "2026-10-09");
  assert.equal(historical.status, 200);
  assert.equal(historical.data.generatedAt, "2026-10-09T21:00:00.000Z");
  assert.equal(calls.filter((url) => url.endsWith("/prices.json")).length, 1);
  assert.equal(diagnostics.filter(({ provider }) => provider === "yahoo").length, 1);
  assert(diagnostics.every(({ reason }) => reason === "fetch-binding"));
  assert(!JSON.stringify(diagnostics).includes("untrusted private text"));
});

test("embedded recovery rejects stale prices, wrong-currency rates, incomplete histories and oversized decompressed files", async () => {
  const stale = publishedFixture();
  stale.generatedAt = "2026-01-01T00:00:00.000Z";
  const incomplete = publishedFxFixture();
  delete incomplete.byCurrency.USD;
  const app = createApp({ ...assets, "data/prices.json": embeddedJson(stale),
    "data/exchange-rate.json": embeddedJson({ ...currentFxFixture(), base: "EUR", quote: "USD" }),
    "data/portfolio-fx.json": embeddedJson(incomplete) },
  { now: NOW, reportFailure() {}, fetchImpl: async () => { throw new TypeError("Illegal invocation and credential-like private text"); } });
  for (const path of ["/api/market/history?ticker=VWCE.DE", "/api/exchange-rate", "/api/portfolio-fx"]) {
    const result = await response(app, {}, path);
    assert.equal(result.status, 503);
    assert.equal(result.data.providerFailures.length, 3);
    assert.equal(result.data.providerFailures[0].reason, "fetch-binding");
    assert(!JSON.stringify(result.data).includes("credential-like private text"));
  }
  const reader = createMarketAssetReader({ "data/exchange-rate.json": embeddedJson({ padding: "x".repeat(16 * 1024) }) });
  await assert.rejects(reader("data/exchange-rate.json"), { code: "BODY_TOO_LARGE" });
  assert.equal(await reader("server/auth.mjs"), null);
});
