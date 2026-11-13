import {getExchangeRate} from "../data/exchange-rate.js";
import {loadFundamentalsSnapshot} from "../data/fundamentals.js";
import {renderFundamentals} from "./fundamentals.js";
import {renderDataConfidence} from "../ui/components.js";
import {technicalSignalFor,TECHNICAL_EXPLANATION} from "../analysis/technical-policy.js";
import { applyLearningSignal, scoreSeries } from "../analysis/scoring.js";
import { holdSignalFor, sellSignalFor } from "../analysis/signals.js";
import { applyQuoteSnapshot, loadMarketSeries, loadQuoteSnapshots } from "../data/market.js";
import { uniqueArticles } from "../data/news-helpers.js";
import { loadNewsSources } from "../data/news.js";
import { formatNumber, formatPercent, formatSignal } from "../shared/format.js";
import { isBlockedAssetTicker } from "../shared/symbols.js";
import { resolveStockQuestion } from "../shared/stock-input.js";
import { dateValue, escapeHtml, unique } from "../shared/text.js";
import { els, showToast } from "../ui/dom.js";

let isQuestionRunning = false;

export async function answerQuestion() {
  if (isQuestionRunning) {
    showToast("Question analysis is already running");
    return;
  }

  const question = els.askInput.value.trim();
  isQuestionRunning = true;
  els.askButton.disabled = true;
  try {
    const parsed = await resolveStockQuestion(question);
    if (!parsed?.ticker) {
      els.askAnswer.innerHTML = `<div class="empty-state">No ticker recognized. Enter a ticker such as INTC or a company name such as Intel.</div>`;
      return;
    }
    if (isBlockedAssetTicker(parsed.ticker)) {
      els.askAnswer.innerHTML = `<div class="empty-state">That asset type is outside this stock-and-ETF version. Ask about a listed company or fund instead.</div>`;
      return;
    }

    els.askAnswer.innerHTML = `<div class="empty-state">Checking prices and matched articles for ${escapeHtml(parsed.ticker)}…</div>`;

    const contextTickers = unique([parsed.ticker, "SPY", "QQQ", "VTI"]);
    const [series, quotes, news, financials] = await Promise.all([
      loadMarketSeries(parsed.ticker),
      loadQuoteSnapshots([parsed.ticker]),
      loadNewsSources(contextTickers, { allowCache: false }),
      loadFundamentalsSnapshot(parsed.ticker)
    ]);
    const scored = applyLearningSignal(scoreSeries(applyQuoteSnapshot(series, quotes.byTicker), news.byTicker[parsed.ticker] || [],{fxReference:getExchangeRate()}));
    if (!scored.dataQuality?.eligible) {
      els.askAnswer.innerHTML = `<div class="empty-state"><h3>${escapeHtml(scored.ticker)} · Analysis unavailable</h3><p>${escapeHtml(scored.dataQuality?.reason || "Qualified price history is unavailable.")}</p><p>No investment signal can be generated until recent real history is available.</p></div>`;
      els.askAnswer.insertAdjacentHTML("beforeend",renderDataConfidence(scored,{financial:financials.byTicker?.[scored.ticker]})+await renderFundamentals(scored,financials));
      return;
    }
    const answer = buildQuestionAnswer(scored, news, parsed);
    answer.confidenceHtml = renderDataConfidence(scored,{financial:financials.byTicker?.[scored.ticker]});
    answer.financialsHtml = await renderFundamentals(scored,financials);
    renderQuestionAnswer(answer);
  } catch (error) {
    console.error(error);
    els.askAnswer.innerHTML = `<div class="empty-state">Could not complete the ticker check. Check the connection and try again.</div>`;
  } finally {
    isQuestionRunning = false;
    els.askButton.disabled = false;
  }
}

