import { negativeNewsWords, negativeOutlookWords, positiveNewsWords, positiveOutlookWords } from "../config/settings.js";
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
    MCD: ["MCDONALD"],
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
    SMH: ["SEMICONDUCTOR", "CHIPS"],
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

  return tickers.filter((ticker) => (aliases[ticker] || []).some((alias) => text.includes(alias)));
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
  if (!marketTerms.some((term) => text.includes(term))) return [];
  return tickers.filter((ticker) => ["SPY", "VTI", "QQQ", "IWM", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLRE", "XLB", "SMH", "XBI"].includes(ticker));
}

export function inferOutlookTargets(text, tickers) {
  const targets = [];
  const broadEquityTerms = ["EQUITIES", "STOCKS", "S&P 500", "NASDAQ", "US EQUITY", "U.S. EQUITY", "GLOBAL MARKETS", "MARKET OUTLOOK"];
  const bondTerms = ["BONDS", "FIXED INCOME", "TREASURIES", "YIELDS", "CREDIT", "RATE CUT", "RATE HIK"];
  const aiTerms = ["AI", "ARTIFICIAL INTELLIGENCE", "SEMICONDUCTOR", "CHIPS", "HYPERSCALER", "DATACENTER", "DATA CENTER"];
  const energyTerms = ["ENERGY", "OIL", "GAS", "POWER", "ELECTRICITY", "UTILITIES"];
  const financialTerms = ["BANKS", "FINANCIALS", "CREDIT", "LENDING"];
  const healthcareTerms = ["HEALTHCARE", "PHARMA", "BIOTECH", "MEDICARE"];

  if (broadEquityTerms.some((term) => text.includes(term))) targets.push(...tickers.filter((ticker) => ["SPY", "VTI", "VOO", "IVV", "QQQ", "VT", "VEA", "VWO"].includes(ticker)));
  if (bondTerms.some((term) => text.includes(term))) targets.push(...tickers.filter((ticker) => ["BND", "AGG"].includes(ticker)));
  if (aiTerms.some((term) => text.includes(term))) targets.push(...tickers.filter((ticker) => ["QQQ", "XLK", "SMH", "NVDA", "MSFT", "AAPL", "AVGO", "AMD", "INTC", "TSM", "ORCL", "CRM", "ADBE", "NOW"].includes(ticker)));
  if (energyTerms.some((term) => text.includes(term))) targets.push(...tickers.filter((ticker) => ["XLE", "XOM", "CVX", "COP", "SLB", "NEE", "CEG", "XLU"].includes(ticker)));
  if (financialTerms.some((term) => text.includes(term))) targets.push(...tickers.filter((ticker) => ["XLF", "JPM", "BAC", "V", "MA", "AXP", "GS", "MS", "BX", "SCHW"].includes(ticker)));
  if (healthcareTerms.some((term) => text.includes(term))) targets.push(...tickers.filter((ticker) => ["XLV", "XBI", "LLY", "UNH", "JNJ", "MRK", "ABBV", "TMO", "PFE", "ISRG"].includes(ticker)));
  return targets;
}

export function outlookTermsMentioned(text) {
  return ["OUTLOOK", "FORECAST", "STRATEGY", "PERSPECTIVE", "COMMENTARY", "OVERWEIGHT", "UNDERWEIGHT", "BULLISH", "BEARISH"].some((term) => text.includes(term));
}

export function symbolMentioned(text, ticker) {
  const escaped = ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(text);
}

export function headlineSentiment(text) {
  const lower = text.toLowerCase();
  const positive = positiveNewsWords.filter((word) => lower.includes(word)).length;
  const negative = negativeNewsWords.filter((word) => lower.includes(word)).length;
  return clamp((positive - negative) / 3, -1, 1);
}

export function outlookSentiment(text) {
  const lower = text.toLowerCase();
  const positive = positiveOutlookWords.filter((word) => lower.includes(word)).length;
  const negative = negativeOutlookWords.filter((word) => lower.includes(word)).length;
  return clamp((positive - negative) / 3, -1, 1);
}
