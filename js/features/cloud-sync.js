import { cloudSession } from "../data/cloud-portfolio-store.js";
import { portfolioBookStore } from "../data/portfolio-book-store.js";
import { getActivePortfolioBook, setActivePortfolioBook } from "../portfolio-state.js";
import { state } from "../storage.js";
import { reloadPortfolioBook } from "./portfolio-book.js";
import { refreshWatchlistFromCloud } from "./watchlist.js";

export function initializeCloudSync({ document: doc = globalThis.document, window: win = globalThis.window,
  session = cloudSession, store = portfolioBookStore, reloadPortfolio = reloadPortfolioBook,
  reloadWatchlist = refreshWatchlistFromCloud } = {}) {
  const status = doc.getElementById("cloudStorageStatus");
  const detail = doc.getElementById("cloudStorageMessage");
  const reload = doc.getElementById("cloudReload");
  const signout = doc.getElementById("cloudSignOut");
  const passwordSignout = doc.getElementById("cloudPasswordSignOut");
  const signin = doc.getElementById("cloudSignIn");
  const migration = doc.getElementById("cloudMigration");
  const upload = doc.getElementById("cloudUploadBrowser");
  let busy = false;
  let browserBook = null;
  let lastChecked = 0;
  const say = (text) => { if (detail) detail.textContent = text; };
  async function showMigration() {
    if (!session.isCloud || !migration || !upload) return;
    migration.hidden = Boolean(getActivePortfolioBook());
    if (migration.hidden) return;
    try { browserBook = await store.readBrowserPortfolio?.(); } catch { browserBook = null; }
    upload.hidden = !browserBook;
  }
  session.subscribe((value) => {
    if (["ACCOUNT_CHANGED", "UNAUTHORIZED"].includes(value.errorCode)) {
      setActivePortfolioBook(null);
      state.holdings = [];
      state.myPortfolioInput = "";
      state.tickerInput = "";
      if (doc.documentElement) doc.documentElement.dataset.privateBlocked = "true";
    } else if (value.status === "ready" && doc.documentElement) doc.documentElement.dataset.privateBlocked = "false";
    if (status) status.textContent = value.mode === "browser" ? "Saved in this browser" : value.status === "ready" ? "Cloud sync" : value.status === "connecting" ? "Connecting to cloud…" : "Cloud sync unavailable";
    if (status) status.dataset.syncState = value.status;
    say(value.message);
    const expired = value.errorCode === "UNAUTHORIZED";
    if (reload) { reload.hidden = !session.isCloud || expired; reload.disabled = busy; }
    if (signout) signout.hidden = !session.isCloud || expired || value.authMode !== "chatgpt";
    if (passwordSignout) passwordSignout.hidden = !session.isCloud || expired || value.authMode !== "password";
    if (signin) {
      signin.hidden = !session.isCloud || !expired;
      signin.textContent = value.authMode === "chatgpt" ? "Sign in again" : "Unlock app";
      signin.href = value.authMode === "chatgpt" ? "/" : "/login";
    }
  });
  if (!session.isCloud) return;

  async function refresh({ retry = false } = {}) {
    if (busy) return;
    busy = true;
    if (reload) reload.disabled = true;
    try {
      await session.initialize({ retry });
      await Promise.all([reloadPortfolio(), reloadWatchlist()]);
      await showMigration();
      lastChecked = Date.now();
    } catch (error) { say(error.message); }
    finally { busy = false; if (reload) reload.disabled = false; }
  }
  reload?.addEventListener("click", () => refresh({ retry: true }));
  upload?.addEventListener("click", async () => {
    if (busy || !browserBook) return;
    busy = true;
    upload.disabled = true;
    try {
      await store.uploadBrowserPortfolio();
      await reloadPortfolio();
      await showMigration();
      say("Browser portfolio uploaded. It is now available on your other devices.");
    } catch (error) { say(error.message); }
    finally { busy = false; upload.disabled = false; }
  });
  showMigration();
  const whenVisible = () => {
    if (doc.visibilityState !== "hidden" && Date.now() - lastChecked > 15000) refresh();
  };
  win?.addEventListener("focus", whenVisible);
  doc.addEventListener("visibilitychange", whenVisible);
}
