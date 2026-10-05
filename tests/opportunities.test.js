import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpportunities } from "../js/analysis/opportunities.js";

const NOW = Date.UTC(2026, 9, 5, 16);
const DAY = 24 * 60 * 60 * 1000;
const market = { available: true, score: 60 };

function article(ticker, overrides = {}) {
  return { title: `${ticker} reports new company developments`, source: "Example News", sourceId: "example",
    link: `https://example.com/${ticker}`, pubDate: new Date(NOW - DAY).toISOString(),
    directTickers: [ticker], sentiment: 0.2, ...overrides };
}

function stock(ticker = "ACME", overrides = {}) {
  return { ticker, source: "fixture", instrumentType: "EQUITY", isFund: false,
    dataQuality: { eligible: true, asOf: new Date(NOW - DAY).toISOString() },
    score: 76, latest: 150, sma50: 140, sma200: 120, sixMonth: 0.2,
    oneMonth: 0.04, threeMonth: 0.1, volumePressure: 0.03, drawdown: -0.06,
    volatility: 0.22, rsi14: 58, averageDollarVolume: 10000000,
    macd: { histogram: 0.5 }, eventRisk: { level: "Low", hits: [] },
    headlineSourceCount: 1, headlineScore: 0.2, outlookSourceCount: 0, outlookScore: 0,
    reasons: ["Above 200-day average: long-term trend is positive.", "Six-month momentum is +20.0%."],
    flags: ["Single-stock exposure adds company-specific risk."],
    setup: { signal: "Buy signal", invalidation: 115, timeframe: "1 day to 4 weeks" },
    headlines: [article(ticker)], outlooks: [], ...overrides };
}

test("up to three individual stock candidates rank deterministically with concrete explanations", () => {
  const results = [stock("DELTA", { score: 70 }), stock("BETA", { score: 80 }), stock("ALPHA", { score: 80 }), stock("GAMMA", { score: 75 })];
  const built = buildOpportunities(results, market, { now: NOW });
  assert.deepEqual(built.candidates.map((item) => item.ticker), ["ALPHA", "BETA", "GAMMA"]);
  assert.deepEqual(buildOpportunities([...results].reverse(), market, { now: NOW }).candidates.map((item) => item.ticker), ["ALPHA", "BETA", "GAMMA"]);
  const first = built.candidates[0];
  assert.equal(first.reasons.length, 3);
  assert.equal(first.risks.length, 3);
  assert.match(first.reasons[2], /Example News.*ALPHA reports/);
  assert.equal(first.invalidation, 115);
  assert.equal(first.horizon, "1 day to 4 weeks");
  assert.equal(first.asOf, new Date(NOW - DAY).toISOString());
  assert.equal(built.asOf, new Date(NOW).toISOString());
});

test("mixed samples, stale data, ETFs, weak trends, risk blockers, and sell triggers are excluded", () => {
  const results = [
    stock("GOOD"),
    stock("SAMPLE", { source: "sample", score: null, dataQuality: { eligible: false } }),
    stock("STALE", { dataQuality: { eligible: true, asOf: new Date(NOW - 8 * DAY).toISOString() } }),
    stock("SPY"), stock("NEWETF", { instrumentType: "ETF" }),
    stock("WEAK", { score: 64 }), stock("TREND", { sixMonth: -0.05 }),
    stock("EVENT", { eventRisk: { level: "High", hits: ["guidance cut"] } }),
    stock("STRETCHED", { rsi14: 76 }), stock("VOLATILE", { volatility: 0.51 }),
    stock("ILLIQUID", { averageDollarVolume: 4999999 }),
    stock("SELL", { oneMonth: -0.08, threeMonth: -0.04, rsi14: 38, macd: { histogram: -1 } })
  ];
  const built = buildOpportunities(results, market, { now: NOW });
  assert.deepEqual(built.candidates.map((item) => item.ticker), ["GOOD"]);
  const codes = Object.fromEntries(built.exclusions.map((item) => [item.ticker, item.code]));
  assert.deepEqual(codes, { SAMPLE: "data_quality", STALE: "data_quality", SPY: "fund", NEWETF: "fund",
    WEAK: "score", TREND: "trend", EVENT: "event_risk", STRETCHED: "stretched", VOLATILE: "volatility",
    ILLIQUID: "liquidity", SELL: "sell_signal" });
});

