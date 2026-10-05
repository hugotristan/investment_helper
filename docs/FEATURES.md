# Feature changes

Each feature is delivered in its own commit. This log records the behavior, implementation, and validation for that feature.

## 1. Qualified market signals

**What changed:** Sample, stale, future-dated, and incomplete daily histories cannot generate buy, hold, sell, or allocation suggestions. Missing data has an explicit unavailable state. Signal strength is a rules-based score; market coverage is a count of qualified proxies, not a success probability.

**How:** A shared data-quality gate requires 200 distinct valid daily prices and history no older than seven calendar days. A newer quote cannot repair stale or invented history. Company, sector, and market evidence are tagged separately with boundary-aware matching. Browser scan history records score changes without altering the current score.

**Validation:** Tests cover sample/stale/mixed data, weekends, duplicate dates, quote timestamps, deterministic scoring, and company-name/keyword false matches. Existing portfolio and storage regression checks remain in place.
