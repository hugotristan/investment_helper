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

The personal portfolio starts empty. On Portfolio, enter or correct any existing stock/ETF holdings, then choose a reporting currency and tracking start date under Start portfolio tracking. Existing holdings become opening positions; past trades, opening cash, and historical performance are not invented. Amount-only legacy entries stay as entered until you supply their shares and average purchase price in Opening positions. Your original localStorage snapshot and source text are retained for recovery.

After setup, Record transaction saves purchases, sales, deposits, withdrawals, cash dividends, fees, and one opening cash balance per currency. New symbols must pass stock/ETF validation. Transactions update share quantities, weighted average cost (including purchase fees), and separate currency cash balances. Corrections or deletions cannot create a sale of more shares than were held on that date. Same-day entries use their recorded order; there is no short-selling or stock-split adjustment in this foundation. A negative recorded cash balance warns that funding history may be incomplete. Opening positions remain editable, subject to the same sale checks.

Qualified matching-currency prices calculate current holding value, remaining cost basis, and unrealized gain. The reporting currency is saved for later reports; FX conversion, realized returns, monthly performance, taxes, and dividend-inclusive total returns are not yet calculated. Different currencies remain separate. The start date cannot change after transactions are recorded.

The ledger uses browser-local IndexedDB; no database server, account, or broker connection is required. It is not shared with other visitors or synced between browsers/devices. Export backup downloads only the portfolio settings, opening positions, original source text, and transactions. Choose a JSON backup to preview it, then click Restore this backup to replace the tracked portfolio in that browser. Watchlists and research picks are separate. Export a backup before clearing browser/site data or moving to another browser. Local preview and GitHub Pages have separate browser storage.

Portfolio signals use trend, event risk, concentration, volatility, and model score instead of selling purely because a position is down.

## Recommendation Performance

Complete fresh scans record up to three qualifying opportunities once per ticker per UTC day. Each record freezes the score, reasons, risks, evidence, observation time, and same-currency stock/SPY baseline prices. Cached or preliminary scans cannot create records. Performance tracking starts when a pick is recorded in your browser; no past recommendations or returns are invented.

The Performance page compares observed price changes after five and 21 later matching market sessions. Today's incomplete daily bar is excluded. Missing prices, different currencies, and splits that require price adjustment leave the result unavailable. Mature results retain their original observations when old histories roll off. Results exclude dividends, fees, taxes, and currency conversion and describe observed research performance, not executed trades. Averages use only completed results and display their sample count. Export the local journal to keep a copy; clearing browser storage removes local records.

The app also runs dedicated recent-market-outlook scans. These look for strategist forecasts, market perspectives, weekly commentary, asset-allocation views, overweight/underweight calls, stock-idea articles, and official macro outlooks from trusted research providers and institutions including BlackRock, Vanguard, J.P. Morgan, Fidelity, Morningstar, Schwab, Goldman Sachs, Morgan Stanley, UBS, PIMCO, Motley Fool, the Federal Reserve, IMF, OECD, World Bank, ECB, BEA, BLS, Census, and EIA. Outlook items are scored separately from breaking news, then used as a modest positive or negative adjustment to each ticker or ETF theme.
