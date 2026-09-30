// Scan limits, the initial watchlist, asset categories, and scoring vocabulary.

export const AUTO_REFRESH_DELAY_SECONDS = 900;

export const GDELT_DIRECT_TIMEOUT_MS = 18000;

export const GDELT_RELAY_TIMEOUT_MS = 24000;

export const RSS_DIRECT_TIMEOUT_MS = 10000;

export const RSS_RELAY_TIMEOUT_MS = 16000;

export const PRICE_TIMEOUT_MS = 10000;

export const MIN_ACTIVE_SOURCES = 60;

export const MAX_SOURCE_SCAN_MS = 300000;

export const SCORE_MOVE_LIMIT = 6;

export const SOURCE_CACHE_MIN_RATIO = 0.7;

export const marketProxyTickers = [
  { ticker: "SPY", label: "S&P 500" },
  { ticker: "QQQ", label: "Nasdaq 100" },
  { ticker: "IWM", label: "Russell 2000" },
  { ticker: "VTI", label: "Total U.S. market" },
  { ticker: "TLT", label: "Long bonds / rate pressure" },
  { ticker: "HYG", label: "High-yield credit" },
  { ticker: "LQD", label: "Investment-grade credit" },
  { ticker: "GLD", label: "Gold / safety bid" },
  { ticker: "USO", label: "Oil / inflation pressure" },
  { ticker: "UUP", label: "U.S. dollar" },
  { ticker: "^VIX", label: "VIX volatility" }
];

export const opportunityUniverse = [
  "SPY", "QQQ", "IWM", "VTI", "VEA", "VWO", "TLT", "HYG", "LQD", "GLD", "USO", "UUP",
  "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLRE", "XLB", "SMH", "XBI",
  "AAPL", "MSFT", "NVDA", "AVGO", "AMD", "INTC", "TSM", "ORCL", "CRM", "ADBE", "NOW", "PANW",
  "GOOGL", "META", "AMZN", "NFLX", "TSLA", "UBER", "SHOP", "PLTR", "SNOW", "MU",
  "JPM", "BAC", "V", "MA", "AXP", "GS", "MS", "BX", "SCHW",
  "XOM", "CVX", "COP", "SLB", "NEE", "CEG",
  "LLY", "UNH", "JNJ", "MRK", "ABBV", "TMO", "PFE", "ISRG",
  "COST", "WMT", "HD", "MCD", "NKE", "SBUX", "DIS",
  "CAT", "GE", "DE", "HON", "BA", "LMT",
  "LIN", "FCX", "NEM", "RIO"
];

const blockedAssetSymbols = [
  "BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "ADA-USD", "DOGE-USD", "AVAX-USD", "LINK-USD", "LTC-USD"
];

export const blockedAssetSet = new Set(blockedAssetSymbols);

export const blockedTickerShortcuts = new Set(["BTC", "ETH", "XRP", "DOGE"]);

export const legacyDefaultTickers = "SPY, VTI, QQQ, AAPL, MSFT, NVDA, TSLA, JPM, XOM, UNH";

export const broadFunds = new Set(["SPY", "VTI", "VOO", "IVV", "QQQ", "VT", "VEA", "VWO", "BND", "AGG", "IWM", "TLT", "HYG", "LQD", "GLD", "USO", "UUP", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLRE", "XLB", "SMH", "XBI", "VWRL.AS", "VWCE.DE", "VWRP.L", "VWRL.L"]);

export const positiveNewsWords = ["beat", "beats", "growth", "raises", "raised", "upgrade", "upgraded", "surge", "rally", "record", "strong", "buy", "outperform", "profit", "profits", "cheap", "opportunity", "accelerates"];

export const negativeNewsWords = ["miss", "misses", "cut", "cuts", "downgrade", "downgraded", "lawsuit", "probe", "risk", "warning", "weak", "slump", "falls", "fell", "plunge", "loss", "sell", "tariff", "delay"];

export const positiveOutlookWords = ["overweight", "bullish", "constructive", "positive", "upside", "resilient", "opportunity", "attractive", "favor", "upgrade", "strong", "growth", "soft landing", "rate cut", "disinflation"];

export const negativeOutlookWords = ["underweight", "bearish", "downside", "fragile", "recession", "risk", "risks", "expensive", "overvalued", "cautious", "slowdown", "sticky inflation", "higher rates", "pullback", "volatility"];

export const outlookDomains = new Set([
  "blackrock.com", "vanguard.com", "advisors.vanguard.com", "corporate.vanguard.com", "jpmorgan.com", "fidelity.com",
  "morningstar.com", "schwab.com", "goldmansachs.com", "morganstanley.com", "ubs.com", "pimco.com", "capitalgroup.com",
  "troweprice.com", "franklintempleton.com", "invesco.com", "statestreet.com", "allianzgi.com", "amundi.com",
  "fool.com"
]);

export const companyAliases = {
  intel: "INTC",
  "intel stock": "INTC",
  nvidia: "NVDA",
  apple: "AAPL",
  microsoft: "MSFT",
  tesla: "TSLA",
  amazon: "AMZN",
  meta: "META",
  facebook: "META",
  alphabet: "GOOGL",
  google: "GOOGL",
  amd: "AMD",
  broadcom: "AVGO",
  netflix: "NFLX",
  palantir: "PLTR",
  "jp morgan": "JPM",
  jpmorgan: "JPM",
  "bank of america": "BAC",
  visa: "V",
  mastercard: "MA",
  goldman: "GS",
  "goldman sachs": "GS",
  "morgan stanley": "MS",
  citi: "C",
  "exxon mobil": "XOM",
  exxon: "XOM",
  chevron: "CVX",
  unitedhealth: "UNH",
  "united health": "UNH",
  walmart: "WMT",
  costco: "COST",
  "home depot": "HD",
  mcdonalds: "MCD",
  "eli lilly": "LLY",
  pfizer: "PFE",
  boeing: "BA",
  caterpillar: "CAT",
  "general electric": "GE",
  "freeport mcmoran": "FCX",
  "s&p 500": "SPY",
  "sp500": "SPY",
  nasdaq: "QQQ"
};
