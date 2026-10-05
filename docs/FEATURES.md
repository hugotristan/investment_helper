# Feature changes

Each feature is delivered in its own commit. This log records the behavior, implementation, and validation for that feature.

## 1. Qualified market signals

**What changed:** Sample, stale, future-dated, and incomplete daily histories cannot generate buy, hold, sell, or allocation suggestions. Missing data has an explicit unavailable state. Signal strength is a rules-based score; market coverage is a count of qualified proxies, not a success probability.

**How:** A shared data-quality gate requires 200 distinct valid daily prices and history no older than seven calendar days. A newer quote cannot repair stale or invented history. Company, sector, and market evidence are tagged separately with boundary-aware matching. Browser scan history records score changes without altering the current score.

**Validation:** Tests cover sample/stale/mixed data, weekends, duplicate dates, quote timestamps, deterministic scoring, and company-name/keyword false matches. Existing portfolio and storage regression checks remain in place.

## 2. Evidence-led stock opportunities

**What changed:** The overview highlights one leading stock and up to two alternatives, with reasons, risks, dated article links, price-history timestamps, timeframe, and invalidation. A qualified stock can be added to the watchlist or opened for a full analysis. Empty states explain when no opportunity passes the checks.

**How:** Discovery scans the configured stock universe separately from a visitor's personal watchlist. Candidates require qualified history, recent direct company evidence, a sufficiently strong score, positive trend, adequate liquidity, and acceptable market and event risk. Existing concentration can prevent suggesting more exposure. Watchlist additions use the existing live symbol validator.

**Validation:** Selection tests cover unavailable data, stale/indirect evidence, ETFs, market risk, concentration, and deterministic ranking. Browser checks verify card rendering, empty states, detail links, and watchlist actions.

## 3. Sourced financial fundamentals

**What changed:** Stock detail adds annual revenue, net income, operating/free cash flow, debt, growth, annual diluted EPS valuation, and sourced upcoming earnings dates. Reporting periods, currencies, retrieval dates, and filing links accompany the facts. ETFs and missing data have explicit states.

**How:** A throttled Node generator normalizes SEC companyfacts into a same-origin snapshot for GitHub Pages. It selects full annual periods and comparable units, deduplicates restatements, and derives free cash flow only from matching cash-flow/capex periods. Deployment and daily workflows refresh the snapshot and cache successful prior facts. Dates come from a limited curated issuer-announcement calendar, expire after the event, and are never extrapolated.

**Validation:** Tests cover annual/quarterly distinctions, restatements, currencies, missing debt, retained snapshots after provider failure, valuation, provenance, and unavailable/ETF states. The local SEC endpoint returned HTTP 403; provider failure is handled without fabricated metrics.

## 4. Clearer screens and faster feedback

**What changed:** Your watchlist is distinct from discovery. Market charts reveal dates and prices through pointer, touch, and keyboard controls. Stock detail puts four key metrics and fundamentals first, with technical scoring and longer dated evidence behind expandable sections. Methodology is also expandable.

**How:** Qualified raw histories and research are cached locally, preserving original timestamps and rejecting stale or invalid caches. Prices and portfolio values render before the longer news scan finishes, clearly labeled preliminary; only the complete scan generates new opportunity selections. No chart library or build step is needed.

**Validation:** Cache tests cover date/Map revival, malformed/stale/future data, sample filtering, market timestamps, and quota failures. Browser checks cover chart controls, detail disclosures, navigation, mobile overflow, and cache reload behavior. The deployment test's folder-name assumption was corrected separately for Linux portability.

## 5. Structured holdings and calculated gains

**What changed:** My portfolio now saves symbols, shares, average purchase prices, and currencies through a validated form. Holdings support editing, removal, and Undo. Current value, unrealized gain, and allocation update from qualified prices; totals remain separate for each currency. Existing text holdings stay visible as manual amounts until converted.

**How:** A pure holdings calculator checks quote dates and exact currency matches, falls back to qualified daily history, and keeps missing values explicit. Saved changes trigger a new scan. Gains exclude fees, dividends, taxes, and currency conversion. Migration preserves old amounts without inventing share counts or costs.

**Validation:** Tests cover input normalization, dated prices, stale/sample rejection, exact currency matching, daily fallback, incomplete totals, gains, and legacy preservation. Browser checks cover save/edit/remove/Undo, invalid symbols, persistence, and mobile layout.
