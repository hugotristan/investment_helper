import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRecommendationJournal, saveRecommendationJournal, RECOMMENDATION_STORE_KEY } from "../js/data/recommendation-store.js";

const recordedAt = "2026-09-05T16:00:00.000Z";
function storage() {
  const values = new Map([["today-invest-model-state", "portfolio remains here"]]);
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function pending(sessions) {
  return { status: "pending", reason: "Later settled sessions needed", sessions, observedSessions: 0, asOf: null, observedAt: null,
    stockPrice: null, benchmarkPrice: null, stockReturn: null, benchmarkReturn: null, excessReturn: null };
}
function entry(ticker = "ACME", overrides = {}) {
  return { id: `${ticker}|2026-09-05`, ticker, name: ticker, recordedAt, recordedDate: "2026-09-05", currency: "USD",
    baseline: { price: 100, asOf: "2026-09-04T16:00:00.000Z", currency: "USD" },
    benchmark: { ticker: "SPY", price: 200, asOf: "2026-09-04T16:00:00.000Z", currency: "USD" },
    score: 76, signal: "Buy signal", horizon: "1 to 4 weeks", invalidation: 90,
    evidence: [{ title: "Company evidence", source: "Example", link: "https://example.com/company", pubDate: "2026-09-04" }],
    reasons: ["Original reason"], risks: ["Original risk"], outcomes: { "5": pending(5), "21": pending(21) }, ...overrides };
}
function matured(sessions, overrides = {}) {
  return { status: "matured", reason: null, sessions, observedSessions: sessions,
    asOf: "2026-09-12T16:00:00.000Z", observedAt: "2026-10-05T16:00:00.000Z",
    stockPrice: 110, benchmarkPrice: 210, stockReturn: 0.1, benchmarkReturn: 0.05, excessReturn: 0.05, ...overrides };
}

test("journal uses its own versioned key and round-trips frozen evidence without touching portfolio", () => {
  const saved = storage();
  const input = entry();
  assert.equal(saveRecommendationJournal([input], { storage: saved }).ok, true);
  const loaded = loadRecommendationJournal({ storage: saved });
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.entries, [input]);
  assert.equal(JSON.parse(saved.values.get(RECOMMENDATION_STORE_KEY)).schemaVersion, 1);
  assert.equal(saved.values.get("today-invest-model-state"), "portfolio remains here");
  input.reasons[0] = "Changed outside storage";
  assert.equal(loadRecommendationJournal({ storage: saved }).entries[0].reasons[0], "Original reason");
});

test("UTC day and ticker deduplication preserve the first original signal while observations advance", () => {
  const saved = storage();
  saveRecommendationJournal([entry()], { storage: saved });
  const changed = entry();
  changed.ticker = "ACME"; changed.id = "ACME|2026-09-05";
  changed.score = 90; changed.reasons = ["Rewritten reason"]; changed.evidence = [{ title: "New story", link: "https://example.com/new" }];
  changed.outcomes["5"] = matured(5);
  const result = saveRecommendationJournal([changed, changed], { storage: saved });
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].score, 76);
  assert.equal(result.entries[0].reasons[0], "Original reason");
  assert.equal(result.entries[0].evidence[0].title, "Company evidence");
  assert.equal(result.entries[0].outcomes["5"].status, "matured");
});

test("mature observations remain frozen when later history disappears or changes", () => {
  const saved = storage();
  const completed = entry(); completed.outcomes["5"] = matured(5);
  saveRecommendationJournal([completed], { storage: saved });
  const missing = entry(); missing.outcomes["5"] = { ...pending(5), status: "unavailable", reason: "History rolled off" };
  const restored = saveRecommendationJournal([missing], { storage: saved });
  assert.deepEqual(restored.entries[0].outcomes["5"], completed.outcomes["5"]);
  const changed = entry(); changed.outcomes["5"] = matured(5, { stockPrice: 120, stockReturn: 0.2, excessReturn: 0.15 });
  assert.deepEqual(saveRecommendationJournal([changed], { storage: saved }).entries[0].outcomes["5"], completed.outcomes["5"]);
});

