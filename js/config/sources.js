// Trusted news domains and feed configuration.

import { normalizeDomain, slugify } from "../shared/text.js";

export const sourceFeeds = [
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

export const trustedSourceUniverse = `
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

export const trustedDomainMap = new Map(trustedSourceUniverse.map((source) => [source.domain, source]));
