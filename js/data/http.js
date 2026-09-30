export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { status: "rejected", reason: error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export async function fetchWithRetry(url, options = {}) {
  const {
    timeoutMs = 10000,
    type = "text",
    attempts = 2,
    delayMs = 900
  } = options;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchWithTimeout(url, timeoutMs, type);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(delayMs * attempt);
    }
  }

  throw lastError || new Error("Fetch failed");
}

export function fetchWithTimeout(url, timeoutMs, type = "text") {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const headers = type === "json" ? { Accept: "application/json" } : {};
  return fetch(url, { cache: "no-store", headers, signal: controller.signal }).finally(() => window.clearTimeout(timeout));
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
