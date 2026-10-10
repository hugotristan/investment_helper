# Investing tool

A personal stock research app hosted on GitHub Pages, with a watchlist, a manual portfolio ledger, and dated research picks saved in your browser.

## Run It

Open the [live app on GitHub Pages](https://hugotristan.github.io/investment_helper/) in your browser. No installation is required.

To run a local copy, serve the project directory over HTTP, then open the local URL. For example, if Python is installed, run `python -m http.server 8000 --bind 127.0.0.1` from this directory and open [http://127.0.0.1:8000](http://127.0.0.1:8000). The app uses native JavaScript modules, so opening `index.html` directly as a file is not supported. No build step or package installation is required.

## Code Structure

`app.js` initializes the app, connects feature controls, and manages navigation and scan timing. Feature code and data processing live in native JavaScript modules:

| Location | Responsibility |
| --- | --- |
| `js/config/` | Scan settings, the default watchlist, trusted sources, and feeds |
| `js/data/` | Published price snapshots, HTTP requests, ticker validation, Yahoo price/quote loading, and news scans/caching |
| `js/analysis/` | Technical scoring, headline/outlook interpretation, market forecasts, signals, and allocation |
| `js/features/` | Watchlist, portfolio, screener, stock detail, questions, and signal views |
| `js/ui/` | DOM references, reusable view components, and dashboard/research/source rendering |
| `js/shared/` | Math, formatting, text, and symbol helpers |
| `js/storage.js` | Browser-local settings and scan history |
| `js/scan-state.js` | Latest scan results shared by the dashboard and screener |
| `js/portfolio-state.js` | Committed portfolio ledger and its projected holdings |

The same GitHub Pages workflow serves these modules directly. Saved browser settings continue to use the existing storage key.

Run the module regression tests with `npm test` using Node.js 18 or newer. They use Node's built-in test runner and require no installed packages.

See [the feature change log](docs/FEATURES.md) for the behavior, implementation, and validation of each feature commit.

## What It Does

- Runs immediately when the page opens.
- Suggests stock/ETF tickers and company names from the first typed letter in portfolio forms, stock detail, the header search, and watchlist additions. The bundled Nasdaq directory covers over 11,000 US-listed stocks and ETFs, including international companies listed in the US; configured international tickers remain available. Select with mouse/touch or arrow keys plus Enter. Exact unique company names also resolve when submitted, while ambiguous names require selecting a suggestion. Other symbols can still be typed and verified when saved. Recent official listings validate independently of the 200 daily bars required for a market signal.
- Opens to an index-performance chart, a graph of six saved watchlist tickers' one-day moves, and up to three stocks to review. Prices, dates, and concrete reasons remain available; supporting evidence and risks are expandable.
- Uses a soft grey canvas, slightly lighter square panels, a fixed desktop sidebar, and compact navigation icons. The four main pages are Overview, Watchlist, Portfolio, and Performance. Additional research tools and source diagnostics are under More.
- Compares SPY and QQQ percentage changes from the same displayed daily-close baseline over one month, three months, or one year. Missing or unqualified history has an explicit unavailable state.
- Provides one-month, three-month, and one-year charts under Market & research, plus a closing-price chart on stock details. The header ticker search opens a fresh stock detail scan.
- Market chart hover, touch, and keyboard controls reveal dates, closing prices, and relative changes. Technical checks, scoring inputs, and longer explanations are expandable.
- Reopens the last qualified browser-local scan immediately with its original timestamp. Fresh prices render before the longer background news scan completes, with a clear preliminary status. Invalid, stale, oversized, and sample caches are rejected.
- Refreshes automatically on a slower cadence, and lets slow source scans run longer when needed so each output is a fuller consolidated review.
- Loads real Yahoo Finance daily histories and dated quotes from a price snapshot served by this GitHub Pages site. GitHub Actions fetches the data before deployment, avoiding Yahoo browser CORS and public-relay dependencies for covered symbols.
- Refreshes the published prices every weekday at 7 and 37 minutes past each hour from 13:00 through 22:00 UTC, daily at 06:30 UTC, and on push or manual deployment. These are scheduled snapshots rather than tick-by-tick quotes; each observed price keeps its original provider timestamp.
- Starts with a broad cross-sector opportunity universe across index ETFs, sector ETFs, mega caps, semiconductors, software, internet, financials, energy, healthcare, consumer, industrials, defense, and materials.
- Shows saved watchlist tickers as compact price and signal rows. Edit watchlist opens removable tickers, an add-tickers field, and a text editor for bulk changes.
- Checks new watchlist symbols against dated published metadata, then attempts a Yahoo lookup for uncovered symbols, accepting only stocks and ETFs. Bulk edits use Save tickers and the same validation. Unknown symbols, unsupported instruments, and temporary lookup failures leave the saved watchlist unchanged.
- Filters and sorts your saved watchlist by signal type, minimum score, liquidity, momentum, risk control, and volume pressure. Filters are collapsed initially; new browser settings show all signals with no minimum score or liquidity threshold.
- Adds a stock detail page that runs a fresh single-ticker quote, chart, technical, news, outlook, and market-context scan.
- Pulls and analyzes a 260-source trusted stock-market universe for current headlines and macro context when available.
- Scores trend, momentum, RSI, MACD, Bollinger position, ATR, volatility, drawdown, volume pressure, liquidity, event risk, cross-source headline tone, trusted market outlook tone, source breadth, diversification, and local score changes.
- Adds recent-year stock, sector, institutional, and macro-regime outlook scans to avoid relying only on today's headlines.
- Shows the rules-based market framework used for trend, momentum, risk, diversification, market regime, recent-year research, and known data gaps.
- Shows category scores, signal strength, timeframe, entry zone, invalidation level, support/resistance, and risk level. Scores are rules-based measures, not calibrated success probabilities.
- Requires recent real history with at least 200 distinct daily prices before generating investment signals. Sample, stale, future-dated, and incomplete histories are excluded; a quote cannot make invalid history usable.
- Highlights up to three individual stock opportunities with recent direct company evidence, explicit reasons and risks, dates, and detail/watchlist actions. Discovery scans the configured universe independently of the saved watchlist and can return no qualifying opportunity.
- Shows annual company fundamentals from SEC XBRL snapshots, with Yahoo Finance annual statements as a fallback: revenue, net income, operating/free cash flow, supported debt, growth, and annual diluted EPS valuation. Each metric names its source and reporting period. SEC data includes filing links; Yahoo data uses provider reporting dates and does not invent filing dates. Missing facts stay unavailable. Financial snapshots refresh daily and on push or manual deployment.
- Produces a rules-based market-regime score using qualified equity breadth, VIX, credit appetite, bond/rate pressure, dollar pressure, oil, and gold histories.
- Outputs model allocations by ticker and percentage.
- Provides a Stock check tool for focused questions such as "Should I sell Microsoft?", using the same fixed price and news rules as stock details.
- Shows sell/reduce and do-not-sell/hold signals for the current watchlist.
- Saves structured holdings with shares, average purchase price, and currency. Calculates current value and unrealized gain from qualified matching-currency prices, with separate totals for each currency.
- Shows a "do not buy today" ticker from the weakest setup.
- Stores recent scan history locally in the browser.
- Tracks dated research picks against SPY after five and 21 later matching market sessions. Original evidence and observed baseline prices are preserved; pending results remain pending. The Performance page exports the browser-local journal.

## Important

The app does not place trades or guarantee returns. It shows the model's calculated output from public web data and local score history.

## Source Set

The app checks a 260-source trusted stock-market universe through GDELT live news JSON and supplements it with direct RSS feeds where available. This is more reliable than relying on hundreds of separate publisher RSS endpoints from a static browser page. The universe includes major market media, exchange/index providers, broker/research institutions, central banks, statistical agencies, regulators, labor and commerce data agencies, energy agencies, sector-specific outlets, and selected macro research sources. Each scan displays which trusted sources were active in the current live article set and how many relevant headlines were used.

Slow web sources now get extended retries before being marked unavailable. GDELT scans try direct JSON first, then a relay fallback, with longer timeouts and repeated attempts. RSS feeds try direct RSS first, then the relay, also with repeated attempts. If a scan gets no usable headlines after retries, the app labels the fallback and reuses the last successful headline set while continuing to refresh price data.

If a refresh gets a much thinner source batch than the previous successful scan, the app merges the current and previous headline set. Local scan history records score changes without smoothing the current score, so identical current inputs produce the same score in every browser. Company-specific article matches are distinguished from sector and market commentary.

Each news scan now targets at least 60 active trusted sources, which is still above the original 30-source reliability goal without forcing the browser to wait through every slow RSS endpoint. If the first live pass is too thin, the app widens to broader 48-hour and 7-day GDELT scans for markets, earnings, macro, sectors, ETFs, rates, credit, official macro releases, regulators, energy data, technology, healthcare, financials, industrials, defense, consumer, materials, and event risk. The deep-source scan has a hard time budget of about five minutes because it prioritizes one solid review without turning one refresh into a 20-minute wait.

The app also searches recent-year outlook material from trusted institutions and market sources. These scans look for annual outlooks, 12-month views, sector outlooks, earnings outlooks, stock-pick articles, capital-market assumptions, and macro-regime analysis. Motley Fool is included as a stock-idea/opinion source through both its RSS feed and dedicated GDELT outlook scans. Those items are scored as opinion evidence, not as official or guaranteed recommendations, and can only modestly lift or reduce a stock or sector score.

## Current Gaps

`node scripts/update-prices.mjs` refreshes `data/prices.json` with validated Yahoo histories and quotes for the configured scan symbols and market proxies. The deployment workflow restores and saves this file in its own Actions cache, independently of fundamentals. No database or API key is required. Price generation must succeed before new files are deployed; a failed run leaves the last deployed site in place. A cache restore or save problem does not replace the price validation step.

The browser reads the published price file from the site's own origin. Missing, stale, or unsupported data remains unavailable, with original observation dates preserved; deployment time is not presented as a quote time. Personal symbols outside the published universe may still need a browser provider lookup. GitHub's scheduled runs can be delayed, so the shown data timestamp is the source of truth for freshness. See [GitHub's schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

The app labels missing data explicitly. Fundamentals prefer SEC companyfacts and try Yahoo Finance annual statements when SEC access fails or usable annual facts are absent. Unsupported/custom tags, missing statements, or provider outages may leave metrics unavailable. Yahoo reports its own period-end dates without SEC filing provenance; its free cash flow must be explicitly reported. Annual P/E uses the last reported annual diluted EPS, not trailing twelve months. Fundamentals are displayed for research and do not alter technical signal strength. Bid-ask spreads, analyst revisions, options flow, and social hype still need reliable data feeds.

Upcoming earnings dates are a curated set of sourced issuer announcements in `data/earnings-calendar.json`, not a complete automated calendar. The October 2026 update covers ten companies, including Apple, Alphabet, NVIDIA, AMD, Tesla, Netflix, JPMorgan, TSMC, Johnson & Johnson, and Merck. Confirmed dates expire after the event; other companies link to a calendar for verification and show unavailable instead of an invented date. Extend the file with a future date, confirmation status, and the issuer announcement URL.

`node scripts/update-fundamentals.mjs` refreshes `data/fundamentals.json`. The GitHub Pages workflow runs it daily at 06:30 UTC and on push or manual deployment, restoring the prior financial snapshot from the Actions cache. The more frequent weekday price runs reuse that saved financial snapshot. A failed live ticker lookup can use the verified `data/sec-tickers.json` snapshot or saved issuer-mapping proofs for up to 30 days; successful financial requests do not extend that mapping's verification date. The bundled ticker index stays outside the Actions cache so an older cache cannot overwrite a newly verified mapping. Each provider is throttled, retries are bounded, and access-denied responses are not retried. Set the optional repository variable `SEC_USER_AGENT` to a descriptive user agent with contact information. When both providers fail, retained facts keep their original retrieval timestamps. SEC failures and successful Yahoo fallback refreshes are shown separately.

## Market Forecast

The market-regime score combines qualified SPY, QQQ, IWM, VTI, TLT, HYG, LQD, GLD, USO, UUP, and VIX histories. It is unavailable without sufficient real equity and credit coverage. The output includes a regime label, proxy coverage, evidence, and risk notes. It is not a calibrated forecast probability. The allocation engine uses an available regime to adjust the cash reserve.

## Candidate Universe

Sources can explain and score candidates, but they cannot recommend a stock the app never scans. The default watchlist now includes a much wider opportunity universe instead of only SPY, QQQ, AAPL, MSFT, NVDA, TSLA, JPM, XOM, and UNH. Changing the watchlist or portfolio holdings automatically schedules a fresh scan.

The personal portfolio starts empty. Under Start portfolio tracking, choose a reporting currency, date, and starting point. Keep saved holdings uses those positions as an opening snapshot. Enter past transactions starts with no opening positions, so you can record the purchases and sales that created your holdings. Past trades, opening cash, and historical performance are not invented. Amount-only legacy entries stay as entered until you supply their shares and average purchase price in Opening positions. Your original localStorage snapshot and source text are retained for recovery.

After setup, Record transaction saves purchases, sales, deposits, withdrawals, cash dividends, fees, and an opening cash balance. New symbols must pass stock/ETF validation. Transactions update share quantities and weighted average cost in the trade's original currency, including purchase fees. Cash uses one account in the selected reporting currency (EUR by default). Corrections or deletions cannot create a sale of more shares than were held on that date. Same-day entries use their recorded order; there is no short-selling or stock-split adjustment in this foundation. A complete negative cash balance warns that funding history may be incomplete. Opening positions remain editable, subject to the same sale checks.

For a USD purchase, select USD as Price currency, enter shares, execution price, and any USD fee, then enter Total EUR paid (including fees): the final euro debit shown by your broker. A EUR300 total deducts exactly EUR300; the USD fee is retained for the trade breakdown and native cost basis without being deducted again from cash. Sales use Net EUR received (after fees). Foreign dividends, fees, and other cash entries also require their actual EUR settlement. Same-currency trades calculate the total from shares, price, and fee when the cash field is blank; you can enter the broker's final total instead. No exchange rate is guessed or fetched. For example, EUR10,000 deposited minus a EUR5,000 purchase minus a USD2,000 purchase settled for EUR1,800 leaves EUR3,200 cash.

Older foreign-currency transactions remain saved but need their actual EUR cash amounts. Open Portfolio → Transactions → Edit (or Complete cash amount), fill the final euro total, and save. Until every such entry is completed, the app shows Known EUR cash and an incomplete balance, rather than treating missing conversions as USD debt. Saved settlement amounts are preserved in backups. Changing the cash/reporting currency is blocked once settled transactions exist, so past amounts cannot be silently relabelled. Only one opening cash balance per actual cash currency is accepted.

Past transaction dates are accepted. With no opening positions or opening cash, adding an earlier transaction moves the tracking start back automatically. Reporting settings also allows an earlier start date after transactions are recorded, provided the whole ledger remains valid. If opening positions exist, explicitly confirm that they describe the new date; adding their original purchases again would double-count shares. An opening cash balance keeps its original date and must be deliberately removed/re-entered before selecting a different start date.

To enter your full history after setup, open Portfolio → Reporting settings → Enter my full transaction history. Choose the earliest date and confirm that you will enter the original purchases. The app exports a recovery backup first, keeps saved transactions, and removes opening positions only if the remaining ledger is valid. Sales that still require those opening shares block the switch. Future/invalid dates and a start date later than a saved transaction remain rejected.

The top of Portfolio shows two EUR figures. Money put in is recorded deposits minus withdrawals, plus starting cash; purchases, sales, dividends, and fees are not new contributions. Total value combines current EUR holdings, USD holdings converted at the dated reference rate, and recorded cash once. The numbers also work for cash-only portfolios. Missing prices, converted cash amounts, or required exchange rates leave the total unavailable. Opening positions do not supply their original funding history, so Money put in remains unavailable when that history is unknown. Legacy amount-only holdings cannot establish a current market valuation. Materially negative recorded cash asks for missing funding, while tiny floating-point rounding residuals are treated as zero in this summary.

Qualified matching-currency prices calculate current holding value, remaining cost basis, and unrealized gain in the holding's original currency. USD holdings additionally show EUR equivalents in parentheses beside the average purchase price, cost basis, current value, gain/loss, current share price, and group totals. A dated ECB USD-to-EUR reference rate is fetched through Frankfurter at publishing time and served from the same site. Every equivalent uses that one rate; converted purchase costs are not the broker's historical EUR payments, and converted USD gains do not include currency movements. The underlying native profit calculation and recorded cash settlements stay unchanged. Missing or expired rates leave USD amounts visible with EUR unavailable; share quantities, percentages, and EUR holdings stay as entered. The separate portfolio Performance page calculates EUR cost-basis gains and cash-flow-adjusted returns from the ledger. Taxes and automatic corporate-action adjustments are not calculated. A sale whose native fees exceed its proceeds cannot be entered as net cash received; record a separately charged fee separately.

The ledger uses browser-local IndexedDB; no database server, account, or broker connection is required. It is not shared with other visitors or synced between browsers/devices. Export backup downloads only the portfolio settings, opening positions, original source text, and transactions. Choose a JSON backup to preview it, then click Restore this backup to replace the tracked portfolio in that browser. Watchlists and research picks are separate. Export a backup before clearing browser/site data or moving to another browser. Local preview and GitHub Pages have separate browser storage.

Portfolio signals use trend, event risk, concentration, volatility, and model score instead of selling purely because a position is down.

## Portfolio Performance

Performance in the main sidebar opens your actual portfolio history. It shows total value including cash, growth since the tracking start, an approximate return adjusted for deposits and withdrawals, and SPY's price return in EUR. A daily value/net-deposit chart has a date slider. Monthly results show end value, net funding, gain, and return; the most recent 12 months are visible and earlier months expand. Gains and costs expands into realized/unrealized EUR gains, recorded income and fees, and individual investments including sold positions. More → Research picks retains the separate recommendation journal.

Recorded EUR buy settlements become EUR purchase cost including fees; net EUR sale settlements become proceeds. Weighted-average EUR cost divides partial sales between realized gains and remaining cost. Holdings are valued using real daily closes and ECB historical reference FX on or before each date, with a maximum seven-day carry over weekends/holidays. Fees and dividends affect performance only when recorded. Foreign fee subtotals are estimated conversions; actual total EUR settlements stay authoritative. No portfolio records leave this browser or change during calculation.

Monthly returns use Modified Dietz with end-of-day external cash-flow weights; complete months are linked geometrically. This is an approximation, especially with large flows. Covered periods without invested capital stay visible but do not enter return linking; the benchmark begins at the same first-capital date. Unavailable invested intervals are never skipped or silently replaced with a shorter history. SPY is a price-return comparison and excludes its dividends. Your recorded dividends remain part of portfolio growth. Opening positions start performance from their market value on the tracking date; cost-basis gains may include earlier changes, and foreign opening costs use estimated start-date FX because actual earlier EUR costs are absent.

Published prices cover up to five years for the configured universe. Portfolio tickers outside that snapshot fetch real five-year daily history on demand from Yahoo, with a bounded public relay fallback. The same history supports watchlist scans and stock details, so selecting a new stock does not require adding it to the discovery universe or redeploying the site. Only ticker queries leave the browser; transactions, quantities, costs, and balances do not. Public history is cached separately with a limit of 80 symbols and 4 MiB, original observation dates, and revalidation on reload. Provider outages retain dated cached data; missing history stays unavailable. A young stock can have a valid holding value without enough bars for a market signal. Historical FX covers USD, GBP, JPY, CHF, CAD, and AUD to EUR over the same window. Older dates, incomplete cash settlements, manual amount-only positions, missing prices/rates, and unresolved splits produce explicit unavailable results. Daily performance excludes the current UTC day's bar and may differ from the latest live holding quote. No adjusted share quantities or transactions are invented. The larger public price snapshot is about 10 MB before HTTP compression; older bars contain only dates/closes, and regular scans use only the latest 400 full bars.

`node scripts/update-instruments.mjs` refreshes `data/instruments.json` from the [official Nasdaq symbol directory](https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt), filtering test issues, warrants, units, rights, preferred stock, and debt. The Pages workflow refreshes it daily at 06:30 UTC and on push/manual deployment, separately from the SEC financial-data lookup. A failed directory refresh preserves its original dated snapshot; old listings cannot bypass live ticker verification. The directory is public market metadata, not your portfolio.

Calculation references: [GIPS handbook, Modified Dietz](https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/) and [Frankfurter ECB historical rates](https://frankfurter.dev/).

## Recommendation Performance

Complete fresh scans record up to three qualifying opportunities once per ticker per UTC day. Each record freezes the score, reasons, risks, evidence, observation time, and same-currency stock/SPY baseline prices. Cached or preliminary scans cannot create records. Performance tracking starts when a pick is recorded in your browser; no past recommendations or returns are invented.

More → Research picks compares observed price changes after five and 21 later matching market sessions. Today's incomplete daily bar is excluded. Missing prices, different currencies, and splits that require price adjustment leave the result unavailable. Mature results retain their original observations when old histories roll off. Results exclude dividends, fees, taxes, and currency conversion and describe observed research performance, not executed trades. Averages use only completed results and display their sample count. Export the local journal to keep a copy; clearing browser storage removes local records.

The app also runs dedicated recent-market-outlook scans. These look for strategist forecasts, market perspectives, weekly commentary, asset-allocation views, overweight/underweight calls, stock-idea articles, and official macro outlooks from trusted research providers and institutions including BlackRock, Vanguard, J.P. Morgan, Fidelity, Morningstar, Schwab, Goldman Sachs, Morgan Stanley, UBS, PIMCO, Motley Fool, the Federal Reserve, IMF, OECD, World Bank, ECB, BEA, BLS, Census, and EIA. Outlook items are scored separately from breaking news, then used as a modest positive or negative adjustment to each ticker or ETF theme.
