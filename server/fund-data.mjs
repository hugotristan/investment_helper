import { VWCE_EXPOSURE } from "../js/data/fund-exposure.js";
import { fetchVanguardFund, normalizeVanguardFund } from "../js/data/vanguard-holdings.js";

// Isolate-local public cache. Dates come from Vanguard, never from cache refresh.
export function createFundData({ fetchImpl = (url, init) => globalThis.fetch(url, init), now = Date.now } = {}) {
  let current = VWCE_EXPOSURE, pending = null, retryAt = 0;
  const clock = () => typeof now === "function" ? now() : now;
  async function loadFunds() {
    const time = clock();
    if (!pending && time >= retryAt) {
      retryAt = time + 6 * 3600000;
      pending = (async () => {
        try {
          const latest = await fetchVanguardFund({fetchImpl,now:time});
          const previous = normalizeVanguardFund(current,{now:time});
          if (!previous || latest.asOf >= previous.asOf) current=latest;
        } catch { retryAt=time+5*60000; }
        finally {pending=null;}
      })();
    }
    if (pending) await pending;
    const valid=normalizeVanguardFund(current,{now:clock()});
    return valid ? [valid] : [];
  }
  return {loadFunds};
}
