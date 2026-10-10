import assert from "node:assert/strict";
import { test } from "node:test";
import { createPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { cloudEnvironment, createCloudSession, createCloudPortfolioStore, createCloudWatchlistStore } from "../js/data/cloud-portfolio-store.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const copy = (value) => value === null ? null : structuredClone(value);
const initialBook = () => createPortfolioBook({ holdings: [{ id: "position", kind: "position", ticker: "MSFT", label: "Microsoft", shares: 1, averageCost: 300, currency: "USD" }], baseCurrency: "EUR", startDate: "2026-10-01", now: NOW });
const editBook = (book, offset = 1) => ({ ...copy(book), updatedAt: new Date(NOW + offset).toISOString(), legacyPortfolioInput: `revision ${offset}` });
const response = (body, status = 200, userId = "user-a") => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "X-Portfolio-User-Id": userId } });
function fixture({ book = null, tickers = null, browserBook = initialBook(), before, cacheError = false, authMode } = {}) {
  let account = "user-a";
  let portfolio = { book: copy(book), revision: book ? 1 : 0, updatedAt: book ? book.updatedAt : null };
  let watchlist = { tickers: copy(tickers), revision: tickers ? 1 : 0, updatedAt: tickers ? new Date(NOW).toISOString() : null };
  const calls = [];
  const cacheWrites = [];
  let browserReads = 0;
  let browserWrites = 0;
  const session = createCloudSession({ cloud: true, fetch: async (path, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method, body, expectedUser: options.headers["X-Expected-User-Id"], credentials: options.credentials });
    const interception = await before?.({ path, options, body, portfolio, watchlist });
    if (interception) return interception;
    if (path === "/api/session") return response({ cloud: true, userId: account, storageAvailable: true, ...(authMode ? { authMode } : {}) }, 200, account);
    if (options.headers["X-Expected-User-Id"] !== account) return response({ error: "ACCOUNT_CHANGED" }, 409, account);
    const record = path === "/api/portfolio" ? portfolio : watchlist;
    if (options.method === "PUT") {
      if (body.expectedRevision !== record.revision) return response({ error: "CONFLICT" }, 409, account);
      record[path === "/api/portfolio" ? "book" : "tickers"] = copy(body[path === "/api/portfolio" ? "book" : "tickers"]);
      record.revision++;
      record.updatedAt = new Date(NOW + record.revision).toISOString();
    }
    return response({ ...record, userId: account }, 200, account);
  } });
  const browserStore = { async read() { browserReads++; return copy(browserBook); }, async write() { browserWrites++; } };
  const store = createCloudPortfolioStore({ session, browserStore, now: NOW,
    cacheForUser: (userId) => ({ async write(value) { if (cacheError) throw new Error("Quota full"); cacheWrites.push({ userId, book: copy(value) }); } }) });
  return { session, store, watchlistStore: createCloudWatchlistStore({ session }), calls, cacheWrites,
    get browserReads() { return browserReads; }, get browserWrites() { return browserWrites; },
    get portfolio() { return portfolio; }, get watchlist() { return watchlist; },
    set account(value) { account = value; }, replacePortfolio(value) { portfolio = copy(value); } };
}

test("only the Sites build enables private cloud storage; browser mode sends no API requests", async () => {
  assert.equal(cloudEnvironment({ documentElement: { dataset: { cloudMode: "sites" } } }), true);
  assert.equal(cloudEnvironment({ documentElement: { dataset: { cloudMode: "browser" } } }), false);
  let requests = 0;
  const session = createCloudSession({ cloud: false, fetch: () => { requests++; } });
  assert.equal((await session.initialize()).mode, "browser");
  assert.equal(requests, 0);
});

test("a missing or unauthenticated Sites API fails closed and never falls back to browser data", async () => {
  for (const status of [404, 401, 503]) {
    const f = fixture({ before: () => response({}, status) });
    await assert.rejects(f.store.read(), { code: status === 401 ? "UNAUTHORIZED" : "UNAVAILABLE" });
    assert.equal(f.browserReads, 0);
    assert.equal(f.browserWrites, 0);
    assert.equal(f.cacheWrites.length, 0);
  }
});

test("password authentication keeps the existing owner assertion and uses only same-origin cookies", async () => {
  const f = fixture({ book: initialBook(), authMode: "password" });
  const saved = await f.store.read();
  assert.equal(f.session.state.authMode, "password");
  assert.equal(f.session.state.userId, "user-a");
  await f.store.write(editBook(saved), { expectedUpdatedAt: saved.updatedAt });
  assert.equal(f.calls.find((call) => call.method === "PUT").expectedUser, "user-a");
  assert.ok(f.calls.every((call) => call.credentials === "same-origin"));
  const legacy = fixture();
  await legacy.session.initialize();
  assert.equal(legacy.session.state.authMode, "chatgpt");
});

