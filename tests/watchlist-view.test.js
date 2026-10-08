import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const nodes = new Map();
function element(id) {
  if (!nodes.has(id)) nodes.set(id, { value: "", innerHTML: "", textContent: "" });
  return nodes.get(id);
}
globalThis.document = { getElementById: element, querySelectorAll: () => [],
  querySelector: () => element("filterSummary") };
globalThis.localStorage = { getItem: () => null };
const { state } = await import("../js/storage.js");
const { scanState } = await import("../js/scan-state.js");
const { renderScreener } = await import("../js/features/screener.js");

beforeEach(() => {
  state.tickerInput = "OWN";
  element("screenerSignal").value = "all";
  element("screenerMinScore").value = "0";
  element("screenerMinLiquidity").value = "0";
  element("screenerSort").value = "score";
  scanState.latestRankedResults = [];
});

function stock(ticker, overrides = {}) {
  return { ticker, score: 60, latest: 100, currency: "USD", oneDay: .01, oneMonth: .03,
    sixMonth: .08, dataQuality: { eligible: true, asOf: new Date().toISOString() },
    setup: { signal: "Hold", riskLevel: "Moderate" }, ...overrides };
}

function displayedTickers() {
  return [...element("screenerResults").innerHTML.matchAll(/data-detail-ticker="([^"]+)"/g)].map((match) => match[1]);
}

test("watchlist excludes discovery stocks and keeps missing-volume stocks when no liquidity floor is set", () => {
  scanState.latestRankedResults = [stock("IDEA", { score: 90, averageDollarVolume: 20e6 }), stock("OWN")];
  renderScreener();
  assert.deepEqual(displayedTickers(), ["OWN"]);
  element("screenerMinLiquidity").value = "5";
  renderScreener();
  assert.deepEqual(displayedTickers(), []);
  assert.match(element("screenerResults").innerHTML, /No watchlist symbols match/);
});

test("a long watchlist keeps every matching stock accessible in a closed More stocks disclosure", () => {
  const tickers = Array.from({ length: 43 }, (_, index) => `ST${String(index).padStart(2, "0")}`);
  state.tickerInput = tickers.join(", ");
  scanState.latestRankedResults = tickers.map((ticker) => stock(ticker));
  renderScreener();
  assert.deepEqual(displayedTickers(), tickers);
  const html = element("screenerResults").innerHTML;
  assert.match(html, /<details class="secondary-details"><summary>More stocks \(3\)<\/summary>/);
  assert.equal((html.split("More stocks")[0].match(/data-detail-ticker=/g) || []).length, 40);
});

test("unavailable and missing watched histories cannot show signals and have visible gap counts", () => {
  state.tickerInput = "OWN, OLD, MISS";
  scanState.latestRankedResults = [stock("OWN"), stock("OLD", {
    dataQuality: { eligible: false, reason: "History < 200 days" }
  })];
  renderScreener();
  assert.deepEqual(displayedTickers(), ["OWN"]);
  const html = element("screenerResults").innerHTML;
  assert.match(html, /Unavailable prices \(2\)/);
  assert.match(html, /OLD<\/strong> — History &lt; 200 days/);
  assert.match(html, /MISS<\/strong> — Not returned/);
});
