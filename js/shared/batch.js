// Preserve input order and isolate failures while limiting active work.
export async function mapBatch(items, work, { concurrency = 2 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new RangeError("Concurrency must be 1–3.");
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await work(items[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
}

export async function retryTransient(work, { attempts = 2, delayMs = 250, retryable = () => false,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error) {
      if (attempt + 1 >= attempts || !retryable(error)) throw error;
      await wait(Math.min(2000, delayMs * 2 ** attempt));
    }
  }
}