test("expired password sessions preserve saved data, block further access, and recover after unlocking", async () => {
  let expired = false;
  const f = fixture({ book: initialBook(), authMode: "password", before: ({ path }) => path === "/api/portfolio" && expired ? response({}, 401) : undefined });
  const saved = await f.store.read();
  expired = true;
  await assert.rejects(f.store.write(editBook(saved), { expectedUpdatedAt: saved.updatedAt }), { code: "UNAUTHORIZED" });
  assert.equal(f.session.state.authMode, "password");
  assert.match(f.session.state.message, /Unlock the app again/);
  assert.deepEqual(f.portfolio.book, initialBook());
  assert.equal(f.cacheWrites.length, 1);
  const count = f.calls.length;
  await assert.rejects(f.store.read(), { code: "UNAUTHORIZED" });
  assert.equal(f.calls.length, count);
  expired = false;
  await f.session.initialize({ retry: true });
  assert.deepEqual(await f.store.read(), initialBook());
  assert.equal(f.session.state.errorCode, null);
  assert.equal(f.session.state.authMode, "password");
});

test("an empty cloud portfolio stays empty until an explicit upload or restore", async () => {
  const f = fixture();
  assert.equal(await f.store.read(), null);
  assert.equal(f.browserReads, 0);
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 0);
  const uploaded = await f.store.uploadBrowserPortfolio();
  assert.deepEqual(uploaded, initialBook());
  assert.equal(f.browserReads, 1);
  assert.equal(f.browserWrites, 0);
  assert.equal(f.portfolio.revision, 1);
  assert.equal(f.cacheWrites[0].userId, "user-a");
  await assert.rejects(f.store.uploadBrowserPortfolio(), { code: "CONFLICT" });
});

test("cloud writes use a loaded revision, an owner assertion and detached data", async () => {
  const f = fixture({ book: initialBook() });
  await assert.rejects(f.store.write(initialBook()), { code: "NOT_LOADED" });
  const book = await f.store.read();
  const candidate = editBook(book);
  const pending = f.store.write(candidate, { expectedUpdatedAt: book.updatedAt });
  candidate.legacyPortfolioInput = "caller mutation";
  const saved = await pending;
  assert.equal(saved.legacyPortfolioInput, "revision 1");
  const put = f.calls.find((call) => call.method === "PUT");
  assert.equal(put.expectedUser, "user-a");
  assert.equal(put.body.expectedRevision, 1);
  assert.deepEqual(Object.keys(put.body).sort(), ["book", "expectedRevision"]);
  assert.equal(f.browserWrites, 0);
  saved.legacyPortfolioInput = "returned mutation";
  assert.equal(f.cacheWrites.at(-1).book.legacyPortfolioInput, "revision 1");
});

test("a delayed save serializes later edits and rejects their stale revision", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ book: initialBook(), before: async ({ path, options }) => { if (path === "/api/portfolio" && options.method === "PUT") await gate; } });
  const book = await f.store.read();
  const first = f.store.write(editBook(book), { expectedUpdatedAt: book.updatedAt });
  const second = f.store.write(editBook(book, 2), { expectedUpdatedAt: book.updatedAt });
  release();
  await first;
  await assert.rejects(second, { code: "CONFLICT" });
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 1);
  assert.equal(f.portfolio.book.legacyPortfolioInput, "revision 1");
});

test("a conflict keeps recovery data, requires reload, and does not merge or replace newer cloud data", async () => {
  const f = fixture({ book: initialBook() });
  const original = await f.store.read();
  const newer = editBook(original, 2);
  f.replacePortfolio({ book: newer, revision: 2, updatedAt: newer.updatedAt });
  await assert.rejects(f.store.write(editBook(original), { expectedUpdatedAt: original.updatedAt }), { code: "CONFLICT" });
  assert.equal(f.portfolio.book.updatedAt, newer.updatedAt);
  assert.equal(f.cacheWrites.length, 1);
  await assert.rejects(f.store.write(editBook(original)), { code: "NOT_LOADED" });
  assert.deepEqual(await f.store.read(), newer);
  const candidate = editBook(newer, 3);
  assert.deepEqual(await f.store.write(candidate, { expectedUpdatedAt: newer.updatedAt }), candidate);
});

