import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndexComparison, buildWatchlistMoves, comparisonGeometry, renderIndexComparison, renderWatchlistMoves } from "../js/ui/market-chart.js";

const DAY = 86400000;
const now = Date.now();
const today = Math.floor(now / DAY) * DAY;
function series(ticker, { length = 253, interval = 1, offset = 1, flat = false } = {}) {
  return { ticker, source: "Yahoo Finance chart", currency: "USD", dataQuality: { eligible: true },
    prices: Array.from({ length }, (_, index) => ({ date: new Date(today - (offset + (length - 1 - index) * interval) * DAY), close: flat ? 100 : 100 + index })) };
}

test("index comparison uses exact common dates and the same actual baseline", () => {
  const spy = series("SPY"), qqq = series("QQQ");
  qqq.prices = qqq.prices.filter((_, index) => index % 7 !== 0).map((point) => ({ ...point, close: point.close * 2 }));
  const model = buildIndexComparison([spy, qqq], "3M", { now });
  assert.equal(model.available, true);
  for (const date of model.dates) {
    assert(spy.prices.some((point) => point.date.toISOString().startsWith(date)));
    assert(qqq.prices.some((point) => point.date.toISOString().startsWith(date)));
  }
  assert(model.dates.at(-1) < spy.prices.at(-1).date.toISOString().slice(0, 10));
  assert.deepEqual(model.series.map((entry) => entry.values[0]), [0, 0]);
  for (const entry of model.series) assert.equal(entry.values.at(-1), entry.closes.at(-1) / entry.closes[0] - 1);
});

test("intraday overlays restore the original close without mutating inputs; unfinished and future bars are excluded", () => {
  const spy = series("SPY");
  const original = spy.prices.at(-1).close;
  spy.dailyClose = { price: original, currency: "USD", asOf: spy.prices.at(-1).date };
  spy.quote = { price: 999, currency: "USD", quoteTime: new Date(now - 1000), dayChangePercent: .3 };
  spy.prices.at(-1).close = 999;
  assert.equal(buildIndexComparison([spy], "3M", { now }).series[0].closes.at(-1), original);
  assert.equal(spy.prices.at(-1).close, 999);
  const qqq = series("QQQ");
  qqq.prices.push({ date: new Date(today), close: 900 }, { date: new Date(today + DAY), close: 1000 });
  const model = buildIndexComparison([qqq], "3M", { now });
  assert.equal(model.dates.at(-1), new Date(today - DAY).toISOString().slice(0, 10));
  assert.equal(model.series[0].closes.at(-1), original);
});

test("sample, stale, incomplete, and disjoint histories never create a substitute chart", () => {
  const spy = series("SPY");
  assert.equal(buildIndexComparison([{ ...spy, source: "sample" }], "3M", { now }).available, false);
  assert.equal(buildIndexComparison([spy], "3M", { now, priceSource: "sample" }).available, false);
  const stale = { ...spy, historyAsOf: new Date(now), prices: spy.prices.map((point) => ({ ...point, date: new Date(point.date.getTime() - 20 * DAY) })) };
  assert.equal(buildIndexComparison([stale], "3M", { now }).available, false);
  assert.equal(buildIndexComparison([series("SPY", { length: 199 })], "3M", { now }).available, false);
  const disjoint = [series("SPY", { interval: 2, offset: 2 }), series("QQQ", { interval: 2, offset: 1 })];
  assert.equal(buildIndexComparison(disjoint, "3M", { now }).available, false);
  assert.equal(buildIndexComparison([series("AAPL")], "3M", { now }).available, false);
});

test("flat-price geometry remains finite and single-index coverage is explicit", () => {
  const model = buildIndexComparison([series("QQQ", { flat: true })], "1Y", { now });
  assert.equal(model.available, true);
  assert.match(model.note, /QQQ only/);
  assert.equal(model.partial, true);
  const geometry = comparisonGeometry(model);
  assert(geometry.xs.every(Number.isFinite));
  assert(geometry.ticks.every(Number.isFinite));
  assert(geometry.y(0) > geometry.plot.top && geometry.y(0) < geometry.height - geometry.plot.bottom);
  assert(!/NaN|Infinity/.test(geometry.paths[0]));
});

test("finite input prices that overflow a derived change cannot produce graph coordinates or bars", () => {
  const spy = series("SPY");
  spy.prices.forEach((point, index) => { point.close = index === spy.prices.length - 1 ? 1e308 : 1e-320; });
  assert.equal(buildIndexComparison([spy], "3M", { now }).available, false);
  assert.equal(buildWatchlistMoves([spy], ["SPY"], null, { now })[0].change, null);
});

