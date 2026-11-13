# Technical Score v2

Introduced after the 13 November 2026 audit. This is technical analysis, not a valuation model or probability of profit. It never changes portfolio records.

## Numeric score

Weights total 100: trend 22, momentum 22, RSI 6, MACD 6, Bollinger position 5, ATR risk 5, volatility 12, drawdown 10, volume pressure 6, USD liquidity 6. Existing indicator formulas remain, except flat-price RSI now correctly returns 50. Trend and momentum occur once. No fund bonus or single-stock penalty applies. The previous overlapping technical composite, outlook bonuses and missing-news/event-risk credits were removed.

The score uses completed daily bars only. Quotes remain separate for current displayed prices and holdings valuation. Original v1 cached quote overlays recover their saved daily close; unrecoverable original range/volume observations are marked missing. Today's unfinished bar is excluded. Missing ATR, volume or USD liquidity components are excluded and available weights are normalized to 100; the displayed available-weight percentage and provisional label disclose this. No missing-volume score cap applies. Zero reported volume remains a real zero, distinct from missing volume.

USD turnover uses completed-day price times mean volume over 60 sessions. EUR turnover uses a validated, dated ECB USD/EUR reference. Other currencies without a supported conversion remain unavailable; native amounts are never silently called USD. Research selection uses the shared USD 5 million minimum. Liquidity contributes continuously to the score and no separate contradictory score-cap threshold remains.

## News and signals

Dated articles from the last 14 days inform news context and event-risk checks, not numeric score points. Undated/future/older articles cannot affect current checks. URLs are deduplicated, and sentiment decays linearly with age: max(1/3, 1-age/21 days). No recent evidence means unknown event risk, not low risk. Older articles may remain visible as historical context.

All current views use one label policy. Two review triggers, score <=40, or high event risk produce Technical risk review. Otherwise incomplete components produce Provisional technical conditions; complete scores >=75 are Favorable technical setup, >=60 Constructive technical trend, >=45 Mixed technical conditions, and lower scores Weak technical conditions. These are observations, not trading instructions. Existing public function names and score fields remain compatible. The former setup.confidence alias is null; no percentage success claim is emitted.

## Data Confidence

A separate transparent heuristic measures evidence, never price direction: daily history 40%, daily ranges 10%, volume/USD turnover 10%, dated news 15%, company financials 25%. ETF company statements are not applicable and excluded from this evidence denominator; no diversification or business-quality conclusion follows.

History needs 200 valid daily observations, recognized source provenance and recent dates. History older than three days gets 70% freshness credit; failed refreshes multiply its component by 60%; recognized relay provenance gets 85% and unknown adapter provenance 50%. Range and volume completeness are measured directly. Missing USD conversion reduces the volume/turnover component. News uses recognized publisher IDs, breadth up to three publishers and article freshness. These declared policy factors are not statistically calibrated reliability probabilities.

Company financial coverage checks revenue, growth, income, cash flows/growth, debt and EPS. It also checks provider, retrieval and reporting-period dates. Reporting periods older than 450 days receive reduced credit; missing/future/over-550-day periods receive none. Financial retrieval older than ten days or failed refreshes reduce credit. Values' signs do not affect Data Confidence. Financials not checked in a scanner view are explicitly disclosed; Detail and stock Q&A use the requested company's financial record. Labels: High >=80, Moderate >=60, Limited >=35, otherwise Low.

## Financials and history

Stock Detail and Q&A show revenue/growth, net income/growth, operating and free cash flow/growth, debt, EPS and validated annual/provider-period P/E, with missing values, reporting periods and sources. These do not feed Technical Score. P/E remains unavailable for invalid EPS/currency/date provenance and when a subsequent split requires verification of its per-share basis. No TTM, fair-value estimate or fundamental rating is invented.

New scan and prospective recommendation records carry technical-v2 and available input weight. Untagged old recommendation records remain legacy-v1 and keep their original scores, labels, evidence and outcomes. Current report averages exclude legacy models and summaries are grouped by model. Score deltas require matching version and available weights. Raw cached series are recomputed under v2 rather than treating old scores as comparable.

## Limits

Weights and thresholds remain heuristic and have not been calibrated to future returns. News uses keyword matching, can include broader market context and does not establish causality. Only supported, dated currency conversions are used. Data availability depends on providers; EPS/ADR/split and accounting comparability still need care. Financial visibility is separate from valuation. Existing illustrative allocation proportions remain examples, not personalized investment advice.
