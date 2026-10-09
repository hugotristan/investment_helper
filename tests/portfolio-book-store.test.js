import assert from "node:assert/strict";
import { test } from "node:test";
import { createPortfolioBook, normalizeTransaction } from "../js/analysis/portfolio-ledger.js";
import { createPortfolioBookStore, serializePortfolioBackup, parsePortfolioBackup,
  PORTFOLIO_DATABASE_NAME, PORTFOLIO_DATABASE_VERSION, PORTFOLIO_STORE_NAME, PORTFOLIO_BOOK_KEY,
  MAX_PORTFOLIO_BACKUP_BYTES, MAX_PORTFOLIO_TRANSACTIONS } from "../js/data/portfolio-book-store.js";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => value === undefined ? undefined : structuredClone(value);
function book() {
  return createPortfolioBook({ holdings: [
    { id: "apple-opening", kind: "position", ticker: "AAPL", label: "Apple", shares: 2, averageCost: 100, currency: "USD" },
    { id: "legacy-opening", kind: "manual", ticker: "SWRD", label: "Legacy fund", amount: 300, status: "down", currency: "EUR" }
  ], legacyPortfolioInput: "SWRD | Legacy fund | 300 | down", baseCurrency: "EUR", startDate: "2026-10-01", now: NOW - 86400000 });
}

// This fake has one database and serial transactions on its one object store.
// Request success stages a put; only commit changes the persisted Map. Tests can
// hold a successful request open or abort it before the transaction completes.
function fakeIndexedDB({ initial, manualCommit = false, blocked = false, openError, quota = false, abortAfterSuccess = false } = {}) {
  const values = new Map(initial === undefined ? [] : [[PORTFOLIO_BOOK_KEY, clone(initial)]]);
  const names = new Set(initial === undefined ? [] : [PORTFOLIO_STORE_NAME]);
  const transactions = [];
  const pending = [];
  const connections = [];
  const opens = [];
  let active = null;
  let blockedRequest = null;
  let version = initial === undefined ? 0 : PORTFOLIO_DATABASE_VERSION;

  function advance() {
    if (active || !pending.length) return;
    active = pending.shift();
    active.start();
  }
  function transaction(mode) {
    let started = false;
    let ended = false;
    let outstanding = 0;
    let staged;
    const requests = [];
    const tx = { mode, error: null,
      objectStore(name) {
        assert.equal(name, PORTFOLIO_STORE_NAME);
        return {
          get(key) { return enqueue((request) => { request.result = clone(values.get(key)); }); },
          put(value, key) {
            const detached = clone(value);
            return enqueue((request) => {
              if (quota) throw new DOMException("Quota reached", "QuotaExceededError");
              staged = { key, value: detached };
              request.result = key;
            });
          }
        };
      },
      abort() {
        if (ended) throw new DOMException("Inactive transaction", "InvalidStateError");
        ended = true;
        tx.error ||= new DOMException("Aborted", "AbortError");
        queueMicrotask(() => { tx.onabort?.(); release(); });
      },
      commit() {
        assert.equal(outstanding, 0, "A pending request cannot be committed");
        if (ended) return;
        ended = true;
        if (staged) values.set(staged.key, clone(staged.value));
        tx.oncomplete?.();
        release();
      },
      start() { started = true; requests.splice(0).forEach((run) => queueMicrotask(run)); }
    };
    function release() {
      if (active === tx) active = null;
      else { const index = pending.indexOf(tx); if (index >= 0) pending.splice(index, 1); }
      advance();
    }
    function enqueue(operation) {
      const request = {};
      outstanding += 1;
      const run = () => {
        if (ended) return;
        try { operation(request); request.onsuccess?.(); }
        catch (error) { request.error = error; tx.error = error; request.onerror?.(); if (!ended) tx.abort(); }
        outstanding -= 1;
        if (!ended && outstanding === 0 && !manualCommit) queueMicrotask(() => {
          if (ended || outstanding) return;
          if (abortAfterSuccess && mode === "readwrite") tx.abort();
          else tx.commit();
        });
      };
      if (started) queueMicrotask(run);
      else requests.push(run);
      return request;
    }
    transactions.push(tx);
    pending.push(tx);
    queueMicrotask(advance);
    return tx;
  }
  function connection() {
    const db = { closed: false, objectStoreNames: { contains: (name) => names.has(name) },
      createObjectStore(name) { names.add(name); return {}; },
      transaction(name, mode) { assert.equal(name, PORTFOLIO_STORE_NAME); assert.equal(db.closed, false); return transaction(mode); },
      close() { db.closed = true; }
    };
    connections.push(db);
    return db;
  }
  function succeed(request) {
    request.result = connection();
    request.transaction = { abort() {} };
    if (version === 0) { request.onupgradeneeded?.(); version = PORTFOLIO_DATABASE_VERSION; }
    request.onsuccess?.();
  }
  return { values, transactions, connections, opens,
    open(name, requestedVersion) {
      opens.push({ name, version: requestedVersion });
      const request = {};
      queueMicrotask(() => {
        if (blocked) { blockedRequest = request; request.onblocked?.(); }
        else if (openError) { request.error = openError; request.onerror?.(); }
        else succeed(request);
      });
      return request;
    },
    finishBlockedOpen() { succeed(blockedRequest); }
  };
}

