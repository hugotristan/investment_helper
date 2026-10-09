import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateHoldings } from "../js/analysis/holdings.js";
import { portfolioMoney } from "../js/shared/portfolio-money.js";

const NOW = Date.parse("2026-10-09T12:05:00Z");
const FX = {
  schemaVersion: 1, available: true, base: "USD", quote: "EUR", rate: 0.9,
  date: "2026-10-09", source: "ECB reference rate via Frankfurter",
  sourceUrl: "https://api.frankfurter.dev/v2/providers/ecb/rate/usd/eur",
  retrievedAt: "2026-10-09T12:00:00Z"
};

const position = (ticker, overrides = {}) => ({
  id: ticker, kind: "position", ticker, label: `${ticker} holding`,
  shares: 2, averageCost: 100, currency: "USD", ...overrides
});

const priceResult = (ticker, price, currency = "USD") => ({
  ticker, source: "Fixture prices", latest: price, currency, score: 70,
  dataQuality: { eligible: true, asOf: "2026-10-08T16:00:00Z" },
  quote: { ticker, price, currency, quoteTime: "2026-10-09T12:00:00Z" }
});

function reviewFixture(holdings, results) {
  const calculated = calculateHoldings(holdings, results, { now: NOW });
  const rows = calculated.holdings.map((holding) => ({
    ...holding,
    weight: calculated.groups.find((group) => group.currency === holding.currency)?.complete ? holding.weight : null,
    analysis: null,
    review: { className: "holding-watch", label: "Fixture review", reason: "Review reason.", detail: "Review detail." }
  }));
  return {
    ...calculated, holdings: rows,
    groups: calculated.groups.map((group) => ({ ...group, holdings: rows.filter((row) => row.currency === group.currency) })),
    concentrationNotes: ["Weights remain grouped by native currency."]
  };
}

function browserFixture(t) {
  const nodes = new Map([["portfolioReview", { innerHTML: "" }]]);
  const saved = new Map([["today-invest-model-state", JSON.stringify({ holdings: [], currency: "EUR" })]]);
  const writes = [];
  const replace = (name, value) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  };
  replace("document", { getElementById: (id) => nodes.get(id) || null, querySelectorAll: () => [] });
  replace("localStorage", {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { writes.push([key, value]); saved.set(key, value); }
  });
  replace("window", {});
  return { nodes, saved, writes };
}

function groupMarkup(html, currency) {
  const match = html.match(new RegExp(`<details class="portfolio-currency-group" data-portfolio-currency="${currency}"(?: open)?>\\s*<summary class="control-summary"><strong>${currency} holdings</strong></summary>([\\s\\S]*?)(?=<details class="portfolio-currency-group"|<details class="secondary-details"><summary>Concentration checks)`));
  assert.ok(match, `${currency} group rendered`);
  return match[1];
}

function cardMarkup(html, ticker) {
  const cards = html.match(/<article class="holding-card[^\"]*">[\s\S]*?<\/article>/g) || [];
  const card = cards.find((value) => value.includes(`<h3>${ticker} holding</h3>`));
  assert.ok(card, `${ticker} holding rendered`);
  return card;
}

