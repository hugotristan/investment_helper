import assert from "node:assert/strict";
import { test } from "node:test";
import { createPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { calculatePortfolioPerformance } from "../js/analysis/portfolio-performance.js";

const nodes = new Map();
globalThis.document = { getElementById: (id) => {
  if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; } });
  return nodes.get(id);
} };
globalThis.localStorage = { getItem: () => null, setItem() { throw new Error("Performance rendering must not change saved data"); } };
const { renderPortfolioPerformance, renderValueChart } = await import("../js/features/portfolio-performance.js");
const html = (id) => nodes.get(id)?.innerHTML;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const fxHistory = { schemaVersion: 1, source: "ECB reference rates via Frankfurter",
  sourceUrl: "https://api.frankfurter.dev/v2/providers/ecb/rates", generatedAt: "2026-10-10T10:00:00Z",
  byCurrency: { USD: [{ date: "2026-10-01", rate: .9 }, { date: "2026-10-09", rate: .9 }] } };
const history = (ticker, start, end) => ({ ticker, currency: "USD", source: "Yahoo Finance published snapshot", splits: [],
  prices: [{ date: "2026-10-01", close: start }, { date: "2026-10-09", close: end }] });
const money = (value) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(value);

test("performance screen shows actual EUR settlement gains and dated monthly results separately from native USD profit", () => {
  const book = createPortfolioBook({ baseCurrency: "EUR", startDate: "2026-10-01", now: NOW });
  book.transactions = [
    { id: "fund", date: "2026-10-01", type: "deposit", currency: "EUR", amount: 10000, cashCurrency: "EUR", cashAmount: 10000 },
    { id: "buy", date: "2026-10-02", type: "buy", ticker: "MSFT", currency: "USD", quantity: 2, price: 170,
      amount: 340, fee: 5, cashCurrency: "EUR", cashAmount: 300 }
  ];
  const before = structuredClone(book);
  const report = calculatePortfolioPerformance({ book, fxHistory, now: NOW,
    histories: { MSFT: history("MSFT", 170, 180), SPY: history("SPY", 400, 410) } });
  renderPortfolioPerformance(report);
  assert.ok(html("portfolioPerformanceSummary").includes(money(10024)));
  assert.ok(html("portfolioPerformanceSummary").includes(`<span>Growth since start</span><strong>${money(24)}</strong>`));
  assert.ok(html("portfolioPerformanceHoldings").includes(money(300)));
  assert.ok(html("portfolioPerformanceHoldings").includes(money(324)));
  assert.match(html("portfolioPerformanceMonths"), /2026-10-01 → 2026-10-09/);
  assert.match(html("portfolioPerformanceMonths"), /SPY in EUR/);
  assert.match(nodes.get("portfolioPerformanceStatus").textContent, /daily closes, including cash/);
  assert.match(nodes.get("portfolioChartReadout").textContent, /2026-10-09/);
  assert.equal(nodes.get("portfolioChartDate").disabled, false);
  assert.deepEqual(book, before);
});

test("missing histories stay unavailable in the headline and explanations are safely escaped", () => {
  renderPortfolioPerformance({ startDate: "2026-10-01", endDate: "2026-10-09", summary: {}, series: [], months: [], holdings: [],
    reasons: ['<img src=x onerror="bad()"> missing prices'] });
  assert.equal((html("portfolioPerformanceSummary").match(/Unavailable/g) || []).length, 4);
  assert.match(html("portfolioPerformanceReasons"), /&lt;img/);
  assert.doesNotMatch(html("portfolioPerformanceReasons"), /<img/);
  assert.match(html("portfolioPerformanceChart"), /needs dated prices/);
  assert.equal(nodes.get("portfolioChartDate").disabled, true);
});

test("value chart breaks at unknown values and one point or flat values remain finite", () => {
  const chart = renderValueChart([
    { date: "2026-10-01", value: 100, netContributions: 100 },
    { date: "2026-10-02", value: null, netContributions: 100 },
    { date: "2026-10-03", value: 110, netContributions: 100 }
  ]);
  const valuePath = chart.match(/<path d="([^"]*)" class="portfolio-value-line"/)?.[1];
  assert.equal((valuePath.match(/M/g) || []).length, 2);
  assert.doesNotMatch(valuePath, /L/);
  for (const series of [[{ date: "2026-10-01", value: 0, netContributions: 0 }],
    [{ date: "2026-10-01", value: 100, netContributions: 100 }, { date: "2026-10-02", value: 100, netContributions: 100 }]]) {
    assert.doesNotMatch(renderValueChart(series), /NaN|Infinity/);
  }
});

test("before portfolio setup performance clears prior results and offers the portfolio link", () => {
  renderPortfolioPerformance(null);
  assert.equal(html("portfolioPerformanceSummary"), "");
  assert.equal(html("portfolioPerformanceHoldings"), "");
  assert.match(html("portfolioPerformanceChart"), /href="#portfolio"/);
  assert.equal(nodes.get("portfolioChartReadout").textContent, "");
});
