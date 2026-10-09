import test from "node:test";
import assert from "node:assert/strict";
import { buildTickerCatalog, loadTickerCatalog, searchTickers } from "../js/data/ticker-search.js";

const secTickers = { schemaVersion: 1, companyTickers: {
  AAPL: { ticker: "AAPL", title: "Apple Inc.", cik_str: 320193 },
  MSFT: { ticker: "MSFT", title: "MICROSOFT CORP", cik_str: 789019 },
  ZZZ: { ticker: "ZZZ", title: "Zebra Materials Incorporated", cik_str: 1234 }
} };
const priceSnapshot = { schemaVersion: 1, byTicker: {
  SPY: { ticker: "SPY", instrumentType: "ETF", source: "Yahoo Finance published snapshot", quote: { ticker: "SPY", name: "SPDR S&P 500 ETF Trust" } },
  QQQ: { ticker: "QQQ", instrumentType: "ETF", source: "Yahoo Finance published snapshot", quote: { ticker: "QQQ", name: "Invesco QQQ Trust" } }
} };

test("catalog has configured fallback stocks/ETFs, keeps company aliases and adopts real instrument labels", () => {
  const fallback = buildTickerCatalog();
  assert.equal(searchTickers("apple", { catalog: fallback })[0].ticker, "AAPL");
  assert.equal(searchTickers("nasdaq", { catalog: fallback })[0].ticker, "QQQ");
  const catalog = buildTickerCatalog({ secTickers, priceSnapshot });
  assert.deepEqual(searchTickers("aapl", { catalog })[0], { ticker: "AAPL", label: "Apple Inc.", type: "stock" });
  assert.deepEqual(searchTickers("invesco", { catalog })[0], { ticker: "QQQ", label: "Invesco QQQ Trust", type: "ETF" });
  assert.equal(searchTickers("zebra", { catalog })[0].ticker, "ZZZ");
  assert.match(catalog.coverage, /3 bundled US issuers/);
  assert.match(catalog.coverage, /Other tickers can be typed/);
  assert.equal(catalog.entries.filter(({ ticker }) => ticker === "AAPL").length, 1);
});

test("exact and prefix matches rank before contains, with deterministic ticker tie breaks", () => {
  const catalog = [
    { ticker: "XAI", label: "Other Company", type: "stock" },
    { ticker: "AIB", label: "Company Two", type: "stock" },
    { ticker: "ZED", label: "Air Systems", type: "stock" },
    { ticker: "AIA", label: "Company One", type: "stock" },
    { ticker: "AI", label: "C3.ai", type: "stock" },
    { ticker: "ABC", label: "Air", type: "stock" }
  ];
  assert.deepEqual(searchTickers("ai", { catalog }).map(({ ticker }) => ticker), ["AI", "AIA", "AIB", "ABC", "ZED", "XAI"]);
  assert.deepEqual(searchTickers("AIR", { catalog }).map(({ ticker }) => ticker), ["ABC", "ZED"]);
  assert.deepEqual(searchTickers("ai", { catalog: [...catalog].reverse() }), searchTickers("ai", { catalog }));
});

test("one-letter searches are case-insensitive, bounded to eight and accept accented company names", () => {
  const catalog = Array.from({ length: 12 }, (_, index) => ({ ticker: `A${String(index).padStart(2, "0")}`, label: `Acme ${index}`, type: "stock" }));
  assert.equal(searchTickers("a", { catalog }).length, 8);
  assert.equal(searchTickers("A", { catalog, limit: 200 }).length, 8);
  assert.equal(searchTickers("a", { catalog, limit: 2 }).length, 2);
  assert.deepEqual(searchTickers("A", { catalog }), searchTickers("a", { catalog }));
  assert.equal(searchTickers("cafe", { catalog: [{ ticker: "CAFE", label: "Café Holdings", type: "stock" }] })[0].ticker, "CAFE");
  assert.deepEqual(searchTickers("", { catalog }), []);
  assert.deepEqual(searchTickers(" ", { catalog }), []);
  assert.deepEqual(searchTickers("X".repeat(121), { catalog }), []);
});

test("catalog ignores malformed, sample, crypto and index-only entries without inventing search results", () => {
  const badIssuers = { schemaVersion: 1, companyTickers: {
    badName: { ticker: "FAKE", title: "Made Up", cik_str: "100" },
    crypto: { ticker: "BTC-USD", title: "Bitcoin", cik_str: 12 },
    badSymbol: { ticker: "<SCRIPT>", title: "Bad Symbol", cik_str: 12 }
  } };
  const badPrices = { schemaVersion: 1, byTicker: {
    FAKE: { ticker: "FAKE", instrumentType: "EQUITY", source: "Sample fallback", quote: { ticker: "FAKE", name: "Invented Company" } },
    GOOD: { ticker: "OTHER", instrumentType: "ETF", quote: { ticker: "GOOD", name: "Wrong Symbol" } },
    "^VIX": { ticker: "^VIX", instrumentType: "INDEX", source: "Yahoo Finance", quote: { ticker: "^VIX", name: "VIX" } },
    ZZZ: { ticker: "ZZZ", instrumentType: "UNKNOWN", quote: { ticker: "ZZZ", name: "Wrong Type" } }
  } };
  const catalog = buildTickerCatalog({ secTickers: badIssuers, priceSnapshot: badPrices });
  for (const query of ["Invented Company", "Bitcoin", "Wrong Symbol", "Wrong Type", "XXXXXXXX"]) assert.deepEqual(searchTickers(query, { catalog }), []);
  assert.equal(catalog.entries.some(({ ticker }) => ticker === "^VIX"), false);
  assert.deepEqual(searchTickers("bitcoin", { catalog: [{ ticker: "BTC", label: "Bitcoin", type: "stock" }] }), []);
});

test("local loader uses repository-relative same-origin files once and survives unavailable catalogs", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/data/sec-tickers.json")) return { ok: true, json: async () => secTickers };
    return { ok: false, status: 503 };
  };
  try {
    const [first, second] = await Promise.all([loadTickerCatalog(), loadTickerCatalog()]);
    assert.equal(first, second);
    assert.equal(requests.length, 2);
    assert.equal(requests.filter(({ url }) => url.endsWith("/data/sec-tickers.json")).length, 1);
    assert.ok(requests.every(({ options }) => options.credentials === "same-origin"));
    assert.ok(requests.every(({ url }) => [new URL("../data/sec-tickers.json", import.meta.url).href, new URL("../data/prices.json", import.meta.url).href].includes(url)));
    assert.equal(searchTickers("Zebra", { catalog: first })[0].ticker, "ZZZ");
    assert.equal(searchTickers("spy", { catalog: first })[0].type, "ETF");
  } finally { globalThis.fetch = originalFetch; }
});

test("unavailable same-origin files leave configured suggestions and free typing available", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const later = originalNow() + 6 * 60 * 1000;
  globalThis.fetch = async () => { throw new Error("offline"); };
  Date.now = () => later;
  try {
    const catalog = await loadTickerCatalog();
    assert.equal(searchTickers("microsoft", { catalog })[0].ticker, "MSFT");
    assert.equal(searchTickers("QQQ", { catalog })[0].type, "ETF");
    assert.match(catalog.coverage, /Other tickers can be typed/);
    assert.doesNotMatch(catalog.coverage, /bundled US issuers/);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});
