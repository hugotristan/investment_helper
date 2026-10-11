// Published issuer data, never a substitute for live constituent prices.
// Update weights and the observation date together after checking the source.
export const VWCE_EXPOSURE = {
  tickers: ["VWCE.DE"], name: "Vanguard FTSE All-World UCITS ETF (USD) Accumulating",
  asOf: "2026-08-31", source: "Vanguard", sourceUrl: "https://www.vanguard.co.uk/professional/product/etf/equity/9679/ftse-all-world-ucits",
  // Vanguard lists two Alphabet share classes; issuer exposure combines both.
  holdings: [
    { id: "nvidia", name: "NVIDIA", tickers: ["NVDA"], weight: 0.0476598 },
    { id: "apple", name: "Apple", tickers: ["AAPL"], weight: 0.0423529 },
    { id: "microsoft", name: "Microsoft", tickers: ["MSFT"], weight: 0.0348660 },
    { id: "amazon", name: "Amazon", tickers: ["AMZN"], weight: 0.0233245 },
    { id: "alphabet", name: "Alphabet", tickers: ["GOOG", "GOOGL"], weight: 0.0330583 },
    { id: "tsmc", name: "Taiwan Semiconductor Manufacturing", tickers: ["TSM", "2330.TW"], weight: 0.0170366 },
    { id: "broadcom", name: "Broadcom", tickers: ["AVGO"], weight: 0.0159466 },
    { id: "meta", name: "Meta Platforms", tickers: ["META"], weight: 0.0116567 },
    { id: "micron", name: "Micron Technology", tickers: ["MU"], weight: 0.0100043 }
  ]
};
