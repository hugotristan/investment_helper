# Feature changes

Each feature is delivered in its own commit. This log records the behavior, implementation, and validation for that feature.

## Ticker suggestions

**What changed:** Portfolio ticker inputs, stock detail, the header search, and watchlist additions suggest matching stocks/ETFs from the first letter or company name. Up to eight matches show their symbol and name. Arrow keys/Enter, mouse, and touch select a symbol without submitting the form. Watchlist selection preserves any symbols before the current comma/semicolon.

**How:** A shared catalog combines configured symbols/aliases, bundled SEC issuer names, and published instrument names from same-origin files. Matches rank exact/prefix results before substring results; the catalog is a limited suggestion list, not proof that any typed symbol is valid. Existing save-time validation remains in place. The combobox uses accessible listbox options, safe text rendering, and response checks that prevent delayed catalog loads from reopening dismissed lists or replacing newer input. The updated portfolio module has a release query so browsers load the historical-date fix promptly.

**Validation:** All 227 tests pass. Search/interaction tests cover one-letter and company-name matching, determinism/limits, unavailable catalogs, invalid/crypto/index exclusion, keyboard and pointer selection without submission, disabled fields, safe labels, duplicate binding, dismissal, delayed responses, and multiple watchlist symbols. The module import check resolves release queries to their source files. HTML control structure and dropdown placement rules were checked; native visual inspection remains unavailable.

## Past portfolio transactions

**What changed:** Transaction dates can be in the past. An empty opening portfolio automatically extends its tracking start to the earliest transaction. Setup offers an empty starting point for full history; an existing portfolio can switch through Reporting settings → Enter my full transaction history, with an exported recovery backup and explicit confirmation. Existing transactions are kept.

**How:** The candidate start date and transaction are committed together and validated against the whole ledger. Opening positions are never silently subtracted or redated. Changing their start date requires confirmation; a full-history switch removes them only after validation. Opening cash keeps its original date and must be deliberately removed/re-entered when a different start is needed. Browser date inputs no longer use the tracking start as their minimum; clear date help explains any opening-balance conflict.

**Validation:** Controller checks cover real older dates, automatically extending empty history, legacy preservation, no duplicate opening shares, backup-before-switch, unsupported sales, opening-cash provenance, write failures, future/invalid dates, and a start date after an existing trade. Existing ledger, storage, and portfolio regressions remain required.

## Portfolio foundation: opening positions and manual transactions

**What changed:** Portfolio setup saves a reporting currency and tracking start date, preserving current holdings as opening positions without inventing earlier trades. Purchases, sales, deposits, withdrawals, cash dividends, fees, and opening cash update holdings and separate currency cash balances. The old editor remains available for correcting opening positions; later activity belongs in Transactions. Settings, the ledger, and backup controls are collapsed to keep the page compact.

**How:** A versioned pure ledger projects chronological transactions with weighted purchase cost including fees. Complete-book validation rejects overselling even when a supporting purchase/opening position is edited or deleted, future dates, unsupported assets, duplicate IDs, and numeric overflow. A committed IndexedDB record becomes the source of holdings; the original localStorage holdings/text remain intact. Atomic revision checks prevent stale tabs from overwriting changes. Export/restore uses a bounded, validated portfolio-only JSON format; importing previews the contents and requires a separate Restore click. No server database is needed.

**Limits:** Cash is recorded per currency and negative balances warn of incomplete funding. Historical returns, FX, monthly performance, stock splits, tax calculations, reports, and the AI analyst are later steps. The reporting currency does not convert balances yet. Opening positions describe the selected start date; use the full-history starting point when entering the purchases that created them.

**Validation:** All 202 tests pass, including 43 new model, storage, and controller checks for legacy preservation, same-day ordering, cost/cash math, atomic failures, stale tabs, overselling after edits/deletions, new ticker validation, opening-position editing/removal/Undo, backup previews, restore conflicts, and export isolation. HTML control/label structure and responsive form rules were checked. Browser inspection could not start: its helper exited with `windows sandbox failed: helper_unknown_error: setup refresh had errors`, so visual browser verification remains unavailable.

## 1. Qualified market signals

**What changed:** Sample, stale, future-dated, and incomplete daily histories cannot generate buy, hold, sell, or allocation suggestions. Missing data has an explicit unavailable state. Signal strength is a rules-based score; market coverage is a count of qualified proxies, not a success probability.

**How:** A shared data-quality gate requires 200 distinct valid daily prices and history no older than seven calendar days. A newer quote cannot repair stale or invented history. Company, sector, and market evidence are tagged separately with boundary-aware matching. Browser scan history records score changes without altering the current score.

