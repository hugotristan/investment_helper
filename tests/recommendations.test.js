import assert from "node:assert/strict";
import { test } from "node:test";
import { recordRecommendations, observeRecommendations } from "../js/analysis/recommendations.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 5, 16);
const BASE_AS_OF = new Date(Date.UTC(2026, 9, 2, 14)).toISOString();

function history(ticker = "ACME", overrides = {}) {
  const price = ticker === "SPY" ? 500 : 100;
  const prices = [];
  let time = Date.parse(BASE_AS_OF);
  while (prices.length < 220) {
    const weekday = new Date(time).getUTCDay();
    if (weekday !== 0 && weekday !== 6) prices.unshift({ date: new Date(time), close: price });
    time -= DAY;
  }
  return { ticker, source: "fixture", currency: "USD", score: 75, prices,
    dataQuality: { eligible: true, asOf: BASE_AS_OF }, ...overrides };
}

function candidate(overrides = {}) {
  return { ...history(), name: "Acme", reasons: ["Positive trend", "Direct company coverage"],
    risks: ["Single-stock exposure"], horizon: "1 to 4 weeks", invalidation: 80,
    setup: { signal: "Buy signal" },
    evidence: [{ title: "Acme reports", link: "https://example.com/acme", source: "Example", pubDate: new Date(NOW - DAY).toISOString(), directTickers: ["ACME"] }],
    ...overrides };
}

function record(candidates = [candidate()], results = [history(), history("SPY")], options = {}) {
  return recordRecommendations([], candidates, results, { now: NOW, complete: true, fresh: true, ...options });
}

function sessions(count) {
  const days = [];
  let time = Date.UTC(2026, 9, 6, 14);
  while (days.length < count) {
    const weekday = new Date(time).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(time);
    time += DAY;
  }
  return days;
}

function later(count, { skipBenchmark = -1, stock = {}, benchmark = {} } = {}) {
  const days = sessions(count);
  const append = (ticker, priceAt, skip) => {
    const initial = history(ticker);
    return { ...initial, prices: initial.prices.concat(
      { date: new Date(Date.UTC(2026, 9, 5, 14)), close: ticker === "SPY" ? 500 : 100 },
      days.flatMap((time, index) => index === skip ? [] : [{ date: new Date(time), close: priceAt(index + 1) }])
    ) };
  };
  return {
    now: (days.at(-1) ?? NOW) + DAY + 2 * 3600000,
    results: [{ ...append("ACME", (index) => 100 + index * 2, -1), ...stock },
      { ...append("SPY", (index) => 500 + index * 5, skipBenchmark), ...benchmark }]
  };
}

