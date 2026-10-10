import test from "node:test";
import assert from "node:assert/strict";
import { buildTickerCatalog, loadTickerCatalog, searchTickers, resolveTickerInput, findListedInstrument,
  normalizeInstrumentCatalog, INSTRUMENT_SOURCE, INSTRUMENT_SOURCE_URL } from "../js/data/ticker-search.js";

const now = Date.now();
const directoryDate = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
const sourceAsOf = `${directoryDate.slice(4, 8)}${directoryDate.slice(0, 4)}00:00`;
const instruments = { schemaVersion: 1, source: INSTRUMENT_SOURCE, sourceUrl: INSTRUMENT_SOURCE_URL, sourceAsOf,
  generatedAt: new Date(now).toISOString(), entries: [
    { ticker: "SNDK", label: "SanDisk Corporation - Common Stock", type: "stock", exchange: "Q", aliases: ["SanDisk Corporation", "SanDisk"] },
    { ticker: "ASML", label: "ASML Holding N.V. - American Depositary Shares", type: "stock", exchange: "Q", aliases: ["ASML Holding N.V.", "ASML"] },
    { ticker: "BRK-B", label: "Berkshire Hathaway Inc. Class B Common Stock", type: "stock", exchange: "N", aliases: ["BRK.B", "Berkshire Hathaway"] },
    { ticker: "NEWETF", label: "New Index ETF", type: "ETF", exchange: "P", aliases: [] }
  ] };

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
    if (String(url).endsWith("/data/instruments.json")) return { ok: true, json: async () => instruments };
    return { ok: false, status: 503 };
  };
  try {
    const [first, second] = await Promise.all([loadTickerCatalog(), loadTickerCatalog()]);
    assert.equal(first, second);
    assert.equal(requests.length, 3);
    assert.equal(requests.filter(({ url }) => url.endsWith("/data/sec-tickers.json")).length, 1);
    assert.ok(requests.every(({ options }) => options.credentials === "same-origin"));
    assert.ok(requests.every(({ url }) => [new URL("../data/instruments.json", import.meta.url).href, new URL("../data/sec-tickers.json", import.meta.url).href, new URL("../data/prices.json", import.meta.url).href].includes(url)));
    assert.equal(searchTickers("Zebra", { catalog: first })[0].ticker, "ZZZ");
    assert.equal(searchTickers("spy", { catalog: first })[0].type, "ETF");
    assert.equal(searchTickers("sandisk", { catalog: first })[0].ticker, "SNDK");
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
    assert.equal(catalog.instrumentSnapshot.generatedAt, instruments.generatedAt);
    assert.equal(searchTickers("Sandisk", { catalog })[0].ticker, "SNDK");
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test("published directory broadens names and ADR/ETF suggestions while preserving non-US fallbacks", async () => {
  const catalog = buildTickerCatalog({ instruments, now });
  assert.equal(searchTickers("sand", { catalog })[0].ticker, "SNDK");
  assert.equal(searchTickers("asml", { catalog })[0].ticker, "ASML");
  assert.equal(searchTickers("New Index", { catalog })[0].type, "ETF");
  assert.ok(catalog.entries.some(({ ticker }) => ticker === "VWCE.DE"));
  assert.match(catalog.coverage, /4 US-listed stocks and ETFs/);
  assert.equal(await resolveTickerInput("Sandisk", { catalog }), "SNDK");
  assert.equal(await resolveTickerInput("SanDisk Corporation", { catalog }), "SNDK");
  assert.equal(await resolveTickerInput("SanDisk Corporation - Common Stock", { catalog }), "SNDK");
  assert.equal(await resolveTickerInput("Berkshire Hathaway Inc.", { catalog }), "BRK-B");
  assert.equal(await resolveTickerInput("brk.b", { catalog }), "BRK-B");
  assert.equal(await resolveTickerInput("sndk", { catalog }), "SNDK");
  assert.equal(await resolveTickerInput("OTHER.DE", { catalog }), "OTHER.DE");
  assert.equal(await resolveTickerInput("Some random company", { catalog }), null);
});

test("company names require an unambiguous exact match; prefixes remain suggestions", async () => {
  const catalog = [{ ticker: "ACM", label: "Acme Corp", type: "stock", aliases: ["Acme"] },
    { ticker: "ACMA", label: "Acme Corp Class A Common Stock", type: "stock", aliases: ["Acme"] }];
  assert.equal(await resolveTickerInput("Acme", { catalog }), null);
  assert.equal(await resolveTickerInput("acm", { catalog }), "ACM");
  assert.equal(await resolveTickerInput("Acme C", { catalog }), null);
  assert.equal(await resolveTickerInput("not-in-list", { catalog }), "NOT-IN-LIST");
  assert.equal(await resolveTickerInput("X".repeat(121), { catalog }), null);
});

test("listing verification uses only recent official snapshot provenance and never configured aliases", () => {
  const catalog = buildTickerCatalog({ instruments, secTickers, priceSnapshot, now });
  assert.deepEqual(findListedInstrument(catalog, "SNDK", { now }), { ticker: "SNDK", name: "SanDisk Corporation - Common Stock",
    quoteType: "EQUITY", exchange: "Q", source: INSTRUMENT_SOURCE, sourceUrl: INSTRUMENT_SOURCE_URL, verifiedAt: instruments.generatedAt });
  assert.equal(findListedInstrument(catalog, "NEWETF", { now }).quoteType, "ETF");
  assert.equal(findListedInstrument(catalog, "AAPL", { now }), null);
  assert.equal(findListedInstrument(catalog, "SNDK", { now: now + 8 * 86400000 }), null);
  assert.equal(findListedInstrument({ ...catalog, instrumentSnapshot: { ...instruments, source: "invented" } }, "SNDK", { now }), null);
  assert.equal(findListedInstrument(catalog, "SNDK", { now: now - 1000 }), null);
  const oldSource = { ...instruments, sourceAsOf: "0101202000:00" };
  assert.equal(findListedInstrument(buildTickerCatalog({ instruments: oldSource, now }), "SNDK", { now }), null);
});

test("directory normalization rejects malformed dates, types, provenance, symbols and duplicate identities", () => {
  assert.equal(normalizeInstrumentCatalog(instruments, { now }).entries.length, 4);
  for (const patch of [{ source: "Other" }, { sourceUrl: "https://example.com" }, { generatedAt: new Date(now + 1).toISOString() },
    { sourceAsOf: "0230202600:00" }, { sourceAsOf: "1009202624:00" }, { entries: [] },
    { entries: [...instruments.entries, instruments.entries[0]] },
    { entries: [{ ...instruments.entries[0], ticker: "<SCRIPT>" }] },
    { entries: [{ ...instruments.entries[0], type: "warrant" }] }]) {
    assert.equal(normalizeInstrumentCatalog({ ...instruments, ...patch }, { now }), null);
  }
});