**Validation:** Tests cover sample/stale/mixed data, weekends, duplicate dates, quote timestamps, deterministic scoring, and company-name/keyword false matches. Existing portfolio and storage regression checks remain in place.

## 2. Stock discovery

**What changed:** The overview highlights one leading stock and up to two alternatives, with reasons, risks, dated article links, price-history timestamps, timeframe, and invalidation. A qualified stock can be added to the watchlist or opened for a full analysis. Empty states explain when no opportunity passes the checks.

**How:** Discovery scans the configured stock universe separately from a visitor's personal watchlist. Candidates require qualified history, recent direct company evidence, a sufficiently strong score, positive trend, adequate liquidity, and acceptable market and event risk. Existing concentration can prevent suggesting more exposure. Watchlist additions use the existing live symbol validator.

**Validation:** Selection tests cover unavailable data, stale/indirect evidence, ETFs, market risk, concentration, and deterministic ranking. Browser checks verify card rendering, empty states, detail links, and watchlist actions.

## 3. Sourced financial fundamentals

**What changed:** Stock detail adds annual revenue, net income, operating/free cash flow, debt, growth, annual diluted EPS valuation, and sourced upcoming earnings dates. Reporting periods, currencies, retrieval dates, and filing links accompany the facts. ETFs and missing data have explicit states.

**How:** A throttled Node generator normalizes SEC companyfacts into a same-origin snapshot for GitHub Pages. It selects full annual periods and comparable units, deduplicates restatements, and derives free cash flow only from matching cash-flow/capex periods. Deployment and daily workflows refresh the snapshot and cache successful prior facts. Dates come from a limited curated issuer-announcement calendar, expire after the event, and are never extrapolated.

**Provider reliability follow-up:** A failed SEC ticker lookup no longer prevents all company requests. A dated, verified SEC mapping snapshot provides a bounded fallback, with issuer identity checks and independent mapping verification dates. SEC remains preferred; Yahoo Finance annual statements supply usable facts when SEC is blocked or lacks supported annual data. Yahoo sources are explicitly labelled, use provider reporting dates, and contain no invented SEC filing information. Only reported Yahoo free cash flow is accepted. SEC diagnostics remain visible when Yahoo succeeds; failed refreshes retain original financial retrieval dates. The confirmed earnings calendar now covers ten configured companies.

**Validation:** Tests cover annual/quarterly distinctions, restatements, currencies, missing debt, retained snapshots after provider failure, valuation, provenance, and unavailable/ETF states. The local SEC endpoint returned HTTP 403; provider failure is handled without fabricated metrics.

**Follow-up validation:** All 120 module tests pass, including provider fallback, identity mismatches, mapping age, retained acquisition dates, Yahoo annual provenance, currency checks, retry limits, and rendered diagnostics. A real update on October 8, 2026 retrieved usable Yahoo annual financials for all 62 configured stocks, with ten confirmed earnings dates. Individual unsupported metrics remain unavailable. SEC still returned HTTP 403.

## 4. Clearer screens and faster feedback

**What changed:** Your watchlist is distinct from discovery. Market charts reveal dates and prices through pointer, touch, and keyboard controls. Stock detail puts four key metrics and fundamentals first, with technical scoring and longer dated evidence behind expandable sections. Methodology is also expandable.

**How:** Qualified raw histories and research are cached locally, preserving original timestamps and rejecting stale or invalid caches. Prices and portfolio values render before the longer news scan finishes, clearly labeled preliminary; only the complete scan generates new opportunity selections. No chart library or build step is needed.

**Validation:** Cache tests cover date/Map revival, malformed/stale/future data, sample filtering, market timestamps, and quota failures. Browser checks cover chart controls, detail disclosures, navigation, mobile overflow, and cache reload behavior. The deployment test's folder-name assumption was corrected separately for Linux portability.

## 5. Structured holdings and calculated gains

**What changed:** My portfolio now saves symbols, shares, average purchase prices, and currencies through a validated form. Holdings support editing, removal, and Undo. Current value, unrealized gain, and allocation update from qualified prices; totals remain separate for each currency. Existing text holdings stay visible as manual amounts until converted.

**How:** A pure holdings calculator checks quote dates and exact currency matches, falls back to qualified daily history, and keeps missing values explicit. Saved changes trigger a new scan. Gains exclude fees, dividends, taxes, and currency conversion. Migration preserves old amounts without inventing share counts or costs.

**Validation:** Tests cover input normalization, dated prices, stale/sample rejection, exact currency matching, daily fallback, incomplete totals, gains, and legacy preservation. Browser checks cover save/edit/remove/Undo, invalid symbols, persistence, and mobile layout.

## 6. Dated recommendation performance