test("insufficient market coverage and bearish regimes never force a pick", () => {
  const unavailable = buildOpportunities([stock()], { available: false, score: null }, { now: NOW });
  assert.equal(unavailable.candidates.length, 0);
  assert.match(unavailable.reason, /coverage is insufficient/);
  const bearish = buildOpportunities([stock()], { available: true, score: 44 }, { now: NOW });
  assert.equal(bearish.candidates.length, 0);
  assert.match(bearish.reason, /defensive/);
});

test("only dated direct company articles with usable URLs within fourteen days count as evidence", () => {
  const invalidStories = [
    article("ACME", { directTickers: [], sectorTickers: ["ACME"], evidenceScope: "sector" }),
    article("ACME", { pubDate: new Date(NOW - 15 * DAY).toISOString() }),
    article("ACME", { pubDate: "" }), article("ACME", { pubDate: "unknown" }),
    article("ACME", { pubDate: new Date(NOW + 2 * DAY).toISOString() }),
    article("ACME", { link: "javascript:alert(1)" }), article("ACME", { link: "" }),
    article("ACME", { directTickers: ["OTHER"] })
  ];
  for (const story of invalidStories) {
    const built = buildOpportunities([stock("ACME", { headlines: [story] })], market, { now: NOW });
    assert.equal(built.candidates.length, 0);
    assert.equal(built.exclusions[0].code, "evidence");
    assert.match(built.reason, /direct company evidence/);
  }
  for (const pubDate of [new Date(NOW - 14 * DAY).toISOString(), "20261004T160000Z", "20261004160000"]) {
    const built = buildOpportunities([stock("ACME", { headlines: [article("ACME", { pubDate })] })], market, { now: NOW });
    assert.equal(built.candidates.length, 1);
    assert(Number.isFinite(Date.parse(built.candidates[0].evidence[0].pubDate)));
  }
});

test("duplicated headlines, tracking URLs, and repeated result tickers cannot inflate evidence or candidates", () => {
  const story = article("ACME");
  const first = stock("ACME", { headlines: [story, { ...story }], outlooks: [{ ...story, link: `${story.link}?utm_source=mail#section` }] });
  const built = buildOpportunities([first, first], market, { now: NOW });
  assert.equal(built.candidates.length, 1);
  assert.equal(built.candidates[0].evidence.length, 1);
});

test("portfolio concentration excludes holdings over ten percent and cautions about smaller existing holdings", () => {
  const concentrated = buildOpportunities([stock("ACME")], market, { now: NOW,
    holdings: [{ ticker: "ACME", amount: 30 }, { ticker: "OTHER", amount: 170 }] });
  assert.equal(concentrated.candidates.length, 0);
  assert.equal(concentrated.exclusions[0].code, "concentration");
  assert.match(concentrated.reason, /concentrated holding/);
  const smaller = buildOpportunities([stock("ACME")], market, { now: NOW,
    holdings: [{ ticker: "ACME", amount: 10 }, { ticker: "ACME", amount: 10 }, { ticker: "OTHER", amount: 180 }] });
  assert.equal(smaller.candidates[0].holdingWeight, 10);
  assert.match(smaller.candidates[0].risks[0], /Already 10.0%/);
});

test("empty scans and all unavailable histories return clear explanations without a substitute stock", () => {
  assert.equal(buildOpportunities([], market, { now: NOW }).candidates.length, 0);
  const unavailable = buildOpportunities([stock("ACME", { score: null, dataQuality: { eligible: false } })], market, { now: NOW });
  assert.equal(unavailable.candidates.length, 0);
  assert.match(unavailable.reason, /No stock has qualified recent real price history/);
});
