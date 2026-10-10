import { validatePortfolioBook } from "../analysis/portfolio-ledger.js";
import { isBlockedAssetTicker } from "../shared/symbols.js";

export const MAX_CLOUD_PORTFOLIO_BYTES = 1024 * 1024;
const clone = (value) => value === null ? null : JSON.parse(JSON.stringify(value));
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export class CloudStorageError extends Error {
  constructor(code, message, options) { super(message, options); this.name = "CloudStorageError"; this.code = code; }
}

export function cloudEnvironment(doc = globalThis.document) {
  return doc?.documentElement?.dataset?.cloudMode === "sites";
}

export function createCloudSession({ cloud = cloudEnvironment(), fetch: request = globalThis.fetch, timeoutMs = 12000 } = {}) {
  let session = { mode: cloud ? "cloud" : "browser", status: cloud ? "connecting" : "ready", userId: null, message: "" };
  let initializing;
  const listeners = new Set();
  const failures = new Map();
  function update(changes) {
    const { source = "session", ...fields } = changes;
    if (fields.status === "error") failures.set(source, { message: fields.message, errorCode: fields.errorCode });
    else if (fields.status === "ready") failures.delete(source);
    session = { ...session, ...fields };
    if (failures.size) {
      const failure = [...failures.values()].find((entry) => ["ACCOUNT_CHANGED", "UNAUTHORIZED"].includes(entry.errorCode)) || [...failures.values()].at(-1);
      session = { ...session, status: "error", ...failure };
    }
    for (const listener of listeners) { try { listener({ ...session }); } catch { /* UI subscribers cannot change persistence. */ } }
  }
  async function api(path, { method = "GET", body } = {}) {
    if (!cloud) throw new CloudStorageError("BROWSER_MODE", "This version saves data in your browser.");
    if (path !== "/api/session" && ["ACCOUNT_CHANGED", "UNAUTHORIZED"].includes(session.errorCode)) throw new CloudStorageError(session.errorCode, session.message);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(path, { method, credentials: "same-origin", signal: controller.signal,
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(path !== "/api/session" && session.userId ? { "X-Expected-User-Id": session.userId } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const responseUser = response.headers?.get?.("X-Portfolio-User-Id");
      if (path !== "/api/session" && responseUser && responseUser !== session.userId) throw new CloudStorageError("ACCOUNT_CHANGED", "The signed-in account changed. Reload the app before accessing portfolio data.");
      if (response.status === 401 || response.status === 403) throw new CloudStorageError("UNAUTHORIZED", "Sign in again to access your private cloud data. No changes were saved.");
      if (response.status === 409) throw new CloudStorageError("CONFLICT", "Your cloud data changed on another device. Reload its latest data before saving these edits.");
      if (response.status === 413) throw new CloudStorageError("TOO_LARGE", "The portfolio exceeds the cloud storage limit of 1 MiB. Your saved portfolio was kept.");
      if (!response.ok) throw new CloudStorageError("UNAVAILABLE", method === "PUT" ? "The cloud save could not be confirmed. Reload cloud data before retrying."
        : "Cloud storage is unavailable. Your existing data was kept; reload to retry.");
      const value = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new CloudStorageError("INVALID_RESPONSE", "Cloud storage returned an invalid response. Your browser recovery data was kept.");
      if (path !== "/api/session" && value.userId !== session.userId) throw new CloudStorageError("ACCOUNT_CHANGED", "The signed-in account changed. Reload the app before accessing portfolio data.");
      if (path !== "/api/session" && ["ACCOUNT_CHANGED", "UNAUTHORIZED"].includes(session.errorCode)) throw new CloudStorageError(session.errorCode, session.message);
      return value;
    } catch (error) {
      const failure = error instanceof CloudStorageError ? error : new CloudStorageError("UNAVAILABLE", "Could not confirm the cloud request. Reload cloud data before retrying; your saved data was kept.", { cause: error });
      update({ source: path, status: "error", errorCode: failure.code, message: failure.message });
      throw failure;
    } finally { clearTimeout(timer); }
  }
  async function initialize({ retry = false } = {}) {
    if (!cloud) return { ...session };
    if (retry) initializing = null;
    initializing ||= (async () => {
      update({ status: "connecting", message: "Connecting to private cloud storage…" });
      const value = await api("/api/session");
      if (value.cloud !== true || typeof value.userId !== "string" || !value.userId.trim() || value.storageAvailable !== true) {
        const error = new CloudStorageError("UNAVAILABLE", "Private cloud storage is not ready. Your browser data was kept; reload to retry.");
        update({ status: "error", errorCode: error.code, message: error.message });
        throw error;
      }
      if (session.userId && session.userId !== value.userId) {
        const error = new CloudStorageError("ACCOUNT_CHANGED", "The signed-in account changed. Reload the app before accessing portfolio data.");
        update({ status: "error", errorCode: error.code, message: error.message });
        throw error;
      }
      failures.delete("/api/session");
      if (retry) for (const [key, failure] of failures) if (failure.errorCode === "UNAUTHORIZED") failures.delete(key);
      update({ status: "ready", errorCode: null, userId: value.userId, message: "" });
      return { ...session };
    })();
    return initializing;
  }
  return Object.freeze({ initialize, api, update,
    subscribe(listener) { listeners.add(listener); listener({ ...session }); return () => listeners.delete(listener); },
    get state() { return { ...session }; }, get isCloud() { return cloud; } });
}

export const cloudSession = createCloudSession();

function checkedBook(book, now) {
  const result = validatePortfolioBook(book, now === undefined ? {} : { now });
  if (!result.ok) throw new CloudStorageError("INVALID_BOOK", result.error || "The portfolio book is invalid.");
  return clone(result.book);
}

function checkedEnvelope(value, property, normalize) {
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !(value.updatedAt === null || timestamp(value.updatedAt))
    || !Object.hasOwn(value, property) || (value[property] === null ? value.revision !== 0 || value.updatedAt !== null : value.revision === 0 || value.updatedAt === null)) {
    throw new CloudStorageError("INVALID_RESPONSE", "Cloud storage returned an invalid saved revision. Your previous data was kept.");
  }
  return { value: value[property] === null ? null : normalize(value[property]), revision: value.revision, updatedAt: value.updatedAt };
}

function serialQueue() {
  let tail = Promise.resolve();
  return (action) => {
    const pending = tail.then(action);
    tail = pending.catch(() => {});
    return pending;
  };
}

export function createCloudPortfolioStore({ session = cloudSession, browserStore, cacheForUser, now } = {}) {
  let current;
  let loaded = false;
  let cache;
  let lastError = null;
  const queue = serialQueue();
  const clock = () => typeof now === "function" ? now() : now;
  async function ready() {
    const account = await session.initialize();
    if (!cache && cacheForUser) cache = cacheForUser(account.userId);
  }
  async function remember(book) {
    if (!book || !cache) return;
    try { await cache.write(book); }
    catch { session.update({ status: "ready", message: "Cloud data is saved. This browser could not keep its recovery copy; export a backup." }); }
  }
  async function read() {
    try {
      await ready();
      const next = checkedEnvelope(await session.api("/api/portfolio"), "book", (book) => checkedBook(book, clock()));
      current = next;
      loaded = true;
      lastError = null;
      session.update({ source: "/api/portfolio", status: "ready", errorCode: null, message: "" });
      await remember(next.value);
      return clone(next.value);
    } catch (error) { loaded = false; lastError = error; session.update({ source: "/api/portfolio", status: "error", errorCode: error.code, message: error.message }); throw error; }
  }
  async function write(book, { expectedUpdatedAt } = {}) {
    try {
      const candidate = checkedBook(book, clock());
      if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_CLOUD_PORTFOLIO_BYTES) throw new CloudStorageError("TOO_LARGE", "The portfolio exceeds the cloud storage limit of 1 MiB. Your saved portfolio was kept.");
      await ready();
      if (!loaded) throw new CloudStorageError("NOT_LOADED", "Reload your cloud portfolio before saving. No changes were saved.");
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== (current.value?.updatedAt ?? null)) throw new CloudStorageError("CONFLICT", "Your portfolio changed. Reload its latest cloud data before saving these edits.");
      const payload = { book: candidate, expectedRevision: current.revision };
      if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_CLOUD_PORTFOLIO_BYTES) throw new CloudStorageError("TOO_LARGE", "The portfolio exceeds the cloud storage limit of 1 MiB. Your saved portfolio was kept.");
      const next = checkedEnvelope(await session.api("/api/portfolio", { method: "PUT", body: payload }), "book", (value) => checkedBook(value, clock()));
      if (!next.value || next.revision !== current.revision + 1 || JSON.stringify(next.value) !== JSON.stringify(candidate)) throw new CloudStorageError("INVALID_RESPONSE", "The cloud did not confirm this portfolio revision. Reload cloud data before retrying.");
      current = next;
      lastError = null;
      session.update({ source: "/api/portfolio", status: "ready", errorCode: null, message: "" });
      await remember(next.value);
      return clone(next.value);
    } catch (error) {
      lastError = error;
      // A timed-out PUT can have committed. Require a read before any retry.
      if (!["INVALID_BOOK", "TOO_LARGE"].includes(error.code)) loaded = false;
      session.update({ source: "/api/portfolio", status: "error", errorCode: error.code, message: error.message });
      throw error;
    }
  }
  return Object.freeze({ read: () => queue(read), write: (book, options) => {
    const detached = clone(book);
    const revision = options ? { ...options } : undefined;
    return queue(() => write(detached, revision));
  }, get mode() { return "cloud"; }, get lastError() { return lastError; },
    readBrowserPortfolio: () => browserStore?.read() ?? Promise.resolve(null),
    uploadBrowserPortfolio: () => queue(async () => {
      await read();
      if (current.value) throw new CloudStorageError("CONFLICT", "A cloud portfolio already exists. Export and review a backup before replacing it.");
      const local = await browserStore?.read();
      if (!local) throw new CloudStorageError("NO_BROWSER_BOOK", "This browser has no tracked portfolio to upload. Export a backup from the GitHub app, then restore it here.");
      return write(local, { expectedUpdatedAt: null });
    }) });
}

