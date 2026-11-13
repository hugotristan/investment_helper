import { usesCloudMarket } from "./cloud-mode.js";
const SNAPSHOT_URL = new URL("../../data/fundamentals.json", import.meta.url);
let cachedRequest = null;
let cacheUntil = 0;

// Read the published snapshot from this site's own base path. Browsers never
// need to call SEC endpoints or supply a third-party API key.
const tickerRequests = new Map();
export function loadFundamentalsSnapshot(ticker) {
  if (ticker && usesCloudMarket()) {
    const saved = tickerRequests.get(ticker);
    if (saved && Date.now() < saved.until) return saved.request;
    const request = fetchSnapshot(ticker);
    tickerRequests.set(ticker, {until:Date.now()+60000,request});
    if (tickerRequests.size > 100) tickerRequests.delete(tickerRequests.keys().next().value);
    return request;
  }
  if (cachedRequest && Date.now() < cacheUntil) return cachedRequest;
  cacheUntil = Date.now() + 5 * 60 * 1000;
  cachedRequest = fetchSnapshot();
  return cachedRequest;
}

async function fetchSnapshot(ticker) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(ticker ? `/api/market/fundamentals?ticker=${encodeURIComponent(ticker)}` : SNAPSHOT_URL, { cache: "no-cache", credentials: "same-origin", signal: controller.signal });
    if (!response.ok) throw new Error(`Published snapshot request returned HTTP ${response.status}.`);
    const snapshot = await response.json();
    if (snapshot?.schemaVersion !== 1 || !snapshot.byTicker || typeof snapshot.byTicker !== "object" || Array.isArray(snapshot.byTicker)) {
      throw new Error("Snapshot format is unavailable");
    }
    return snapshot;
  } catch (error) {
    // Short-lived failure caching avoids duplicate requests while still letting
    // a later detail scan recover after deployment or a temporary outage.
    cacheUntil = Date.now() + 60 * 1000;
    return { schemaVersion: 1, generatedAt: null, provider: "Company fundamentals snapshot", byTicker: {}, available: false,
      snapshotStatus: "unavailable", providerStatus: "unknown",
      reason: `The published company fundamentals snapshot is unavailable. ${error?.message || "The snapshot could not be loaded."} Financial values are not estimated.` };
  } finally {
    clearTimeout(timeout);
  }
}
