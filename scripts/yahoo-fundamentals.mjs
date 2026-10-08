import { YAHOO_ANNUAL_TYPES } from "../js/analysis/yahoo-fundamentals.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export class YahooFetchError extends Error {
  constructor(message, status = 0) { super(message); this.name = "YahooFetchError"; this.status = status; }
}

// Serialize concurrent callers so the same provider always sees paced requests.
export function createYahooFetcher({ fetchImpl = fetch, now = Date.now, wait = sleep, spacingMs = 500, timeoutMs = 15000 } = {}) {
  let queue = Promise.resolve();
  let lastStarted = -Infinity;
  return function fetchYahooFinancials(ticker) {
    const run = queue.then(() => fetchTicker(ticker));
    queue = run.catch(() => {});
    return run;
  };

  async function fetchTicker(value) {
    const ticker = String(value || "").trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker)) throw new YahooFetchError("Yahoo Finance ticker is invalid.");
    const acquired = now();
    if (!Number.isFinite(acquired)) throw new YahooFetchError("Yahoo Finance request date is invalid.");
    const url = new URL(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}`);
    url.search = new URLSearchParams({ symbol: ticker, type: YAHOO_ANNUAL_TYPES.join(","),
      period1: String(Math.floor(Date.UTC(new Date(acquired).getUTCFullYear() - 5, 0, 1) / 1000)),
      period2: String(Math.floor(acquired / 1000)) });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const delay = Math.max(0, spacingMs - (now() - lastStarted));
      if (delay) await wait(delay);
      lastStarted = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let retryDelay = 1000;
      try {
        const response = await fetchImpl(url.href, { headers: { Accept: "application/json" }, signal: controller.signal });
        if (!response.ok) {
          const seconds = Number(response.headers?.get?.("retry-after"));
          if (seconds > 0) retryDelay = Math.min(5000, Math.max(1000, seconds * 1000));
          throw new YahooFetchError(`Yahoo Finance request returned HTTP ${response.status}.`, response.status);
        }
        let json;
        try { json = await response.json(); }
        catch (error) {
          if (error?.name === "AbortError") throw error;
          throw new YahooFetchError("Yahoo Finance returned malformed financial data.");
        }
        if (json?.timeseries?.error || !Array.isArray(json?.timeseries?.result)) throw new YahooFetchError("Yahoo Finance returned unavailable or malformed financial data.");
        return json;
      } catch (error) {
        const transportFailure = !(error instanceof YahooFetchError);
        const failure = error instanceof YahooFetchError ? error : new YahooFetchError(error?.name === "AbortError" ? "Yahoo Finance request timed out." : "Yahoo Finance request failed.");
        if (attempt || !(transportFailure || failure.status === 429 || failure.status >= 500 && failure.status <= 599)) throw failure;
      } finally { clearTimeout(timer); }
      await wait(retryDelay);
    }
  }
}
