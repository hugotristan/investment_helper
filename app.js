(function () {
  const STORAGE_KEY = "today-invest-model-state";
  const AUTO_REFRESH_DELAY_SECONDS = 900;
  const GDELT_DIRECT_TIMEOUT_MS = 18000;
  const GDELT_RELAY_TIMEOUT_MS = 24000;
  const RSS_DIRECT_TIMEOUT_MS = 10000;
  const RSS_RELAY_TIMEOUT_MS = 16000;
  const PRICE_TIMEOUT_MS = 10000;
  const MIN_ACTIVE_SOURCES = 60;
  const MAX_SOURCE_SCAN_MS = 300000;
  const SCORE_MOVE_LIMIT = 6;
  const SOURCE_CACHE_MIN_RATIO = 0.7;
  const marketProxyTickers = [
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
  const opportunityUniverse = [
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
  const blockedAssetSet = new Set(blockedAssetSymbols);
  const blockedTickerShortcuts = new Set(["BTC", "ETH", "XRP", "DOGE"]);
  const legacyDefaultTickers = "SPY, VTI, QQQ, AAPL, MSFT, NVDA, TSLA, JPM, XOM, UNH";
  const broadFunds = new Set(["SPY", "VTI", "VOO", "IVV", "QQQ", "VT", "VEA", "VWO", "BND", "AGG", "IWM", "TLT", "HYG", "LQD", "GLD", "USO", "UUP", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLRE", "XLB", "SMH", "XBI", "VWRL.AS", "VWCE.DE", "VWRP.L", "VWRL.L"]);
  const positiveNewsWords = ["beat", "beats", "growth", "raises", "raised", "upgrade", "upgraded", "surge", "rally", "record", "strong", "buy", "outperform", "profit", "profits", "cheap", "opportunity", "accelerates"];
  const negativeNewsWords = ["miss", "misses", "cut", "cuts", "downgrade", "downgraded", "lawsuit", "probe", "risk", "warning", "weak", "slump", "falls", "fell", "plunge", "loss", "sell", "tariff", "delay"];
  const positiveOutlookWords = ["overweight", "bullish", "constructive", "positive", "upside", "resilient", "opportunity", "attractive", "favor", "upgrade", "strong", "growth", "soft landing", "rate cut", "disinflation"];
  const negativeOutlookWords = ["underweight", "bearish", "downside", "fragile", "recession", "risk", "risks", "expensive", "overvalued", "cautious", "slowdown", "sticky inflation", "higher rates", "pullback", "volatility"];
  const outlookDomains = new Set([
    "blackrock.com", "vanguard.com", "advisors.vanguard.com", "corporate.vanguard.com", "jpmorgan.com", "fidelity.com",
    "morningstar.com", "schwab.com", "goldmansachs.com", "morganstanley.com", "ubs.com", "pimco.com", "capitalgroup.com",
    "troweprice.com", "franklintempleton.com", "invesco.com", "statestreet.com", "allianzgi.com", "amundi.com",
    "fool.com"
  ]);
  const companyAliases = {
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
  const sourceFeeds = [
    { id: "yahoo-ticker", name: "Yahoo Finance ticker headlines", domain: "finance.yahoo.com", url: (tickers) => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(tickers.join(","))}&region=US&lang=en-US` },
    { id: "cnbc-top", name: "CNBC Top News", domain: "cnbc.com", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
    { id: "cnbc-finance", name: "CNBC Finance", domain: "cnbc.com", url: "https://www.cnbc.com/id/10000664/device/rss/rss.html" },
    { id: "cnbc-investing", name: "CNBC Investing", domain: "cnbc.com", url: "https://www.cnbc.com/id/15839069/device/rss/rss.html" },
    { id: "cnbc-earnings", name: "CNBC Earnings", domain: "cnbc.com", url: "https://www.cnbc.com/id/15839135/device/rss/rss.html" },
    { id: "cnbc-economy", name: "CNBC Economy", domain: "cnbc.com", url: "https://www.cnbc.com/id/20910258/device/rss/rss.html" },
    { id: "cnbc-tech", name: "CNBC Technology", domain: "cnbc.com", url: "https://www.cnbc.com/id/19854910/device/rss/rss.html" },
    { id: "cnbc-business", name: "CNBC Business", domain: "cnbc.com", url: "https://www.cnbc.com/id/10001147/device/rss/rss.html" },
    { id: "cnbc-energy", name: "CNBC Energy", domain: "cnbc.com", url: "https://www.cnbc.com/id/19836768/device/rss/rss.html" },
    { id: "cnbc-market-insider", name: "CNBC Market Insider", domain: "cnbc.com", url: "https://www.cnbc.com/id/20409666/device/rss/rss.html" },
    { id: "marketwatch-top", name: "MarketWatch Top Stories", domain: "marketwatch.com", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
    { id: "marketwatch-pulse", name: "MarketWatch MarketPulse", domain: "marketwatch.com", url: "https://feeds.content.dowjones.io/public/rss/mw_marketpulse" },
    { id: "wsj-markets", name: "WSJ Markets", domain: "wsj.com", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" },
    { id: "wsj-business", name: "WSJ Business", domain: "wsj.com", url: "https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml" },
    { id: "wsj-tech", name: "WSJ Technology", domain: "wsj.com", url: "https://feeds.a.dj.com/rss/RSSWSJD.xml" },
    { id: "nasdaq-stocks", name: "Nasdaq stocks", domain: "nasdaq.com", url: "https://www.nasdaq.com/feed/rssoutbound?category=Stocks" },
    { id: "nasdaq-markets", name: "Nasdaq markets", domain: "nasdaq.com", url: "https://www.nasdaq.com/feed/rssoutbound?category=Markets" },
    { id: "fed-press", name: "Federal Reserve press releases", domain: "federalreserve.gov", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
    { id: "fred-blog", name: "FRED Blog", domain: "fredblog.stlouisfed.org", url: "https://fredblog.stlouisfed.org/feed/" },
    { id: "investing-market", name: "Investing.com market news", domain: "investing.com", url: "https://www.investing.com/rss/news_25.rss" },
    { id: "investing-stocks", name: "Investing.com stocks", domain: "investing.com", url: "https://www.investing.com/rss/stock.rss" },
    { id: "investing-economy", name: "Investing.com economy", domain: "investing.com", url: "https://www.investing.com/rss/news_95.rss" },
    { id: "fool-investing", name: "Motley Fool investing", domain: "fool.com", url: "https://www.fool.com/feeds/index.aspx?tag=investing" },
    { id: "bls-latest", name: "BLS latest releases", domain: "bls.gov", url: "https://www.bls.gov/feed/bls_latest.rss" },
    { id: "bls-cpi", name: "BLS Consumer Price Index", domain: "bls.gov", url: "https://www.bls.gov/feed/cpi.rss" },
    { id: "bls-cpi-latest", name: "BLS CPI latest numbers", domain: "bls.gov", url: "https://www.bls.gov/feed/cpi_latest.rss" },
    { id: "bls-ppi", name: "BLS Producer Price Index", domain: "bls.gov", url: "https://www.bls.gov/feed/ppi.rss" },
    { id: "bls-jolts", name: "BLS JOLTS", domain: "bls.gov", url: "https://www.bls.gov/feed/jolts.rss" },
    { id: "sec-press", name: "SEC press releases", domain: "sec.gov", url: "https://www.sec.gov/news/pressreleases.rss" },
    { id: "sec-speeches", name: "SEC speeches and statements", domain: "sec.gov", url: "https://www.sec.gov/news/speeches-statements.rss" },
    { id: "sec-trading-suspensions", name: "SEC trading suspensions", domain: "sec.gov", url: "https://www.sec.gov/enforcement-litigation/trading-suspensions/rss" },
    { id: "bea-releases", name: "BEA economic releases", domain: "bea.gov", url: "https://apps.bea.gov/rss/rss.xml" },
    { id: "fed-monetary", name: "Federal Reserve monetary policy", domain: "federalreserve.gov", url: "https://www.federalreserve.gov/feeds/press_monetary.xml" },
    { id: "fed-speeches", name: "Federal Reserve speeches", domain: "federalreserve.gov", url: "https://www.federalreserve.gov/feeds/speeches.xml" },
    { id: "fed-feds", name: "Federal Reserve FEDS papers", domain: "federalreserve.gov", url: "https://www.federalreserve.gov/feeds/feds.xml" },
    { id: "fed-h15", name: "Federal Reserve H.15 rates", domain: "federalreserve.gov", url: "https://www.federalreserve.gov/feeds/h15.xml" },
    { id: "fed-sloos", name: "Federal Reserve loan officer survey", domain: "federalreserve.gov", url: "https://www.federalreserve.gov/feeds/sloos.xml" },
    { id: "ftc-press", name: "FTC press releases", domain: "ftc.gov", url: "https://www.ftc.gov/feeds/press-release.xml" },
    { id: "ftc-consumer", name: "FTC consumer protection releases", domain: "ftc.gov", url: "https://www.ftc.gov/feeds/press-release-consumer-protection.xml" },
    { id: "ftc-competition", name: "FTC competition releases", domain: "ftc.gov", url: "https://www.ftc.gov/feeds/press-release-competition.xml" },
    { id: "eia-today", name: "EIA Today in Energy", domain: "eia.gov", url: "https://www.eia.gov/rss/todayinenergy.xml" },
    { id: "eia-press", name: "EIA press releases", domain: "eia.gov", url: "https://www.eia.gov/rss/press_rss.xml" },
    { id: "eia-gas-diesel", name: "EIA gasoline and diesel update", domain: "eia.gov", url: "https://www.eia.gov/petroleum/gasdiesel/includes/gas_diesel_rss.xml" },
    { id: "ecb-press", name: "ECB press releases", domain: "ecb.europa.eu", url: "https://www.ecb.europa.eu/rss/press.html" }
  ];

  const trustedSourceUniverse = `
Reuters|reuters.com
Associated Press|apnews.com
Bloomberg|bloomberg.com
CNBC|cnbc.com
Wall Street Journal|wsj.com
MarketWatch|marketwatch.com
Barron's|barrons.com
Financial Times|ft.com
The Economist|economist.com
New York Times Business|nytimes.com
Washington Post Business|washingtonpost.com
Fortune|fortune.com
Forbes|forbes.com
Business Insider|businessinsider.com
Yahoo Finance|finance.yahoo.com
Nasdaq|nasdaq.com
Investopedia|investopedia.com
Morningstar|morningstar.com
Seeking Alpha|seekingalpha.com
Zacks|zacks.com
Investor's Business Daily|investors.com
Kiplinger|kiplinger.com
Benzinga|benzinga.com
TheStreet|thestreet.com
Motley Fool|fool.com
S&P Global|spglobal.com
MSCI|msci.com
LSEG|lseg.com
NYSE|nyse.com
Cboe|cboe.com
Federal Reserve|federalreserve.gov
FRED|stlouisfed.org
FRED Blog|fredblog.stlouisfed.org
Bureau of Labor Statistics|bls.gov
Bureau of Economic Analysis|bea.gov
U.S. Census Bureau|census.gov
Department of Labor|dol.gov
U.S. Treasury|home.treasury.gov
SEC|sec.gov
CFTC|cftc.gov
Federal Trade Commission|ftc.gov
FDIC|fdic.gov
OCC|occ.gov
National Credit Union Administration|ncua.gov
Congressional Budget Office|cbo.gov
White House Economy|whitehouse.gov
Department of Commerce|commerce.gov
IMF|imf.org
World Bank|worldbank.org
OECD|oecd.org
Bank for International Settlements|bis.org
European Central Bank|ecb.europa.eu
Bank of England|bankofengland.co.uk
Bank of Japan|boj.or.jp
Swiss National Bank|snb.ch
Bank of Canada|bankofcanada.ca
Reserve Bank of Australia|rba.gov.au
Reserve Bank of India|rbi.org.in
Eurostat|ec.europa.eu
UK ONS|ons.gov.uk
Statistics Canada|statcan.gc.ca
U.S. Energy Information Administration|eia.gov
International Energy Agency|iea.org
OPEC|opec.org
USDA NASS|nass.usda.gov
USDA Economic Research Service|ers.usda.gov
Baker Hughes|bakerhughes.com
Conference Board|conference-board.org
Institute for Supply Management|ismworld.org
S&P Global PMI|pmi.spglobal.com
J.P. Morgan|jpmorgan.com
Goldman Sachs|goldmansachs.com
Morgan Stanley|morganstanley.com
Bank of America|bankofamerica.com
Citi|citi.com
UBS|ubs.com
Deutsche Bank|db.com
Barclays|barclays.com
BNP Paribas|bnpparibas.com
ING Think|think.ing.com
HSBC|hsbc.com
Societe Generale|societegenerale.com
Wells Fargo|wellsfargo.com
PIMCO|pimco.com
BlackRock|blackrock.com
Vanguard|vanguard.com
Fidelity|fidelity.com
Charles Schwab|schwab.com
State Street|statestreet.com
Invesco|invesco.com
WisdomTree|wisdomtree.com
Franklin Templeton|franklintempleton.com
T. Rowe Price|troweprice.com
Janus Henderson|janushenderson.com
Amundi|amundi.com
Allianz Global Investors|allianzgi.com
Capital Group|capitalgroup.com
RBC|rbc.com
TD Bank|td.com
Nomura|nomura.com
Mizuho|mizuho-fg.com
Macquarie|macquarie.com
TechCrunch|techcrunch.com
The Verge|theverge.com
Ars Technica|arstechnica.com
Wired|wired.com
The Information|theinformation.com
SemiAnalysis|semianalysis.com
Tom's Hardware|tomshardware.com
AnandTech|anandtech.com
Engadget|engadget.com
VentureBeat|venturebeat.com
SiliconANGLE|siliconangle.com
CRN|crn.com
Electrek|electrek.co
Teslarati|teslarati.com
CleanTechnica|cleantechnica.com
Automotive News|autonews.com
Car and Driver|caranddriver.com
Healthcare Dive|healthcaredive.com
BioPharma Dive|biopharmadive.com
Fierce Biotech|fiercebiotech.com
Fierce Pharma|fiercepharma.com
STAT News|statnews.com
Endpoints News|endpts.com
Modern Healthcare|modernhealthcare.com
MedTech Dive|medtechdive.com
PharmaVoice|pharmavoice.com
Oilprice.com|oilprice.com
Rigzone|rigzone.com
Offshore Energy|offshore-energy.biz
Argus Media|argusmedia.com
Natural Gas Intelligence|naturalgasintel.com
Mining.com|mining.com
Kitco|kitco.com
MetalMiner|agmetalminer.com
Retail Dive|retaildive.com
Supply Chain Dive|supplychaindive.com
Utility Dive|utilitydive.com
Manufacturing Dive|manufacturingdive.com
Construction Dive|constructiondive.com
Food Dive|fooddive.com
Restaurant Dive|restaurantdive.com
Payments Dive|paymentsdive.com
Banking Dive|bankingdive.com
CFO Dive|cfodive.com
CIO Dive|ciodive.com
HR Dive|hrdive.com
Marketing Dive|marketingdive.com
Cybersecurity Dive|cybersecuritydive.com
Transport Dive|transportdive.com
Nikkei Asia|asia.nikkei.com
South China Morning Post|scmp.com
The Straits Times|straitstimes.com
Channel News Asia|channelnewsasia.com
The Japan Times|japantimes.co.jp
Korea Herald|koreaherald.com
Times of India|timesofindia.indiatimes.com
Economic Times India|economictimes.indiatimes.com
Mint|livemint.com
Business Standard|business-standard.com
Australian Financial Review|afr.com
Sydney Morning Herald|smh.com.au
The Globe and Mail|theglobeandmail.com
Financial Post|financialpost.com
CBC Business|cbc.ca
Deutsche Welle|dw.com
France 24 Business|france24.com
Les Echos|lesechos.fr
Handelsblatt|handelsblatt.com
FAZ|faz.net
Il Sole 24 Ore|ilsole24ore.com
El Economista|eleconomista.es
Expansion|expansion.com
Cinco Dias|cincodias.elpais.com
Euromoney|euromoney.com
GlobalCapital|globalcapital.com
Institutional Investor|institutionalinvestor.com
Pensions & Investments|pionline.com
ETF.com|etf.com
ETF Trends|etftrends.com
ETF Database|etfdb.com
Nasdaq TradeTalks|nasdaq.com
Markets Insider|markets.businessinsider.com
GuruFocus|gurufocus.com
ValueWalk|valuewalk.com
StockCharts|stockcharts.com
AAII|aaii.com
Yardeni Research|yardeni.com
Apollo Academy|apolloacademy.com
Ritholtz|ritholtz.com
A Wealth of Common Sense|awealthofcommonsense.com
Calculated Risk|calculatedriskblog.com
Wolf Street|wolfstreet.com
Advisor Perspectives|advisorperspectives.com
ThinkAdvisor|thinkadvisor.com
InvestmentNews|investmentnews.com
Citywire|citywire.com
Morning Brew|morningbrew.com
The Hustle|thehustle.co
Axios Markets|axios.com
Politico Economy|politico.com
The Hill Finance|thehill.com
Roll Call|rollcall.com
NPR Business|npr.org
PBS NewsHour Economy|pbs.org
Al Jazeera Business|aljazeera.com
BBC Business|bbc.com
Sky News Business|news.sky.com
The Guardian Business|theguardian.com
The Telegraph Business|telegraph.co.uk
Evening Standard Business|standard.co.uk
Independent Business|independent.co.uk
Irish Times Business|irishtimes.com
RTE Business|rte.ie
Swissinfo Business|swissinfo.ch
Euronews Business|euronews.com
Politico Europe Economy|politico.eu
The Local Europe|thelocal.com
China Daily Business|chinadaily.com.cn
Caixin Global|caixinglobal.com
Yicai Global|yicaiglobal.com
The Standard Hong Kong|thestandard.com.hk
Bangkok Post Business|bangkokpost.com
The Edge Markets|theedgemalaysia.com
BusinessWorld Philippines|bworldonline.com
Vietnam Investment Review|vir.com.vn
Jakarta Post Business|thejakartapost.com
The Hindu BusinessLine|thehindubusinessline.com
Moneycontrol|moneycontrol.com
CNBC TV18|cnbctv18.com
NDTV Profit|ndtvprofit.com
Reuters Institute|reutersinstitute.politics.ox.ac.uk
Harvard Business Review|hbr.org
MIT Sloan Management Review|sloanreview.mit.edu
Stanford Graduate School of Business|gsb.stanford.edu
Wharton Knowledge|knowledge.wharton.upenn.edu
Brookings Economy|brookings.edu
Peterson Institute|piie.com
Council on Foreign Relations|cfr.org
Atlantic Council Economy|atlanticcouncil.org
Carnegie Endowment|carnegieendowment.org
RAND Economics|rand.org
NBER|nber.org
Federal Reserve Bank of New York|newyorkfed.org
Federal Reserve Bank of Atlanta|atlantafed.org
Federal Reserve Bank of Dallas|dallasfed.org
Federal Reserve Bank of Cleveland|clevelandfed.org
Federal Reserve Bank of Chicago|chicagofed.org
Federal Reserve Bank of San Francisco|frbsf.org
Federal Reserve Bank of Richmond|richmondfed.org
Federal Reserve Bank of Philadelphia|philadelphiafed.org
Federal Reserve Bank of Kansas City|kansascityfed.org
Federal Reserve Bank of Minneapolis|minneapolisfed.org
Federal Reserve Bank of Boston|bostonfed.org
Federal Reserve Bank of St. Louis|stlouisfed.org
CME Group|cmegroup.com
VanEck|vaneck.com
`.trim().split("\n").map((row) => {
    const [name, domain] = row.split("|");
    return {
      id: `trusted-${slugify(domain)}`,
      name,
      domain: normalizeDomain(domain)
    };
  });
  const trustedDomainMap = new Map(trustedSourceUniverse.map((source) => [source.domain, source]));

  const defaults = {
    tickerInput: opportunityUniverse.join(", "),
    myPortfolioInput: [
      "VWRL.AS | Vanguard FTSE All-World | 9300 | up",
      "MSFT | Microsoft | 300 | down",
      "TSM | TSMC | 250 | down",
      "AVGO | Broadcom | 250 | down",
      "NVDA | Nvidia | 150 | down",
      "GOOGL | Google | 150 | down"
    ].join("\n"),
    screenerSignal: "actionable",
    screenerMinScore: 50,
    screenerMinLiquidity: 5,
    screenerSort: "score",
    detailTicker: "MSFT",
    currency: "EUR",
    learningHistory: []
  };

  const state = { ...defaults, ...loadState() };
  if (String(state.tickerInput || "").trim() === legacyDefaultTickers) state.tickerInput = defaults.tickerInput;
  if (!Array.isArray(state.learningHistory)) state.learningHistory = [];

  const els = {
    dataStatus: document.getElementById("dataStatus"),
    viewPages: document.querySelectorAll("[data-page]"),
    pageLinks: document.querySelectorAll("[data-page-link]"),
    tickerInput: document.getElementById("tickerInput"),
    myPortfolioInput: document.getElementById("myPortfolioInput"),
    screenerSignal: document.getElementById("screenerSignal"),
    screenerMinScore: document.getElementById("screenerMinScore"),
    screenerMinLiquidity: document.getElementById("screenerMinLiquidity"),
    screenerSort: document.getElementById("screenerSort"),
    screenerResults: document.getElementById("screenerResults"),
    detailTickerInput: document.getElementById("detailTickerInput"),
    detailButton: document.getElementById("detailButton"),
    detailOutput: document.getElementById("detailOutput"),
    askInput: document.getElementById("askInput"),
    askButton: document.getElementById("askButton"),
    askAnswer: document.getElementById("askAnswer"),
    marketPulseTitle: document.getElementById("marketPulseTitle"),
    marketPulse: document.getElementById("marketPulse"),
    marketForecast: document.getElementById("marketForecast"),
    portfolioReview: document.getElementById("portfolioReview"),
    lastScan: document.getElementById("lastScan"),
    refreshTitle: document.getElementById("refreshTitle"),
    nextScan: document.getElementById("nextScan"),
    modelInstructions: document.getElementById("modelInstructions"),
    sellGuidance: document.getElementById("sellGuidance"),
    researchEvidence: document.getElementById("researchEvidence"),
    marketFramework: document.getElementById("marketFramework"),
    sourceStatus: document.getElementById("sourceStatus"),
    analysisResults: document.getElementById("analysisResults"),
    toast: document.getElementById("toast")
  };

  let autoRefreshTimer = null;
  let refreshTicker = null;
  let inputScanTimer = null;
  let scanStartedAt = null;
  let nextRunAt = null;
  let lastScanDurationMs = 0;
  let isRunning = false;
  let isQuestionRunning = false;
  let isDetailRunning = false;
  let pendingInputScan = false;
  let lastGoodNews = null;
  let latestRankedResults = [];
  let latestPriceSource = "";
  let latestNews = null;
  let latestMarketContext = null;
  let latestQuoteSnapshot = null;

  init();

  function init() {
    hydrateInputs();
    bindEvents();
    syncActivePage();
    startRefreshTicker();
    runAnalysis();
  }

  function hydrateInputs() {
    els.tickerInput.value = state.tickerInput;
    els.myPortfolioInput.value = state.myPortfolioInput;
    els.screenerSignal.value = state.screenerSignal;
    els.screenerMinScore.value = state.screenerMinScore;
    els.screenerMinLiquidity.value = state.screenerMinLiquidity;
    els.screenerSort.value = state.screenerSort;
    els.detailTickerInput.value = state.detailTicker;
  }

  function bindEvents() {
    ["tickerInput", "myPortfolioInput"].forEach((key) => {
      els[key].addEventListener("input", () => {
        state[key] = els[key].value;
        persist();
        scheduleConfigScan();
      });
    });

    ["screenerSignal", "screenerMinScore", "screenerMinLiquidity", "screenerSort"].forEach((key) => {
      els[key].addEventListener("input", () => {
        state[key] = els[key].value;
        persist();
        renderScreener();
      });
    });

    els.detailButton.addEventListener("click", () => runStockDetail());
    els.detailTickerInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") runStockDetail();
    });

    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const link = target?.closest("[data-detail-ticker]");
      if (!link) return;
      event.preventDefault();
      const ticker = link.getAttribute("data-detail-ticker");
      if (!ticker) return;
      els.detailTickerInput.value = ticker;
      state.detailTicker = ticker;
      persist();
      window.location.hash = "detail";
      runStockDetail();
    });

    els.askButton.addEventListener("click", () => answerQuestion());
    els.askInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") answerQuestion();
    });
    window.addEventListener("hashchange", syncActivePage);
  }

  function syncActivePage() {
    const pageNames = ["dashboard", "screener", "detail", "portfolio", "ask", "signals", "research", "sources"];
    const requested = String(window.location.hash || "").replace(/^#/, "") || "dashboard";
    const activePage = pageNames.includes(requested) ? requested : "dashboard";

    els.viewPages.forEach((page) => {
      const isActive = page.dataset.page === activePage;
      page.hidden = !isActive;
      page.classList.toggle("active", isActive);
    });

    els.pageLinks.forEach((link) => {
      const isActive = link.dataset.pageLink === activePage;
      link.classList.toggle("active", isActive);
      if (isActive) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    if (requested !== activePage) {
      window.history.replaceState(null, "", `#${activePage}`);
    }
  }

  async function runAnalysis(options = {}) {
    if (isRunning) {
      if (options.reason === "config") pendingInputScan = true;
      return;
    }
    const tickers = unique(parseTickers(state.tickerInput)
      .concat(parsePortfolioPositions(state.myPortfolioInput).map((holding) => holding.ticker)))
      .filter((ticker) => !isBlockedAssetTicker(ticker))
      .slice(0, 96);
    if (!tickers.length) {
      setStatus("Add tickers");
      return;
    }

    clearAutoRefresh();
    isRunning = true;
    scanStartedAt = Date.now();
    nextRunAt = null;
    pendingInputScan = false;
    updateRefreshTimer();
    setStatus(options.reason === "config" ? "Settings changed; rescanning" : "Deep source scan running");
    els.modelInstructions.innerHTML = `<div class="empty-state">Building one consolidated review from live price action, macro proxies, headlines, and outlooks. The scan retries slow sources and keeps widening until it gets at least ${MIN_ACTIVE_SOURCES} trusted sources, or until the review time budget is reached...</div>`;

    try {
      const [series, quotes, news, marketContext] = await Promise.all([
        loadTickerSeries(tickers),
        loadQuoteSnapshots(tickers),
        loadNewsSources(tickers),
        loadMarketContext()
      ]);
      const priceSource = series.find((item) => item.source !== "sample")?.source || "sample";
      const ranked = series
        .map((item) => applyQuoteSnapshot(item, quotes.byTicker))
        .map((item) => scoreSeries(item, news.byTicker[item.ticker] || []))
        .map(applyLearningSignal)
        .sort(stableRankSort);

      renderAll(ranked, priceSource, news, marketContext, quotes);
      saveLearningSnapshot(ranked, priceSource, news.label);
      setStatus(priceSource === "sample" ? "Sample fallback" : "Live web data");
    } catch (error) {
      console.error(error);
      setStatus("Scan failed");
      els.modelInstructions.innerHTML = `<div class="empty-state">Could not complete the live scan. Check the connection and try again.</div>`;
    } finally {
      if (scanStartedAt) lastScanDurationMs = Date.now() - scanStartedAt;
      isRunning = false;
      scanStartedAt = null;
      if (pendingInputScan) {
        pendingInputScan = false;
        window.setTimeout(() => runAnalysis({ reason: "config" }), 300);
      } else {
        scheduleNextRun();
      }
      updateRefreshTimer();
    }
  }

  function scheduleConfigScan() {
    if (inputScanTimer) window.clearTimeout(inputScanTimer);
    pendingInputScan = true;
    clearAutoRefresh();
    nextRunAt = Date.now() + 2500;
    updateRefreshTimer();
    inputScanTimer = window.setTimeout(() => {
      inputScanTimer = null;
      runAnalysis({ reason: "config" });
    }, 2500);
  }

  async function answerQuestion() {
    if (isQuestionRunning) {
      showToast("Question analysis is already running");
      return;
    }

    const question = els.askInput.value.trim();
    const parsed = parseQuestionTarget(question);
    if (!parsed.ticker) {
      els.askAnswer.innerHTML = `<div class="empty-state">I could not identify the stock. Try a ticker, like "Should I sell INTC today?", or a common company name like Intel, Apple, Microsoft, Nvidia, Tesla, or Amazon.</div>`;
      return;
    }
    if (isBlockedAssetTicker(parsed.ticker)) {
      els.askAnswer.innerHTML = `<div class="empty-state">That asset type is outside this stock-and-ETF version. Ask about a listed company or fund instead.</div>`;
      return;
    }

    isQuestionRunning = true;
    els.askButton.disabled = true;
    els.askAnswer.innerHTML = `<div class="empty-state">Running deep live analysis for ${escapeHtml(parsed.ticker)}. This checks price action, sell/hold signals, recent headlines, trusted outlooks, and broad market context...</div>`;

    try {
      const contextTickers = unique([parsed.ticker, "SPY", "QQQ", "VTI"]);
      const [series, quotes, news] = await Promise.all([
        loadMarketSeries(parsed.ticker),
        loadQuoteSnapshots([parsed.ticker]),
        loadNewsSources(contextTickers, { allowCache: false })
      ]);
      const scored = applyLearningSignal(scoreSeries(applyQuoteSnapshot(series, quotes.byTicker), news.byTicker[parsed.ticker] || []));
      const answer = buildQuestionAnswer(scored, news, parsed);
      renderQuestionAnswer(answer);
    } catch (error) {
      console.error(error);
      els.askAnswer.innerHTML = `<div class="empty-state">Could not complete the focused deep scan. Check the connection and try again.</div>`;
    } finally {
      isQuestionRunning = false;
      els.askButton.disabled = false;
    }
  }

  async function runStockDetail() {
    if (isDetailRunning) {
      showToast("Stock detail scan is already running");
      return;
    }

    const parsed = parseDetailTicker(els.detailTickerInput.value);
    if (!parsed.ticker) {
      els.detailOutput.innerHTML = `<div class="empty-state">Enter a ticker, like MSFT, NVDA, VTI, or INTC.</div>`;
      return;
    }
    if (isBlockedAssetTicker(parsed.ticker)) {
      els.detailOutput.innerHTML = `<div class="empty-state">That asset type is outside this stock-and-ETF version. Use a stock or ETF ticker.</div>`;
      return;
    }

    isDetailRunning = true;
    state.detailTicker = parsed.ticker;
    persist();
    els.detailTickerInput.value = parsed.ticker;
    els.detailButton.disabled = true;
    els.detailOutput.innerHTML = `<div class="empty-state">Fetching live quote, one-year chart history, market context, and trusted-source evidence for ${escapeHtml(parsed.ticker)}...</div>`;

    try {
      const contextTickers = unique([parsed.ticker, "SPY", "QQQ", "VTI"]);
      const [series, quotes, news, marketContext] = await Promise.all([
        loadMarketSeries(parsed.ticker),
        loadQuoteSnapshots([parsed.ticker]),
        loadNewsSources(contextTickers, { allowCache: false }),
        loadMarketContext()
      ]);
      const scored = applyLearningSignal(scoreSeries(applyQuoteSnapshot(series, quotes.byTicker), news.byTicker[series.ticker] || news.byTicker[parsed.ticker] || []));
      renderStockDetail(scored, news, marketContext, quotes);
    } catch (error) {
      console.error(error);
      els.detailOutput.innerHTML = `<div class="empty-state">Could not complete the stock detail scan. Check the connection and try again.</div>`;
    } finally {
      isDetailRunning = false;
      els.detailButton.disabled = false;
    }
  }

  function startRefreshTicker() {
    refreshTicker = window.setInterval(updateRefreshTimer, 1000);
    updateRefreshTimer();
  }

  function scheduleNextRun() {
    clearAutoRefresh();
    nextRunAt = Date.now() + AUTO_REFRESH_DELAY_SECONDS * 1000;
    autoRefreshTimer = window.setTimeout(() => runAnalysis(), AUTO_REFRESH_DELAY_SECONDS * 1000);
  }

  function clearAutoRefresh() {
    if (autoRefreshTimer) window.clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  function updateRefreshTimer() {
    if (isRunning && scanStartedAt) {
      els.refreshTitle.textContent = "Scanning now";
      els.nextScan.textContent = `Elapsed ${formatDuration(Date.now() - scanStartedAt)}`;
      return;
    }

    if (nextRunAt) {
      const remainingMs = Math.max(0, nextRunAt - Date.now());
      els.refreshTitle.textContent = lastScanDurationMs ? `Last scan ${formatDuration(lastScanDurationMs)}` : "Deep live scan";
      els.nextScan.textContent = remainingMs ? `Next in ${formatDuration(remainingMs)}` : "Starting now";
      return;
    }

    els.refreshTitle.textContent = "Deep live scan";
    els.nextScan.textContent = "Starting now";
  }

  async function loadTickerSeries(tickers) {
    const settled = await mapLimit(tickers, 12, (ticker) => loadMarketSeries(ticker));
    return settled
      .map((result, index) => result.status === "fulfilled" ? result.value : sampleSeries(tickers[index]))
      .filter((series) => series.prices.length >= 60);
  }

  async function loadQuoteSnapshots(tickers) {
    const symbols = unique(tickers.map((ticker) => String(ticker || "").trim().toUpperCase()).filter(Boolean))
      .filter((ticker) => !isBlockedAssetTicker(ticker))
      .slice(0, 160);
    if (!symbols.length) {
      return { byTicker: new Map(), count: 0, total: 0, source: "none", label: "No live quote symbols requested" };
    }

    const settled = await mapLimit(symbols, 10, (ticker) => loadIntradayQuote(ticker));
    const quotes = settled
      .map((result) => result.status === "fulfilled" ? result.value : null)
      .filter(Boolean);
    const source = quotes.length ? "Yahoo Finance intraday chart" : "unavailable";
    return {
      byTicker: new Map(quotes.map((quote) => [quote.ticker, quote])),
      count: quotes.length,
      total: symbols.length,
      source,
      label: quotes.length ? `Live quotes: ${quotes.length}/${symbols.length} from ${source}` : "Live quotes unavailable; one-year chart data used"
    };
  }

  async function loadIntradayQuote(ticker) {
    const directUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`;
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;

    for (const [index, url] of [directUrl, proxyUrl].entries()) {
      try {
        const response = await fetchWithRetry(url, {
          timeoutMs: index === 0 ? PRICE_TIMEOUT_MS : PRICE_TIMEOUT_MS + 6000,
          type: "json",
          attempts: index === 0 ? 2 : 1,
          delayMs: 900
        });
        if (!response.ok) continue;
        const json = await response.json();
        const quote = parseIntradayQuote(json, ticker);
        if (quote) return quote;
      } catch {
        // Fall through to the relay or daily-chart fallback.
      }
    }

    return null;
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function parseIntradayQuote(json, ticker) {
    const result = json?.chart?.result?.[0];
    const meta = result?.meta || {};
    const symbol = String(meta.symbol || ticker || "").toUpperCase();
    const price = finiteNumber(meta.regularMarketPrice);
    if (!symbol || !price) return null;
    const previousClose = finiteNumber(meta.previousClose || meta.chartPreviousClose);
    return {
      ticker: symbol,
      name: meta.longName || meta.shortName || symbol,
      exchange: meta.fullExchangeName || meta.exchangeName || "",
      marketState: marketStateFromMeta(meta),
      currency: meta.currency || "",
      price,
      previousClose,
      dayChange: previousClose ? price - previousClose : 0,
      dayChangePercent: previousClose ? price / previousClose - 1 : 0,
      volume: finiteNumber(meta.regularMarketVolume),
      averageVolume: 0,
      marketCap: 0,
      bid: 0,
      ask: 0,
      high52Week: finiteNumber(meta.fiftyTwoWeekHigh),
      low52Week: finiteNumber(meta.fiftyTwoWeekLow),
      dayHigh: finiteNumber(meta.regularMarketDayHigh),
      dayLow: finiteNumber(meta.regularMarketDayLow),
      quoteTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : null,
      epsTrailingTwelveMonths: 0,
      trailingPE: 0,
      dividendYield: 0,
      quoteType: meta.instrumentType || ""
    };
  }

  function marketStateFromMeta(meta) {
    const now = Date.now() / 1000;
    const regular = meta?.currentTradingPeriod?.regular;
    if (regular?.start && regular?.end) {
      if (now >= regular.start && now <= regular.end) return "Market open";
      if (now < regular.start) return "Pre-market";
      return "After hours";
    }
    return meta.marketState || "";
  }

  function applyQuoteSnapshot(series, quoteMap) {
    const quote = quoteMap?.get(series.ticker);
    if (!quote) return series;
    const prices = series.prices.slice();
    const latest = prices.at(-1);
    if (latest && Number.isFinite(quote.price) && quote.price > 0) {
      prices[prices.length - 1] = {
        ...latest,
        close: quote.price,
        high: quote.dayHigh || (Number.isFinite(latest.high) ? Math.max(latest.high, quote.price) : quote.price),
        low: quote.dayLow || (Number.isFinite(latest.low) ? Math.min(latest.low, quote.price) : quote.price),
        volume: quote.volume || latest.volume
      };
    }
    return {
      ...series,
      prices,
      quote,
      source: series.source === "sample" ? series.source : `${series.source} + ${quote.price ? "Yahoo intraday" : "quote metadata"}`
    };
  }

  async function loadMarketSeries(ticker) {
    const directUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;

    for (const [index, url] of [directUrl, proxyUrl].entries()) {
      try {
        const response = await fetchWithRetry(url, {
          timeoutMs: index === 0 ? PRICE_TIMEOUT_MS : PRICE_TIMEOUT_MS + 6000,
          type: "json",
          attempts: index === 0 ? 2 : 1,
          delayMs: 1200
        });
        if (!response.ok) continue;
        const json = await response.json();
        const parsed = parseYahooChart(json, ticker);
        if (parsed.prices.length >= 60) {
          parsed.source = url === directUrl ? "Yahoo Finance chart" : "Yahoo Finance via CORS relay";
          return parsed;
        }
      } catch {
        // Fall through to the next data route.
      }
    }

    return sampleSeries(ticker);
  }

  function parseYahooChart(json, ticker) {
    const result = json?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0] || {};
    const closes = quote.close || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const volumes = quote.volume || [];
    const prices = timestamps.map((time, index) => ({
      date: new Date(time * 1000),
      close: Number(closes[index]),
      high: Number(highs[index]),
      low: Number(lows[index]),
      volume: Number(volumes[index] || 0)
    })).filter((point) => Number.isFinite(point.close) && point.close > 0);

    return {
      ticker: String(result?.meta?.symbol || ticker).toUpperCase(),
      prices,
      source: "Yahoo Finance chart"
    };
  }

  async function loadMarketContext() {
    const series = await Promise.all(marketProxyTickers.map(async (proxy) => ({
      ...proxy,
      series: await loadMarketSeries(proxy.ticker)
    })));
    return analyzeMarketContext(series);
  }

  function analyzeMarketContext(proxySeries) {
    const byTicker = new Map(proxySeries.map((proxy) => [proxy.ticker, proxy]));
    const metric = (ticker, days) => {
      const values = byTicker.get(ticker)?.series?.prices?.map((point) => point.close) || [];
      return returnOver(values, days);
    };
    const latest = (ticker) => byTicker.get(ticker)?.series?.prices?.at(-1)?.close || 0;
    const liveCount = proxySeries.filter((proxy) => proxy.series.source !== "sample").length;
    const equityTickers = ["SPY", "QQQ", "IWM", "VTI"];
    const equityOneMonth = average(equityTickers.map((ticker) => metric(ticker, 21)));
    const equityThreeMonth = average(equityTickers.map((ticker) => metric(ticker, 63)));
    const breadth = equityTickers.filter((ticker) => metric(ticker, 21) > 0).length / equityTickers.length;
    const creditRisk = metric("HYG", 21) - metric("LQD", 21);
    const ratePressure = metric("TLT", 21);
    const dollarPressure = metric("UUP", 21);
    const oilPressure = metric("USO", 21);
    const goldSafetyBid = metric("GLD", 21);
    const vix = latest("^VIX");

    let score = 50;
    score += equityOneMonth * 210;
    score += equityThreeMonth * 95;
    score += (breadth - 0.5) * 28;
    score += creditRisk * 260;
    score += ratePressure * 70;
    score -= dollarPressure * 70;
    if (vix) score -= (vix - 20) * 1.15;
    if (oilPressure > 0.08 && ratePressure < 0) score -= 4;
    if (goldSafetyBid > 0.07 && equityOneMonth < 0) score -= 4;
    score = Math.round(clamp(score, 0, 100));

    const confidence = Math.round(clamp(35 + liveCount * 4.5 + Math.abs(score - 50) * 0.55, 25, 92));
    const label = score >= 68 ? "Bullish / risk-on" : score >= 56 ? "Mildly bullish" : score >= 45 ? "Neutral / choppy" : score >= 34 ? "Bearish / defensive" : "High-risk bearish";
    const horizon = "next session to 4 weeks";
    const evidence = [
      `Equity trend: 1M ${formatPercent(equityOneMonth)}, 3M ${formatPercent(equityThreeMonth)}, breadth ${(breadth * 100).toFixed(0)}%.`,
      `Credit appetite: HYG minus LQD over 1M is ${formatPercent(creditRisk)}.`,
      `Rate pressure: TLT 1M is ${formatPercent(ratePressure)}.`,
      vix ? `Volatility: VIX is ${formatNumber(vix)}.` : "Volatility: VIX data unavailable, confidence reduced.",
      `Dollar pressure: UUP 1M is ${formatPercent(dollarPressure)}.`,
      `Commodity/safety check: USO ${formatPercent(oilPressure)}, GLD ${formatPercent(goldSafetyBid)}.`
    ];
    const risks = [
      score >= 56 && vix > 24 ? "Bullish score is capped by elevated volatility." : "",
      score >= 56 && ratePressure < -0.04 ? "Rising-rate pressure could weaken equity multiples." : "",
      score < 45 && breadth > 0.5 ? "Some equity breadth remains positive, so bearish signal is not unanimous." : "",
      liveCount < marketProxyTickers.length ? `${marketProxyTickers.length - liveCount} proxy series used fallback data.` : ""
    ].filter(Boolean);

    return {
      score,
      confidence,
      label,
      horizon,
      evidence,
      risks,
      liveCount,
      total: marketProxyTickers.length,
      metrics: { equityOneMonth, equityThreeMonth, breadth, creditRisk, ratePressure, dollarPressure, oilPressure, goldSafetyBid, vix }
    };
  }

  async function loadNewsSources(tickers, options = {}) {
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

  function buildGdeltScans(tickers) {
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

  function buildDeepSourceScans(tickers) {
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

  function buildAnalystOutlookScans(tickers) {
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

  function parseGdeltArticle(article, tickers, scan = {}) {
    const title = cleanText(article?.title || "");
    const link = article?.url || "";
    const domain = normalizeDomain(article?.domain || safeDomainFromUrl(link));
    const trusted = sourceForDomain(domain);
    if (!title || !trusted) return null;

    const text = `${title} ${trusted.name}`.toUpperCase();
    const isOutlook = scan.kind === "outlook" || outlookDomains.has(trusted.domain) || outlookTermsMentioned(text);
    const targets = unique(tickers.filter((ticker) => symbolMentioned(text, ticker))
      .concat(inferNewsTargets(text, tickers), inferMarketContextTargets(text, tickers), isOutlook ? inferOutlookTargets(text, tickers) : []));
    if (!targets.length) return null;

    return {
      title,
      description: "",
      link,
      pubDate: article?.seendate || "",
      sentiment: isOutlook ? outlookSentiment(title) : headlineSentiment(title),
      tickers: targets,
      source: trusted.name,
      sourceId: trusted.id,
      domain: trusted.domain,
      kind: isOutlook ? "outlook" : "news",
      horizon: scan.horizon || (isOutlook ? "recent" : "current")
    };
  }

  function groupNewsByTicker(items) {
    const byTicker = {};
    items.forEach((item) => {
      item.tickers.forEach((ticker) => {
        if (!byTicker[ticker]) byTicker[ticker] = [];
        if (byTicker[ticker].length < 16) byTicker[ticker].push(item);
      });
    });
    return byTicker;
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

  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        try {
          results[index] = { status: "fulfilled", value: await worker(items[index], index) };
        } catch (error) {
          results[index] = { status: "rejected", reason: error };
        }
      }
    });
    await Promise.all(runners);
    return results;
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

  async function fetchWithRetry(url, options = {}) {
    const {
      timeoutMs = 10000,
      type = "text",
      attempts = 2,
      delayMs = 900
    } = options;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fetchWithTimeout(url, timeoutMs, type);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await delay(delayMs * attempt);
      }
    }

    throw lastError || new Error("Fetch failed");
  }

  function fetchWithTimeout(url, timeoutMs, type = "text") {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    const headers = type === "json" ? { Accept: "application/json" } : {};
    return fetch(url, { cache: "no-store", headers, signal: controller.signal }).finally(() => window.clearTimeout(timeout));
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function parseNewsFeed(xmlText, tickers, feed) {
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
      const text = `${title} ${description}`.toUpperCase();
      const targets = unique(tickers.filter((ticker) => symbolMentioned(text, ticker))
        .concat(inferNewsTargets(text, tickers), inferMarketContextTargets(text, tickers)));
      const sentiment = headlineSentiment(`${title} ${description}`);
      if (!title || !targets.length) return;
      parsed.push({ title, description, link, pubDate, sentiment, tickers: targets, source: sourceName, sourceId, domain: sourceDomain });
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

  function activeTrustedSourceTotal(sources) {
    return Math.max(0, (sources || []).filter((source) => source.ok).length - 1);
  }

  function uniqueArticles(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.sourceId}|${item.title}|${item.link}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => dateValue(b.pubDate) - dateValue(a.pubDate));
  }

  function sourceForDomain(domain) {
    const normalized = normalizeDomain(domain);
    if (!normalized) return null;
    const exact = trustedDomainMap.get(normalized);
    if (exact) return exact;
    return trustedSourceUniverse.find((source) => normalized === source.domain || normalized.endsWith(`.${source.domain}`)) || null;
  }

  function normalizeDomain(domain) {
    return String(domain || "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .trim();
  }

  function slugify(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function safeDomainFromUrl(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  function dateValue(value) {
    const compact = String(value || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (compact) return Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]), Number(compact[4]), Number(compact[5]), Number(compact[6]));
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : 0;
  }

  function inferNewsTargets(text, tickers) {
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

  function inferMarketContextTargets(text, tickers) {
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

  function inferOutlookTargets(text, tickers) {
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

  function outlookTermsMentioned(text) {
    return ["OUTLOOK", "FORECAST", "STRATEGY", "PERSPECTIVE", "COMMENTARY", "OVERWEIGHT", "UNDERWEIGHT", "BULLISH", "BEARISH"].some((term) => text.includes(term));
  }

  function symbolMentioned(text, ticker) {
    const escaped = ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(text);
  }

  function scoreSeries(series, headlines) {
    const outlooks = headlines.filter((headline) => headline.kind === "outlook");
    const newsHeadlines = headlines.filter((headline) => headline.kind !== "outlook");
    const prices = series.prices;
    const closes = prices.map((point) => point.close);
    const highs = prices.map((point) => Number.isFinite(point.high) ? point.high : point.close);
    const lows = prices.map((point) => Number.isFinite(point.low) ? point.low : point.close);
    const latest = closes.at(-1);
    const sma20 = average(closes.slice(-20));
    const sma50 = average(closes.slice(-50));
    const sma200 = average(closes.slice(-200));
    const previousSma50 = average(closes.slice(-100, -50));
    const oneWeek = returnOver(closes, 5);
    const oneDay = series.quote?.dayChangePercent || returnOver(closes, 1);
    const oneMonth = returnOver(closes, 21);
    const threeMonth = returnOver(closes, 63);
    const sixMonth = returnOver(closes, 126);
    const returns = dailyReturns(closes);
    const volatility = stdev(returns) * Math.sqrt(252);
    const high = series.quote?.high52Week || Math.max(...highs.slice(-252));
    const low52Week = series.quote?.low52Week || Math.min(...lows.slice(-252));
    const drawdown = high ? latest / high - 1 : 0;
    const volumes = prices.map((point) => point.volume).filter((volume) => Number.isFinite(volume) && volume > 0);
    const averageVolume60 = series.quote?.averageVolume || average(volumes.slice(-60));
    const averageDollarVolume = latest * averageVolume60;
    const volumePressure = average(volumes.slice(-10)) / Math.max(average(volumes.slice(-60)), 1) - 1;
    const headlineScore = newsHeadlines.length ? average(newsHeadlines.map((headline) => headline.sentiment)) : headlines.length ? average(headlines.map((headline) => headline.sentiment)) : 0;
    const headlineSourceCount = unique(newsHeadlines.map((headline) => headline.sourceId)).length;
    const outlookScore = outlooks.length ? average(outlooks.map((outlook) => outlook.sentiment)) : 0;
    const outlookSourceCount = unique(outlooks.map((outlook) => outlook.sourceId)).length;
    const yearOutlooks = outlooks.filter((outlook) => outlook.horizon === "recent-year");
    const yearOutlookScore = yearOutlooks.length ? average(yearOutlooks.map((outlook) => outlook.sentiment)) : 0;
    const yearOutlookSourceCount = unique(yearOutlooks.map((outlook) => outlook.sourceId)).length;
    const isFund = broadFunds.has(series.ticker);
    const rsi14 = relativeStrengthIndex(closes, 14);
    const macd = macdSignal(closes);
    const bands = bollingerBands(closes, 20);
    const atrValue = averageTrueRange(prices, 14);
    const atrPercent = latest ? atrValue / latest : 0;
    const support = Math.min(...lows.slice(-60));
    const resistance = Math.max(...highs.slice(-60));
    const sma50Slope = previousSma50 ? sma50 / previousSma50 - 1 : 0;
    const eventRisk = detectEventRisk(headlines);

    const trendRaw = (latest > sma20 ? 0.2 : 0) + (latest > sma50 ? 0.35 : 0) + (latest > sma200 ? 0.45 : 0);
    const momentumRaw = clamp((oneMonth + 0.08) / 0.22, 0, 1) * 0.35 + clamp((threeMonth + 0.1) / 0.35, 0, 1) * 0.3 + clamp((sixMonth + 0.15) / 0.5, 0, 1) * 0.35;
    const riskRaw = 1 - clamp((volatility - 0.12) / 0.55, 0, 1);
    const drawdownRaw = 1 - clamp(Math.abs(Math.min(drawdown, 0)) / 0.35, 0, 1);
    const volumeRaw = clamp((volumePressure + 0.15) / 0.45, 0, 1);
    const liquidityRaw = clamp(Math.log10(Math.max(averageDollarVolume, 1)) / 9, 0, 1);
    const rsiRaw = Number.isFinite(rsi14) ? rsi14 > 75 ? 0.35 : rsi14 >= 45 && rsi14 <= 70 ? 1 : rsi14 >= 35 && rsi14 < 45 ? 0.65 : rsi14 < 30 ? 0.45 : 0.55 : 0.5;
    const macdRaw = macd.histogram > 0 ? 0.72 + clamp(macd.histogram / Math.max(latest * 0.02, 1), 0, 0.28) : 0.45 + clamp(macd.histogram / Math.max(latest * 0.02, 1), -0.35, 0);
    const bollingerRaw = Number.isFinite(bands.position) ? bands.position > 1.05 ? 0.42 : bands.position >= 0.35 && bands.position <= 0.85 ? 0.9 : bands.position < 0.15 ? 0.55 : 0.66 : 0.5;
    const atrRiskRaw = 1 - clamp((atrPercent - 0.018) / 0.06, 0, 1);
    const technicalRaw = average([trendRaw, momentumRaw, rsiRaw, macdRaw, bollingerRaw, atrRiskRaw]);
    const headlineRaw = clamp((headlineScore + 1) / 2, 0, 1);
    const sourceRaw = clamp(headlineSourceCount / 6, 0, 1);
    const outlookRaw = clamp((outlookScore + 1) / 2, 0, 1);
    const outlookBreadthRaw = clamp(outlookSourceCount / 4, 0, 1);
    const diversificationRaw = isFund ? 1 : 0.48;
    const eventRiskRaw = 1 - clamp(eventRisk.score / 100, 0, 1);

    let score = (
      trendRaw * 18 +
      momentumRaw * 17 +
      technicalRaw * 14 +
      riskRaw * 11 +
      drawdownRaw * 9 +
      headlineRaw * 7 +
      sourceRaw * 4 +
      volumeRaw * 5 +
      liquidityRaw * 5 +
      eventRiskRaw * 5 +
      diversificationRaw * 5
    );

    if (outlooks.length) {
      score += (outlookRaw - 0.5) * 12;
      score += outlookScore >= 0 ? outlookBreadthRaw * 2 : -outlookBreadthRaw;
    }

    if (yearOutlooks.length) {
      const yearBreadthRaw = clamp(yearOutlookSourceCount / 4, 0, 1);
      score += clamp(yearOutlookScore * 6, -5, 5);
      score += yearOutlookScore >= 0 ? yearBreadthRaw * 1.5 : -yearBreadthRaw * 1.5;
    }

    if (!isFund) score -= 4;
    if (volatility > 0.65) score -= 8;
    if (latest < sma200 && sixMonth < 0) score -= 8;
    if (eventRisk.level === "High") score -= 8;
    if (liquidityRaw < 0.38 && !isFund) score = Math.min(score, 44);
    score = Math.round(clamp(score, 0, 100));
    const categories = buildCategoryScores({
      trendRaw, momentumRaw, technicalRaw, headlineRaw, outlookRaw, yearOutlookScore,
      liquidityRaw, riskRaw, drawdownRaw, eventRiskRaw, sourceRaw
    });
    const setup = buildTradeSetup({
      latest, sma50, sma200, support, resistance, atrValue, atrPercent, rsi14, macd,
      volumePressure, averageDollarVolume, eventRisk, score, isFund
    });

    return {
      ...series,
      score,
      latest,
      oneDay,
      sma20,
      sma50,
      sma200,
      sma50Slope,
      oneWeek,
      oneMonth,
      threeMonth,
      sixMonth,
      volatility,
      drawdown,
      high52Week: high,
      low52Week,
      support,
      resistance,
      rsi14,
      macd,
      bollinger: bands,
      atrValue,
      atrPercent,
      averageVolume60,
      averageDollarVolume,
      volumePressure,
      headlineScore,
      headlineSourceCount,
      outlookScore,
      outlookSourceCount,
      yearOutlookScore,
      yearOutlookSourceCount,
      headlines,
      outlooks,
      yearOutlooks,
      isFund,
      categories,
      eventRisk,
      setup,
      scoreDelta: 0,
      label: scoreLabel(score),
      reasons: buildReasons({ latest, sma20, sma50, sma200, sma50Slope, oneMonth, threeMonth, sixMonth, volatility, drawdown, volumePressure, headlineScore, headlineSourceCount, outlookScore, outlookSourceCount, yearOutlookScore, yearOutlookSourceCount, rsi14, macd, averageDollarVolume, eventRisk, isFund }),
      flags: buildFlags({ latest, sma200, sixMonth, volatility, drawdown, atrPercent, averageDollarVolume, eventRisk, isFund })
    };
  }

  function buildCategoryScores(parts) {
    const recentYearRaw = clamp((parts.yearOutlookScore + 1) / 2, 0, 1);
    return {
      trend: Math.round(parts.trendRaw * 100),
      momentum: Math.round(parts.momentumRaw * 100),
      technical: Math.round(parts.technicalRaw * 100),
      news: Math.round(((parts.headlineRaw * 0.55) + (parts.outlookRaw * 0.3) + (parts.sourceRaw * 0.15)) * 100),
      recentYear: Math.round(recentYearRaw * 100),
      liquidity: Math.round(parts.liquidityRaw * 100),
      risk: Math.round(average([parts.riskRaw, parts.drawdownRaw, parts.eventRiskRaw]) * 100)
    };
  }

  function buildTradeSetup(data) {
    const stopBuffer = data.atrValue || data.latest * 0.025;
    const supportStop = Number.isFinite(data.support) ? data.support - stopBuffer * 0.35 : data.latest - stopBuffer;
    const movingStop = Math.min(data.sma50 || data.latest, data.sma200 || data.latest) - stopBuffer * 0.25;
    const invalidation = Math.max(0, Math.min(supportStop, movingStop));
    const entryLow = Math.max(invalidation, data.latest - stopBuffer * 0.35);
    const entryHigh = data.score >= 70 ? data.latest + stopBuffer * 0.45 : Math.min(data.latest + stopBuffer * 0.2, data.resistance || data.latest + stopBuffer * 0.2);
    const riskLevel = data.eventRisk.level === "High" || data.atrPercent > 0.055 || data.score < 45
      ? "High"
      : data.atrPercent > 0.03 || data.eventRisk.level === "Medium"
        ? "Medium"
        : "Lower";
    const timeframe = data.score >= 70 ? "1 day to 4 weeks" : data.score >= 55 ? "1 to 4 weeks" : "Now / avoid new buys";
    return {
      signal: signalForScore(data.score, data.eventRisk.level),
      confidence: Math.round(clamp(data.score - (data.eventRisk.level === "High" ? 10 : data.eventRisk.level === "Medium" ? 5 : 0), 0, 100)),
      timeframe,
      entryZone: `${formatNumber(entryLow)}-${formatNumber(Math.max(entryLow, entryHigh))}`,
      invalidation,
      riskLevel,
      support: data.support,
      resistance: data.resistance,
      note: data.eventRisk.level === "High" ? "Event risk is high; avoid new entries unless the setup improves." : "Entry is a signal zone, not a guaranteed fill."
    };
  }

  function signalForScore(score, eventRiskLevel) {
    if (eventRiskLevel === "High" && score < 72) return "Avoid new buys";
    if (score >= 76) return "Buy signal";
    if (score >= 62) return "Hold / buy-watch";
    if (score >= 48) return "Watch";
    if (score >= 38) return "Avoid new buys";
    return "Sell / reduce";
  }

  function detectEventRisk(headlines) {
    const text = headlines.map((item) => `${item.title} ${item.description || ""}`).join(" ").toLowerCase();
    const highTerms = ["earnings miss", "guidance cut", "sec lawsuit", "antitrust lawsuit", "trading suspension", "hack", "exploit", "delisting", "bankruptcy", "default"];
    const mediumTerms = ["earnings", "rate decision", "fed decision", "cpi", "ppi", "jobs report", "lawsuit", "probe", "regulation", "merger", "acquisition", "etf outflow", "sanctions"];
    const highHits = highTerms.filter((term) => text.includes(term));
    const mediumHits = mediumTerms.filter((term) => text.includes(term));
    const score = Math.min(100, highHits.length * 38 + mediumHits.length * 18);
    return {
      score,
      level: score >= 55 ? "High" : score >= 24 ? "Medium" : "Low",
      hits: unique(highHits.concat(mediumHits)).slice(0, 5)
    };
  }

  function applyLearningSignal(item) {
    const previous = latestLearningPoint(item.ticker);
    if (!previous) return { ...item, rawScore: item.score };
    const rawScore = item.score;
    const rawDelta = rawScore - previous.score;
    const limitedScore = previous.score + clamp(rawDelta, -SCORE_MOVE_LIMIT, SCORE_MOVE_LIMIT);
    const adjusted = Math.round(clamp(limitedScore, 0, 100));
    const scoreDelta = adjusted - previous.score;

    return {
      ...item,
      rawScore,
      score: adjusted,
      scoreDelta,
      label: scoreLabel(adjusted),
      setup: item.setup ? { ...item.setup, signal: signalForScore(adjusted, item.eventRisk?.level || "Low"), confidence: Math.round(clamp(adjusted - (item.eventRisk?.level === "High" ? 10 : item.eventRisk?.level === "Medium" ? 5 : 0), 0, 100)) } : item.setup,
      reasons: [
        ...item.reasons,
        scoreDelta >= 5
          ? `Score improved ${scoreDelta} points since the previous local scan.`
          : scoreDelta <= -5
            ? `Score weakened ${Math.abs(scoreDelta)} points since the previous local scan.`
            : rawDelta !== scoreDelta
              ? `Raw score moved ${rawDelta >= 0 ? "+" : ""}${rawDelta} points, capped to ${scoreDelta >= 0 ? "+" : ""}${scoreDelta} for scan stability.`
              : "Score change from the previous local scan is small."
      ].slice(0, 4)
    };
  }

  function stableRankSort(a, b) {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) >= 3) return scoreDiff;
    const previousA = latestLearningPoint(a.ticker)?.score ?? a.score;
    const previousB = latestLearningPoint(b.ticker)?.score ?? b.score;
    const previousDiff = previousB - previousA;
    if (Math.abs(previousDiff) >= 3) return previousDiff;
    return a.ticker.localeCompare(b.ticker);
  }

  function renderAll(results, priceSource, news, marketContext, quoteSnapshot = null) {
    latestRankedResults = results;
    latestPriceSource = priceSource;
    latestNews = news;
    latestMarketContext = marketContext;
    latestQuoteSnapshot = quoteSnapshot;
    const allocation = buildModelAllocation(results, marketContext);
    const portfolio = buildPortfolioReview(results, marketContext);
    const top = results[0];
    const now = new Date();
    const sourceLine = priceSource === "sample"
      ? "Price data fell back to sample data. Do not act on this scan."
      : `Price data: ${priceSource}. ${quoteSnapshot?.label || "Quote data checked"}. Headlines: ${news.label}.`;
    const activeTrustedSources = Math.max(0, news.sources.filter((source) => source.ok).length - 1);

    els.lastScan.textContent = now.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    els.marketPulseTitle.textContent = top ? `${top.ticker} leads today's scan` : "No leader";
    els.marketPulse.innerHTML = [
      ["Scanned", results.length],
      ["Average", Math.round(average(results.map((item) => item.score)))],
      ["Top score", top ? `${top.score}/100` : "-"],
      ["Active sources", `${activeTrustedSources}/${news.configured}`],
      ["Quotes", quoteSnapshot?.count ? `${quoteSnapshot.count}/${quoteSnapshot.total}` : "Chart only"],
      ["Universe", `${news.configured}+`],
      ["Forecast", marketContext.label],
      ["Confidence", `${marketContext.confidence}%`],
      ["Headlines", news.items.length],
      ["Outlooks", news.outlookCount || 0],
      ["Source", priceSource === "sample" ? "Sample" : "Live"]
    ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");

    renderModelInstructions(allocation, sourceLine);
    renderScreener();
    renderMarketForecast(marketContext, news);
    renderPortfolioReview(portfolio, priceSource);
    renderSellGuidance(results, priceSource);
    renderEvidence(results, allocation);
    renderMarketFramework(results, marketContext, news);
    renderSourceStatus(news.sources, news.configured);
    renderRanking(results);
  }

  function renderScreener() {
    if (!latestRankedResults.length) {
      els.screenerResults.innerHTML = `<div class="empty-state">The screener will populate after the first live scan.</div>`;
      return;
    }

    const signal = els.screenerSignal.value || defaults.screenerSignal;
    const minScore = clamp(Number(els.screenerMinScore.value || defaults.screenerMinScore), 0, 100);
    const minLiquidity = Math.max(0, Number(els.screenerMinLiquidity.value || defaults.screenerMinLiquidity)) * 1000000;
    const sort = els.screenerSort.value || defaults.screenerSort;
    const appliesScoreFloor = !["sell", "avoid"].includes(signal);
    const filtered = latestRankedResults
      .filter((item) => !appliesScoreFloor || item.score >= minScore)
      .filter((item) => item.averageDollarVolume >= minLiquidity || item.isFund)
      .filter((item) => screenerSignalMatches(item, signal))
      .sort((a, b) => sortScreenerResults(a, b, sort))
      .slice(0, 40);
    const top = filtered[0];

    els.screenerResults.innerHTML = `
      <div class="screener-summary">
        <article><span>Matched</span><strong>${filtered.length}/${latestRankedResults.length}</strong></article>
        <article><span>Top ticker</span><strong>${escapeHtml(top?.ticker || "-")}</strong></article>
        <article><span>Quote data</span><strong>${latestQuoteSnapshot?.count ? `${latestQuoteSnapshot.count}/${latestQuoteSnapshot.total}` : "Chart only"}</strong></article>
        <article><span>Source set</span><strong>${latestNews?.label ? escapeHtml(latestNews.label.split(" ")[0]) : "-"}</strong></article>
      </div>
      <div class="screener-table">
        ${filtered.length ? filtered.map((item, index) => renderScreenerRow(item, index)).join("") : `<div class="empty-state">No tickers match these filters. Lower the score or liquidity filter, or choose all scanned tickers.</div>`}
      </div>
    `;
  }

  function screenerSignalMatches(item, signal) {
    const modelSignal = String(item.setup?.signal || item.label || "").toLowerCase();
    if (signal === "all") return true;
    if (signal === "buy") return item.score >= 62 && !modelSignal.includes("avoid") && !modelSignal.includes("sell");
    if (signal === "hold") return Boolean(holdSignalFor(item)) || modelSignal.includes("hold");
    if (signal === "sell") return Boolean(sellSignalFor(item)) || modelSignal.includes("sell");
    if (signal === "avoid") return modelSignal.includes("avoid") || item.score < 48;
    return item.score >= 58 && !sellSignalFor(item) && !modelSignal.includes("avoid");
  }

  function sortScreenerResults(a, b, sort) {
    const tie = b.score - a.score || a.ticker.localeCompare(b.ticker);
    if (sort === "momentum") return (b.categories?.momentum || 0) - (a.categories?.momentum || 0) || tie;
    if (sort === "risk") return (b.categories?.risk || 0) - (a.categories?.risk || 0) || tie;
    if (sort === "liquidity") return (b.averageDollarVolume || 0) - (a.averageDollarVolume || 0) || tie;
    if (sort === "volume") return (b.volumePressure || 0) - (a.volumePressure || 0) || tie;
    return tie;
  }

  function renderScreenerRow(item, index) {
    const quote = item.quote || {};
    const dayRange = quote.dayLow && quote.dayHigh ? `${formatNumber(quote.dayLow)}-${formatNumber(quote.dayHigh)}` : "-";
    const source = quote.price ? "Intraday + chart" : item.source === "sample" ? "Sample fallback" : "Chart";
    return `
      <article class="screener-row ${item.score >= 75 ? "grade-good" : item.score >= 60 ? "grade-watch" : item.score >= 45 ? "grade-mixed" : "grade-avoid"}">
        <div class="rank">${index + 1}</div>
        <div>
          <div class="stock-title">
            <h3><a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</a></h3>
            <span>${item.score}/100</span>
          </div>
          <strong>${escapeHtml(quote.name && quote.name !== item.ticker ? quote.name : item.setup?.signal || item.label)}</strong>
          <div class="stock-stats">
            <span>Price ${escapeHtml(formatNumber(item.latest))}</span>
            <span>Today ${formatPercent(item.oneDay)}</span>
            <span>1M ${formatPercent(item.oneMonth)}</span>
            <span>Day range ${escapeHtml(dayRange)}</span>
            <span>Liquidity ${escapeHtml(compactMoney(item.averageDollarVolume))}</span>
            <span>Source ${escapeHtml(source)}</span>
          </div>
        </div>
        <div>
          <b class="signal-pill">${escapeHtml(item.setup?.signal || item.label)}</b>
          <p>${escapeHtml(item.reasons[0] || item.flags[0] || "No dominant note.")}</p>
          <a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">Open detail</a>
        </div>
      </article>
    `;
  }

  function renderStockDetail(item, news, marketContext, quoteSnapshot) {
    const quote = item.quote || {};
    const links = uniqueArticles((news.byTicker[item.ticker] || []).concat(item.outlooks || [], item.headlines || []))
      .filter((entry) => entry.link)
      .slice(0, 8);
    const sellSignal = sellSignalFor(item);
    const holdSignal = holdSignalFor(item);
    const currentVerdict = sellSignal?.label || holdSignal?.label || item.setup?.signal || item.label;
    const dayRange = quote.dayLow && quote.dayHigh ? `${formatNumber(quote.dayLow)} - ${formatNumber(quote.dayHigh)}` : "-";
    const quoteTime = quote.quoteTime ? quote.quoteTime.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "latest chart point";

    els.detailOutput.innerHTML = `
      <article class="detail-card ${item.score >= 75 ? "grade-good" : item.score >= 60 ? "grade-watch" : item.score >= 45 ? "grade-mixed" : "grade-avoid"}">
        <div class="detail-hero">
          <div>
            <span>${escapeHtml(quote.name || item.ticker)}</span>
            <h3>${escapeHtml(item.ticker)}</h3>
            <p>${escapeHtml(currentVerdict)}. ${escapeHtml(item.reasons[0] || item.flags[0] || "No dominant signal found.")}</p>
          </div>
          <strong>${item.score}/100</strong>
        </div>
        <div class="detail-metrics">
          ${renderMetric("Last price", formatNumber(item.latest), quote.marketState || "Yahoo intraday/chart")}
          ${renderMetric("Today", formatPercent(item.oneDay), quote.dayChange ? formatNumber(quote.dayChange) : "daily move")}
          ${renderMetric("1M / 6M", `${formatPercent(item.oneMonth)} / ${formatPercent(item.sixMonth)}`, "trend")}
          ${renderMetric("Day range", dayRange, quoteTime)}
          ${renderMetric("Volume", compactMoney(item.latest * (quote.volume || item.averageVolume60)), "latest dollar volume")}
          ${renderMetric("Avg liquidity", compactMoney(item.averageDollarVolume), "average dollar volume")}
          ${renderMetric("Exchange", quote.exchange || "-", quote.currency || quote.quoteType || "metadata")}
          ${renderMetric("52W range", `${formatNumber(item.low52Week)} - ${formatNumber(item.high52Week)}`, "quote/chart")}
          ${renderMetric("SMA 50 / 200", `${formatNumber(item.sma50)} / ${formatNumber(item.sma200)}`, item.latest > item.sma200 ? "above 200D" : "below 200D")}
          ${renderMetric("RSI / MACD", `${Number.isFinite(item.rsi14) ? item.rsi14.toFixed(0) : "-"} / ${item.macd?.histogram >= 0 ? "positive" : "negative"}`, "momentum")}
          ${renderMetric("ATR / Vol", `${formatPercent(item.atrPercent)} / ${formatPercent(item.volatility)}`, "risk")}
          ${renderMetric("Event risk", item.eventRisk?.level || "Low", item.eventRisk?.hits?.join(", ") || "headline scan")}
        </div>
        ${renderCategoryBars(item.categories)}
        <div class="detail-columns">
          <section>
            <span>Reasons</span>
            <ul>${item.reasons.slice(0, 5).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
          </section>
          <section>
            <span>Risk flags</span>
            <ul>${item.flags.slice(0, 5).map((flag) => `<li>${escapeHtml(flag)}</li>`).join("")}</ul>
          </section>
        </div>
        <div class="setup-line">
          <span>Entry ${escapeHtml(item.setup?.entryZone || "-")}</span>
          <span>Invalidation ${escapeHtml(item.setup ? formatNumber(item.setup.invalidation) : "-")}</span>
          <span>Support ${escapeHtml(formatNumber(item.support))}</span>
          <span>Resistance ${escapeHtml(formatNumber(item.resistance))}</span>
          <span>Market ${escapeHtml(marketContext.label)}</span>
          <span>${escapeHtml(quoteSnapshot?.label || "Quote data checked")}</span>
        </div>
        <div class="detail-sources">
          <span>Source-backed evidence</span>
          ${links.length ? links.map((entry) => `<a href="${escapeHtml(entry.link)}" target="_blank" rel="noreferrer">${escapeHtml(entry.source)}: ${escapeHtml(entry.title)}</a>`).join("") : `<p>No direct article links matched this ticker; the score leans more on price, technicals, liquidity, and broad market context.</p>`}
        </div>
      </article>
    `;
  }

  function renderMetric(label, value, note = "") {
    return `
      <article class="metric-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        ${note ? `<small>${escapeHtml(note)}</small>` : ""}
      </article>
    `;
  }

  function buildPortfolioReview(results, marketContext) {
    const holdings = parsePortfolioPositions(state.myPortfolioInput);
    const byTicker = new Map(results.map((item) => [item.ticker, item]));
    const enriched = holdings.map((holding) => {
      const item = byTicker.get(holding.ticker);
      return {
        ...holding,
        analysis: item || null,
        isCore: broadFunds.has(holding.ticker) || /vanguard|ftse|all-world|index|etf/i.test(holding.label)
      };
    });
    const total = enriched.reduce((sum, holding) => sum + holding.amount, 0);
    enriched.forEach((holding) => {
      holding.weight = total ? (holding.amount / total) * 100 : 0;
      holding.review = portfolioHoldingReview(holding, marketContext);
    });

    const coreValue = enriched.filter((holding) => holding.isCore).reduce((sum, holding) => sum + holding.amount, 0);
    const stockValue = total - coreValue;
    const largest = enriched.reduce((best, holding) => !best || holding.amount > best.amount ? holding : best, null);
    const downCount = enriched.filter((holding) => holding.status === "down").length;
    const ownedTech = enriched
      .filter((holding) => ["MSFT", "TSM", "AVGO", "NVDA", "GOOGL"].includes(holding.ticker))
      .reduce((sum, holding) => sum + holding.amount, 0);
    const concentrationNotes = [];
    if (total && coreValue / total >= 0.8) concentrationNotes.push("Most of the portfolio is in one broad Vanguard/FTSE core holding. That is diversified by companies, but still concentrated in one fund wrapper.");
    if (total && ownedTech / total >= 0.1) concentrationNotes.push("The satellite positions are mostly mega-cap tech and semiconductors, so they can fall together even if each individual amount is small.");
    if (downCount >= 3) concentrationNotes.push("Several satellite holdings are down. The model separates normal drawdown from actual trend damage before suggesting any reduction.");
    if (marketContext?.score < 45) concentrationNotes.push(`Market regime is weak (${marketContext.label}), so new buys need a stricter setup.`);
    if (!concentrationNotes.length) concentrationNotes.push("Position sizes look controlled. The main task is patience and avoiding impulsive averaging down.");

    return {
      holdings: enriched,
      total,
      coreValue,
      stockValue,
      largest,
      downCount,
      concentrationNotes
    };
  }

  function portfolioHoldingReview(holding, marketContext) {
    const item = holding.analysis;
    if (!item) {
      return {
        label: "Needs ticker check",
        className: "holding-watch",
        reason: "This holding was not returned by the live price scan. Check that the ticker matches your broker symbol.",
        detail: "The app can still count the position size, but it cannot score trend or risk until price data loads."
      };
    }

    const down = holding.status === "down";
    const overweightSatellite = !holding.isCore && holding.weight > 8;
    const largeCore = holding.isCore && holding.weight > 80;
    const broken = item.score <= 44 || (item.latest < item.sma200 && item.sixMonth < 0) || item.eventRisk?.level === "High";
    const healthy = item.score >= 58 && item.latest > item.sma200 && item.eventRisk?.level !== "High";
    const stretched = item.rsi14 > 72 || item.volatility > (holding.isCore ? 0.28 : 0.5);

    if (broken && down) {
      return {
        label: "Review / possible trim",
        className: "holding-danger",
        reason: `${holding.ticker} is down and the live model also sees technical or event damage.`,
        detail: `${item.label} (${item.score}/100). ${item.flags[0] || "Trend, momentum, or risk filters are weak."}`
      };
    }

    if (broken) {
      return {
        label: "Avoid adding",
        className: "holding-warning",
        reason: `${holding.ticker} does not clear the quality gate today.`,
        detail: `${item.label} (${item.score}/100). Let the setup repair before adding more.`
      };
    }

    if (healthy && down) {
      return {
        label: "Hold, no panic sell",
        className: "holding-good",
        reason: `${holding.ticker} is down for you, but the current setup is not broken.`,
        detail: `${item.label} (${item.score}/100). The safer move is to avoid emotional selling and only add if the signal stays strong across scans.`
      };
    }

    if (largeCore && healthy) {
      return {
        label: "Core hold",
        className: "holding-good",
        reason: "Your Vanguard/FTSE position is the portfolio anchor and currently passes the broad-holding checks.",
        detail: `Weight ${holding.weight.toFixed(1)}%. Consider future additions carefully because it already drives most portfolio movement.`
      };
    }

    if (overweightSatellite || stretched) {
      return {
        label: "Hold / avoid adding",
        className: "holding-warning",
        reason: overweightSatellite ? `${holding.ticker} is a large satellite position.` : `${holding.ticker} looks stretched or volatile.`,
        detail: `${item.label} (${item.score}/100). New money may be better reserved unless the setup improves.`
      };
    }

    return {
      label: marketContext?.score < 45 ? "Hold, be selective" : "Hold / watch",
      className: "holding-watch",
      reason: `${holding.ticker} does not show an urgent sell signal today.`,
      detail: `${item.label} (${item.score}/100). Watch the invalidation area near ${formatNumber(item.setup?.invalidation || item.sma50)}.`
    };
  }

  function renderPortfolioReview(portfolio, priceSource) {
    if (!portfolio.holdings.length) {
      els.portfolioReview.innerHTML = `<div class="empty-state">Add your holdings above to make the model position-aware.</div>`;
      return;
    }
    const sourceWarning = priceSource === "sample"
      ? `<p class="data-note">Price data fell back to sample data, so this is only a position-size review.</p>`
      : `<p class="data-note">This is a portfolio-aware market signal, not personal financial advice. It uses your stated position sizes, current model scores, trend checks, and risk filters.</p>`;
    els.portfolioReview.innerHTML = `
      ${sourceWarning}
      <div class="portfolio-summary">
        <article><span>Total tracked</span><strong>${money(portfolio.total)}</strong></article>
        <article><span>Core ETF weight</span><strong>${portfolio.total ? `${((portfolio.coreValue / portfolio.total) * 100).toFixed(1)}%` : "-"}</strong></article>
        <article><span>Satellite stock weight</span><strong>${portfolio.total ? `${((portfolio.stockValue / portfolio.total) * 100).toFixed(1)}%` : "-"}</strong></article>
        <article><span>Down positions</span><strong>${portfolio.downCount}/${portfolio.holdings.length}</strong></article>
      </div>
      <div class="portfolio-notes">
        ${portfolio.concentrationNotes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}
      </div>
      <div class="holding-grid">
        ${portfolio.holdings.map(renderHoldingCard).join("")}
      </div>
    `;
  }

  function renderHoldingCard(holding) {
    const item = holding.analysis;
    return `
      <article class="holding-card ${holding.review.className}">
        <div class="holding-head">
          <div>
            <span>${escapeHtml(holding.status === "down" ? "Currently down" : holding.status === "up" ? "Currently up" : "Status unknown")}</span>
            <h3>${escapeHtml(holding.label || holding.ticker)}</h3>
          </div>
          <strong>${holding.weight.toFixed(1)}%</strong>
        </div>
        <div class="stock-stats">
          <span>${escapeHtml(holding.ticker)}</span>
          <span>${money(holding.amount)}</span>
          ${item ? `<span>Score ${item.score}/100</span>` : ""}
          ${item ? `<span>1M ${formatPercent(item.oneMonth)}</span>` : ""}
          ${item ? `<span>Risk ${escapeHtml(item.setup?.riskLevel || "-")}</span>` : ""}
        </div>
        <b class="holding-label">${escapeHtml(holding.review.label)}</b>
        <p>${escapeHtml(holding.review.reason)} ${escapeHtml(holding.review.detail)}</p>
      </article>
    `;
  }

  function renderModelInstructions(allocation, sourceLine) {
    els.modelInstructions.innerHTML = `
      <p class="data-note">${escapeHtml(sourceLine)} Output is phrased as market signals, not personal investment advice. Use entry and invalidation levels as risk markers, not guaranteed instructions.</p>
      <div class="instruction-list">
        ${allocation.actions.map((action) => renderAction(action)).join("")}
      </div>
      <div class="avoid-box">
        <span>Do not buy today</span>
        <strong>${escapeHtml(allocation.avoid.ticker)}</strong>
        <p>${escapeHtml(allocation.avoid.text)}</p>
      </div>
    `;
  }

  function renderMarketForecast(forecast, news) {
    const activeTrustedSources = Math.max(0, news.sources.filter((source) => source.ok).length - 1);
    els.marketForecast.innerHTML = `
      <article class="forecast-card ${forecast.score >= 56 ? "forecast-positive" : forecast.score < 45 ? "forecast-negative" : "forecast-neutral"}">
        <div class="forecast-head">
          <div>
            <span>${escapeHtml(forecast.horizon)}</span>
            <h3>${escapeHtml(forecast.label)}</h3>
          </div>
          <strong>${forecast.confidence}% confidence</strong>
        </div>
        <div class="forecast-meter" aria-hidden="true"><span style="width: ${forecast.score}%"></span></div>
        <div class="stock-stats">
          <span>Forecast ${forecast.score}/100</span>
          <span>Sources ${activeTrustedSources}/${news.configured}</span>
          <span>Proxies ${forecast.liveCount}/${forecast.total}</span>
          <span>Outlooks ${news.outlookCount || 0}</span>
        </div>
        <ul>${forecast.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        ${forecast.risks.length ? `<p>${escapeHtml(forecast.risks.join(" "))}</p>` : `<p>No major contradiction found across the market proxy set.</p>`}
      </article>
    `;
  }

  function renderSellGuidance(results, priceSource) {
    const guidance = buildSellGuidance(results);
    const sourceWarning = priceSource === "sample"
      ? `<p class="data-note">Price data fell back to sample data, so the sell/hold model is disabled for action.</p>`
      : `<p class="data-note">Sell/hold signals use the same live market, headline, outlook, volatility, trend, and local scan-change model. This is not an order ticket.</p>`;

    els.sellGuidance.innerHTML = `
      ${sourceWarning}
      <div class="sell-grid">
        <article class="sell-column sell-column-danger">
          <div class="sell-column-head">
            <span>Sell / reduce now</span>
            <strong>${guidance.sell.length}</strong>
          </div>
          ${guidance.sell.length ? guidance.sell.map(renderSellItem).join("") : `<div class="empty-state">No strong sell/reduce signal in the current watchlist.</div>`}
        </article>
        <article class="sell-column sell-column-hold">
          <div class="sell-column-head">
            <span>Do not sell / hold</span>
            <strong>${guidance.hold.length}</strong>
          </div>
          ${guidance.hold.length ? guidance.hold.map(renderSellItem).join("") : `<div class="empty-state">No high-conviction hold signal. Treat the rest as watch/rebalance candidates.</div>`}
        </article>
      </div>
    `;
  }

  function buildSellGuidance(results) {
    const sell = [];
    const hold = [];

    results.forEach((item) => {
      const sellSignal = sellSignalFor(item);
      const holdSignal = holdSignalFor(item);
      if (sellSignal) sell.push(sellSignal);
      else if (holdSignal) hold.push(holdSignal);
    });

    return {
      sell: sell.sort((a, b) => b.urgency - a.urgency).slice(0, 6),
      hold: hold.sort((a, b) => b.conviction - a.conviction).slice(0, 6)
    };
  }

  function sellSignalFor(item) {
    const triggers = [];
    if (item.score <= 44) triggers.push(`Low total model score: ${item.score}/100.`);
    if (item.latest < item.sma200 && item.sixMonth < 0) triggers.push(`Below 200-day average with ${formatPercent(item.sixMonth)} six-month momentum.`);
    if (item.latest < item.sma50 && item.volumePressure > 0.12) triggers.push(`Fell below the 50-day average while recent volume is ${formatPercent(item.volumePressure)} above baseline.`);
    if (item.oneMonth < -0.06 && item.threeMonth < 0) triggers.push(`Short-term trend is breaking: 1M ${formatPercent(item.oneMonth)}, 3M ${formatPercent(item.threeMonth)}.`);
    if (Number.isFinite(item.rsi14) && item.rsi14 < 40 && item.macd?.histogram < 0) triggers.push(`RSI ${item.rsi14.toFixed(0)} and negative MACD show weakening momentum.`);
    if (item.drawdown < -0.22) triggers.push(`Large drawdown from recent high: ${formatPercent(item.drawdown)}.`);
    if (item.eventRisk?.level === "High") triggers.push(`High event risk: ${item.eventRisk.hits.join(", ") || "major headline risk"}.`);
    if (!item.isFund && item.volatility > 0.5) triggers.push(`Single-stock volatility is high at ${formatPercent(item.volatility)} annualized.`);
    if (item.outlookSourceCount >= 1 && item.outlookScore < -0.15) triggers.push(`Trusted outlook tone is negative across ${item.outlookSourceCount} source${item.outlookSourceCount === 1 ? "" : "s"}.`);
    if (item.headlineSourceCount >= 2 && item.headlineScore < -0.2) triggers.push(`Recent headline tone is negative across ${item.headlineSourceCount} sources.`);
    if (item.scoreDelta <= -8) triggers.push(`Model score dropped ${Math.abs(item.scoreDelta)} points since the previous scan.`);

    const urgent = item.score <= 40 || triggers.length >= 3;
    if (!urgent && triggers.length < 2) return null;

    return {
      ticker: item.ticker,
      label: urgent ? "Sell / reduce" : "Trim / review",
      score: item.score,
      urgency: triggers.length * 10 + (100 - item.score),
      reason: triggers[0],
      detail: triggers.slice(1, 3).join(" "),
      className: "sell-item-danger"
    };
  }

  function holdSignalFor(item) {
    const reasons = [];
    if (item.score >= 65) reasons.push(`Strong model score: ${item.score}/100.`);
    if (item.latest > item.sma50 && item.latest > item.sma200) reasons.push("Price is above both 50-day and 200-day averages.");
    if (item.sixMonth > 0) reasons.push(`Six-month momentum is positive at ${formatPercent(item.sixMonth)}.`);
    if (Number.isFinite(item.rsi14) && item.rsi14 >= 45 && item.rsi14 <= 70) reasons.push(`RSI ${item.rsi14.toFixed(0)} is healthy without being stretched.`);
    if (item.eventRisk?.level === "Low") reasons.push("No major event-risk blocker was detected.");
    if (item.outlookSourceCount >= 1 && item.outlookScore >= 0.05) reasons.push(`Trusted outlook tone is constructive across ${item.outlookSourceCount} source${item.outlookSourceCount === 1 ? "" : "s"}.`);
    if (item.isFund && item.score >= 58) reasons.push("Broad ETF exposure reduces single-company risk.");
    if (item.scoreDelta >= 5) reasons.push(`Model score improved ${item.scoreDelta} points since the previous scan.`);

    if (item.score < 58 || reasons.length < 2) return null;

    return {
      ticker: item.ticker,
      label: "Do not sell / hold",
      score: item.score,
      conviction: reasons.length * 10 + item.score,
      reason: reasons[0],
      detail: reasons.slice(1, 3).join(" "),
      className: "sell-item-hold"
    };
  }

  function renderSellItem(item) {
    return `
      <div class="sell-item ${item.className}">
        <div>
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.ticker)}</strong>
        </div>
        <b>${item.score}/100</b>
        <p>${escapeHtml(item.reason)} ${escapeHtml(item.detail || "")}</p>
      </div>
    `;
  }

  function buildQuestionAnswer(item, news, parsed) {
    const sellSignal = sellSignalFor(item);
    const holdSignal = holdSignalFor(item);
    const activeSources = Math.max(0, news.sources.filter((source) => source.ok).length - 1);
    const relevantItems = uniqueArticles((news.byTicker[item.ticker] || []).concat(item.outlooks || [], item.headlines || []));
    const links = relevantItems.filter((entry) => entry.link).slice(0, 5);
    let verdict = "Wait / watch";
    let className = "ask-verdict-watch";
    let summary = "The model does not see enough evidence for an urgent sell, but it also does not have enough strength for a high-conviction hold.";

    if (sellSignal) {
      verdict = sellSignal.label;
      className = "ask-verdict-sell";
      summary = `${sellSignal.reason} ${sellSignal.detail || ""}`.trim();
    } else if (holdSignal) {
      verdict = holdSignal.label;
      className = "ask-verdict-hold";
      summary = `${holdSignal.reason} ${holdSignal.detail || ""}`.trim();
    }

    return {
      ticker: item.ticker,
      question: parsed.question,
      company: parsed.company,
      verdict,
      className,
      summary,
      score: item.score,
      stats: [
        ["Signal", item.setup?.signal || item.label],
        ["Confidence", `${item.setup?.confidence || item.score}/100`],
        ["Timeframe", item.setup?.timeframe || "1-4 weeks"],
        ["Price", formatNumber(item.latest)],
        ["1M", formatPercent(item.oneMonth)],
        ["3M", formatPercent(item.threeMonth)],
        ["6M", formatPercent(item.sixMonth)],
        ["Entry", item.setup?.entryZone || "-"],
        ["Invalidation", item.setup ? formatNumber(item.setup.invalidation) : "-"],
        ["RSI", Number.isFinite(item.rsi14) ? item.rsi14.toFixed(0) : "-"],
        ["ATR", formatPercent(item.atrPercent)],
        ["Drawdown", formatPercent(item.drawdown)],
        ["Vol", formatPercent(item.volatility)],
        ["Event risk", item.eventRisk?.level || "Low"],
        ["Headline tone", formatSignal(item.headlineScore)],
        ["Outlook tone", formatSignal(item.outlookScore)]
      ],
      reasons: buildQuestionReasons(item, activeSources, news.outlookCount || 0),
      links,
      activeSources,
      headlines: news.items.length,
      outlooks: news.outlookCount || 0
    };
  }

  function renderQuestionAnswer(answer) {
    els.askAnswer.innerHTML = `
      <article class="ask-result ${answer.className}">
        <div class="ask-result-head">
          <div>
            <span>Model answer for ${escapeHtml(answer.company || answer.ticker)}</span>
            <h3>${escapeHtml(answer.verdict)}</h3>
          </div>
          <strong>${answer.score}/100</strong>
        </div>
        <p>${escapeHtml(answer.summary)}</p>
        <div class="stock-stats">
          ${answer.stats.map(([label, value]) => `<span>${escapeHtml(label)} ${escapeHtml(value)}</span>`).join("")}
        </div>
        <ul>${answer.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
        <div class="ask-source-line">${answer.activeSources} active trusted sources, ${answer.headlines} relevant headlines, ${answer.outlooks} outlook items in this focused scan.</div>
        ${answer.links.length ? `
          <div class="ask-links">
            ${answer.links.map((item) => `<a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(item.source)}: ${escapeHtml(item.title)}</a>`).join("")}
          </div>
        ` : `<span class="muted-line">No article links matched this ticker directly; answer relies more on price action and broad market context.</span>`}
      </article>
    `;
  }

  function buildQuestionReasons(item, activeSources, outlookCount) {
    return [
      `Deep scan checked ${activeSources} active trusted sources from the ${trustedSourceUniverse.length}-source universe.`,
      `The focused scan found ${item.headlineSourceCount} direct headline sources and ${item.outlookSourceCount} trusted outlook sources for ${item.ticker}.`,
      `Trend check: ${item.latest > item.sma200 ? "above" : "below"} the 200-day average and ${item.latest > item.sma50 ? "above" : "below"} the 50-day average.`,
      `Recent market context included ${outlookCount} strategist/outlook items across the scan.`,
      item.flags[0] || item.reasons[0] || "No single dominant risk flag was detected."
    ].filter(Boolean);
  }

  function buildModelAllocation(results, marketContext) {
    const candidates = results.filter((item) => item.score >= 58);
    const funds = candidates.filter((item) => item.isFund).slice(0, 2);
    const stocks = candidates.filter((item) => !item.isFund).slice(0, 4);
    const averageScore = average(results.map((item) => item.score));
    const forecastScore = marketContext?.score ?? 50;
    const marketCash = averageScore >= 78 ? 8 : averageScore >= 68 ? 12 : averageScore >= 58 ? 22 : 40;
    const forecastCash = forecastScore >= 68 ? -6 : forecastScore >= 56 ? -2 : forecastScore < 34 ? 18 : forecastScore < 45 ? 10 : 0;
    let cash = clamp(marketCash + forecastCash, 5, 65);
    const profile = { fund: 0.62, maxStock: 16 };
    const investable = 100 - cash;
    const fundBudget = investable * profile.fund;
    const stockBudget = investable - fundBudget;
    const actions = [];

    if (funds.length) {
      const totalFundScore = funds.reduce((sum, item) => sum + item.score, 0);
      funds.forEach((item) => actions.push(modelAction(item, (fundBudget * item.score) / totalFundScore)));
    } else {
      cash += fundBudget;
    }

    if (stocks.length) {
      const totalStockScore = stocks.reduce((sum, item) => sum + item.score, 0);
      stocks.forEach((item) => actions.push(modelAction(item, Math.min(profile.maxStock, (stockBudget * item.score) / totalStockScore))));
    } else {
      cash += stockBudget;
    }

    const allocated = actions.reduce((sum, action) => sum + action.percent, 0);
    actions.push({
      kind: "cash",
      ticker: "Cash",
      percent: roundPercent(clamp(100 - allocated, 0, 100)),
      label: "Hold back",
      reason: marketContext
        ? `Reserve adjusted for market forecast: ${marketContext.label} (${marketContext.confidence}% confidence).`
        : "Reserve for volatility, bad fills, and better entries if the deep scans weaken."
    });

    const avoid = [...results].reverse().find((item) => item.score < 55 || item.flags.some((flag) => flag.includes("Below 200-day") || flag.includes("High volatility"))) || results.at(-1);
    return {
      actions: normalizeActions(actions),
      avoid: {
        ticker: avoid?.ticker || "-",
        text: avoid ? `${avoid.label} (${avoid.score}/100). ${avoid.flags[0] || "The model sees stronger alternatives today."}` : "No avoid candidate found."
      }
    };
  }

  function modelAction(item, percent) {
    const outlook = item.outlooks[0];
    const headline = item.headlines[0];
    return {
      kind: "invest",
      ticker: item.ticker,
      percent: roundPercent(percent),
      label: item.label,
      signal: item.setup?.signal || item.label,
      setup: item.setup,
      reason: outlook
        ? `${item.label}. Trusted outlook: ${outlook.source}: ${outlook.title}`
        : headline ? `${item.label}. ${headline.source}: ${headline.title}` : `${item.label}. ${item.reasons[0] || "Score is stronger than watchlist average."}`
    };
  }

  function normalizeActions(actions) {
    const live = actions.filter((action) => action.percent > 0);
    const diff = roundPercent(100 - live.reduce((sum, action) => sum + action.percent, 0));
    const cash = live.find((action) => action.kind === "cash");
    if (cash) cash.percent = roundPercent(cash.percent + diff);
    return live.filter((action) => action.percent > 0);
  }

  function renderAction(action) {
    const verb = action.kind === "cash" ? "Reserve" : "Signal";
    return `
      <article class="instruction-row ${action.kind === "cash" ? "cash-row" : ""}">
        <div><span>${escapeHtml(verb)}</span><h3>${escapeHtml(action.ticker)}</h3></div>
        <strong>${action.percent.toFixed(1)}%</strong>
        <p>
          ${action.kind === "cash" ? "" : `<b class="signal-pill">${escapeHtml(action.signal)}</b> `}
          ${escapeHtml(action.reason)}
          ${action.setup ? ` Entry zone ${escapeHtml(action.setup.entryZone)}, invalidated below ${escapeHtml(formatNumber(action.setup.invalidation))}, risk ${escapeHtml(action.setup.riskLevel)}.` : ""}
        </p>
      </article>
    `;
  }

  function renderCategoryBars(categories = {}) {
    const rows = [
      ["Trend", categories.trend],
      ["Momentum", categories.momentum],
      ["Technical", categories.technical],
      ["News", categories.news],
      ["Recent year", categories.recentYear],
      ["Liquidity", categories.liquidity],
      ["Risk control", categories.risk]
    ].filter(([, value]) => Number.isFinite(value));
    return `
      <div class="score-breakdown">
        ${rows.map(([label, value]) => `
          <div>
            <span>${escapeHtml(label)}</span>
            <strong>${Math.round(value)}</strong>
            <i style="width: ${clamp(value, 0, 100)}%"></i>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderEvidence(results, allocation) {
    const tickers = allocation.actions.filter((action) => action.kind === "invest").map((action) => action.ticker);
    const selected = results.filter((item) => tickers.includes(item.ticker)).slice(0, 6);
    els.researchEvidence.innerHTML = selected.map((item) => `
      <article class="evidence-card">
        <div class="evidence-head">
          <h3>${escapeHtml(item.ticker)}</h3>
          <span>${item.score}/100</span>
        </div>
        <div class="stock-stats">
          <span>${escapeHtml(item.setup?.signal || item.label)}</span>
          <span>1W ${formatPercent(item.oneWeek)}</span>
          <span>1M ${formatPercent(item.oneMonth)}</span>
          <span>3M ${formatPercent(item.threeMonth)}</span>
          <span>RSI ${Number.isFinite(item.rsi14) ? item.rsi14.toFixed(0) : "-"}</span>
          <span>MACD ${item.macd?.histogram >= 0 ? "positive" : "negative"}</span>
          <span>Vol ${formatPercent(item.volatility)}</span>
          <span>ATR ${formatPercent(item.atrPercent)}</span>
          <span>Drawdown ${formatPercent(item.drawdown)}</span>
          <span>Volume ${formatPercent(item.volumePressure)}</span>
          <span>Outlook ${item.outlookSourceCount || 0}</span>
        </div>
        <div class="setup-line">
          <span>Entry ${escapeHtml(item.setup?.entryZone || "-")}</span>
          <span>Invalidation ${escapeHtml(item.setup ? formatNumber(item.setup.invalidation) : "-")}</span>
          <span>Support ${escapeHtml(formatNumber(item.support))}</span>
          <span>Resistance ${escapeHtml(formatNumber(item.resistance))}</span>
        </div>
        ${renderCategoryBars(item.categories)}
        <ul>${item.reasons.slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
        ${item.outlooks[0] ? `<a href="${escapeHtml(item.outlooks[0].link)}" target="_blank" rel="noreferrer">Outlook: ${escapeHtml(item.outlooks[0].source)}: ${escapeHtml(item.outlooks[0].title)}</a>` : ""}
        ${item.headlines[0] ? `<a href="${escapeHtml(item.headlines[0].link)}" target="_blank" rel="noreferrer">${escapeHtml(item.headlines[0].source)}: ${escapeHtml(item.headlines[0].title)}</a>` : `<span class="muted-line">No current ticker headline found.</span>`}
      </article>
    `).join("");
  }

  function renderMarketFramework(results, marketContext, news) {
    const averageScore = Math.round(average(results.map((item) => item.score)));
    const yearOutlookItems = news.items.filter((item) => item.horizon === "recent-year");
    const yearSourceCount = unique(yearOutlookItems.map((item) => item.sourceId)).length;
    const yearTone = yearOutlookItems.length ? average(yearOutlookItems.map((item) => item.sentiment)) : 0;
    const above200 = results.filter((item) => item.latest > item.sma200).length;
    const above50 = results.filter((item) => item.latest > item.sma50).length;
    const positiveSixMonth = results.filter((item) => item.sixMonth > 0).length;
    const highRisk = results.filter((item) => item.volatility > 0.45 || item.drawdown < -0.18).length;
    const breadth = results.length ? Math.round((above200 / results.length) * 100) : 0;
    const nearTermBreadth = results.length ? Math.round((above50 / results.length) * 100) : 0;
    const momentumBreadth = results.length ? Math.round((positiveSixMonth / results.length) * 100) : 0;

    els.marketFramework.innerHTML = `
      <article class="framework-card">
        <span>Recent-year research</span>
        <strong>${yearSourceCount} sources</strong>
        <p>${yearOutlookItems.length ? `${yearOutlookItems.length} recent-year outlook items found. Tone is ${formatSignal(yearTone)}.` : "No recent-year outlook items matched the current watchlist in this scan."}</p>
      </article>
      <article class="framework-card">
        <span>Trend and momentum</span>
        <strong>${breadth}% above 200D</strong>
        <p>${nearTermBreadth}% are above the 50-day average and ${momentumBreadth}% have positive six-month momentum.</p>
      </article>
      <article class="framework-card">
        <span>Risk discipline</span>
        <strong>${highRisk} high-risk setups</strong>
        <p>The model penalizes high volatility, large drawdowns, weak 200-day trend, and negative six-month momentum.</p>
      </article>
      <article class="framework-card">
        <span>Market regime</span>
        <strong>${escapeHtml(marketContext.label)}</strong>
        <p>Allocation cash is adjusted using equity breadth, VIX, credit appetite, rate pressure, dollar, oil, and gold signals.</p>
      </article>
      <article class="framework-card framework-wide">
        <span>How stock-market knowledge is applied</span>
        <strong>${averageScore}/100 average score</strong>
        <p>The model favors diversified exposure first, then individual stocks only when trend, momentum, volatility, drawdown, volume pressure, source breadth, current headlines, and recent-year research agree. It reduces exposure when market regime, credit, volatility, or long-term trend contradict the buy case.</p>
      </article>
      <article class="framework-card framework-wide">
        <span>Known data gaps</span>
        <strong>Not yet connected</strong>
        <p>Bid-ask spread, stock fundamentals, earnings calendar, analyst revisions, options flow, and social hype need reliable dedicated APIs before they can be scored honestly.</p>
      </article>
    `;
  }

  function renderSourceStatus(sources, configured) {
    const visibleSources = sources.filter((source) => source.ok);
    const indexSource = visibleSources.find((source) => source.id === "live-source-index");
    const trustedSources = visibleSources.filter((source) => source.id !== "live-source-index");
    els.sourceStatus.innerHTML = `
      <article class="source-card source-summary">
        <strong>${trustedSources.length}/${configured} trusted sources active</strong>
        <span>${escapeHtml(indexSource?.meta || "The app checked the live source index and direct RSS feeds.")}</span>
      </article>
      ${trustedSources.slice(0, 80).map((source) => `
      <article class="source-card ${source.ok ? "source-ok" : "source-fail"} ${source.ok && source.count === 0 ? "source-empty" : ""}">
        <strong>${escapeHtml(source.name)}</strong>
        <span>${source.ok ? source.count ? `${source.count} relevant headlines via ${source.via}` : `Loaded via ${source.via}; no relevant watchlist headlines` : source.error || "Unavailable"}</span>
      </article>
      `).join("")}
      ${trustedSources.length > 80 ? `<article class="source-card source-empty"><strong>More sources</strong><span>${trustedSources.length - 80} additional active sources were included in the score.</span></article>` : ""}
    `;
  }

  function renderRanking(results) {
    els.analysisResults.innerHTML = results.map((item, index) => `
      <article class="stock-row ${item.score >= 75 ? "grade-good" : item.score >= 60 ? "grade-watch" : item.score >= 45 ? "grade-mixed" : "grade-avoid"}">
        <div class="rank">${index + 1}</div>
        <div>
          <div class="stock-title"><h3><a href="#detail" data-detail-ticker="${escapeHtml(item.ticker)}">${escapeHtml(item.ticker)}</a></h3><span>${item.score}/100</span></div>
          <strong>${escapeHtml(item.setup?.signal || item.label)}</strong>
          <div class="stock-stats">
            <span>Price ${formatNumber(item.latest)}</span>
            <span>1M ${formatPercent(item.oneMonth)}</span>
            <span>6M ${formatPercent(item.sixMonth)}</span>
            <span>RSI ${Number.isFinite(item.rsi14) ? item.rsi14.toFixed(0) : "-"}</span>
            <span>ATR ${formatPercent(item.atrPercent)}</span>
            <span>Risk ${escapeHtml(item.setup?.riskLevel || "-")}</span>
            <span>Delta ${item.scoreDelta >= 0 ? "+" : ""}${item.scoreDelta}</span>
          </div>
          ${renderCategoryBars(item.categories)}
          <div class="setup-line">
            <span>Entry ${escapeHtml(item.setup?.entryZone || "-")}</span>
            <span>Invalidation ${escapeHtml(item.setup ? formatNumber(item.setup.invalidation) : "-")}</span>
          </div>
        </div>
        <p>${escapeHtml(item.flags[0] || item.reasons[0] || "No major note.")}</p>
      </article>
    `).join("");
  }

  function saveLearningSnapshot(results, priceSource, newsSource) {
    state.learningHistory = [
      ...state.learningHistory,
      {
        at: new Date().toISOString(),
        priceSource,
        newsSource,
        scores: results.map((item) => ({ ticker: item.ticker, score: item.score, latest: item.latest }))
      }
    ].slice(-96);
    persist();
  }

  function latestLearningPoint(ticker) {
    for (let i = state.learningHistory.length - 1; i >= 0; i -= 1) {
      const match = state.learningHistory[i].scores?.find((entry) => entry.ticker === ticker);
      if (match) return match;
    }
    return null;
  }

  function buildReasons(data) {
    const reasons = [];
    if (data.latest > data.sma200) reasons.push("Above 200-day average: long-term trend is positive.");
    if (data.latest > data.sma50) reasons.push("Above 50-day average: near-term trend is positive.");
    if (data.sma50Slope > 0) reasons.push(`50-day average is rising (${formatPercent(data.sma50Slope)} vs prior 50-day average).`);
    if (data.sixMonth > 0) reasons.push(`Six-month momentum is ${formatPercent(data.sixMonth)}.`);
    if (Number.isFinite(data.rsi14) && data.rsi14 >= 45 && data.rsi14 <= 70) reasons.push(`RSI ${data.rsi14.toFixed(0)} is constructive without being extremely overbought.`);
    if (data.macd?.histogram > 0) reasons.push("MACD momentum is positive.");
    if (data.volumePressure > 0.08) reasons.push(`Recent volume is ${formatPercent(data.volumePressure)} above its 60-day baseline.`);
    if (data.averageDollarVolume > 5000000) reasons.push(`Liquidity screen passed with about ${compactMoney(data.averageDollarVolume)} average daily dollar volume.`);
    if (data.headlineScore > 0.1) reasons.push("Current headline tone is positive.");
    if (data.headlineSourceCount >= 3) reasons.push(`${data.headlineSourceCount} independent sources mention this ticker or its market context.`);
    if (data.outlookSourceCount >= 2 && data.outlookScore > 0.05) reasons.push(`${data.outlookSourceCount} trusted outlook sources are constructive on this exposure or its market theme.`);
    if (data.outlookSourceCount >= 2 && data.outlookScore < -0.05) reasons.push(`${data.outlookSourceCount} trusted outlook sources are cautious on this exposure or its market theme.`);
    if (data.yearOutlookSourceCount >= 2 && data.yearOutlookScore > 0.05) reasons.push(`${data.yearOutlookSourceCount} recent-year research sources support this stock or sector theme.`);
    if (data.yearOutlookSourceCount >= 2 && data.yearOutlookScore < -0.05) reasons.push(`${data.yearOutlookSourceCount} recent-year research sources are cautious on this stock or sector theme.`);
    if (data.eventRisk?.level === "Low") reasons.push("No major event-risk blocker was detected in matched headlines.");
    if (data.isFund) reasons.push("Broad ETF exposure reduces single-company risk.");
    if (!reasons.length) reasons.push("No strong positive signal stands out today.");
    return reasons;
  }

  function buildFlags(data) {
    const flags = [];
    if (data.latest < data.sma200) flags.push("Below 200-day average: long-term trend may be weak.");
    if (data.sixMonth < 0) flags.push(`Negative six-month momentum at ${formatPercent(data.sixMonth)}.`);
    if (data.volatility > 0.45) flags.push(`High volatility at ${formatPercent(data.volatility)} annualized.`);
    if (data.atrPercent > 0.05) flags.push(`ATR risk is high at ${formatPercent(data.atrPercent)} of price.`);
    if (data.averageDollarVolume < 5000000 && !data.isFund) flags.push(`Liquidity warning: only about ${compactMoney(data.averageDollarVolume)} average daily dollar volume.`);
    if (data.eventRisk?.level !== "Low") flags.push(`${data.eventRisk.level} event risk detected${data.eventRisk.hits.length ? `: ${data.eventRisk.hits.join(", ")}` : ""}.`);
    if (data.drawdown < -0.18) flags.push(`Still ${formatPercent(data.drawdown)} below its recent high.`);
    if (!data.isFund) flags.push("Single-stock exposure adds company-specific risk.");
    if (!flags.length) flags.push("No major risk flag, but all market investments can lose money.");
    return flags;
  }

  function scoreLabel(score) {
    if (score >= 75) return "Strong buy-model candidate";
    if (score >= 60) return "Buy-model candidate";
    if (score >= 45) return "Watch only";
    return "Avoid today";
  }

  function headlineSentiment(text) {
    const lower = text.toLowerCase();
    const positive = positiveNewsWords.filter((word) => lower.includes(word)).length;
    const negative = negativeNewsWords.filter((word) => lower.includes(word)).length;
    return clamp((positive - negative) / 3, -1, 1);
  }

  function outlookSentiment(text) {
    const lower = text.toLowerCase();
    const positive = positiveOutlookWords.filter((word) => lower.includes(word)).length;
    const negative = negativeOutlookWords.filter((word) => lower.includes(word)).length;
    return clamp((positive - negative) / 3, -1, 1);
  }

  function cleanText(value) {
    const doc = new DOMParser().parseFromString(String(value || ""), "text/html");
    return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
  }

  function sampleSeries(ticker) {
    const days = 252;
    const seed = ticker.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const drift = broadFunds.has(ticker) ? 0.00034 : ((seed % 9) - 2) / 10000;
    const vol = broadFunds.has(ticker) ? 0.010 : 0.014 + (seed % 7) / 1000;
    let price = 50 + (seed % 180);
    const prices = [];
    const today = new Date();

    for (let i = days; i >= 0; i -= 1) {
      price = Math.max(5, price * (1 + drift + Math.sin((days - i + seed) / 13) * vol + Math.sin((days - i + seed) / 37) * vol * 0.7));
      const range = price * vol * 1.8;
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      prices.push({ date, close: price, high: price + range, low: Math.max(1, price - range), volume: 1000000 + seed * 1000 });
    }

    return { ticker, prices, source: "sample" };
  }

  function parsePortfolioPositions(value) {
    return String(value || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/[|,\t]+/).map((part) => part.trim()).filter(Boolean);
        const ticker = String(parts[0] || "")
          .toUpperCase()
          .replace(/[^A-Z0-9.^-]/g, "");
        const label = parts[1] && !/^\d/.test(parts[1]) ? parts[1] : ticker;
        const amountPart = parts.find((part, index) => index > 0 && /[\d]/.test(part) && Number.isFinite(parseMoneyNumber(part)));
        const amount = parseMoneyNumber(amountPart);
        const statusText = parts.join(" ").toLowerCase();
        const status = /\b(up|profit|green|positive)\b/.test(statusText)
          ? "up"
          : /\b(down|loss|red|negative)\b/.test(statusText)
            ? "down"
            : "unknown";
        return ticker && amount > 0 ? { ticker, label, amount, status } : null;
      })
      .filter(Boolean);
  }

  function parseMoneyNumber(value) {
    const cleaned = String(value || "").replace(/[^0-9.,-]/g, "").replace(",", ".");
    const number = Number(cleaned);
    return Number.isFinite(number) ? number : 0;
  }

  function parseTickers(value) {
    return unique(String(value || "")
      .split(/[\s,;]+/)
      .map((ticker) => ticker.trim().toUpperCase().replace(/[^A-Z0-9.^-]/g, ""))
      .filter(Boolean))
      .slice(0, 90);
  }

  function parseDetailTicker(value) {
    const parsed = parseQuestionTarget(value);
    const fallbackTicker = parseTickers(value)[0] || "";
    const ticker = String(parsed.ticker || fallbackTicker).toUpperCase();
    return { ticker, company: parsed.company || ticker };
  }

  function isBlockedAssetTicker(ticker) {
    const normalized = String(ticker || "").trim().toUpperCase();
    return blockedAssetSet.has(normalized) || blockedTickerShortcuts.has(normalized) || normalized.endsWith("-USD");
  }

  function parseQuestionTarget(question) {
    const raw = String(question || "").trim();
    const normalized = raw.toLowerCase()
      .replace(/[^a-z0-9.^\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const tickerStopWords = new Set(["I", "ME", "MY", "A", "AN", "THE", "DO", "IS", "IT", "TO", "SHOULD", "SELL", "BUY", "HOLD", "TODAY", "NOW"]);
    const directTicker = Array.from(raw.matchAll(/\b[A-Z]{1,5}\b/g))
      .map((match) => match[0])
      .find((token) => !tickerStopWords.has(token));
    if (directTicker) {
      return { ticker: directTicker, question: raw, company: directTicker };
    }

    const alias = Object.keys(companyAliases)
      .sort((a, b) => b.length - a.length)
      .find((name) => normalized.includes(name));
    if (alias) return { ticker: companyAliases[alias], question: raw, company: titleCase(alias.replace(/\s+stock$/, "")) };

    const cleaned = normalized
      .replace(/\b(should|i|me|my|sell|buy|hold|stock|srock|share|shares|today|right|now|the|a|an|is|it|to|do)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const maybeTicker = cleaned.toUpperCase().replace(/[^A-Z0-9.^-]/g, "");
    if (maybeTicker && maybeTicker.length <= 5) return { ticker: maybeTicker, question: raw, company: maybeTicker };

    return { ticker: "", question: raw, company: "" };
  }

  function returnOver(values, days) {
    if (values.length <= days) return values[0] ? values.at(-1) / values[0] - 1 : 0;
    const start = values[values.length - 1 - days];
    return start ? values.at(-1) / start - 1 : 0;
  }

  function dailyReturns(values) {
    const returns = [];
    for (let i = 1; i < values.length; i += 1) {
      if (values[i - 1]) returns.push(values[i] / values[i - 1] - 1);
    }
    return returns;
  }

  function relativeStrengthIndex(values, period = 14) {
    if (values.length <= period) return 50;
    const changes = [];
    for (let i = values.length - period; i < values.length; i += 1) {
      changes.push(values[i] - values[i - 1]);
    }
    const gains = changes.map((change) => Math.max(change, 0));
    const losses = changes.map((change) => Math.abs(Math.min(change, 0)));
    const avgLoss = average(losses);
    if (!avgLoss) return 100;
    const rs = average(gains) / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  function ema(values, period) {
    if (!values.length) return [];
    const multiplier = 2 / (period + 1);
    const output = [values[0]];
    for (let i = 1; i < values.length; i += 1) {
      output.push(values[i] * multiplier + output[i - 1] * (1 - multiplier));
    }
    return output;
  }

  function macdSignal(values) {
    if (values.length < 35) return { macd: 0, signal: 0, histogram: 0 };
    const ema12 = ema(values, 12);
    const ema26 = ema(values, 26);
    const macdLine = values.map((_, index) => ema12[index] - ema26[index]);
    const signalLine = ema(macdLine, 9);
    const macd = macdLine.at(-1) || 0;
    const signal = signalLine.at(-1) || 0;
    return { macd, signal, histogram: macd - signal };
  }

  function bollingerBands(values, period = 20) {
    const slice = values.slice(-period);
    const middle = average(slice);
    const deviation = stdev(slice);
    const upper = middle + deviation * 2;
    const lower = middle - deviation * 2;
    const latest = values.at(-1);
    return {
      upper,
      middle,
      lower,
      position: upper === lower ? 0.5 : (latest - lower) / (upper - lower)
    };
  }

  function averageTrueRange(prices, period = 14) {
    if (prices.length < 2) return 0;
    const ranges = [];
    for (let i = Math.max(1, prices.length - period); i < prices.length; i += 1) {
      const high = Number.isFinite(prices[i].high) ? prices[i].high : prices[i].close;
      const low = Number.isFinite(prices[i].low) ? prices[i].low : prices[i].close;
      const previousClose = prices[i - 1].close;
      ranges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
    }
    return average(ranges);
  }

  function average(values) {
    const clean = values.filter((value) => Number.isFinite(value));
    return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
  }

  function stdev(values) {
    const mean = average(values);
    return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
  }

  function money(value) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: state.currency || "EUR",
      maximumFractionDigits: 0
    }).format(value);
  }

  function formatPercent(value) {
    return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value);
  }

  function compactMoney(value) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1
    }).format(value || 0);
  }

  function formatSignal(value) {
    if (value > 0.1) return "positive";
    if (value < -0.1) return "negative";
    return "mixed";
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) return `${seconds}s`;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  function roundPercent(value) {
    return Math.round(value * 10) / 10;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function unique(values) {
    return Array.from(new Set(values));
  }

  function setStatus(text) {
    els.dataStatus.textContent = text;
  }

  function titleCase(value) {
    return String(value || "").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    window.setTimeout(() => els.toast.classList.remove("show"), 1800);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[char]);
  }
})();