function labeledValue(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<span>${escaped}</span><strong>([\\s\\S]*?)</strong>`));
  assert.ok(match, `${label} value rendered`);
  return match[1];
}

function nativeMoney(value, currency, signed = false) {
  return `${signed && value > 0 ? "+" : ""}${new Intl.NumberFormat(undefined, {
    style: "currency", currency, maximumFractionDigits: 2
  }).format(value)}`;
}

function convertedMoney(value, signed = false) {
  return `${nativeMoney(value, "USD", signed)} (${nativeMoney(value * FX.rate, "EUR", signed)})`;
}

test("USD display appends EUR and preserves positive, negative, and zero gain signs in both currencies", () => {
  assert.equal(portfolioMoney(100, "USD", { exchangeRate: FX, locale: "en-US" }), "$100.00 (€90.00)");
  assert.equal(portfolioMoney(25, "USD", { exchangeRate: FX, signed: true, locale: "en-US" }), "+$25.00 (+€22.50)");
  assert.equal(portfolioMoney(-25, "USD", { exchangeRate: FX, signed: true, locale: "en-US" }), "-$25.00 (-€22.50)");
  assert.equal(portfolioMoney(0, "USD", { exchangeRate: FX, signed: true, locale: "en-US" }), "$0.00 (€0.00)");
  for (const currency of ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD"]) {
    const expected = new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(100);
    assert.equal(portfolioMoney(100, currency, { exchangeRate: FX, locale: "en-US" }), expected);
  }
});

test("missing or invalid display rates preserve USD amounts and unavailable money never becomes zero", () => {
  for (const exchangeRate of [null, undefined, {}, { ...FX, available: false }, { ...FX, base: "EUR" },
    { ...FX, quote: "GBP" }, { ...FX, rate: 0 }, { ...FX, rate: -0.9 }, { ...FX, rate: NaN },
    { ...FX, rate: Infinity }, { ...FX, rate: "0.9" }]) {
    assert.equal(portfolioMoney(100, "USD", { exchangeRate, locale: "en-US" }), "$100.00 (EUR unavailable)");
    assert.equal(portfolioMoney(-25, "USD", { exchangeRate, signed: true, locale: "en-US" }), "-$25.00 (EUR unavailable)");
  }
  for (const value of [null, undefined, NaN, Infinity, -Infinity, "100"]) {
    assert.equal(portfolioMoney(value, "USD", { exchangeRate: FX, signed: true, locale: "en-US" }), "Unavailable");
  }
  assert.match(portfolioMoney(Number.MAX_VALUE, "USD", { exchangeRate: { ...FX, rate: 2 }, locale: "en-US" }), /\(EUR unavailable\)$/);
});

test("portfolio review converts every USD monetary line while preserving native groups, shares, returns, and inputs", async (t) => {
  const browser = browserFixture(t);
  const { renderPortfolioReview } = await import("../js/features/portfolio.js");
  const { els } = await import("../js/ui/dom.js");
  const { state } = await import("../js/storage.js");
  const holdings = [position("GAIN"), position("LOSS", { shares: 3, averageCost: 80 }),
    position("FLAT", { shares: 1.25, averageCost: 40 }), position("EURO", { currency: "EUR", averageCost: 20 })];
  const results = [priceResult("GAIN", 150), priceResult("LOSS", 50), priceResult("FLAT", 40), priceResult("EURO", 30, "EUR")];
  const portfolio = reviewFixture(holdings, results);
  const before = structuredClone({ holdings, results, portfolio, exchangeRate: FX, state, saved: [...browser.saved] });
  const originalOutput = els.portfolioReview;
  // The shared DOM module keeps its first references; point it at this test's output.
  els.portfolioReview = browser.nodes.get("portfolioReview");
  t.after(() => { els.portfolioReview = originalOutput; });

  renderPortfolioReview(portfolio, "fixture", { now: NOW, exchangeRate: FX });
  const html = els.portfolioReview.innerHTML;
  const usd = groupMarkup(html, "USD");
  assert.equal(labeledValue(usd, "Tracked value"), convertedMoney(500));
  assert.equal(labeledValue(usd, "Cost basis"), convertedMoney(490));
  assert.equal(labeledValue(usd, "Unrealized gain / loss"), convertedMoney(10, true));

  for (const row of portfolio.holdings.filter((holding) => holding.currency === "USD")) {
    const card = cardMarkup(usd, row.ticker);
    assert.equal(labeledValue(card, "Shares"), new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(row.shares));
    assert.equal(labeledValue(card, "Average purchase"), convertedMoney(row.averageCost));
    assert.equal(labeledValue(card, "Cost basis"), convertedMoney(row.costBasis));
    assert.equal(labeledValue(card, "Current value"), convertedMoney(row.currentValue));
    assert.equal(labeledValue(card, "Unrealized gain / loss"), `${convertedMoney(row.gain, true)} <small>${row.gainPercent >= 0 ? "+" : ""}${(row.gainPercent * 100).toFixed(1)}%</small>`);
    assert.ok(card.includes(`Price ${convertedMoney(row.price)} · quote`));
    assert.ok(card.includes(`<strong>${row.weight.toFixed(1)}%</strong>`));
  }
  assert.match(cardMarkup(usd, "GAIN"), /In profit/);
  assert.match(cardMarkup(usd, "LOSS"), /In loss/);
  assert.match(cardMarkup(usd, "FLAT"), /At cost/);
  const euro = groupMarkup(html, "EUR");
  assert.equal(labeledValue(euro, "Tracked value"), nativeMoney(60, "EUR"));
  assert.doesNotMatch(euro, /\(€|EUR unavailable/);
  assert.match(html, /2026-10-09 reference rate/);
  assert.match(html, /not your historical EUR costs or EUR investment return/);
  assert.match(html, /data-portfolio-currency="USD" open>/);
  assert.match(html, /data-portfolio-currency="EUR" open>/);
  els.portfolioReview.querySelectorAll = () => [
    { dataset: { portfolioCurrency: "USD" }, open: false },
    { dataset: { portfolioCurrency: "EUR" }, open: true }
  ];
  renderPortfolioReview(portfolio, "fixture", { now: NOW, exchangeRate: FX });
  assert.match(els.portfolioReview.innerHTML, /data-portfolio-currency="USD">/);
  assert.match(els.portfolioReview.innerHTML, /data-portfolio-currency="EUR" open>/);
  assert.equal(labeledValue(groupMarkup(els.portfolioReview.innerHTML, "USD"), "Tracked value"), convertedMoney(500));
  assert.deepEqual({ holdings, results, portfolio, exchangeRate: FX, state, saved: [...browser.saved] }, before);
  assert.deepEqual(browser.writes, []);
  assert.deepEqual(portfolio.holdings.map(({ ticker, gain, gainPercent, status }) => ({ ticker, gain, gainPercent, status })), [
    { ticker: "GAIN", gain: 100, gainPercent: 0.5, status: "up" },
    { ticker: "LOSS", gain: -90, gainPercent: -0.375, status: "down" },
    { ticker: "FLAT", gain: 0, gainPercent: 0, status: "flat" },
    { ticker: "EURO", gain: 20, gainPercent: 0.5, status: "up" }
  ]);
});

test("legacy amounts convert for display while missing prices and group gains remain unavailable", async (t) => {
  const browser = browserFixture(t);
  const { renderPortfolioReview } = await import("../js/features/portfolio.js");
  const { els } = await import("../js/ui/dom.js");
  const originalOutput = els.portfolioReview;
  els.portfolioReview = browser.nodes.get("portfolioReview");
  t.after(() => { els.portfolioReview = originalOutput; });
  const portfolio = reviewFixture([
    { id: "MANUAL", kind: "manual", ticker: "MANUAL", label: "MANUAL holding", amount: 250, status: "down", currency: "USD" },
    position("MISSING", { shares: 4, averageCost: 25 })
  ], []);
  const before = structuredClone(portfolio);
  renderPortfolioReview(portfolio, "fixture", { now: NOW, exchangeRate: FX });
  const usd = groupMarkup(els.portfolioReview.innerHTML, "USD");
  assert.equal(labeledValue(usd, "Known tracked value"), convertedMoney(250));
  assert.equal(labeledValue(usd, "Cost basis"), "Unavailable");
  assert.equal(labeledValue(usd, "Unrealized gain / loss"), "Unavailable");
  const manual = cardMarkup(usd, "MANUAL");
  assert.equal(labeledValue(manual, "Entered amount"), convertedMoney(250));
  assert.match(manual, /Manual status: down/);
  assert.match(manual, /Legacy amount stays as entered/);
  const missing = cardMarkup(usd, "MISSING");
  assert.equal(labeledValue(missing, "Average purchase"), convertedMoney(25));
  assert.equal(labeledValue(missing, "Cost basis"), convertedMoney(100));
  assert.equal(labeledValue(missing, "Current value"), "Unavailable");
  assert.equal(labeledValue(missing, "Unrealized gain / loss"), "Unavailable");
  assert.match(missing, /Gain \/ loss unavailable/);
  assert.match(missing, /Weight unavailable/);
  assert.doesNotMatch(missing, /Price |\(€0|\$0\.00/);
  assert.deepEqual(portfolio, before);
  assert.deepEqual(browser.writes, []);
});

test("renderer rejects stale or unverified rates without inventing EUR values or hiding native USD prices", async (t) => {
  const browser = browserFixture(t);
  const { renderPortfolioReview } = await import("../js/features/portfolio.js");
  const { els } = await import("../js/ui/dom.js");
  const originalOutput = els.portfolioReview;
  els.portfolioReview = browser.nodes.get("portfolioReview");
  t.after(() => { els.portfolioReview = originalOutput; });
  const portfolio = reviewFixture([position("GAIN")], [priceResult("GAIN", 150)]);
  const before = structuredClone(portfolio);
  for (const exchangeRate of [null, { ...FX, date: "2026-10-01" }, { ...FX, source: "Unverified rate" },
    { ...FX, retrievedAt: "2026-10-09T13:00:00Z" }, { ...FX, sourceUrl: "https://example.com/rate" }]) {
    renderPortfolioReview(portfolio, "fixture", { now: NOW, exchangeRate });
    const html = els.portfolioReview.innerHTML;
    const usd = groupMarkup(html, "USD");
    assert.equal(labeledValue(usd, "Tracked value"), `${nativeMoney(300, "USD")} (EUR unavailable)`);
    assert.equal(labeledValue(usd, "Unrealized gain / loss"), `${nativeMoney(100, "USD", true)} (EUR unavailable)`);
    assert.ok(html.includes(`Price ${nativeMoney(150, "USD")} (EUR unavailable) · quote`));
    assert.match(html, /EUR equivalents are unavailable/);
    assert.doesNotMatch(html, /\(€|reference rate\./);
  }
  assert.deepEqual(portfolio, before);
  assert.deepEqual(browser.writes, []);
});