**What changed:** A Performance page tracks future price changes for saved research picks against SPY after five and 21 matching sessions. It shows pending/unavailable results explicitly, sample counts, and an exportable local journal. The original score, reasons, risks, sources, and baseline prices stay with each pick.

**How:** Only complete fresh scans record qualified candidates, once per ticker per UTC day. Stock and benchmark baselines use the same date and currency. Outcomes require later matched dates and exclude today's incomplete bar. Known splits block unadjusted comparisons. Mature observations persist when older histories disappear; averages include only mature results. No historical picks, trade fills, dividends, fees, or currency conversion are assumed.

**Validation:** Tests cover immutable recording, duplicate refreshes, fresh-scan guards, exact matching sessions, missing/currency/stale/sample data, split events, mature observation retention, storage failures, and the export payload. Browser checks cover the new page, pending results, frozen evidence, ticker links, reload persistence, and responsive layout.

## 7. Minimal layout and plain copy

**What changed:** Overview has two sections: stocks to review and six saved watchlist tickers. Prices, dates, and one reason appear in simple rows; evidence and risks expand on demand. Overview, Watchlist, Portfolio, and Performance are the four main destinations. Stock details, market research, signals, stock checks, and source diagnostics remain under More. Rounded corners, decorative cards, taglines, and repeated explanatory text were removed.

**How:** The layout uses square controls, flat sections, and thin separators. Watchlist editing and filters, portfolio editing, technical checks, and scan diagnostics start collapsed. Watchlist results include only saved tickers; more than 40 matching rows remain accessible in a disclosure. New browser filter settings show all signals without a minimum score or liquidity floor; saved settings remain intact. The existing analysis rules, data-quality checks, and browser storage keys are retained. Index charts show qualified SPY/QQQ history and report unavailable data explicitly.

**Validation:** All 126 module tests pass. Navigation tests cover all nine direct routes, unknown routes, and ticker search. Watchlist tests cover discovery exclusion, missing volume with no liquidity floor, long lists, and unavailable histories. Focused rendering checks cover overview quotes, opportunity actions, disclosures, and empty or unavailable data. Browser automation failed to start in this session, so the visual layout still needs a browser review.

## 8. Visible charts and a clearer sidebar

**What changed:** The [Settle reference](https://21st.dev/@uvain/templates/settle-payment-operations-dashboard) informed a light canvas, white square panels, compact navigation icons, and a wider sidebar. Overview leads with a large SPY/QQQ performance chart and six saved watchlist moves, followed by stocks to review. The moves graph replaces the previous watchlist preview so tickers are not repeated on the same page. The sidebar stays on the left through tablet widths and becomes top navigation below 600px.

**How:** A standalone SVG module compares percentage changes from a shared daily-close baseline over one month, three months, or one year. It uses matching observed dates, restores original closes when quotes overlay the last point, and excludes unfinished or future bars. Pointer, touch, and keyboard controls reveal dates, closing prices, and relative changes. Watchlist bars share a centered scale, retain saved order, and label each quote or daily-close date. Missing data stays unavailable. Existing analysis and browser storage are unchanged; no chart library or build step was added.

**Validation:** All 135 module tests pass, including nine new chart checks for shared dates, original closes, incomplete/stale/sample data, finite geometry, quote provenance, signed bars, keyboard controls, and repeated rendering. Overview integration and static HTML/sidebar contracts were checked. Browser inspection helpers could not start, so visual browser verification remains unavailable in this session.

## 9. Published real price snapshots

**What changed:** Covered scan symbols and market proxies load validated Yahoo daily histories and dated quotes from `data/prices.json` on this site's own origin. Browser CORS and public relay failures no longer block that published price coverage. No database or API key is required. Prices retain their provider observation times; missing or stale data is not filled with estimates.

**How:** `scripts/update-prices.mjs` fetches real data server-side before GitHub Pages deployment. Its Actions cache is separate from the financial snapshot cache. Prices refresh daily at 06:30 UTC and every 30 minutes on weekdays from 13:07 through 22:37 UTC, plus push and manual runs. The weekday price runs reuse saved fundamentals; company financials refresh only on the daily schedule, push, or manual runs. A price updater failure blocks deployment. These are scheduled snapshots, not tick-by-tick quotes; GitHub scheduling delays and provider observation dates determine actual freshness. Personal symbols outside the published universe may still require a browser lookup.

**Validation:** All 159 module tests pass. Tests cover a complete browser price path with external requests disabled, provider identity and currency, original dates, correct one-day changes, partial cache retention, bounded concurrency/retries, and required index coverage. A real publisher run returned usable histories and dated quotes for all 97 configured symbols. An end-to-end data check populated both index series, all 11 proxies, and the six overview moves from one site-relative request. The workflow keeps tests and price generation as required steps before upload; deployment is blocked if required index histories are unavailable.