export function normalizeCloudWatchlist(tickers) {
  if (!Array.isArray(tickers) || tickers.length > 90 || tickers.some((ticker) => typeof ticker !== "string" || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) || isBlockedAssetTicker(ticker))
    || new Set(tickers).size !== tickers.length) throw new CloudStorageError("INVALID_WATCHLIST", "The watchlist must contain up to 90 unique stock or ETF ticker symbols.");
  return [...tickers];
}

export function createCloudWatchlistStore({ session = cloudSession } = {}) {
  const queue = serialQueue();
  let current;
  let loaded = false;
  async function read() {
    try {
      await session.initialize();
      current = checkedEnvelope(await session.api("/api/watchlist"), "tickers", normalizeCloudWatchlist);
      loaded = true;
      session.update({ source: "/api/watchlist", status: "ready", errorCode: null, message: "" });
      return current.value === null ? null : [...current.value];
    } catch (error) { loaded = false; session.update({ source: "/api/watchlist", status: "error", errorCode: error.code, message: error.message }); throw error; }
  }
  async function write(tickers, { expectedTickers } = {}) {
    const candidate = normalizeCloudWatchlist(tickers);
    try {
      await session.initialize();
      if (!loaded) throw new CloudStorageError("NOT_LOADED", "Reload your cloud watchlist before saving. No changes were saved.");
      if (expectedTickers !== undefined && current.value !== null && JSON.stringify(expectedTickers) !== JSON.stringify(current.value)) throw new CloudStorageError("CONFLICT", "Your watchlist changed. Reload cloud data before saving these edits.");
      const next = checkedEnvelope(await session.api("/api/watchlist", { method: "PUT", body: { tickers: candidate, expectedRevision: current.revision } }), "tickers", normalizeCloudWatchlist);
      if (next.value === null || next.revision !== current.revision + 1 || JSON.stringify(next.value) !== JSON.stringify(candidate)) throw new CloudStorageError("INVALID_RESPONSE", "The cloud did not confirm this watchlist revision. Reload cloud data before retrying.");
      current = next;
      session.update({ source: "/api/watchlist", status: "ready", errorCode: null, message: "" });
      return [...next.value];
    } catch (error) { loaded = false; session.update({ source: "/api/watchlist", status: "error", errorCode: error.code, message: error.message }); throw error; }
  }
  return Object.freeze({ read: () => queue(read), write: (tickers, options) => {
    const value = [...tickers];
    const revision = options ? { ...options, ...(options.expectedTickers ? { expectedTickers: [...options.expectedTickers] } : {}) } : undefined;
    return queue(() => write(value, revision));
  } });
}

export const cloudWatchlistStore = createCloudWatchlistStore();
