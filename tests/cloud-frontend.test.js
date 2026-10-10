import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPortfolioBook } from "../js/analysis/portfolio-ledger.js";

const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", innerHTML: "", hidden: false, disabled: false, dataset: {}, listeners: {},
    setAttribute() {}, focus() {}, reset() {}, addEventListener(type, callback) { this.listeners[type] = callback; },
    querySelector(selector) { return selector === "button" ? node(`${id}-button`) : null; }, querySelectorAll() { return []; },
    closest() { return node("watchlistEditor"); } });
  return nodes.get(id);
}
const doc = { documentElement: { dataset: { cloudMode: "sites" } }, visibilityState: "visible", getElementById: node,
  querySelectorAll: () => [], addEventListener() {} };
globalThis.document = doc;
globalThis.window = { addEventListener() {}, setTimeout, clearTimeout };
const browserSnapshot = JSON.stringify({ tickerInput: "PRIVATE", myPortfolioInput: "private legacy portfolio", holdings: [{ ticker: "PRIVATE", amount: 9000 }], screenerSort: "momentum" });
let localSaved = browserSnapshot;
let localWrites = 0;
globalThis.localStorage = { getItem: () => localSaved, setItem(key, value) { localWrites++; localSaved = value; } };
let remote = { tickers: null, revision: 0, updatedAt: null, userId: "user-a" };
let intercept;
const requests = [];
globalThis.fetch = async (path, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ path, method: options.method, body });
  const override = await intercept?.(path, options, body);
  if (override) return override;
  if (path === "/api/session") return new Response(JSON.stringify({ cloud: true, storageAvailable: true, userId: "user-a" }));
  if (path === "/api/watchlist") {
    if (options.method === "PUT") {
      if (body.expectedRevision !== remote.revision) return new Response("{}", { status: 409 });
      remote = { tickers: [...body.tickers], revision: remote.revision + 1, updatedAt: "2026-10-10T12:00:00.000Z", userId: "user-a" };
    }
    return new Response(JSON.stringify(remote));
  }
  throw new Error(`Unexpected test request ${path}`);
};
const { state, persist, loadPrivateWatchlist, savePrivateWatchlist, defaults } = await import("../js/storage.js");
const { cloudSession } = await import("../js/data/cloud-portfolio-store.js");
const { initializeWatchlist, bindWatchlistEvents, refreshWatchlistFromCloud } = await import("../js/features/watchlist.js");
const { createPortfolioBookController } = await import("../js/features/portfolio-book.js");
const { initializeCloudSync } = await import("../js/features/cloud-sync.js");
const { getActivePortfolioBook, setActivePortfolioBook } = await import("../js/portfolio-state.js");

test("Sites preferences hide old browser private fields while preserving their original recovery bytes", () => {
  assert.equal(state.tickerInput, defaults.tickerInput);
  assert.deepEqual(state.holdings, []);
  assert.equal(state.myPortfolioInput, "");
  assert.equal(localSaved, browserSnapshot);
  state.screenerSort = "score";
  persist();
  const saved = JSON.parse(localSaved);
  assert.equal(saved.tickerInput, "PRIVATE");
  assert.equal(saved.myPortfolioInput, "private legacy portfolio");
  assert.deepEqual(saved.holdings, [{ ticker: "PRIVATE", amount: 9000 }]);
  assert.equal(saved.screenerSort, "score");
});

test("watchlist startup reads the cloud before adopting its values and does not publish the browser default", async () => {
  remote = { tickers: ["MSFT", "AAPL"], revision: 4, updatedAt: "2026-10-10T12:00:00.000Z", userId: "user-a" };
  requests.length = 0;
  await loadPrivateWatchlist();
  assert.equal(state.tickerInput, "MSFT, AAPL");
  assert.equal(requests.some((item) => item.method === "PUT"), false);
});

test("a failed watchlist edit preserves confirmed state and never falls back to browser writes", async () => {
  const original = state.tickerInput;
  const writes = localWrites;
  intercept = (path, options) => path === "/api/watchlist" && options.method === "PUT" ? new Response("{}", { status: 503 }) : undefined;
  await assert.rejects(savePrivateWatchlist(["MSFT"]), /save could not be confirmed/);
  assert.equal(state.tickerInput, original);
  assert.equal(localWrites, writes);
  intercept = null;
  await loadPrivateWatchlist();
});

