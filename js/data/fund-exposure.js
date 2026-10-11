import snapshot from "./fund-holdings-snapshot.js";
import { normalizeVanguardFund } from "./vanguard-holdings.js";
import { usesCloudMarket } from "./cloud-mode.js";

// Public fund weights only. This cache never contains a personal portfolio.
export const VWCE_EXPOSURE = snapshot;
let current = snapshot, pending = null, retryAt = 0;
export function getFundExposures({ now = Date.now() } = {}) {
  const valid = normalizeVanguardFund(current, {now});
  return valid ? [valid] : [];
}
export function loadFundExposures() {
  if (!usesCloudMarket()) return Promise.resolve(getFundExposures());
  if (!pending && Date.now() >= retryAt) {
    retryAt = Date.now() + 6 * 3600000;
    pending = (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 55000);
      try {
        const response = await fetch("/api/fund-holdings", { credentials: "same-origin", cache: "no-cache", signal: controller.signal });
        if (!response.ok) throw new Error("Fund data unavailable.");
        const value = await response.json(), next = normalizeVanguardFund(value?.funds?.[0]);
        if (!next || value.funds.length !== 1) throw new Error("Invalid fund data.");
        if (!normalizeVanguardFund(current) || next.asOf >= current.asOf) current = next;
      } catch { retryAt = Date.now() + 5 * 60000; }
      finally { clearTimeout(timer); pending = null; }
      return getFundExposures();
    })();
  }
  return pending || Promise.resolve(getFundExposures());
}
