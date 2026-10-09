import { validatePortfolioBook } from "../analysis/portfolio-ledger.js";

export const PORTFOLIO_DATABASE_NAME = "investment-helper-portfolio-v1";
export const PORTFOLIO_DATABASE_VERSION = 1;
export const PORTFOLIO_STORE_NAME = "book";
export const PORTFOLIO_BOOK_KEY = "personal";
export const PORTFOLIO_BACKUP_VERSION = 1;
export const MAX_PORTFOLIO_BACKUP_BYTES = 5 * 1024 * 1024;
export const MAX_PORTFOLIO_TRANSACTIONS = 10000;

const BOOK_KEYS = new Set(["schemaVersion", "id", "settings", "openingHoldings", "transactions", "createdAt", "updatedAt", "legacyPortfolioInput"]);
const SETTINGS_KEYS = new Set(["baseCurrency", "startDate"]);
const BACKUP_KEYS = new Set(["app", "backupVersion", "exportedAt", "portfolio"]);

export class PortfolioStorageError extends Error {
  constructor(code, message, { cause, operation } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PortfolioStorageError";
    this.code = code;
    this.operation = operation || null;
  }
}

function storageError(error, operation, code) {
  if (error instanceof PortfolioStorageError) return error;
  if (error?.name === "QuotaExceededError") return new PortfolioStorageError("QUOTA_EXCEEDED", "Portfolio storage is full. Existing saved data was not replaced.", { cause: error, operation });
  if (["SecurityError", "NotAllowedError"].includes(error?.name)) return new PortfolioStorageError("UNAVAILABLE", "Portfolio storage is unavailable in this browser. Existing data was not replaced.", { cause: error, operation });
  if (error?.name === "AbortError") return new PortfolioStorageError("ABORTED", "The portfolio storage transaction was aborted. Existing data was not replaced.", { cause: error, operation });
  return new PortfolioStorageError(error?.code === "INVALID_BOOK" ? "INVALID_BOOK" : code,
    error?.message || `Portfolio storage ${operation} failed.`, { cause: error, operation });
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function invalidBook(message) {
  const error = new TypeError(message);
  error.code = "INVALID_BOOK";
  return error;
}

function checkedBook(book, now) {
  if (!plainRecord(book) || Object.keys(book).some((key) => !BOOK_KEYS.has(key))) throw invalidBook("The portfolio book has unsupported fields or an invalid shape.");
  if (!plainRecord(book.settings) || Object.keys(book.settings).some((key) => !SETTINGS_KEYS.has(key))) throw invalidBook("Portfolio settings have unsupported fields or an invalid shape.");
  if (!Array.isArray(book.transactions) || book.transactions.length > MAX_PORTFOLIO_TRANSACTIONS) throw invalidBook("A portfolio can contain at most 10,000 transactions.");
  const result = validatePortfolioBook(book, now === undefined ? {} : { now });
  if (!result?.ok || !result.book) throw invalidBook(result?.error || "The portfolio book is invalid.");
  // Only the model's portfolio data crosses the persistence/backup boundary.
  // The JSON copy also detaches it from edits made while IndexedDB is opening.
  const copy = Object.fromEntries([...BOOK_KEYS].map((key) => [key, result.book[key]]));
  return JSON.parse(JSON.stringify(copy));
}

function byteLength(serialized) {
  return new TextEncoder().encode(serialized).byteLength;
}

export function serializePortfolioBackup(book, { now } = {}) {
  const portfolio = checkedBook(book, now);
  const date = new Date(now === undefined ? Date.now() : now);
  if (!Number.isFinite(date.getTime())) throw new TypeError("The backup export date is invalid.");
  const serialized = JSON.stringify({ app: "investment-helper", backupVersion: PORTFOLIO_BACKUP_VERSION,
    exportedAt: date.toISOString(), portfolio }, null, 2);
  if (byteLength(serialized) > MAX_PORTFOLIO_BACKUP_BYTES) throw new TypeError("The portfolio backup exceeds the 5 MiB size limit.");
  return serialized;
}

export function parsePortfolioBackup(serialized, { now } = {}) {
  try {
    if (typeof serialized !== "string" || serialized.length > MAX_PORTFOLIO_BACKUP_BYTES
      || byteLength(serialized) > MAX_PORTFOLIO_BACKUP_BYTES) throw new TypeError("Choose a portfolio JSON backup no larger than 5 MiB.");
    const envelope = JSON.parse(serialized);
    if (!plainRecord(envelope) || Object.keys(envelope).some((key) => !BACKUP_KEYS.has(key))
      || envelope.app !== "investment-helper" || envelope.backupVersion !== PORTFOLIO_BACKUP_VERSION) throw new TypeError("This file is not a supported investment-helper portfolio backup.");
    const exported = typeof envelope.exportedAt === "string" ? new Date(envelope.exportedAt) : null;
    if (!exported || !Number.isFinite(exported.getTime()) || exported.toISOString() !== envelope.exportedAt) throw new TypeError("The backup export timestamp is invalid.");
    return { ok: true, book: checkedBook(envelope.portfolio, now), error: null };
  } catch (error) {
    return { ok: false, book: null, error: error?.message || "The portfolio backup is invalid." };
  }
}

export function createPortfolioBookStore(options = {}) {
  let indexedDB;
  let accessError;
  let lastError = null;
  try { indexedDB = Object.hasOwn(options, "indexedDB") ? options.indexedDB : globalThis.indexedDB; }
  catch (error) { accessError = error; }
  const clock = () => typeof options.now === "function" ? options.now() : options.now;
  const openTimeoutMs = Number.isFinite(options.openTimeoutMs) && options.openTimeoutMs > 0 ? options.openTimeoutMs : 8000;
  const transactionTimeoutMs = Number.isFinite(options.transactionTimeoutMs) && options.transactionTimeoutMs > 0 ? options.transactionTimeoutMs : 8000;

  function open() {
    if (accessError || !indexedDB || typeof indexedDB.open !== "function") return Promise.reject(new PortfolioStorageError("UNAVAILABLE", "IndexedDB portfolio storage is unavailable. Existing browser data was not replaced.", { cause: accessError, operation: "open" }));
    return new Promise((resolve, reject) => {
      let request;
      let finished = false;
      const timer = setTimeout(() => fail(new PortfolioStorageError("OPEN_TIMEOUT", "Portfolio storage did not open in time. Existing data was not replaced.", { operation: "open" })), openTimeoutMs);
      function fail(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(storageError(error, "open", "OPEN_FAILED"));
      }
      try { request = indexedDB.open(PORTFOLIO_DATABASE_NAME, PORTFOLIO_DATABASE_VERSION); }
      catch (error) { fail(error); return; }
      request.onblocked = () => fail(new PortfolioStorageError("BLOCKED", "Another tab is blocking portfolio storage. Close that tab and try again; existing data was not replaced.", { operation: "open" }));
      request.onerror = () => fail(request.error);
      request.onupgradeneeded = () => {
        try {
          if (finished) { request.transaction?.abort(); return; }
          const db = request.result;
          if (!db.objectStoreNames.contains(PORTFOLIO_STORE_NAME)) db.createObjectStore(PORTFOLIO_STORE_NAME);
        } catch (error) {
          try { request.transaction?.abort(); } catch { /* Already aborted. */ }
          fail(error);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (finished) { db.close(); return; }
        finished = true;
        clearTimeout(timer);
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }

  function transact(db, mode, book, expectedUpdatedAt) {
    return new Promise((resolve, reject) => {
      let transaction;
      let value = null;
      let requestSucceeded = false;
      let finished = false;
      let failure = null;
      const operation = mode === "readonly" ? "read" : "write";
      const timer = setTimeout(() => fail(new PortfolioStorageError("TRANSACTION_TIMEOUT", "Portfolio storage did not confirm completion in time. Reload saved data before trying again.", { operation }), true), transactionTimeoutMs);
      function fail(error, abort = false) {
        if (finished) return;
        failure = storageError(error, operation, operation === "read" ? "READ_FAILED" : "WRITE_FAILED");
        finished = true;
        clearTimeout(timer);
        if (abort) { try { transaction?.abort(); } catch { /* Already inactive. */ } }
        reject(failure);
      }
      function put(store) {
        const request = store.put(book, PORTFOLIO_BOOK_KEY);
        request.onsuccess = () => { requestSucceeded = true; value = book; };
        request.onerror = () => fail(request.error, true);
      }
      try {
        transaction = db.transaction(PORTFOLIO_STORE_NAME, mode);
        transaction.onerror = () => fail(transaction.error, true);
        transaction.onabort = () => fail(failure || transaction.error || new PortfolioStorageError("ABORTED", "The portfolio transaction was aborted. Existing data was not replaced.", { operation }));
        transaction.oncomplete = () => {
          if (finished) return;
          if (!requestSucceeded) { fail(new PortfolioStorageError("INCOMPLETE", "Portfolio storage finished without a confirmed request.", { operation })); return; }
          finished = true;
          clearTimeout(timer);
          resolve(value);
        };
        const store = transaction.objectStore(PORTFOLIO_STORE_NAME);
        if (mode === "readwrite" && expectedUpdatedAt === undefined) { put(store); return; }
        const request = store.get(PORTFOLIO_BOOK_KEY);
        request.onerror = () => fail(request.error, true);
        request.onsuccess = () => {
          try {
            const current = request.result === undefined ? null : checkedBook(request.result, clock());
            if (mode === "readonly") { value = current; requestSucceeded = true; return; }
            if (expectedUpdatedAt === null ? current !== null : current?.updatedAt !== expectedUpdatedAt) throw new PortfolioStorageError("CONFLICT", "The portfolio changed in another tab. Reload its latest data before saving or restoring.", { operation: "write" });
            put(store);
          } catch (error) { fail(error, true); }
        };
      } catch (error) { fail(error, true); }
    });
  }

  async function operate(mode, book, expectedUpdatedAt) {
    let db;
    try {
      const candidate = mode === "readwrite" ? checkedBook(book, clock()) : undefined;
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null && typeof expectedUpdatedAt !== "string") throw new TypeError("Expected portfolio revision must be a timestamp or null.");
      db = await open();
      const result = await transact(db, mode, candidate, expectedUpdatedAt);
      lastError = null;
      return result;
    } catch (error) {
      lastError = storageError(error, mode === "readonly" ? "read" : "write", mode === "readonly" ? "READ_FAILED" : "WRITE_FAILED");
      throw lastError;
    } finally { db?.close(); }
  }

  return Object.freeze({
    read: () => operate("readonly"),
    write: (book, { expectedUpdatedAt } = {}) => operate("readwrite", book, expectedUpdatedAt),
    get lastError() { return lastError; }
  });
}

export const portfolioBookStore = createPortfolioBookStore();
