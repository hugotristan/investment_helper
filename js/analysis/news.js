import { broadFunds, negativeNewsWords, negativeOutlookWords, positiveNewsWords, positiveOutlookWords } from "../config/settings.js";
import { clamp } from "../shared/math.js";

export function inferNewsTargets(text, tickers) {
  const aliases = {
    AAPL: ["APPLE"],
    MSFT: ["MICROSOFT"],
    NVDA: ["NVIDIA"],
    AVGO: ["BROADCOM"],
    AMD: ["ADVANCED MICRO DEVICES"],
    INTC: ["INTEL"],
    TSM: ["TAIWAN SEMICONDUCTOR", "TSMC"],
    ORCL: ["ORACLE"],
    CRM: ["SALESFORCE"],
    ADBE: ["ADOBE"],
    NOW: ["SERVICENOW"],
    PANW: ["PALO ALTO NETWORKS"],
    GOOGL: ["ALPHABET", "GOOGLE"],
    META: ["META PLATFORMS", "FACEBOOK"],
    AMZN: ["AMAZON"],
    NFLX: ["NETFLIX"],
    TSLA: ["TESLA"],
    UBER: ["UBER"],
    SHOP: ["SHOPIFY"],
    PLTR: ["PALANTIR"],
    SNOW: ["SNOWFLAKE"],
    MU: ["MICRON"],
    JPM: ["JPMORGAN CHASE", "JPMORGAN CHASE & CO", "J.P. MORGAN CHASE"],
    BAC: ["BANK OF AMERICA"],
    V: ["VISA"],
    MA: ["MASTERCARD"],
    AXP: ["AMERICAN EXPRESS"],
    GS: ["GOLDMAN SACHS"],
    MS: ["MORGAN STANLEY"],
    BX: ["BLACKSTONE"],
    SCHW: ["CHARLES SCHWAB"],
    XOM: ["EXXON", "EXXON MOBIL"],
    CVX: ["CHEVRON"],
    COP: ["CONOCOPHILLIPS"],
    SLB: ["SCHLUMBERGER"],
    NEE: ["NEXTERA ENERGY"],
    CEG: ["CONSTELLATION ENERGY"],
    LLY: ["ELI LILLY"],
    UNH: ["UNITEDHEALTH"],
    JNJ: ["JOHNSON & JOHNSON"],
    MRK: ["MERCK"],
    ABBV: ["ABBVIE"],
    TMO: ["THERMO FISHER"],
    PFE: ["PFIZER"],
    ISRG: ["INTUITIVE SURGICAL"],
    COST: ["COSTCO"],
    WMT: ["WALMART"],
    HD: ["HOME DEPOT"],
    MCD: ["MCDONALD", "MCDONALDS"],
    NKE: ["NIKE"],
    SBUX: ["STARBUCKS"],
    DIS: ["DISNEY"],
    CAT: ["CATERPILLAR"],
    GE: ["GENERAL ELECTRIC", "GE AEROSPACE"],
    DE: ["DEERE"],
    HON: ["HONEYWELL"],
    BA: ["BOEING"],
    LMT: ["LOCKHEED MARTIN"],
    LIN: ["LINDE"],
    FCX: ["FREEPORT-MCMORAN", "FREEPORT MCMORAN"],
    NEM: ["NEWMONT"],
    RIO: ["RIO TINTO"],
    QQQ: ["NASDAQ"],
    IWM: ["RUSSELL 2000", "SMALL CAP"],
    SPY: ["S&P 500", "S & P 500"],
    VTI: ["U.S. INDEXES", "STOCK MARKET"],
    SMH: ["SEMICONDUCTOR", "SEMICONDUCTORS", "CHIPS"],
    XBI: ["BIOTECH"],
    XLF: ["FINANCIALS", "BANKS"],
    XLE: ["ENERGY", "OIL"],
    XLV: ["HEALTHCARE"],
    XLI: ["INDUSTRIALS"],
    XLY: ["CONSUMER DISCRETIONARY"],
    XLP: ["CONSUMER STAPLES"],
    XLU: ["UTILITIES"],
    XLRE: ["REAL ESTATE"],
    XLB: ["MATERIALS"]
  };

  return tickers.filter((ticker) => (aliases[ticker] || []).some((alias) => termMentioned(text, alias)));
}

