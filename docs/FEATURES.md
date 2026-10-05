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