test("the single portfolio record round-trips without sharing caller objects", async () => {
  const idb = fakeIndexedDB();
  const store = createPortfolioBookStore({ indexedDB: idb, now: NOW });
  assert.equal(await store.read(), null);
  const original = book();
  const writing = store.write(original, { expectedUpdatedAt: null });
  original.openingHoldings[0].label = "Changed after save started";
  const saved = await writing;
  assert.equal(saved.openingHoldings[0].label, "Apple");
  const restored = await store.read();
  assert.deepEqual(restored, saved);
  restored.openingHoldings[0].label = "Changed after read";
  assert.equal((await store.read()).openingHoldings[0].label, "Apple");
  assert.equal(idb.values.size, 1);
  assert.ok(idb.opens.every((open) => open.name === PORTFOLIO_DATABASE_NAME && open.version === PORTFOLIO_DATABASE_VERSION));
  assert.ok(idb.connections.every((db) => db.closed));
  assert.equal(store.lastError, null);
});

test("save waits for commit rather than treating request success as persistence", async () => {
  const idb = fakeIndexedDB({ manualCommit: true });
  const store = createPortfolioBookStore({ indexedDB: idb, now: NOW });
  let completed = false;
  const saving = store.write(book(), { expectedUpdatedAt: null }).then((value) => { completed = true; return value; });
  await tick();
  assert.equal(completed, false);
  assert.equal(idb.values.size, 0);
  idb.transactions[0].commit();
  assert.deepEqual(await saving, book());
  assert.equal(idb.values.size, 1);
});

test("abort after successful put leaves the previous book intact", async () => {
  const original = book();
  const idb = fakeIndexedDB({ initial: original, abortAfterSuccess: true });
  const store = createPortfolioBookStore({ indexedDB: idb, now: NOW });
  const changed = { ...original, updatedAt: new Date(NOW).toISOString(), settings: { ...original.settings, baseCurrency: "USD" } };
  await assert.rejects(store.write(changed, { expectedUpdatedAt: original.updatedAt }), { code: "ABORTED" });
  assert.deepEqual(idb.values.get(PORTFOLIO_BOOK_KEY), original);
  assert.equal(store.lastError.code, "ABORTED");
});