test("an uncertain PUT requires reading the committed cloud revision before retrying", async () => {
  let fail = true;
  const f = fixture({ book: initialBook(), before: ({ options, body, portfolio }) => {
    if (options.method === "PUT" && fail) {
      fail = false;
      portfolio.book = copy(body.book);
      portfolio.revision++;
      portfolio.updatedAt = new Date(NOW + 2).toISOString();
      throw new Error("Connection ended after commit");
    }
  } });
  const book = await f.store.read();
  await assert.rejects(f.store.write(editBook(book), { expectedUpdatedAt: book.updatedAt }), /Reload cloud data before retrying/);
  await assert.rejects(f.store.write(editBook(book)), { code: "NOT_LOADED" });
  assert.equal(f.cacheWrites.length, 1);
  assert.equal((await f.store.read()).legacyPortfolioInput, "revision 1");
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 1);
});

test("account changes fail before saving and cannot contaminate the original owner's recovery cache", async () => {
  const f = fixture({ book: initialBook() });
  const original = await f.store.read();
  f.account = "user-b";
  await assert.rejects(f.store.write(editBook(original), { expectedUpdatedAt: original.updatedAt }), { code: "ACCOUNT_CHANGED" });
  assert.equal(f.portfolio.revision, 1);
  assert.equal(f.cacheWrites.length, 1);
  assert.equal(f.session.state.errorCode, "ACCOUNT_CHANGED");
  await assert.rejects(f.store.read(), { code: "ACCOUNT_CHANGED" });
});

test("unowned, malformed or mismatched read responses never update state or recovery", async () => {
  for (const envelope of [
    { book: initialBook(), revision: 1, updatedAt: new Date(NOW).toISOString() },
    { book: initialBook(), revision: 1, updatedAt: new Date(NOW).toISOString(), userId: "user-b" },
    { book: null, revision: 3, updatedAt: null, userId: "user-a" },
    { book: { unsupported: true }, revision: 1, updatedAt: new Date(NOW).toISOString(), userId: "user-a" }
  ]) {
    const f = fixture({ before: ({ path }) => path === "/api/portfolio" ? response(envelope) : undefined });
    await assert.rejects(f.store.read());
    assert.equal(f.cacheWrites.length, 0);
    assert.equal(f.browserReads, 0);
  }
});

test("a recovery cache failure cannot turn an already committed cloud save into a failed edit", async () => {
  const f = fixture({ cacheError: true });
  await f.store.read();
  assert.deepEqual(await f.store.write(initialBook(), { expectedUpdatedAt: null }), initialBook());
  assert.equal(f.portfolio.revision, 1);
  assert.match(f.session.state.message, /recovery copy/);
});

test("cloud size limits count UTF-8 request bytes and reject before replacing the saved book", async () => {
  const f = fixture({ book: initialBook() });
  const saved = await f.store.read();
  const oversized = { ...editBook(saved), legacyPortfolioInput: "€".repeat(400000) };
  await assert.rejects(f.store.write(oversized, { expectedUpdatedAt: saved.updatedAt }), { code: "TOO_LARGE" });
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 0);
  assert.deepEqual(f.portfolio.book, initialBook());
  assert.equal(f.cacheWrites.length, 1);
});

test("an unsaved cloud watchlist is distinct from an intentionally empty list and never auto-overwrites defaults", async () => {
  const f = fixture();
  assert.equal(await f.watchlistStore.read(), null);
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 0);
  assert.deepEqual(await f.watchlistStore.write([], { expectedTickers: ["AAPL"] }), []);
  assert.deepEqual(await f.watchlistStore.read(), []);
  assert.equal(f.watchlist.revision, 1);
});

test("watchlist save ordering and stale-device protection preserve the confirmed list", async () => {
  const f = fixture({ tickers: ["AAPL"] });
  await f.watchlistStore.read();
  const first = f.watchlistStore.write(["AAPL", "MSFT"], { expectedTickers: ["AAPL"] });
  const second = f.watchlistStore.write(["AAPL", "TSM"], { expectedTickers: ["AAPL"] });
  assert.deepEqual(await first, ["AAPL", "MSFT"]);
  await assert.rejects(second, { code: "CONFLICT" });
  assert.deepEqual(f.watchlist.tickers, ["AAPL", "MSFT"]);
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 1);
});

test("invalid watchlists fail before any request and retain the existing product limit", async () => {
  const f = fixture({ tickers: ["AAPL"] });
  await f.watchlistStore.read();
  for (const tickers of [["AAPL", "AAPL"], ["bad ticker"], ["BTC-USD"], Array.from({ length: 91 }, (_, index) => `T${index}`)]) await assert.rejects(f.watchlistStore.write(tickers), { code: "INVALID_WATCHLIST" });
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 0);
});

test("a successful portfolio request cannot hide an outstanding watchlist failure", async () => {
  const f = fixture({ book: initialBook(), before: ({ path }) => path === "/api/watchlist" ? response({}, 503) : undefined });
  await assert.rejects(f.watchlistStore.read());
  await f.store.read();
  assert.equal(f.session.state.status, "error");
  assert.match(f.session.state.message, /Cloud storage is unavailable/);
});