test("baseline rewrites cannot attach returns computed against a different starting price", () => {
  const saved = storage(); saveRecommendationJournal([entry()], { storage: saved });
  const changed = entry(); changed.baseline.price = 50;
  changed.outcomes["5"] = matured(5, { stockReturn: 1.2, excessReturn: 1.15 });
  const result = saveRecommendationJournal([changed], { storage: saved });
  assert.equal(result.entries[0].baseline.price, 100);
  assert.equal(result.entries[0].outcomes["5"].status, "pending");
  assert.equal(loadRecommendationJournal({ storage: saved }).ok, true);
});

test("retention caps the journal at one thousand records without combining ticker days", () => {
  const saved = storage();
  const records = Array.from({ length: 1001 }, (_, index) => entry(`T${String(index).padStart(4, "0")}`));
  const result = saveRecommendationJournal(records, { storage: saved });
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 1000);
  assert.equal(loadRecommendationJournal({ storage: saved }).entries.length, 1000);
  const nextDay = entry("T1000", { id: "T1000|2026-09-06", recordedDate: "2026-09-06", recordedAt: "2026-09-06T16:00:00.000Z" });
  const advanced = saveRecommendationJournal([nextDay], { storage: saved });
  assert.equal(advanced.entries.length, 1000);
  assert.equal(advanced.entries.filter((record) => record.ticker === "T1000").length, 2);
});

test("malformed, oversized, and unsupported saved journals remain untouched", () => {
  const saved = storage();
  for (const raw of ["{", "null", JSON.stringify({ schemaVersion: 2, entries: [] }), "x".repeat(4 * 1024 * 1024 + 1)]) {
    saved.values.set(RECOMMENDATION_STORE_KEY, raw);
    assert.equal(loadRecommendationJournal({ storage: saved }).ok, false);
    assert.equal(saveRecommendationJournal([entry()], { storage: saved }).ok, false);
    assert.equal(saved.values.get(RECOMMENDATION_STORE_KEY), raw);
  }
});

test("invalid chronology and inconsistent returns cannot be loaded or saved", () => {
  const saved = storage();
  const invalid = [];
  const futureBaseline = entry(); futureBaseline.baseline.asOf = "2026-09-06T16:00:00.000Z"; invalid.push(futureBaseline);
  const wrongDay = entry(); wrongDay.benchmark.asOf = "2026-09-03T16:00:00.000Z"; invalid.push(wrongDay);
  for (const outcome of [
    matured(5, { asOf: recordedAt }), matured(5, { observedAt: "2026-09-10T16:00:00.000Z" }),
    matured(5, { stockReturn: 0.9 }), matured(5, { excessReturn: 0.8 })
  ]) { const bad = entry(); bad.outcomes["5"] = outcome; invalid.push(bad); }
  for (const bad of invalid) {
    assert.equal(saveRecommendationJournal([bad], { storage: storage() }).ok, false);
    saved.values.set(RECOMMENDATION_STORE_KEY, JSON.stringify({ schemaVersion: 1, entries: [bad] }));
    assert.equal(loadRecommendationJournal({ storage: saved }).ok, false);
  }
});

test("storage read and quota failures never throw or erase the existing journal", () => {
  assert.equal(loadRecommendationJournal({ storage: { getItem() { throw new Error("Blocked"); } } }).ok, false);
  const saved = storage(); saveRecommendationJournal([entry()], { storage: saved });
  const original = saved.values.get(RECOMMENDATION_STORE_KEY);
  const quota = { getItem: saved.getItem, setItem() { throw new Error("Quota"); } };
  const result = saveRecommendationJournal([entry("OTHER")], { storage: quota });
  assert.equal(result.ok, false);
  assert.equal(result.entries.length, 1);
  assert.equal(saved.values.get(RECOMMENDATION_STORE_KEY), original);
});