test("watchlist remove waits for cloud confirmation; auto refresh preserves an unsaved editor", async () => {
  await initializeWatchlist();
  let changes = 0;
  bindWatchlistEvents(() => { changes++; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  intercept = async (path, options) => { if (path === "/api/watchlist" && options.method === "PUT") await gate; };
  const button = { dataset: { removeTicker: "AAPL" } };
  const pending = node("watchlistChips").listeners.click({ target: { closest: () => button } });
  assert.equal(state.tickerInput, "MSFT, AAPL");
  assert.equal(changes, 0);
  release();
  await pending;
  assert.equal(state.tickerInput, "MSFT");
  assert.equal(changes, 1);
  intercept = null;
  node("tickerInput").value = "TSM";
  node("tickerInput").listeners.input();
  remote.tickers = ["MSFT", "NVDA"];
  const requestCount = requests.length;
  assert.equal(await refreshWatchlistFromCloud(), false);
  assert.equal(requests.length, requestCount);
  assert.equal(node("tickerInput").value, "TSM");
  assert.equal(node("watchlistDiscardEdits").hidden, false);
  await node("watchlistDiscardEdits").listeners.click();
  assert.equal(state.tickerInput, "MSFT, NVDA");
  assert.equal(node("tickerInput").value, "MSFT, NVDA");
  assert.equal(changes, 2);
});

test("an empty cloud portfolio explains backup migration and its restore preview names all devices", async () => {
  setActivePortfolioBook(null);
  const store = { mode: "cloud", async read() { return null; } };
  const controller = createPortfolioBookController({ document: doc, store, subscribe: false });
  await controller.initialize();
  assert.match(node("portfolioBookStatus").textContent, /export a backup from the GitHub app/);
  assert.equal(getActivePortfolioBook(), null);
});

test("a native account failure clears active private data and hides every private view", async () => {
  const book = createPortfolioBook({ baseCurrency: "EUR", startDate: "2026-10-01", now: Date.parse("2026-10-10T12:00:00.000Z") });
  setActivePortfolioBook(book);
  state.tickerInput = "MSFT";
  state.holdings = [{ ticker: "MSFT", shares: 3 }];
  let notify;
  const session = { isCloud: true, subscribe(listener) { notify = listener; listener({ mode: "cloud", status: "ready", authMode: "chatgpt" }); } };
  initializeCloudSync({ document: doc, window: globalThis.window, session, store: {}, reloadPortfolio: async () => {}, reloadWatchlist: async () => {} });
  notify({ mode: "cloud", status: "error", authMode: "chatgpt", errorCode: "ACCOUNT_CHANGED", message: "Reload the app." });
  assert.equal(getActivePortfolioBook(), null);
  assert.equal(state.tickerInput, "");
  assert.deepEqual(state.holdings, []);
  assert.equal(doc.documentElement.dataset.privateBlocked, "true");
  assert.equal(node("cloudStorageStatus").textContent, "Cloud sync unavailable");
  assert.equal(node("cloudStorageMessage").textContent, "Reload the app.");
  assert.equal(node("cloudSignOut").hidden, false);
});

test("password sessions expose only a server POST lock action and leave the GitHub copy unchanged", async () => {
  const session = { isCloud: true, subscribe(listener) { listener({ mode: "cloud", status: "ready", authMode: "password" }); } };
  initializeCloudSync({ document: doc, window: globalThis.window, session, store: {}, reloadPortfolio: async () => {}, reloadWatchlist: async () => {} });
  assert.equal(node("cloudPasswordSignOut").hidden, false);
  assert.equal(node("cloudSignOut").hidden, true);
  assert.equal(node("cloudSignIn").hidden, true);
  const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(source, /<form\b[^>]*id="cloudPasswordSignOut"[^>]*action="\/logout"[^>]*method="post"[^>]*target="_top"[^>]*hidden>/);
  assert.match(source, /<a\b[^>]*id="cloudSignIn"[^>]*href="\/login"[^>]*target="_top"[^>]*hidden>/);
  const browserSession = { isCloud: false, subscribe(listener) { listener({ mode: "browser", status: "ready", authMode: null }); } };
  initializeCloudSync({ document: doc, window: globalThis.window, session: browserSession });
  for (const id of ["cloudPasswordSignOut", "cloudSignOut", "cloudSignIn", "cloudReload"]) assert.equal(node(id).hidden, true);
});

test("an expired password session clears private data and offers a top-level unlock link", async () => {
  setActivePortfolioBook(createPortfolioBook({ baseCurrency: "EUR", startDate: "2026-10-01", now: Date.parse("2026-10-10T12:00:00.000Z") }));
  state.tickerInput = "MSFT";
  state.myPortfolioInput = "MSFT:3";
  state.holdings = [{ ticker: "MSFT", shares: 3 }];
  let notify;
  const session = { isCloud: true, subscribe(listener) { notify = listener; listener({ mode: "cloud", status: "ready", authMode: "password" }); } };
  initializeCloudSync({ document: doc, window: globalThis.window, session, store: {}, reloadPortfolio: async () => {}, reloadWatchlist: async () => {} });
  notify({ mode: "cloud", status: "error", authMode: "password", errorCode: "UNAUTHORIZED", message: "Your session expired. Unlock the app again." });
  assert.equal(getActivePortfolioBook(), null);
  assert.equal(state.tickerInput, "");
  assert.equal(state.myPortfolioInput, "");
  assert.deepEqual(state.holdings, []);
  assert.equal(doc.documentElement.dataset.privateBlocked, "true");
  assert.equal(node("cloudSignIn").hidden, false);
  assert.equal(node("cloudSignIn").href, "/login");
  assert.equal(node("cloudSignIn").textContent, "Unlock app");
  for (const id of ["cloudSignOut", "cloudPasswordSignOut", "cloudReload"]) assert.equal(node(id).hidden, true);
  notify({ mode: "cloud", status: "ready", authMode: "password", errorCode: null, message: "" });
  assert.equal(doc.documentElement.dataset.privateBlocked, "false");
  assert.equal(node("cloudSignIn").hidden, true);
  assert.equal(node("cloudPasswordSignOut").hidden, false);
});

test("a password session that expired before initialization still offers the unlock route", () => {
  const session = { isCloud: true, subscribe(listener) { listener({ mode: "cloud", status: "error", authMode: null, errorCode: "UNAUTHORIZED", message: "Your session expired." }); } };
  initializeCloudSync({ document: doc, window: globalThis.window, session, store: {}, reloadPortfolio: async () => {}, reloadWatchlist: async () => {} });
  assert.equal(node("cloudSignIn").hidden, false);
  assert.equal(node("cloudSignIn").href, "/login");
  assert.equal(node("cloudSignOut").hidden, true);
  assert.equal(node("cloudPasswordSignOut").hidden, true);
});
