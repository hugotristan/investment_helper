import { applyLearningSignal, scoreSeries } from "../analysis/scoring.js";
import { holdSignalFor, sellSignalFor } from "../analysis/signals.js";
import { trustedSourceUniverse } from "../config/sources.js";
import { applyQuoteSnapshot, loadMarketSeries, loadQuoteSnapshots } from "../data/market.js";
import { uniqueArticles } from "../data/news-helpers.js";
import { loadNewsSources } from "../data/news.js";
import { formatNumber, formatPercent, formatSignal } from "../shared/format.js";
import { isBlockedAssetTicker, parseQuestionTarget } from "../shared/symbols.js";
import { escapeHtml, unique } from "../shared/text.js";
import { els, showToast } from "../ui/dom.js";

let isQuestionRunning = false;

export async function answerQuestion() {
  if (isQuestionRunning) {
    showToast("Question analysis is already running");
    return;
  }

  const question = els.askInput.value.trim();
  const parsed = parseQuestionTarget(question);
  if (!parsed.ticker) {
    els.askAnswer.innerHTML = `<div class="empty-state">I could not identify the stock. Try a ticker, like "Should I sell INTC today?", or a common company name like Intel, Apple, Microsoft, Nvidia, Tesla, or Amazon.</div>`;
    return;
  }
  if (isBlockedAssetTicker(parsed.ticker)) {
    els.askAnswer.innerHTML = `<div class="empty-state">That asset type is outside this stock-and-ETF version. Ask about a listed company or fund instead.</div>`;
    return;
  }

  isQuestionRunning = true;
  els.askButton.disabled = true;
  els.askAnswer.innerHTML = `<div class="empty-state">Running deep live analysis for ${escapeHtml(parsed.ticker)}. This checks price action, sell/hold signals, recent headlines, trusted outlooks, and broad market context...</div>`;

  try {
    const contextTickers = unique([parsed.ticker, "SPY", "QQQ", "VTI"]);
    const [series, quotes, news] = await Promise.all([
      loadMarketSeries(parsed.ticker),
      loadQuoteSnapshots([parsed.ticker]),
      loadNewsSources(contextTickers, { allowCache: false })
    ]);
    const scored = applyLearningSignal(scoreSeries(applyQuoteSnapshot(series, quotes.byTicker), news.byTicker[parsed.ticker] || []));
    if (!scored.dataQuality?.eligible) {
      els.askAnswer.innerHTML = `<div class="empty-state"><h3>${escapeHtml(scored.ticker)} · Analysis unavailable</h3><p>${escapeHtml(scored.dataQuality?.reason || "Qualified price history is unavailable.")}</p><p>No investment signal can be generated until recent real history is available.</p></div>`;
      return;
    }
    const answer = buildQuestionAnswer(scored, news, parsed);
    renderQuestionAnswer(answer);
  } catch (error) {
    console.error(error);
    els.askAnswer.innerHTML = `<div class="empty-state">Could not complete the focused deep scan. Check the connection and try again.</div>`;
  } finally {
    isQuestionRunning = false;
    els.askButton.disabled = false;
  }
}

function buildQuestionAnswer(item, news, parsed) {
  const sellSignal = sellSignalFor(item);
  const holdSignal = holdSignalFor(item);
  const activeSources = Math.max(0, news.sources.filter((source) => source.ok).length - 1);
  const relevantItems = uniqueArticles((news.byTicker[item.ticker] || []).concat(item.outlooks || [], item.headlines || []));
  const links = relevantItems.filter((entry) => entry.link).slice(0, 5);
  let verdict = "Wait / watch";
  let className = "ask-verdict-watch";
  let summary = "The model does not see enough evidence for an urgent sell, but it also does not have enough strength for a high-conviction hold.";

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
    verdict,
    className,
    summary,
    score: item.score,
    stats: [
      ["Signal", item.setup?.signal || item.label],
      ["Signal strength", `${item.score}/100`],
      ["Timeframe", item.setup?.timeframe || "1-4 weeks"],
      ["Price", formatNumber(item.latest)],
      ["1M", formatPercent(item.oneMonth)],
      ["3M", formatPercent(item.threeMonth)],
      ["6M", formatPercent(item.sixMonth)],
      ["Entry", item.setup?.entryZone || "-"],
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
          <span>Model answer for ${escapeHtml(answer.company || answer.ticker)}</span>
          <h3>${escapeHtml(answer.verdict)}</h3>
        </div>
        <strong>${answer.score}/100</strong>
      </div>
      <p>${escapeHtml(answer.summary)}</p>
      <div class="stock-stats">
        ${answer.stats.map(([label, value]) => `<span>${escapeHtml(label)} ${escapeHtml(value)}</span>`).join("")}
      </div>
      <ul>${answer.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
      <div class="ask-source-line">${answer.activeSources} active trusted sources, ${answer.headlines} relevant headlines, ${answer.outlooks} outlook items in this focused scan.</div>
      ${answer.links.length ? `
        <div class="ask-links">
          ${answer.links.map((item) => `<a href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(item.source)}: ${escapeHtml(item.title)}</a>`).join("")}
        </div>
      ` : `<span class="muted-line">No article links matched this ticker directly; answer relies more on price action and broad market context.</span>`}
    </article>
  `;
}

function buildQuestionReasons(item, activeSources, outlookCount) {
  return [
    `Deep scan checked ${activeSources} active trusted sources from the ${trustedSourceUniverse.length}-source universe.`,
    `The focused scan found ${item.headlineSourceCount} direct headline sources and ${item.outlookSourceCount} trusted outlook sources for ${item.ticker}.`,
    `Trend check: ${item.latest > item.sma200 ? "above" : "below"} the 200-day average and ${item.latest > item.sma50 ? "above" : "below"} the 50-day average.`,
    `Recent market context included ${outlookCount} strategist/outlook items across the scan.`,
    item.flags[0] || item.reasons[0] || "No single dominant risk flag was detected."
  ].filter(Boolean);
}
