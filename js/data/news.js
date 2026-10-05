import { cleanArticleText, headlineSentiment, inferArticleEvidence, outlookSentiment, outlookTermsMentioned } from "../analysis/news.js";
import { GDELT_DIRECT_TIMEOUT_MS, GDELT_RELAY_TIMEOUT_MS, MAX_SOURCE_SCAN_MS, MIN_ACTIVE_SOURCES, RSS_DIRECT_TIMEOUT_MS, RSS_RELAY_TIMEOUT_MS, SOURCE_CACHE_MIN_RATIO, outlookDomains } from "../config/settings.js";
import { sourceFeeds, trustedSourceUniverse } from "../config/sources.js";
import { fetchWithRetry, mapLimit } from "./http.js";
import { activeTrustedSourceTotal, groupNewsByTicker, sourceForDomain, uniqueArticles } from "./news-helpers.js";
import { buildAnalystOutlookScans, buildDeepSourceScans, buildGdeltScans } from "./news-scans.js";
import { cleanText, normalizeDomain, safeDomainFromUrl, unique } from "../shared/text.js";

let lastGoodNews = null;

export async function loadNewsSources(tickers, options = {}) {
  const allowCache = options.allowCache !== false;
  const startedAt = Date.now();
  const scanSources = [];
  const primaryGdeltScans = buildGdeltScans(tickers);
  const outlookScans = buildAnalystOutlookScans(tickers);
  const [gdeltSettled, outlookSettled] = await Promise.all([
    mapLimit(primaryGdeltScans, 2, (scan) => loadGdeltScan(scan, tickers)),
    mapLimit(outlookScans, 2, (scan) => loadGdeltScan(scan, tickers))
  ]);
  scanSources.push(...gdeltSettled.map((result, index) => result.status === "fulfilled"
    ? result.value
    : { id: primaryGdeltScans[index].id, name: primaryGdeltScans[index].name, ok: false, via: "none", count: 0, items: [], error: "Fetch failed" }));
  scanSources.push(...outlookSettled.map((result, index) => result.status === "fulfilled"
    ? result.value
    : { id: outlookScans[index].id, name: outlookScans[index].name, ok: false, via: "none", count: 0, items: [], error: "Fetch failed" }));

  if (activeSourceCount(scanSources) < MIN_ACTIVE_SOURCES && Date.now() - startedAt < MAX_SOURCE_SCAN_MS) {
    await collectSourceBatch(sourceFeeds, 6, (feed) => loadFeed(feed, tickers), scanSources, startedAt);
  }

  for (const scan of buildDeepSourceScans(tickers)) {
    if (activeSourceCount(scanSources) >= MIN_ACTIVE_SOURCES) break;
    if (Date.now() - startedAt > MAX_SOURCE_SCAN_MS) break;
    scanSources.push(await loadGdeltScan(scan, tickers));
  }

  const coverage = buildSourceCoverage(scanSources);
  const items = uniqueArticles(scanSources.flatMap((source) => source.items || []));
  const byTicker = groupNewsByTicker(items);
  const okCount = Math.max(0, coverage.filter((source) => source.ok).length - 1);
  const result = {
    byTicker,
    items,
    outlookCount: items.filter((item) => item.kind === "outlook").length,
    sources: coverage,
    scanSources,
    configured: trustedSourceUniverse.length,
    label: `${okCount}/${trustedSourceUniverse.length} trusted sources active${okCount < MIN_ACTIVE_SOURCES ? " after deep scan" : ""}`
  };
  if (items.length) {
    const stabilized = allowCache ? stableNewsResult(result) : null;
    if (stabilized) return stabilized;
    if (allowCache) lastGoodNews = result;
    return result;
  }
  return allowCache ? cachedNewsResult(result) || result : result;
}