test("atomic revision checks reject a second tab's stale save or initial migration", async () => {
  const initial = book();
  const idb = fakeIndexedDB({ initial });
  const first = createPortfolioBookStore({ indexedDB: idb, now: NOW });
  const second = createPortfolioBookStore({ indexedDB: idb, now: NOW });
  const updated = { ...initial, updatedAt: new Date(NOW - 60000).toISOString(), settings: { ...initial.settings, baseCurrency: "USD" } };
  const competing = { ...initial, updatedAt: new Date(NOW).toISOString(), settings: { ...initial.settings, baseCurrency: "GBP" } };
  const outcomes = await Promise.allSettled([
    first.write(updated, { expectedUpdatedAt: initial.updatedAt }),
    second.write(competing, { expectedUpdatedAt: initial.updatedAt })
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(outcomes[1].reason.code, "CONFLICT");
  await assert.rejects(second.write(competing, { expectedUpdatedAt: null }), { code: "CONFLICT" });
  assert.deepEqual(await second.read(), updated);
});

test("quota and unavailable storage never touch legacy browser state", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const indexedDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let legacyWrites = 0;
  const legacy = new Map([["today-invest-model-state", "original holdings and settings"]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => legacy.get(key), setItem() { legacyWrites += 1; }, removeItem() { legacyWrites += 1; }, clear() { legacyWrites += 1; }
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else delete globalThis.localStorage;
    if (indexedDescriptor) Object.defineProperty(globalThis, "indexedDB", indexedDescriptor); else delete globalThis.indexedDB;
  });
  const original = book();
  const idb = fakeIndexedDB({ initial: original, quota: true });
  const quota = createPortfolioBookStore({ indexedDB: idb, now: NOW });
  await assert.rejects(quota.write(original, { expectedUpdatedAt: original.updatedAt }), { code: "QUOTA_EXCEEDED" });
  assert.deepEqual(idb.values.get(PORTFOLIO_BOOK_KEY), original);
  const absent = createPortfolioBookStore({ indexedDB: undefined, now: NOW });
  await assert.rejects(absent.read(), { code: "UNAVAILABLE" });
  await assert.rejects(absent.write(original), { code: "UNAVAILABLE" });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, get() { throw new DOMException("Blocked by privacy settings", "SecurityError"); } });
  const blockedAccess = createPortfolioBookStore({ now: NOW });
  await assert.rejects(blockedAccess.read(), { code: "UNAVAILABLE" });
  assert.equal(legacyWrites, 0);
  assert.equal(legacy.get("today-invest-model-state"), "original holdings and settings");
});

test("blocked opens reject and close a connection that succeeds later", async () => {
  const idb = fakeIndexedDB({ blocked: true });
  const store = createPortfolioBookStore({ indexedDB: idb, now: NOW });
  await assert.rejects(store.read(), { code: "BLOCKED" });
  idb.finishBlockedOpen();
  assert.ok(idb.connections.every((db) => db.closed));
  assert.equal(idb.values.size, 0);
});

test("open errors and missing completion are explicit rather than empty portfolios", async () => {
  const denied = createPortfolioBookStore({ indexedDB: fakeIndexedDB({ openError: new DOMException("Denied", "SecurityError") }), now: NOW });
  await assert.rejects(denied.read(), { code: "UNAVAILABLE" });
  const idb = fakeIndexedDB({ initial: book(), manualCommit: true });
  const hanging = createPortfolioBookStore({ indexedDB: idb, now: NOW, transactionTimeoutMs: 10 });
  await assert.rejects(hanging.write(book(), { expectedUpdatedAt: book().updatedAt }), { code: "TRANSACTION_TIMEOUT" });
  assert.deepEqual(idb.values.get(PORTFOLIO_BOOK_KEY), book());
});

test("invalid persisted books reject reads and checked replacement without deleting anything", async () => {
  const invalid = { ...book(), schemaVersion: 99 };
  const oversold = { ...book(), transactions: [{ id: "oversell", type: "sell", date: "2026-10-09", currency: "USD", ticker: "AAPL", quantity: 3, price: 100, amount: 300, fee: 0 }] };
  for (const persisted of [invalid, oversold]) {
    const idb = fakeIndexedDB({ initial: persisted });
    const store = createPortfolioBookStore({ indexedDB: idb, now: NOW });
    await assert.rejects(store.read(), { code: "INVALID_BOOK" });
    await assert.rejects(store.write(book(), { expectedUpdatedAt: null }), { code: "INVALID_BOOK" });
    assert.deepEqual(idb.values.get(PORTFOLIO_BOOK_KEY), persisted);
  }
  const newStore = createPortfolioBookStore({ indexedDB: fakeIndexedDB(), now: NOW });
  await assert.rejects(newStore.write(invalid), { code: "INVALID_BOOK" });
});