test("watchlist moves keep saved order, zero quotes, explicit gaps, and reject stale or mismatched quotes", () => {
  const spy = series("SPY");
  const quote = { ticker: "SPY", price: 352, currency: "USD", dayChangePercent: 0, quoteTime: new Date(now - 1000) };
  const tickers = ["MISS", "SPY", "A", "B", "C", "D", "E"];
  const quotes = { byTicker: new Map([["SPY", quote]]) };
  const moves = buildWatchlistMoves([spy], tickers, quotes, { now });
  assert.deepEqual(moves.map((move) => move.ticker), tickers.slice(0, 6));
  assert.equal(moves[0].change, null);
  assert.equal(moves[1].change, 0);
  assert.equal(moves[1].source, "Quote");
  for (const bad of [{ currency: "EUR" }, { ticker: "QQQ" }, { quoteTime: new Date(now + DAY) }, { quoteTime: new Date(now - 10 * DAY) }]) {
    quotes.byTicker.set("SPY", { ...quote, ...bad, dayChangePercent: .5 });
    const fallback = buildWatchlistMoves([spy], ["SPY"], quotes, { now })[0];
    assert.equal(fallback.source, "Daily close");
    assert.equal(fallback.change, 352 / 351 - 1);
  }
});

test("daily move fallback restores original prices and cannot use a forged recent history timestamp", () => {
  const spy = series("SPY");
  spy.dailyClose = { price: 352, currency: "USD", asOf: spy.prices.at(-1).date };
  spy.quote = { price: 999, currency: "USD", quoteTime: new Date(now - 10 * DAY), dayChangePercent: .5 };
  spy.prices.at(-1).close = 999;
  assert.equal(buildWatchlistMoves([spy], ["SPY"], null, { now })[0].change, 352 / 351 - 1);
  spy.prices = spy.prices.map((point) => ({ ...point, date: new Date(point.date.getTime() - 20 * DAY) }));
  spy.historyAsOf = new Date(now);
  assert.equal(buildWatchlistMoves([spy], ["SPY"], null, { now })[0].change, null);
});

function container() {
  const output = { textContent: "" };
  const cursor = { setAttribute() {} };
  const element = { innerHTML: "", handlers: new Map(), contains: () => true,
    addEventListener(name, handler) { this.handlers.set(name, [...(this.handlers.get(name) || []), handler]); },
    querySelector(selector) { return selector === "#overviewChartReadout" ? output : selector === "[data-market-cursor]" ? cursor : { focus() {} }; },
    querySelectorAll: () => [], output };
  return element;
}

test("rendered chart supports keyboard inspection, period changes, and one-time event binding", () => {
  const chart = container();
  globalThis.document = { getElementById: (id) => id === "overviewMarketChart" ? chart : null };
  const results = [series("SPY"), series("QQQ")];
  renderIndexComparison(results, "Yahoo Finance chart");
  renderIndexComparison(results, "Yahoo Finance chart");
  assert.equal(chart.handlers.get("keydown").length, 1);
  assert.match(chart.innerHTML, /role="img"/);
  assert.match(chart.innerHTML, /aria-describedby="overviewChartReadout"/);
  const svg = { closest: () => svg };
  let prevented = 0;
  chart.handlers.get("keydown")[0]({ target: svg, key: "Home", preventDefault() { prevented++; } });
  assert.match(chart.output.textContent, /SPY .*\(\+0\.0%\).*QQQ .*\(\+0\.0%\)/);
  chart.handlers.get("keydown")[0]({ target: svg, key: "End", preventDefault() { prevented++; } });
  assert.equal(prevented, 2);
  const button = { dataset: { marketPeriod: "1M" }, closest: () => button };
  chart.handlers.get("click")[0]({ target: button });
  assert.match(chart.innerHTML, /data-market-period="1M" aria-pressed="true"/);
  renderIndexComparison([], "none");
  assert.match(chart.innerHTML, /need recent real daily price history/);
  assert(!chart.innerHTML.includes("<svg"));
});

test("move bars share a centered signed scale and empty states do not invent a graph", () => {
  const moves = container();
  globalThis.document = { getElementById: (id) => id === "watchlistMoves" ? moves : null };
  const quotes = { byTicker: new Map([ ["UP", { price: 100, dayChangePercent: .01, quoteTime: new Date(now - 1000) }],
    ["DOWN", { price: 100, dayChangePercent: -.02, quoteTime: new Date(now - 1000) }] ]) };
  renderWatchlistMoves([], ["UP", "DOWN"], quotes, "quotes");
  assert.match(moves.innerHTML, /left:50%;width:25%/);
  assert.match(moves.innerHTML, /left:0%;width:50%/);
  assert.match(moves.innerHTML, /\+1\.0%/);
  assert.match(moves.innerHTML, /-2\.0%/);
  renderWatchlistMoves([], [], null, "none");
  assert.match(moves.innerHTML, /Your watchlist is empty/);
});