export function inferMarketContextTargets(text, tickers) {
  const marketTerms = [
    "S&P 500", "S & P 500", "STOCK FUTURES", "STOCK MARKET", "WALL STREET", "MARKET", "NASDAQ", "DOW JONES",
    "FED", "FEDERAL RESERVE", "INFLATION", "CPI", "PPI", "JOLTS", "PAYROLLS", "UNEMPLOYMENT", "RETAIL SALES",
    "GDP", "PERSONAL INCOME", "DURABLE GOODS", "HOUSING STARTS", "YIELDS", "TREASURY", "H.15", "RATES",
    "LOAN OFFICER", "BANK LENDING", "CREDIT", "LIQUIDITY", "ECONOMY", "EIA", "OIL INVENTORIES", "CRUDE STOCKS",
    "GASOLINE", "DIESEL", "SEC", "CFTC", "FTC", "REGULATION", "ANTITRUST", "SANCTIONS",
    "EARNINGS", "REVENUE", "GUIDANCE", "VALUATION", "ANALYST", "DIVIDEND"
  ];
  if (!marketTerms.some((term) => termMentioned(text, term))) return [];
  return tickers.filter((ticker) => ["SPY", "VTI", "QQQ", "IWM", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLRE", "XLB", "SMH", "XBI"].includes(ticker));
}

export function inferOutlookTargets(text, tickers) {
  return [...new Set(inferBroadOutlookTargets(text, tickers).concat(inferSectorTargets(text, tickers)))];
}

function inferBroadOutlookTargets(text, tickers) {
  const targets = [];
  const broadEquityTerms = ["EQUITIES", "STOCKS", "S&P 500", "NASDAQ", "US EQUITY", "U.S. EQUITY", "GLOBAL MARKETS", "MARKET OUTLOOK"];
  const bondTerms = ["BONDS", "FIXED INCOME", "TREASURIES", "YIELDS", "CREDIT", "RATE CUT", "RATE CUTS", "RATE HIKE", "RATE HIKES"];
  if (broadEquityTerms.some((term) => termMentioned(text, term))) targets.push(...tickers.filter((ticker) => ["SPY", "VTI", "VOO", "IVV", "QQQ", "VT", "VEA", "VWO"].includes(ticker)));
  if (bondTerms.some((term) => termMentioned(text, term))) targets.push(...tickers.filter((ticker) => ["BND", "AGG", "TLT", "HYG", "LQD"].includes(ticker)));
  return targets;
}

export function inferSectorTargets(text, tickers) {
  const targets = [];
  const aiTerms = ["AI", "ARTIFICIAL INTELLIGENCE", "SEMICONDUCTOR", "SEMICONDUCTORS", "CHIPS", "HYPERSCALER", "HYPERSCALERS", "DATACENTER", "DATACENTERS", "DATA CENTER", "DATA CENTERS"];
  const energyTerms = ["ENERGY", "OIL", "GAS", "POWER", "ELECTRICITY", "UTILITIES"];
  const financialTerms = ["BANKS", "FINANCIALS", "CREDIT", "LENDING"];
  const healthcareTerms = ["HEALTHCARE", "PHARMA", "BIOTECH", "MEDICARE"];

  if (aiTerms.some((term) => termMentioned(text, term))) targets.push(...tickers.filter((ticker) => ["QQQ", "XLK", "SMH", "NVDA", "MSFT", "AAPL", "AVGO", "AMD", "INTC", "TSM", "ORCL", "CRM", "ADBE", "NOW"].includes(ticker)));
  if (energyTerms.some((term) => termMentioned(text, term))) targets.push(...tickers.filter((ticker) => ["XLE", "XOM", "CVX", "COP", "SLB", "NEE", "CEG", "XLU"].includes(ticker)));
  if (financialTerms.some((term) => termMentioned(text, term))) targets.push(...tickers.filter((ticker) => ["XLF", "JPM", "BAC", "V", "MA", "AXP", "GS", "MS", "BX", "SCHW"].includes(ticker)));
  if (healthcareTerms.some((term) => termMentioned(text, term))) targets.push(...tickers.filter((ticker) => ["XLV", "XBI", "LLY", "UNH", "JNJ", "MRK", "ABBV", "TMO", "PFE", "ISRG"].includes(ticker)));
  return [...new Set(targets)];
}

export function outlookTermsMentioned(text) {
  return ["OUTLOOK", "FORECAST", "STRATEGY", "PERSPECTIVE", "COMMENTARY", "OVERWEIGHT", "UNDERWEIGHT", "BULLISH", "BEARISH"].some((term) => termMentioned(text, term));
}

export function symbolMentioned(text, ticker) {
  const symbol = String(ticker || "").toUpperCase();
  if (!symbol) return false;
  const escaped = escapeRegex(symbol);
  const explicit = new RegExp(`(?:^|[^A-Z0-9])(?:\\$${escaped}(?![A-Z0-9]|[.^-][A-Z0-9])|\\(\\s*${escaped}\\s*\\)|(?:NYSE|NASDAQ|AMEX|LSE|XETRA|TSX|OTC|TICKER|SYMBOL)\\s*:\\s*${escaped}(?![A-Z0-9]|[.^-][A-Z0-9]))`, "i");
  // Short symbols overlap ordinary words and abbreviations (MS, NOW, CAT, DE).
  // Longer bare symbols must remain uppercase in the original article text.
  return explicit.test(String(text)) || symbol.length >= 4 && new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}]|[.^-][\\p{L}\\p{N}])`, "u").test(String(text));
}

export function headlineSentiment(text) {
  const positive = positiveNewsWords.filter((word) => termMentioned(text, word)).length;
  const negative = negativeNewsWords.filter((word) => termMentioned(text, word)).length;
  return clamp((positive - negative) / 3, -1, 1);
}

export function outlookSentiment(text) {
  const positive = positiveOutlookWords.filter((word) => termMentioned(text, word)).length;
  const negative = negativeOutlookWords.filter((word) => termMentioned(text, word)).length;
  return clamp((positive - negative) / 3, -1, 1);
}

export function inferArticleEvidence(text, tickers, { isOutlook = false, publisher = "" } = {}) {
  const content = cleanArticleText(text, publisher);
  const aliases = inferNewsTargets(content, tickers);
  const directTickers = [...new Set(tickers.filter((ticker) => symbolMentioned(content, ticker))
    .concat(aliases.filter((ticker) => !broadFunds.has(ticker))))];
  const sectorTickers = inferSectorTargets(content, tickers).filter((ticker) => !directTickers.includes(ticker));
  const marketTickers = [...new Set(aliases.filter((ticker) => broadFunds.has(ticker))
    .concat(inferMarketContextTargets(content, tickers), isOutlook ? inferBroadOutlookTargets(content, tickers) : []))]
    .filter((ticker) => !directTickers.includes(ticker) && !sectorTickers.includes(ticker));
  return {
    tickers: [...new Set(directTickers.concat(sectorTickers, marketTickers))],
    directTickers,
    sectorTickers,
    marketTickers,
    evidenceScope: directTickers.length ? "direct" : sectorTickers.length ? "sector" : "market"
  };
}

export function cleanArticleText(text, publisher = "") {
  let content = String(text || "").replace(/\s+/g, " ").trim();
  const brand = String(publisher || "").trim();
  if (brand) {
    const escaped = escapeRegex(brand);
    content = content.replace(new RegExp(`\\s+(?:[-–—|])\\s*${escaped}\\s*$`, "i"), "")
      .replace(new RegExp(`^${escaped}\\s*[|:]\\s+`, "i"), "");
  }
  return content;
}

function termMentioned(text, term) {
  const phrase = String(term).trim().split(/\s+/).map(escapeRegex).join("\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${phrase}([^\\p{L}\\p{N}]|$)`, "iu").test(String(text || ""));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