async function loadGdeltScan(scan, tickers) {
  const relayUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(scan.url)}`;
  const routes = [
    { url: scan.url, via: "GDELT JSON", timeoutMs: GDELT_DIRECT_TIMEOUT_MS },
    { url: relayUrl, via: "GDELT relay", timeoutMs: GDELT_RELAY_TIMEOUT_MS }
  ];

  for (const route of routes) {
    try {
      const response = await fetchWithRetry(route.url, {
        timeoutMs: route.timeoutMs,
        type: "json",
        attempts: route.via === "GDELT JSON" ? 2 : 1,
        delayMs: 1200
      });
      if (!response.ok) continue;
      const json = await response.json();
      const articles = Array.isArray(json?.articles) ? json.articles : [];
      const items = articles.map((article) => parseGdeltArticle(article, tickers, scan)).filter(Boolean);
      return {
        id: scan.id,
        name: scan.name,
        ok: true,
        via: route.via,
        count: items.length,
        items
      };
    } catch {
      // Try the slower relay after direct GDELT fails or times out.
    }
  }

  return { id: scan.id, name: scan.name, ok: false, via: "none", count: 0, items: [], error: "GDELT unavailable after retry" };
}

export function parseGdeltArticle(article, tickers, scan = {}) {
  const title = cleanText(article?.title || "");
  const description = cleanText(article?.description || article?.summary || "");
  const link = article?.url || "";
  const domain = normalizeDomain(article?.domain || safeDomainFromUrl(link));
  const trusted = sourceForDomain(domain);
  if (!title || !trusted) return null;

  // Publisher identity is attribution, never evidence about a listed company.
  const text = `${cleanArticleText(title, trusted.name)} ${cleanArticleText(description, trusted.name)}`.trim();
  const isOutlook = scan.kind === "outlook" || outlookDomains.has(trusted.domain) || outlookTermsMentioned(text);
  const evidence = inferArticleEvidence(text, tickers, { isOutlook });
  if (!evidence.tickers.length) return null;

  return {
    title,
    description,
    link,
    pubDate: article?.seendate || "",
    sentiment: isOutlook ? outlookSentiment(text) : headlineSentiment(text),
    ...evidence,
    source: trusted.name,
    sourceId: trusted.id,
    domain: trusted.domain,
    kind: isOutlook ? "outlook" : "news",
    horizon: scan.horizon || (isOutlook ? "recent" : "current")
  };
}

function activeSourceCount(scanSources) {
  return unique((scanSources || [])
    .flatMap((source) => source.items || [])
    .map((item) => item.sourceId)).length;
}

async function loadFeed(feed, tickers) {
  const resolvedUrl = typeof feed.url === "function" ? feed.url(tickers) : feed.url;
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(resolvedUrl)}`;

  for (const [index, url] of [resolvedUrl, proxyUrl].entries()) {
    try {
      const response = await fetchWithRetry(url, {
        timeoutMs: index === 0 ? RSS_DIRECT_TIMEOUT_MS : RSS_RELAY_TIMEOUT_MS,
        attempts: index === 0 ? 2 : 1,
        delayMs: 1000
      });
      if (!response.ok) continue;
      const xmlText = await response.text();
      const items = parseNewsFeed(xmlText, tickers, feed);
      return {
        id: feed.id,
        name: feed.name,
        ok: true,
        via: index === 0 ? "direct RSS" : "RSS relay",
        count: items.length,
        items
      };
    } catch {
      // Try relay when direct fetch fails.
    }
  }

  return { id: feed.id, name: feed.name, ok: false, via: "none", count: 0, items: [], error: "Unavailable after retry" };
}

async function collectSourceBatch(items, limit, worker, scanSources, startedAt) {
  let next = 0;
  let running = 0;

  return new Promise((resolve) => {
    const shouldStop = () => activeSourceCount(scanSources) >= MIN_ACTIVE_SOURCES || Date.now() - startedAt >= MAX_SOURCE_SCAN_MS;
    const finishIfDone = () => {
      if ((next >= items.length || shouldStop()) && running === 0) resolve();
    };
    const launch = () => {
      while (running < limit && next < items.length && !shouldStop()) {
        const item = items[next];
        next += 1;
        running += 1;
        worker(item)
          .then((result) => scanSources.push(result))
          .catch(() => scanSources.push({
            id: item.id,
            name: item.name,
            ok: false,
            via: "none",
            count: 0,
            items: [],
            error: "Fetch failed"
          }))
          .finally(() => {
            running -= 1;
            launch();
            finishIfDone();
          });
      }
      finishIfDone();
    };
    launch();
  });
}