function approximately(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} should equal ${expected}`);
}

test("only complete fresh scans with qualified same-day daily baselines can record", () => {
  assert.equal(record().length, 1);
  for (const options of [{ complete: false }, { fresh: false }]) assert.equal(record(undefined, undefined, options).length, 0);
  assert.equal(recordRecommendations([], [candidate()], [history(), history("SPY")], { now: NOW }).length, 0);
  for (const invalid of [candidate({ score: 64 }), candidate({ score: null }), candidate({ isFund: true }), candidate({ evidence: [] })]) {
    assert.equal(record([invalid]).length, 0);
  }
  assert.equal(record(undefined, [history()]).length, 0);
  assert.equal(record(undefined, [history(), history("SPY", { currency: "EUR" })]).length, 0);
  const oldBenchmark = history("SPY");
  oldBenchmark.prices.pop();
  assert.equal(record(undefined, [history(), oldBenchmark]).length, 0);
  for (const invalid of [history("ACME", { source: "sample" }), history("ACME", { currency: "" }), history("ACME", { prices: history().prices.slice(0, 199) })]) {
    assert.equal(record(undefined, [invalid, history("SPY")]).length, 0);
  }
});

test("the first ticker/UTC-day baseline and evidence stay immutable across rescans", () => {
  const idea = candidate();
  const journal = record([idea]);
  const before = JSON.stringify(journal);
  const changed = candidate({ score: 90, reasons: ["Later explanation"], evidence: [{ title: "Different evidence" }] });
  const rescanned = recordRecommendations(journal, [changed, changed], [history(), history("SPY")], {
    now: NOW + 3600000, complete: true, fresh: true
  });
  assert.equal(JSON.stringify(journal), before);
  assert.deepEqual(rescanned, journal);
  idea.evidence[0].title = "Changed source object";
  assert.equal(journal[0].evidence[0].title, "Acme reports");
  assert.equal(journal[0].signal, "Buy signal");
  const nextDay = recordRecommendations(journal, [changed], [history(), history("SPY")], {
    now: NOW + DAY, complete: true, fresh: true
  });
  assert.equal(nextDay.length, 2);
  assert.notEqual(nextDay[0].id, nextDay[1].id);
});

test("intraday overlays restore the original daily close for recording and observing", () => {
  const base = history();
  base.prices[base.prices.length - 1] = { date: new Date(BASE_AS_OF), close: 999 };
  const overlay = { ...base, source: "fixture + Yahoo intraday", dailyClose: { price: 100, currency: "USD", asOf: BASE_AS_OF } };
  const journal = record(undefined, [overlay, history("SPY")]);
  assert.equal(journal[0].baseline.price, 100);
  assert.equal(record(undefined, [{ ...overlay, dailyClose: undefined }, history("SPY")]).length, 0);
  const followup = later(5);
  const stock = followup.results[0];
  const last = stock.prices.at(-1);
  stock.dailyClose = { price: last.close, currency: "USD", asOf: last.date.toISOString() };
  stock.source += " + Yahoo intraday";
  stock.prices[stock.prices.length - 1] = { ...last, close: 1000 };
  const outcome = observeRecommendations(journal, followup.results, { now: followup.now }).entries[0].outcomes[5];
  assert.equal(outcome.status, "matured");
  assert.equal(outcome.stockPrice, 110);
});

test("day zero and today's partial daily bar never count toward maturity or summary wins", () => {
  const journal = record();
  const dayZero = observeRecommendations(journal, [history(), history("SPY")], { now: NOW + 3600000 });
  assert.equal(dayZero.entries[0].outcomes[5].observedSessions, 0);
  assert.equal(dayZero.summary.matured5, 0);
  assert.equal(dayZero.summary.outperformanceRate5, null);
  const followup = later(5);
  const stillToday = observeRecommendations(journal, followup.results, { now: sessions(5).at(-1) + 2 * 3600000 });
  assert.equal(stillToday.entries[0].outcomes[5].status, "pending");
  assert.equal(stillToday.entries[0].outcomes[5].observedSessions, 4);
  assert.equal(stillToday.summary.averageExcess5, null);
});

test("five and twenty-one matched settled sessions yield contemporaneous SPY excess returns", () => {
  const journal = record();
  const followup = later(21);
  const observed = observeRecommendations(journal, followup.results, { now: followup.now });
  const outcomes = observed.entries[0].outcomes;
  assert.equal(outcomes[5].status, "matured");
  assert.equal(outcomes[21].status, "matured");
  assert.equal(outcomes[5].asOf, new Date(sessions(5).at(-1)).toISOString());
  approximately(outcomes[5].stockReturn, 0.1);
  approximately(outcomes[5].benchmarkReturn, 0.05);
  approximately(outcomes[5].excessReturn, 0.05);
  approximately(outcomes[21].stockReturn, 0.42);
  approximately(outcomes[21].benchmarkReturn, 0.21);
  approximately(outcomes[21].excessReturn, 0.21);
  assert.equal(observed.summary.matured5, 1);
  assert.equal(observed.summary.matured21, 1);
  assert.equal(observed.summary.outperformanceRate5, 1);
  assert.equal(JSON.stringify(journal[0].outcomes).includes("matured"), false);
});

test("only matching dated trading sessions count when one history has gaps", () => {
  const journal = record();
  const short = later(5, { skipBenchmark: 2 });
  const pending = observeRecommendations(journal, short.results, { now: short.now });
  assert.equal(pending.entries[0].outcomes[5].status, "pending");
  assert.equal(pending.entries[0].outcomes[5].observedSessions, 4);
  const enough = later(6, { skipBenchmark: 2 });
  const matured = observeRecommendations(journal, enough.results, { now: enough.now }).entries[0].outcomes[5];
  assert.equal(matured.status, "matured");
  assert.equal(matured.asOf, new Date(sessions(6).at(-1)).toISOString());
  assert.equal(matured.stockPrice, 112);
  assert.equal(matured.benchmarkPrice, 530);
});

test("sample, stale, future, missing, and changed-currency data block observations", () => {
  const journal = record();
  const followup = later(5);
  const invalid = [
    { results: [followup.results[1]] },
    { results: [{ ...followup.results[0], source: "sample" }, followup.results[1]] },
    { results: [{ ...followup.results[0], currency: "EUR" }, followup.results[1]] },
    { results: [{ ...followup.results[0], currency: "GBp" }, followup.results[1]] },
    { now: followup.now + 8 * DAY },
    { results: [{ ...followup.results[0], prices: followup.results[0].prices.concat({ date: new Date(followup.now + DAY), close: 100 }) }, followup.results[1]] }
  ];
  for (const overrides of invalid) {
    const observed = observeRecommendations(journal, overrides.results || followup.results, { now: overrides.now || followup.now });
    assert.equal(observed.entries[0].outcomes[5].status, "unavailable");
    assert.equal(observed.entries[0].outcomes[5].stockReturn, null);
    assert.equal(observed.summary.matured5, 0);
  }
});

test("splits after a baseline block only windows reaching the affected session", () => {
  const journal = record();
  const followup = later(21, { stock: { splits: [{ date: new Date(sessions(10).at(-1)), numerator: 2, denominator: 1 }] } });
  const observed = observeRecommendations(journal, followup.results, { now: followup.now });
  assert.equal(observed.entries[0].outcomes[5].status, "matured");
  assert.equal(observed.entries[0].outcomes[21].status, "unavailable");
  assert.match(observed.entries[0].outcomes[21].reason, /split/);
  const splitTime = sessions(3).at(-1) / 1000;
  followup.results[0].splits = [];
  followup.results[1].splits = { [splitTime]: { date: splitTime, splitRatio: "2:1" } };
  assert.equal(observeRecommendations(journal, followup.results, { now: followup.now }).entries[0].outcomes[5].status, "unavailable");
});

test("mature outcomes persist unchanged when later history is missing or revised", () => {
  const journal = record();
  const followup = later(21);
  const observed = observeRecommendations(journal, followup.results, { now: followup.now });
  const original = JSON.stringify(observed.entries[0].outcomes);
  const rolledOff = observeRecommendations(observed.entries, [], { now: followup.now + 400 * DAY });
  assert.equal(JSON.stringify(rolledOff.entries[0].outcomes), original);
  followup.results[0].prices.at(-1).close = 2000;
  const revised = observeRecommendations(observed.entries, followup.results, { now: followup.now });
  assert.equal(JSON.stringify(revised.entries[0].outcomes), original);
});

test("a delayed observation cannot replace original forward sessions with a later rolling history window", () => {
  const journal = record();
  const shifted = [history(), history("SPY")].map((item) => ({ ...item,
    prices: item.prices.map((point) => ({ ...point, date: new Date(point.date.getTime() + 400 * DAY) }))
  }));
  const delayed = observeRecommendations(journal, shifted, { now: NOW + 400 * DAY });
  for (const sessions of [5, 21]) {
    assert.equal(delayed.entries[0].outcomes[sessions].status, "unavailable");
    assert.match(delayed.entries[0].outcomes[sessions].reason, /no longer covers the start/);
    assert.equal(delayed.entries[0].outcomes[sessions].stockReturn, null);
  }
  const firstFive = later(5);
  const partiallyMatured = observeRecommendations(journal, firstFive.results, { now: firstFive.now });
  const preserved = observeRecommendations(partiallyMatured.entries, shifted, { now: NOW + 400 * DAY });
  assert.deepEqual(preserved.entries[0].outcomes[5], partiallyMatured.entries[0].outcomes[5]);
  assert.equal(preserved.entries[0].outcomes[21].status, "unavailable");
});

test("malformed records and duplicates are rejected and journals remain bounded", () => {
  const entry = record()[0];
  const corrupted = { ...entry, id: "broken", baseline: { ...entry.baseline, price: 0 } };
  assert.equal(observeRecommendations([null, corrupted, entry, entry], [], { now: NOW }).entries.length, 1);
  const entries = Array.from({ length: 1005 }, (_, index) => {
    const ticker = `STOCK${index}`;
    return { ...entry, ticker, id: `${ticker}|${entry.recordedDate}` };
  });
  const bounded = recordRecommendations(entries, [], [], { now: NOW });
  assert.equal(bounded.length, 1000);
  assert.equal(new Set(bounded.map((item) => item.id)).size, 1000);
});
