# Fundamental Analysis v1

This model is independent of Technical Score v2 and Data Confidence. It neither changes investment records nor sends orders. Weights are configurable initial design assumptions, not validated predictors.

## Data and formulas

SEC companyfacts and Yahoo annual timeseries now retain up to six dated annual observations plus original source facts for operating income, interest, taxes, D&A, cash, current assets/liabilities, equity, debt, diluted shares and available preferred/minority interests. Existing financial fields and MCP contracts remain compatible. No paid provider or API key is added. Missing taxonomies remain missing. Fiscal-year labels remain unknown when only provider period dates are known. Comparable, non-overlapping annual periods are required for growth/consistency.

The financial breakdown lists P/S, annual P/E, FCF yield, EV/EBITDA, historical PEG, net debt/EBITDA, current ratio, cash, interest coverage, ROIC, operating/FCF/net margins, revenue/EPS growth (1Y and 3Y CAGR), FCF growth, 3–5Y diluted-share CAGR, and positive income/FCF consistency. Each formula is shown in the UI and in fundamental-rating.js. Raw amounts and PEG are diagnostics, not extra votes. FCF uses reported values or matching-period operating cash flow less capex. ROIC uses reported effective tax expense and average beginning/ending debt+equity-cash. This is an accounting approximation, not an independently estimated marginal tax rate or moat measurement.

Market ratios require a recent dated same-currency quote. Market capitalization must be explicitly supplied by the quote provider; zero placeholders and annual diluted share averages are never used to invent a current market cap. EV requires explicit debt, cash, preferred and minority-interest inputs; missing interests are not assumed zero. Splits/ADR ambiguity block per-share ratios/growth pending verification. Nonpositive denominators and invalid growth baselines yield unavailable metrics. Negative FCF remains a real negative observation. A zero interest expense does not manufacture infinite coverage.

## Classification and peers

SEC submissions supplies verified SIC classification where permitted. The existing GitHub updater attempts classification alongside financial refresh and imports it through the existing scoped OIDC path. Runtime SEC access also attempts it. Failures retain unknown classification, not a guessed industry. Company financial cache records upgrade their history schema during normal bounded refresh.

Peer comparisons use only cached/published companies with the same two-digit SIC group, usable financial periods within 400 days of the subject period, non-stale data, and available values for that metric. At least five OTHER companies are needed per comparison. The interface discloses the observed sample count and median. These are observed-cache peer benchmarks, not comprehensive exchange-wide industry medians; watchlist/sample selection bias is a limitation. No worldwide scan or fabricated static industry multiple is used. Up to forty relevant peer records are returned on the existing stock financial page; no holdings amounts or transaction records are sent.

## Scoring and abstention

Category weights: valuation 30, profitability/business quality 30, growth/dilution 25, financial resilience 15. Within categories, correlated metrics share families instead of accumulating independent full weights:
- Valuation: multiples (P/E, P/S, EV/EBITDA); FCF yield.
- Profitability: ROIC; operating/FCF margins; multi-year consistency.
- Growth: revenue/EPS growth/CAGR and FCF growth; dilution.
- Resilience: net debt/EBITDA and interest coverage; current ratio.

Within each family, available same-industry percentile ranks are averaged, then available families are averaged within each category. The screen shows contribution points at the current category coverage. At least 75% weighted family coverage and 50% in every category are required for a total. Unknown industry, stale/future financials or inadequate peer coverage produce Insufficient Data. Score labels: >=70 Attractive for further research, >=40 Mixed, otherwise Unattractive on current fundamentals. No buy/sell forecast is produced.

SIC 60–67 financial institutions receive no generic corporate score; a bank/insurer model using regulatory capital, asset quality and appropriate return measures remains future work. Relevant extractive/manufacturing cyclical groups receive a multi-year earnings caution. Negative-income and negative-FCF warnings are explicit. This does not normalize a full commodity cycle or claim management quality.

## Timing, UI and limits

Acquisition dates, source filing dates, currencies and source units are validated against the analysis time. Future-acquired records cannot supply ratios in historical evaluations. Yahoo lacks reliable filing/restatement timing: these snapshots cannot reconstruct point-in-time historical backtests. Peer classification must also have been verified by the analysis date. Reporting periods over 550 days or retrievals over ten days are stale; historical model evaluation requires genuine archived snapshots.

Detail and stock Q&A show the separate Fundamental Score, financial table and assessment through the existing financial panel. The table is collapsed by default. The assessment separates observed facts, interpretation, assumptions and missing information. No fundamental rating is folded into Technical Score, Data Confidence or automatic trading. Existing raw financial provenance remains available.

Practical limits: provider access/rate limits can restrict SEC classification and annual concepts; quotes may omit market cap; industry cohorts may be too small. EV, ROIC, dilution and CAGR remain unavailable until all required evidence exists. Historical PEG is not consensus-forward PEG. Banks, insurers, IFRS-only tags, detailed ADR/share-class normalization, industry-specific current-ratio adequacy and broader representative peer universes need further work. Financial-score weights and median/percentile comparisons are descriptive heuristics, not predictive validation.
