// Keep quote provenance separate from the provider of historical daily bars.
export const LEEWAY_QUOTE_SOURCE = "Leeway delayed quote";
const SOURCES = new Set(["Yahoo Finance quote", "Yahoo Finance published quote", LEEWAY_QUOTE_SOURCE]);
export function isMarketQuoteSource(source) { return SOURCES.has(source); }
export function publishedQuoteSource(source) {
  return source === LEEWAY_QUOTE_SOURCE ? source : "Yahoo Finance published quote";
}