test("portfolio backups preserve the ledger, opening positions, legacy values, and settings only", () => {
  const original = book();
  original.transactions = [
    { id: "cash-opening", type: "opening_cash", date: "2026-10-01", currency: "USD", amount: 500 },
    { id: "apple-buy", type: "buy", date: "2026-10-03", currency: "USD", ticker: "AAPL", quantity: 1, price: 105, fee: 1, note: "Original trade note" }
  ].map((input) => {
    const normalized = normalizeTransaction(input, { startDate: original.settings.startDate, now: NOW });
    assert.equal(normalized.ok, true);
    return normalized.transaction;
  });
  const serialized = serializePortfolioBackup(original, { now: NOW });
  const envelope = JSON.parse(serialized);
  assert.deepEqual(Object.keys(envelope).sort(), ["app", "backupVersion", "exportedAt", "portfolio"].sort());
  assert.equal(envelope.app, "investment-helper");
  assert.equal(envelope.backupVersion, 1);
  assert.equal(envelope.exportedAt, new Date(NOW).toISOString());
  assert.deepEqual(parsePortfolioBackup(serialized, { now: NOW }), { ok: true, book: original, error: null });
  assert.equal(parsePortfolioBackup(serialized, { now: "2026-10-09" }).ok, true);
  assert.equal(envelope.portfolio.transactions[1].note, "Original trade note");
  assert.equal(envelope.portfolio.transactions[1].amount, 105);
  assert.equal(serialized.includes("marketCache"), false);
  assert.equal(serialized.includes("recommendations"), false);
  assert.throws(() => serializePortfolioBackup({ ...original, watchlist: ["SECRET"] }, { now: NOW }), /unsupported fields/);
});

test("wrong versions, malformed dates, private extras, and invalid full books cannot be imported", () => {
  const envelope = JSON.parse(serializePortfolioBackup(book(), { now: NOW }));
  const invalid = ["{", "null", JSON.stringify(book()),
    JSON.stringify({ ...envelope, app: "different-app" }), JSON.stringify({ ...envelope, backupVersion: 2 }),
    JSON.stringify({ ...envelope, exportedAt: "not-a-date" }), JSON.stringify({ ...envelope, marketCache: {} }),
    JSON.stringify({ ...envelope, portfolio: { ...book(), id: "different-book" } }),
    JSON.stringify({ ...envelope, portfolio: { ...book(), settings: { ...book().settings, watchlist: [] } } }),
    JSON.stringify({ ...envelope, portfolio: { ...book(), openingHoldings: [{ ...book().openingHoldings[0], shares: -1 }] } })
  ];
  for (const input of invalid) {
    const result = parsePortfolioBackup(input, { now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.book, null);
    assert.ok(result.error);
  }
});

test("backup limits use UTF-8 bytes and reject oversized ledgers before import", () => {
  const envelope = JSON.parse(serializePortfolioBackup(book(), { now: NOW }));
  const unicode = JSON.stringify({ ...envelope, portfolio: { ...book(), legacyPortfolioInput: "€".repeat(Math.ceil(MAX_PORTFOLIO_BACKUP_BYTES / 3)) } });
  assert.ok(unicode.length < MAX_PORTFOLIO_BACKUP_BYTES);
  assert.match(parsePortfolioBackup(unicode, { now: NOW }).error, /5 MiB/);
  const oversized = JSON.stringify({ ...envelope, portfolio: { ...book(), transactions: Array(MAX_PORTFOLIO_TRANSACTIONS + 1).fill({}) } });
  assert.match(parsePortfolioBackup(oversized, { now: NOW }).error, /10,000 transactions/);
  assert.equal(parsePortfolioBackup("x".repeat(MAX_PORTFOLIO_BACKUP_BYTES + 1)).ok, false);
});