function buildQuestionAnswer(item, news, parsed) {
  const sellSignal = sellSignalFor(item);
  const holdSignal = holdSignalFor(item);
  const activeSources = news.sources.filter((source) => source.ok && source.id !== "live-source-index").length;
  const relevantItems = uniqueArticles((news.byTicker[item.ticker] || []).concat(item.outlooks || [], item.headlines || []));
  const links = relevantItems.map((entry) => ({ ...entry, link: safeArticleUrl(entry.link) })).filter((entry) => entry.link).slice(0, 5);
  const priceAsOf = item.currentPriceAsOf || item.dataQuality?.asOf;
  let verdict = "Wait / watch";
  let className = "ask-verdict-watch";
  let summary = "Completed daily conditions are mixed; company valuation has not been assessed.";

  if (sellSignal) {
    verdict = sellSignal.label;
    className = "ask-verdict-sell";
    summary = `${sellSignal.reason} ${sellSignal.detail || ""}`.trim();
  } else if (holdSignal) {
    verdict = holdSignal.label;
    className = "ask-verdict-hold";
    summary = `${holdSignal.reason} ${holdSignal.detail || ""}`.trim();
  }

  return {
    ticker: item.ticker,
    question: parsed.question,
    company: parsed.company,
    verdict:technicalSignalFor(item).label,
    className,
    summary,
    score: item.score,
    keyStats: [
      ["Price", `${formatNumber(item.currentPrice || item.latest)} ${item.currency || item.quote?.currency || ""}`.trim(), `As of ${articleDateLabel(priceAsOf)}`],
      ["1D", formatPercent(item.oneDay)],
      ["Technical Score v2", `${item.score}/100`],
      ["Event risk", item.eventRisk?.level || "Unavailable"]
    ],
    stats: [
      ["Signal", item.setup?.signal || item.label],
      ["Technical Score v2", `${item.score}/100`],
      ["Timeframe", item.setup?.timeframe || "1-4 weeks"],
      ["1M", formatPercent(item.oneMonth)],
      ["3M", formatPercent(item.threeMonth)],
      ["6M", formatPercent(item.sixMonth)],
      ["Technical reference range", item.setup?.entryZone || "-"],
      ["Invalidation", item.setup ? formatNumber(item.setup.invalidation) : "-"],
      ["RSI", Number.isFinite(item.rsi14) ? item.rsi14.toFixed(0) : "-"],
      ["ATR", formatPercent(item.atrPercent)],
      ["Drawdown", formatPercent(item.drawdown)],
      ["Vol", formatPercent(item.volatility)],
      ["Event risk", item.eventRisk?.level || "Low"],
      ["Headline tone", formatSignal(item.headlineScore)],
      ["Outlook tone", formatSignal(item.outlookScore)]
    ],
    reasons: buildQuestionReasons(item, activeSources, news.outlookCount || 0),
    links,
    activeSources,
    headlines: news.items.length,
    outlooks: news.outlookCount || 0
  };
}

function renderQuestionAnswer(answer) {
  els.askAnswer.innerHTML = `
    <article class="ask-result ${answer.className}">
      <div class="ask-result-head">
        <div>
          <span>Rule-based result · ${escapeHtml(answer.company || answer.ticker)}</span>
          <h3>${escapeHtml(answer.verdict)}</h3>
        </div>
        <strong>Technical Score v2 · ${answer.score}/100</strong>
      </div>
      <p>${escapeHtml(answer.summary)}</p><p class="data-note">${escapeHtml(TECHNICAL_EXPLANATION)}</p>
      ${answer.confidenceHtml || ""}${answer.financialsHtml || ""}
      <dl class="key-values">${answer.keyStats.map(renderMetric).join("")}</dl>
      <details class="secondary-details"><summary>Checks behind this result</summary>
        <dl class="key-values">${answer.stats.map(renderMetric).join("")}</dl>
        <ul>${answer.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
      </details>
      <details class="secondary-details"><summary>Matched articles (${answer.links.length})</summary>
        <p class="data-note">${answer.activeSources} feeds loaded · ${answer.headlines} articles · ${answer.outlooks} outlook items across the focused scan.</p>
        ${answer.links.length ? `<div class="ask-links">${answer.links.map((item) => `<div class="detail-source-entry"><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.source)}: ${escapeHtml(item.title)}</a><small>${escapeHtml(item.directTickers?.includes(answer.ticker) ? "Direct company evidence" : item.sectorTickers?.includes(answer.ticker) ? "Sector context" : "Market context")} · ${escapeHtml(articleDateLabel(item.pubDate))}</small></div>`).join("")}</div>` : '<p>No usable article links matched this ticker. The result relies on price history.</p>'}
      </details>
    </article>
  `;
}

function buildQuestionReasons(item, activeSources, outlookCount) {
  return [
    `${activeSources} feeds loaded successfully.`,
    `${item.headlineSourceCount || 0} headline sources and ${item.outlookSourceCount || 0} outlook sources matched ${item.ticker}; some matches provide sector or market context.`,
    `Trend check: ${item.latest > item.sma200 ? "above" : "below"} the 200-day average and ${item.latest > item.sma50 ? "above" : "below"} the 50-day average.`,
    `${outlookCount} outlook items were found across the focused scan.`,
    item.flags[0] || item.reasons[0] || ""
  ].filter(Boolean);
}

function renderMetric([label, value, note]) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}${note ? `<small>${escapeHtml(note)}</small>` : ""}</dd></div>`;
}

function safeArticleUrl(value) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; }
  catch { return ""; }
}

function articleDateLabel(value) {
  const time = dateValue(String(value || "").replace(/^(\d{8})T(\d{6})Z?$/, "$1$2"));
  return time ? new Date(time).toLocaleDateString() : "Date unavailable";
}
