import { trustedDomainMap, trustedSourceUniverse } from "../config/sources.js";
import { dateValue, normalizeDomain } from "../shared/text.js";

export function groupNewsByTicker(items) {
  const byTicker = {};
  items.forEach((item) => {
    item.tickers.forEach((ticker) => {
      if (!byTicker[ticker]) byTicker[ticker] = [];
      byTicker[ticker].push(item);
    });
  });
  for (const ticker of Object.keys(byTicker)) {
    // Broad sector stories must not crowd direct company coverage out of scoring.
    // Older cached articles without metadata are retained as context only.
    byTicker[ticker] = byTicker[ticker]
      .sort((a, b) => Number(Boolean(b.directTickers?.includes(ticker))) - Number(Boolean(a.directTickers?.includes(ticker))))
      .slice(0, 16);
  }
  return byTicker;
}

export function activeTrustedSourceTotal(sources) {
  return Math.max(0, (sources || []).filter((source) => source.ok).length - 1);
}

export function uniqueArticles(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.sourceId}|${item.title}|${item.link}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => dateValue(b.pubDate) - dateValue(a.pubDate));
}

export function sourceForDomain(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;
  const exact = trustedDomainMap.get(normalized);
  if (exact) return exact;
  return trustedSourceUniverse.find((source) => normalized === source.domain || normalized.endsWith(`.${source.domain}`)) || null;
}
