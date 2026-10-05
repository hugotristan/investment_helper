# Investing tool

A multi-page stock market dashboard hosted on GitHub Pages that produces ranked market signals for today's watchlist.

## Run It

Open the [live app on GitHub Pages](https://hugotristan.github.io/investment_helper/) in your browser. No installation is required.

To run a local copy, serve the project directory over HTTP, then open the local URL. For example, if Python is installed, run `python -m http.server 8000 --bind 127.0.0.1` from this directory and open [http://127.0.0.1:8000](http://127.0.0.1:8000). The app uses native JavaScript modules, so opening `index.html` directly as a file is not supported. No build step or package installation is required.

## Code Structure

`app.js` initializes the app, connects feature controls, and manages navigation and scan timing. Feature code and data processing live in native JavaScript modules:

| Location | Responsibility |
| --- | --- |
| `js/config/` | Scan settings, the default watchlist, trusted sources, and feeds |
| `js/data/` | HTTP requests, ticker validation, Yahoo price/quote loading, and news scans/caching |
| `js/analysis/` | Technical scoring, headline/outlook interpretation, market forecasts, signals, and allocation |
| `js/features/` | Watchlist, portfolio, screener, stock detail, questions, and signal views |
| `js/ui/` | DOM references, reusable view components, and dashboard/research/source rendering |
| `js/shared/` | Math, formatting, text, and symbol helpers |
| `js/storage.js` | Browser-local settings and scan history |
| `js/scan-state.js` | Latest scan results shared by the dashboard and screener |

The same GitHub Pages workflow serves these modules directly. Saved browser settings continue to use the existing storage key.

Run the module regression tests with `npm test` using Node.js 18 or newer. They use Node's built-in test runner and require no installed packages.

## What It Does

- Runs immediately when the page opens.
- Uses a dark fintech dashboard with blue accents, sidebar navigation, compact stock cards, price-history charts, a portfolio allocation summary, responsive layouts, and reduced-motion fallbacks.
- Provides one-month, three-month, and one-year chart views, with labels when only shorter history is available. The header ticker search opens a fresh stock detail scan.
- Refreshes automatically on a slower cadence, and lets slow source scans run longer when needed so each output is a fuller consolidated review.
- Pulls Yahoo Finance chart data for watchlist price history and broad-market proxy data.
- Pulls Yahoo Finance intraday chart data for current/latest price, day change, day range, volume, exchange metadata, and 52-week range when available.
- Starts with a broad cross-sector opportunity universe across index ETFs, sector ETFs, mega caps, semiconductors, software, internet, financials, energy, healthcare, consumer, industrials, defense, and materials.
- Shows the watchlist as removable ticker chips with a compact preview, an expandable full list, an add-tickers field, and a collapsible text editor for bulk changes.
- Checks new watchlist symbols against live Yahoo Finance metadata before saving, accepting only stocks and ETFs. Bulk edits use an Apply changes button and the same validation. Unknown symbols, unsupported instruments, and temporary lookup failures leave the saved watchlist unchanged.
- Adds a live screener page that filters the current scan by signal type, minimum score, liquidity, momentum, risk control, and volume pressure.
- Adds a stock detail page that runs a fresh single-ticker quote, chart, technical, news, outlook, and market-context scan.
- Pulls and analyzes a 260-source trusted stock-market universe for current headlines and macro context when available.
- Scores trend, momentum, RSI, MACD, Bollinger position, ATR, volatility, drawdown, volume pressure, liquidity, event risk, cross-source headline tone, trusted market outlook tone, source breadth, diversification, and local score changes.
- Adds recent-year stock, sector, institutional, and macro-regime outlook scans to avoid relying only on today's headlines.
- Shows the rules-based market framework used for trend, momentum, risk, diversification, market regime, recent-year research, and known data gaps.
- Shows category scores, signal type, confidence, timeframe, entry zone, invalidation level, support/resistance, and risk level.
- Produces a probabilistic market-regime forecast using equity breadth, VIX, credit appetite, bond/rate pressure, dollar pressure, oil, gold, headlines, and trusted outlooks.
- Outputs model allocations by ticker and percentage.
- Answers focused natural-language questions such as "Should I sell Intel stock today?" or "Should I sell Microsoft today?"
- Shows sell/reduce and do-not-sell/hold signals for the current watchlist.
- Adds a personal portfolio review using the user's current holdings, position sizes, up/down status, concentration, and live score checks.
- Shows a "do not buy today" ticker from the weakest setup.
- Stores recent scan history locally in the browser.

## Important

The app does not place trades or guarantee returns. It shows the model's calculated output from public web data and local score history.

## Source Set

The app checks a 260-source trusted stock-market universe through GDELT live news JSON and supplements it with direct RSS feeds where available. This is more reliable than relying on hundreds of separate publisher RSS endpoints from a static browser page. The universe includes major market media, exchange/index providers, broker/research institutions, central banks, statistical agencies, regulators, labor and commerce data agencies, energy agencies, sector-specific outlets, and selected macro research sources. Each scan displays which trusted sources were active in the current live article set and how many relevant headlines were used.

Slow web sources now get extended retries before being marked unavailable. GDELT scans try direct JSON first, then a relay fallback, with longer timeouts and repeated attempts. RSS feeds try direct RSS first, then the relay, also with repeated attempts. If a scan gets no usable headlines after retries, the app labels the fallback and reuses the last successful headline set while continuing to refresh price data.

Repeated scans are stabilized. If a refresh gets a much thinner source batch than the previous successful scan, the app merges the current and previous headline set instead of letting one weak web response rewrite the ranking. Individual asset scores are also capped to a limited per-scan move, so rankings should change gradually unless the signal persists.

Each news scan now targets at least 60 active trusted sources, which is still above the original 30-source reliability goal without forcing the browser to wait through every slow RSS endpoint. If the first live pass is too thin, the app widens to broader 48-hour and 7-day GDELT scans for markets, earnings, macro, sectors, ETFs, rates, credit, official macro releases, regulators, energy data, technology, healthcare, financials, industrials, defense, consumer, materials, and event risk. The deep-source scan has a hard time budget of about five minutes because it prioritizes one solid review without turning one refresh into a 20-minute wait.

The app also searches recent-year outlook material from trusted institutions and market sources. These scans look for annual outlooks, 12-month views, sector outlooks, earnings outlooks, stock-pick articles, capital-market assumptions, and macro-regime analysis. Motley Fool is included as a stock-idea/opinion source through both its RSS feed and dedicated GDELT outlook scans. Those items are scored as opinion evidence, not as official or guaranteed recommendations, and can only modestly lift or reduce a stock or sector score.

## Current Gaps

The app now labels data gaps instead of pretending they are solved. Bid-ask spreads, stock fundamentals, earnings calendars, analyst revisions, options flow, and social hype need dedicated reliable APIs before they should affect scoring. Yahoo's public fundamentals endpoint returned unauthorized in testing, so fundamentals were not wired in as a fake source.

## Market Forecast

The forecast is probabilistic, not provable. It combines SPY, QQQ, IWM, VTI, TLT, HYG, LQD, GLD, USO, UUP, and VIX with active trusted-source coverage and outlook counts. The output includes a market-regime label, confidence percentage, evidence bullets, and contradiction/risk notes. The allocation engine uses this forecast to adjust the cash reserve.

## Candidate Universe

Sources can explain and score candidates, but they cannot recommend a stock the app never scans. The default watchlist now includes a much wider opportunity universe instead of only SPY, QQQ, AAPL, MSFT, NVDA, TSLA, JPM, XOM, and UNH. Changing the watchlist or portfolio holdings automatically schedules a fresh scan.

The personal portfolio starts empty. On the My portfolio page, add one holding per line in the format `TICKER | Label | Amount | up/down`. The overview shows an allocation summary based on those manually entered amounts. Changes are saved automatically in the current browser's local storage and are not shared with other visitors or synced between devices. Portfolio signals do not sell purely because a position is down; they look for trend damage, event risk, concentration, volatility, and weak model score before escalating from hold/watch to review/trim.

The app also runs dedicated recent-market-outlook scans. These look for strategist forecasts, market perspectives, weekly commentary, asset-allocation views, overweight/underweight calls, stock-idea articles, and official macro outlooks from trusted research providers and institutions including BlackRock, Vanguard, J.P. Morgan, Fidelity, Morningstar, Schwab, Goldman Sachs, Morgan Stanley, UBS, PIMCO, Motley Fool, the Federal Reserve, IMF, OECD, World Bank, ECB, BEA, BLS, Census, and EIA. Outlook items are scored separately from breaking news, then used as a modest positive or negative adjustment to each ticker or ETF theme.