export function parseNewsFeed(xmlText, tickers, feed) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const nodes = Array.from(doc.querySelectorAll("item, entry"));
  const parsed = [];
  const trusted = sourceForDomain(feed.domain);
  const sourceId = trusted?.id || feed.id;
  const sourceName = trusted?.name || feed.name;
  const sourceDomain = trusted?.domain || normalizeDomain(feed.domain || "");

  nodes.slice(0, 18).forEach((item) => {
    const title = cleanText(item.querySelector("title")?.textContent || "");
    const description = cleanText(item.querySelector("description, summary, content")?.textContent || "");
    const linkNode = item.querySelector("link");
    const link = linkNode?.getAttribute("href") || linkNode?.textContent?.trim() || "";
    const pubDate = item.querySelector("pubDate, updated, published")?.textContent?.trim() || "";
    const text = `${cleanArticleText(title, sourceName)} ${cleanArticleText(description, sourceName)}`.trim();
    const isOutlook = outlookDomains.has(sourceDomain) || outlookTermsMentioned(text);
    const evidence = inferArticleEvidence(text, tickers, { isOutlook });
    const sentiment = isOutlook ? outlookSentiment(text) : headlineSentiment(text);
    if (!title || !evidence.tickers.length) return;
    parsed.push({ title, description, link, pubDate, sentiment, ...evidence,
      source: sourceName, sourceId, domain: sourceDomain,
      kind: isOutlook ? "outlook" : "news", horizon: isOutlook ? "recent" : "current" });
  });

  return parsed;
}

function buildSourceCoverage(scanSources) {
  const buckets = new Map(trustedSourceUniverse.map((source) => [source.id, {
    id: source.id,
    name: source.name,
    ok: false,
    via: "trusted universe",
    count: 0,
    items: [],
    domain: source.domain
  }]));

  scanSources.forEach((scan) => {
    (scan.items || []).forEach((item) => {
      const bucket = buckets.get(item.sourceId);
      if (!bucket) return;
      bucket.ok = true;
      bucket.via = item.domain ? "GDELT/RSS" : scan.via;
      bucket.count += 1;
      if (bucket.items.length < 5) bucket.items.push(item);
    });
  });

  const activeSources = Array.from(buckets.values())
    .filter((source) => source.ok)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const liveFeeds = scanSources.filter((source) => source.ok).length;
  const failedFeeds = scanSources.length - liveFeeds;
  const reachedMinimum = activeSources.length >= MIN_ACTIVE_SOURCES;

  return [{
    id: "live-source-index",
    name: "Live source index",
    ok: true,
    via: "GDELT + RSS",
    count: activeSources.reduce((sum, source) => sum + source.count, 0),
    items: [],
    meta: reachedMinimum
      ? `${activeSources.length} active trusted sources reached. ${liveFeeds}/${scanSources.length} live endpoints answered after extended retries; ${failedFeeds} blocked, empty, or unreachable.`
      : `${activeSources.length}/${MIN_ACTIVE_SOURCES} active trusted sources found after deep scan. ${liveFeeds}/${scanSources.length} live endpoints answered; remaining sources were blocked, empty, or unreachable.`
  }].concat(activeSources);
}

function cachedNewsResult(emptyResult) {
  if (!lastGoodNews?.items?.length) return null;
  const cachedSources = lastGoodNews.sources.map((source) => source.id === "live-source-index"
    ? {
        ...source,
        meta: `Current live scan returned no usable headlines after extended retries, so the model reused the last successful headline scan. ${emptyResult.sources[0]?.meta || ""}`.trim()
      }
    : source);
  return {
    ...lastGoodNews,
    sources: cachedSources,
    scanSources: emptyResult.scanSources,
    outlookCount: lastGoodNews.outlookCount || 0,
    label: `${Math.max(0, cachedSources.filter((source) => source.ok).length - 1)}/${trustedSourceUniverse.length} trusted sources from cached live headlines`
  };
}

function stableNewsResult(result) {
  if (!lastGoodNews?.items?.length) return null;
  const currentActive = activeTrustedSourceTotal(result.sources);
  const previousActive = activeTrustedSourceTotal(lastGoodNews.sources);
  if (currentActive >= MIN_ACTIVE_SOURCES || currentActive >= previousActive * SOURCE_CACHE_MIN_RATIO) return null;

  const mergedItems = uniqueArticles(result.items.concat(lastGoodNews.items)).slice(0, 500);
  const mergedSources = buildSourceCoverage((result.scanSources || []).concat(lastGoodNews.scanSources || []));
  const mergedActive = activeTrustedSourceTotal(mergedSources);
  const stabilized = {
    ...result,
    items: mergedItems,
    byTicker: groupNewsByTicker(mergedItems),
    outlookCount: mergedItems.filter((item) => item.kind === "outlook").length,
    sources: mergedSources,
    label: `${mergedActive}/${trustedSourceUniverse.length} trusted sources stabilized from current + previous scan`
  };
  lastGoodNews = stabilized;
  return stabilized;
}
