import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanArticleText, headlineSentiment, inferArticleEvidence, inferMarketContextTargets, inferNewsTargets, inferOutlookTargets, outlookSentiment, outlookTermsMentioned, symbolMentioned } from "../js/analysis/news.js";
import { groupNewsByTicker } from "../js/data/news-helpers.js";
import { parseGdeltArticle, parseNewsFeed } from "../js/data/news.js";

test("company and market phrases do not match inside unrelated words", () => {
  assert.deepEqual(inferOutlookTargets("RAIL and RETAIL outlook", ["NVDA", "MSFT", "SMH"]), []);
  assert.deepEqual(inferNewsTargets("Artificial intelligence and visage research", ["INTC", "V"]), []);
  assert.deepEqual(inferMarketContextTargets("Federation reviews secondhand trailers", ["SPY", "QQQ"]), []);
  assert.equal(outlookTermsMentioned("The forecaster studies new strategies"), false);
  assert.deepEqual(inferNewsTargets("Palo Alto Networks and Taiwan Semiconductor report", ["PANW", "TSM"]), ["PANW", "TSM"]);
});

test("short symbols require financial notation and longer symbols retain case", () => {
  for (const text of ["MS research", "Systems improve now", "CAT and DE", "$MSFT grew", "NYSE:MS.A"]) {
    assert.equal(symbolMentioned(text, "MS"), false, text);
  }
  for (const text of ["$MS.", "Morgan Stanley (MS) reports", "NYSE: MS earnings", "Ticker: MS"]) {
    assert.equal(symbolMentioned(text, "MS"), true, text);
  }
  assert.equal(symbolMentioned("NOW is the time to buy", "NOW"), false);
  assert.equal(symbolMentioned("SNOW earnings", "SNOW"), true);
  assert.equal(symbolMentioned("Snow weather warnings", "SNOW"), false);
  assert.equal(symbolMentioned("fooMSFT earnings", "MSFT"), false);
  assert.equal(symbolMentioned("$VWCE.DE flows", "VWCE.DE"), true);
});

test("sentiment counts whole words and phrases rather than embedded fragments", () => {
  assert.equal(headlineSentiment("Missile cutlery profitable retailers"), 0);
  assert.equal(outlookSentiment("Riskless attractiveness favors resilience"), 0);
  assert.equal(headlineSentiment("Profit beats guidance cuts"), 1 / 3);
  assert.equal(outlookSentiment("Growth opportunity and rate cut"), 1);
});

test("article metadata separates direct company evidence from sector and market context", () => {
  const tickers = ["NVDA", "AMD", "MSFT", "SPY", "QQQ", "SMH"];
  const sector = inferArticleEvidence("AI semiconductor outlook", tickers, { isOutlook: true });
  assert.deepEqual(sector.directTickers, []);
  assert.equal(sector.evidenceScope, "sector");
  assert.ok(sector.sectorTickers.includes("NVDA"));
  const direct = inferArticleEvidence("Nvidia reports AI growth as inflation falls", tickers);
  assert.deepEqual(direct.directTickers, ["NVDA"]);
  assert.ok(direct.sectorTickers.includes("AMD"));
  assert.ok(direct.marketTickers.includes("SPY"));
  assert.equal(direct.evidenceScope, "direct");
  const macro = inferArticleEvidence("Federal Reserve inflation outlook", tickers, { isOutlook: true });
  assert.deepEqual(macro.directTickers, []);
  assert.deepEqual(macro.sectorTickers, []);
  assert.equal(macro.evidenceScope, "market");
  assert.ok(macro.marketTickers.includes("SPY"));
  assert.ok(!macro.tickers.includes("NVDA"));
});

test("publisher metadata and explicit branding never manufacture company coverage", () => {
  const options = { publisher: "Morgan Stanley", isOutlook: true };
  assert.deepEqual(inferArticleEvidence("Equity market outlook", ["MS", "SPY"], options).directTickers, []);
  assert.deepEqual(inferArticleEvidence("Equity market outlook - Morgan Stanley", ["MS", "SPY"], options).directTickers, []);
  assert.equal(cleanArticleText("Morgan Stanley | Equity outlook", "Morgan Stanley"), "Equity outlook");
  assert.deepEqual(inferArticleEvidence("Morgan Stanley earnings growth", ["MS", "SPY"], options).directTickers, ["MS"]);
});

test("both GDELT and RSS normalization preserve direct-evidence metadata", (t) => {
  const originalParser = globalThis.DOMParser;
  t.after(() => { globalThis.DOMParser = originalParser; });
  const feedEntries = [
    { title: "AI outlook - Morgan Stanley", description: "Semiconductor growth", link: "https://morganstanley.com/sector" },
    { title: "Company report", description: "Microsoft earnings beat estimates - Morgan Stanley", link: "https://morganstanley.com/company" }
  ];
  // Parsing is provided by the browser; these fixtures exercise the real
  // normalization functions with already decoded article text and RSS nodes.
  globalThis.DOMParser = class {
    parseFromString(text, type) {
      if (type === "text/html") return { body: { textContent: text } };
      return { querySelectorAll: () => feedEntries.map((entry) => ({
        querySelector(selector) {
          const key = selector === "description, summary, content" ? "description" : selector === "pubDate, updated, published" ? "pubDate" : selector;
          return entry[key] ? { textContent: entry[key], getAttribute: () => null } : null;
        }
      })) };
    }
  };
  const tickers = ["MS", "MSFT", "NVDA", "SPY"];
  const article = parseGdeltArticle({ title: "AI outlook", domain: "morganstanley.com", url: "https://morganstanley.com/outlook" }, tickers);
  assert.ok(article.tickers.includes("NVDA"));
  assert.deepEqual(article.directTickers, []);
  assert.ok(!article.tickers.includes("MS"));
  assert.equal(article.source, "Morgan Stanley");
  const company = parseGdeltArticle({ title: "Company report", description: "Microsoft earnings growth", domain: "reuters.com", url: "https://reuters.com/company" }, tickers);
  assert.deepEqual(company.directTickers, ["MSFT"]);
  const feed = parseNewsFeed("RSS fixture", tickers, { id: "ms", name: "Morgan Stanley", domain: "morganstanley.com" });
  assert.deepEqual(feed[0].directTickers, []);
  assert.ok(!feed[0].tickers.includes("MS"));
  assert.deepEqual(feed[1].directTickers, ["MSFT"]);
  assert.ok(!feed[1].directTickers.includes("MS"));
  assert.equal(feed[1].kind, "outlook");
});

test("ticker grouping retains direct company coverage ahead of generic and legacy context", () => {
  const context = Array.from({ length: 20 }, (_, index) => ({ title: `Sector ${index}`, tickers: ["NVDA"], directTickers: [] }));
  const legacy = { title: "Legacy unclassified story", tickers: ["NVDA"] };
  const direct = { title: "Nvidia earnings", tickers: ["NVDA", "AMD"], directTickers: ["NVDA"] };
  const grouped = groupNewsByTicker([...context, legacy, direct]);
  assert.equal(grouped.NVDA.length, 16);
  assert.equal(grouped.NVDA[0], direct);
  assert.equal(grouped.AMD[0], direct);
  assert.equal(legacy.directTickers, undefined);
});
