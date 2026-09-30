export function buildGdeltScans(tickers) {
  const watchlist = tickers.slice(0, 12).join(" OR ");
  return [
    {
      id: "gdelt-watchlist",
      name: "GDELT watchlist market scan",
      url: gdeltUrl(`(${watchlist} OR "S&P 500" OR Nasdaq OR "stock market" OR "earnings report" OR "analyst upgrade")`, "24h", 250)
    },
    {
      id: "gdelt-macro",
      name: "GDELT macro risk scan",
      url: gdeltUrl(`("Federal Reserve" OR "inflation data" OR "CPI report" OR "jobs report" OR "Treasury yields" OR recession)`, "24h", 250)
    },
    {
      id: "gdelt-sector",
      name: "GDELT sector leadership scan",
      url: gdeltUrl(`("artificial intelligence" OR semiconductors OR "cloud computing" OR "oil prices" OR healthcare OR banks OR "consumer spending")`, "24h", 250)
    },
    {
      id: "gdelt-global",
      name: "GDELT global market scan",
      url: gdeltUrl(`("global markets" OR "European stocks" OR "Asian stocks" OR "bond yields" OR "US dollar" OR commodities)`, "24h", 250)
    }
  ];
}

export function buildDeepSourceScans(tickers) {
  const watchlist = tickers.slice(0, 14).join(" OR ");
  const scans = [
    ["markets-48h", "GDELT broad market depth scan", `(${watchlist} OR stocks OR equities OR "stock market" OR "market rally" OR "market selloff" OR "Wall Street")`, "48h", 250],
    ["earnings-48h", "GDELT earnings depth scan", `(earnings OR revenue OR guidance OR "analyst rating" OR "price target" OR "profit forecast")`, "48h", 250],
    ["macro-48h", "GDELT macro depth scan", `("Federal Reserve" OR inflation OR CPI OR jobs OR GDP OR yields OR Treasury OR recession OR "central bank")`, "48h", 250],
    ["sector-48h", "GDELT sector depth scan", `("artificial intelligence" OR semiconductor OR cloud OR energy OR oil OR healthcare OR banks OR retail OR industrials OR utilities)`, "48h", 250],
    ["global-48h", "GDELT global equities depth scan", `("global markets" OR "European stocks" OR "Asian stocks" OR "emerging markets" OR "bond market" OR commodities OR dollar)`, "48h", 250],
    ["etf-7d", "GDELT ETF and index depth scan", `(ETF OR "index funds" OR "S&P 500" OR Nasdaq OR "Dow Jones" OR "Russell 2000" OR "bond funds")`, "7d", 250],
    ["policy-7d", "GDELT policy and rates depth scan", `("interest rates" OR "rate cuts" OR "rate hikes" OR tariffs OR regulation OR "fiscal policy" OR "debt ceiling")`, "7d", 250],
    ["credit-7d", "GDELT credit and liquidity depth scan", `(credit OR liquidity OR "bank lending" OR "commercial real estate" OR defaults OR spreads OR "high yield")`, "7d", 250],
    ["official-macro-7d", "GDELT official macro data scan", `("consumer price index" OR CPI OR PPI OR JOLTS OR payrolls OR unemployment OR "retail sales" OR GDP OR "personal income" OR "durable goods" OR "housing starts" OR "Treasury yields" OR "loan officer survey") (market OR stocks OR inflation OR rates OR economy)`, "7d", 250],
    ["regulatory-7d", "GDELT regulator and policy scan", `(SEC OR CFTC OR FTC OR "Federal Reserve" OR Treasury OR "Department of Labor" OR "central bank" OR sanctions OR antitrust OR regulation OR "trading suspension") (stocks OR market OR investors OR companies)`, "7d", 250],
    ["energy-data-7d", "GDELT official energy data scan", `(EIA OR IEA OR OPEC OR "oil inventories" OR "natural gas storage" OR gasoline OR diesel OR "crude stocks" OR "energy outlook") (market OR inflation OR energy OR stocks)`, "7d", 250],
    ["global-official-14d", "GDELT global official data scan", `(IMF OR "World Bank" OR OECD OR BIS OR ECB OR "Bank of England" OR "Bank of Japan" OR Eurostat) (outlook OR forecast OR inflation OR growth OR rates OR market)`, "14d", 250],
    ["tech-7d", "GDELT technology leadership depth scan", `(Nvidia OR Apple OR Microsoft OR Amazon OR Meta OR Alphabet OR Tesla OR chips OR AI OR datacenter OR software)`, "7d", 250],
    ["energy-7d", "GDELT energy and commodities depth scan", `(oil OR gas OR OPEC OR copper OR gold OR lithium OR uranium OR electricity OR renewables)`, "7d", 250],
    ["health-7d", "GDELT healthcare depth scan", `(healthcare OR biotech OR pharma OR hospitals OR Medicare OR "drug approval" OR "clinical trial")`, "7d", 250],
    ["banks-7d", "GDELT financials depth scan", `(banks OR insurance OR payments OR fintech OR "net interest income" OR "loan losses" OR "capital markets")`, "7d", 250],
    ["defense-7d", "GDELT industrials and defense depth scan", `(aerospace OR defense OR machinery OR industrials OR "capital goods" OR "supply chain" OR "manufacturing orders")`, "7d", 250],
    ["consumer-7d", "GDELT consumer depth scan", `(consumer spending OR retail OR restaurants OR housing OR travel OR "credit card spending" OR "consumer confidence")`, "7d", 250],
    ["materials-7d", "GDELT materials and mining depth scan", `(materials OR mining OR copper OR steel OR aluminum OR gold OR "rare earths" OR chemicals)`, "7d", 250],
    ["risk-events-7d", "GDELT event risk depth scan", `(earnings OR "guidance cut" OR lawsuit OR probe OR antitrust OR merger OR acquisition OR sanctions OR bankruptcy OR default OR "trading halt")`, "7d", 250]
  ];
  return scans.map(([id, name, query, timespan, maxRecords]) => ({
    id: `deep-${id}`,
    name,
    url: gdeltUrl(query, timespan, maxRecords),
    deep: true
  }));
}

