import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORTFOLIO_FX_CURRENCIES } from "../js/data/portfolio-history.js";
import { buildPortfolioFxSnapshot, portfolioFxStart, runPortfolioFxUpdate, updatePortfolioFxSnapshot } from "../scripts/update-portfolio-fx.mjs";

const NOW = Date.parse("2026-10-10T12:00:00Z"), DAY = 86400000;
function raw() {
  const rows = [];
  for (let date = Date.parse(portfolioFxStart(NOW)); date < Date.parse("2026-10-10"); date += DAY) {
    if ([0, 6].includes(new Date(date).getUTCDay())) continue;
    for (const [i, quote] of PORTFOLIO_FX_CURRENCIES.entries()) rows.push({ date: new Date(date).toISOString().slice(0, 10),
      base: "EUR", quote, rate: 1.2 + i });
  }
  return rows;
}
const response = (payload = raw(), status = 200, retryAfter = null) => ({ ok: status >= 200 && status < 300,
  status, headers: { get: () => retryAfter }, json: async () => payload });

test("publisher stores actual daily native-to-EUR observations over the five-year period", async () => {
  const result = await updatePortfolioFxSnapshot({ now: NOW, fetchImpl: async (url, options) => {
    const request = new URL(url);
    assert.equal(request.pathname, "/v2/providers/ecb/rates");
    assert.equal(request.searchParams.get("base"), "eur");
    assert.equal(request.searchParams.get("quotes"), "usd,gbp,jpy,chf,cad,aud");
    assert.equal(request.searchParams.get("from"), "2021-10-03");
    assert.equal(request.searchParams.get("to"), "2026-10-10");
    assert(options.signal instanceof AbortSignal);
    return response();
  } });
  assert.equal(result.status, "updated");
  assert.equal(result.attempts, 1);
  assert.equal(result.snapshot.generatedAt, new Date(NOW).toISOString());
  for (const [i, currency] of PORTFOLIO_FX_CURRENCIES.entries()) {
    assert.equal(result.snapshot.byCurrency[currency][0].rate, 1 / (1.2 + i));
    assert.equal(result.coverage[currency].from, "2021-10-04");
    assert.equal(result.coverage[currency].to, "2026-10-09");
    assert(result.coverage[currency].points > 1200);
  }
});

test("publisher rejects wrong pairs, bad dates or numbers, duplicates, unsupported currencies and partial coverage", () => {
  const full = raw();
  for (const bad of [{}, [], full.map((row) => ({ ...row, base: "USD" })),
    full.map((row) => ({ ...row, rate: "1.2" })), full.map((row) => ({ ...row, rate: 0 })),
    full.map((row) => ({ ...row, date: "2026-02-29" })), full.map((row) => ({ ...row, date: "2026-10-11" })),
    [...full, full[0]], full.filter((row) => row.quote !== "CAD"), full.slice(-600),
    full.filter((row) => row.date < "2026-09-01"), [{ ...full[0], quote: "XYZ" }, ...full.slice(1)]]) {
    assert.equal(buildPortfolioFxSnapshot(bad, { now: NOW }), null);
  }
});

test("provider weekend boundary preserves the original previous observation date", () => {
  const earlier = PORTFOLIO_FX_CURRENCIES.map((quote) => ({ date: "2021-10-01", base: "EUR", quote, rate: 1.2 }));
  const result = buildPortfolioFxSnapshot([...earlier, ...raw()], { now: NOW });
  assert.equal(result.byCurrency.USD[0].date, "2021-10-01");
  assert.equal(result.byCurrency.USD[0].rate, 1 / 1.2);
  assert.equal(buildPortfolioFxSnapshot([...earlier.map((point) => ({ ...point, date: "2021-09-20" })), ...raw()], { now: NOW }), null);
});

test("transient HTTP failures have one bounded retry and honor bounded Retry-After", async () => {
  for (const status of [429, 500, 503]) {
    let calls = 0;
    const waits = [];
    const result = await updatePortfolioFxSnapshot({ now: NOW,
      wait: async (delay) => waits.push(delay), fetchImpl: async () => response(raw(), ++calls === 1 ? status : 200, "999") });
    assert.equal(result.available, true);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [5000]);
  }
});

test("invalid successful responses are not retried and return explicit unavailability", async () => {
  for (const bad of [response([]), response({}), { ...response(), json: async () => { throw new SyntaxError("Bad JSON"); } }, response(raw(), 403)]) {
    let calls = 0;
    const result = await updatePortfolioFxSnapshot({ now: NOW, fetchImpl: async () => { calls += 1; return bad; } });
    assert.equal(result.status, "unavailable");
    assert.equal(result.snapshot.available, false);
    assert.deepEqual(result.snapshot.byCurrency, {});
    assert.equal(result.snapshot.generatedAt, null);
    assert.equal(calls, 1);
    assert(result.reason);
  }
});

test("timeouts have at most one retry and preserve original dated historical coverage", async () => {
  const previous = buildPortfolioFxSnapshot(raw(), { now: NOW });
  let calls = 0;
  const result = await updatePortfolioFxSnapshot({ now: NOW + 40 * DAY, previous, timeoutMs: 5,
    wait: async () => {}, fetchImpl: async (_url, { signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })), { once: true }));
    } });
  assert.equal(calls, 2);
  assert.equal(result.status, "retained");
  assert.deepEqual(result.snapshot, previous);
  assert.equal(result.snapshot.generatedAt, new Date(NOW).toISOString());
  assert.match(result.reason, /timed out/);
  await assert.rejects(updatePortfolioFxSnapshot({ timeoutMs: 0 }), /positive timeout/);
  await assert.rejects(updatePortfolioFxSnapshot({ maxRetries: 2 }), /one retry/);
});

test("atomic publishing retains the previous file unchanged during outages and cleans temporary files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "portfolio-fx-test-"));
  const output = join(directory, "portfolio-fx.json");
  t.after(async () => { for (const file of await readdir(directory)) await unlink(join(directory, file)); await rmdir(directory); });
  await runPortfolioFxUpdate({ outputPath: output, now: NOW, fetchImpl: async () => response() });
  const before = await readFile(output, "utf8");
  const result = await runPortfolioFxUpdate({ outputPath: output, now: NOW + 40 * DAY, maxRetries: 0,
    fetchImpl: async () => { throw new Error("Offline"); } });
  assert.equal(result.retained, true);
  assert.equal(await readFile(output, "utf8"), before);
  assert.deepEqual(await readdir(directory), ["portfolio-fx.json"]);
  await writeFile(output, "broken", "utf8");
  const empty = await runPortfolioFxUpdate({ outputPath: output, now: NOW, fetchImpl: async () => response({}, 403) });
  assert.equal(empty.status, "unavailable");
  assert.equal(JSON.parse(await readFile(output, "utf8")).available, false);
  assert.deepEqual(await readdir(directory), ["portfolio-fx.json"]);
});