export function buildAnalystOutlookScans(tickers) {
  const watchlist = tickers.slice(0, 12).join(" OR ");
  const baseTerms = `(market outlook OR investment outlook OR weekly commentary OR strategist OR forecast OR "asset allocation" OR "market perspectives")`;
  return [
    {
      id: "outlook-watchlist",
      name: "Trusted strategist outlook scan",
      url: gdeltUrl(`(${watchlist} OR "S&P 500" OR Nasdaq OR stocks OR bonds) ${baseTerms}`, "30d", 250),
      kind: "outlook"
    },
    {
      id: "outlook-asset-allocation",
      name: "Asset allocation outlook scan",
      url: gdeltUrl(`("overweight" OR "underweight" OR bullish OR bearish OR constructive OR cautious) (equities OR stocks OR bonds OR cash OR commodities OR credit)`, "30d", 250),
      kind: "outlook"
    },
    {
      id: "outlook-ai-rates",
      name: "AI and rates outlook scan",
      url: gdeltUrl(`(AI OR "artificial intelligence" OR "rate cuts" OR inflation OR yields) (outlook OR forecast OR strategy OR commentary)`, "30d", 250),
      kind: "outlook"
    },
    {
      id: "outlook-institutional",
      name: "Institutional research outlook scan",
      url: gdeltUrl(`(BlackRock OR Vanguard OR "J.P. Morgan" OR Fidelity OR Morningstar OR Schwab OR Goldman OR "Morgan Stanley" OR PIMCO) (market outlook OR investment outlook OR forecast OR weekly commentary)`, "30d", 250),
      kind: "outlook"
    },
    {
      id: "outlook-motley-fool",
      name: "Motley Fool stock idea scan",
      url: gdeltUrl(`site:fool.com (${watchlist} OR stocks OR "stock to buy" OR "buy now" OR "growth stock" OR dividend OR "undervalued" OR "long term")`, "30d", 250),
      kind: "outlook"
    },
    {
      id: "outlook-official-macro",
      name: "Official macro outlook scan",
      url: gdeltUrl(`(Federal Reserve OR IMF OR OECD OR "World Bank" OR ECB OR "Bank of England" OR BEA OR BLS OR Census OR EIA) (economic outlook OR forecast OR inflation OR growth OR rates OR "financial stability")`, "30d", 250),
      kind: "outlook"
    },
    {
      id: "outlook-recent-year-watchlist",
      name: "Recent-year stock and sector outlook scan",
      url: gdeltUrl(`(${watchlist} OR semiconductors OR software OR banks OR energy OR healthcare OR consumer OR industrials) ("2026 outlook" OR "year ahead" OR "annual outlook" OR "12-month outlook" OR "stock picks" OR "sector outlook" OR "earnings outlook" OR "price target")`, "365d", 250),
      kind: "outlook",
      horizon: "recent-year"
    },
    {
      id: "outlook-recent-year-institutions",
      name: "Recent-year institutional market framework scan",
      url: gdeltUrl(`(BlackRock OR Vanguard OR "J.P. Morgan" OR Fidelity OR Morningstar OR Schwab OR Goldman OR "Morgan Stanley" OR PIMCO OR "Capital Group") ("2026 outlook" OR "year ahead" OR "annual outlook" OR "capital markets assumptions" OR "asset allocation" OR "market outlook")`, "365d", 250),
      kind: "outlook",
      horizon: "recent-year"
    },
    {
      id: "outlook-recent-year-fool",
      name: "Recent-year Motley Fool stock-pick scan",
      url: gdeltUrl(`site:fool.com (${watchlist} OR semiconductors OR software OR banks OR energy OR healthcare OR consumer OR industrials) ("2026 outlook" OR "stock to buy" OR "top stocks" OR "best stocks" OR "long term" OR "growth stock" OR dividend OR "undervalued")`, "365d", 250),
      kind: "outlook",
      horizon: "recent-year"
    },
    {
      id: "outlook-recent-year-macro-regime",
      name: "Recent-year macro regime scan",
      url: gdeltUrl(`("soft landing" OR recession OR disinflation OR "rate cuts" OR "earnings growth" OR valuation OR "profit margins" OR "credit spreads") ("stock market" OR equities OR "S&P 500" OR Nasdaq OR sectors)`, "365d", 250),
      kind: "outlook",
      horizon: "recent-year"
    }
  ];
}

function gdeltUrl(query, timespan, maxRecords) {
  const params = new URLSearchParams({
    query,
    mode: "artlist",
    format: "json",
    maxrecords: String(maxRecords),
    timespan,
    sort: "datedesc"
  });
  return `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
}
