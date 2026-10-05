import { applyLearningSignal, scoreSeries } from "../analysis/scoring.js";
import { holdSignalFor, sellSignalFor } from "../analysis/signals.js";
import { applyQuoteSnapshot, loadMarketContext, loadMarketSeries, loadQuoteSnapshots } from "../data/market.js";
import { uniqueArticles } from "../data/news-helpers.js";
import { loadNewsSources } from "../data/news.js";
import { loadFundamentalsSnapshot } from "../data/fundamentals.js";
import { renderFundamentals } from "./fundamentals.js";
import { compactMoney, formatNumber, formatPercent } from "../shared/format.js";
import { isBlockedAssetTicker, parseDetailTicker } from "../shared/symbols.js";
import { dateValue, escapeHtml, unique } from "../shared/text.js";
import { persist, state } from "../storage.js";
import { renderCategoryBars } from "../ui/components.js";
import { els, showToast } from "../ui/dom.js";

let isDetailRunning = false;

export async function runStockDetail() {
  if (isDetailRunning) {
    showToast("Stock detail scan is already running");
    return;
  }

  const parsed = parseDetailTicker(els.detailTickerInput.value);
  if (!parsed.ticker) {
    els.detailOutput.innerHTML = `<div class="empty-state">Enter a ticker, like MSFT, NVDA, VTI, or INTC.</div>`;
    return;
  }
  if (isBlockedAssetTicker(parsed.ticker)) {
    els.detailOutput.innerHTML = `<div class="empty-state">That asset type is outside this stock-and-ETF version. Use a stock or ETF ticker.</div>`;
    return;
  }

  isDetailRunning = true;
  state.detailTicker = parsed.ticker;
  persist();
  els.detailTickerInput.value = parsed.ticker;
  els.detailButton.disabled = true;
  els.detailOutput.innerHTML = `<div class="empty-state">Fetching live quote, one-year chart history, market context, and trusted-source evidence for ${escapeHtml(parsed.ticker)}...</div>`;

  try {
    const contextTickers = unique([parsed.ticker, "SPY", "QQQ", "VTI"]);
    const [series, quotes, news, marketContext, fundamentals] = await Promise.all([
      loadMarketSeries(parsed.ticker),
      loadQuoteSnapshots([parsed.ticker]),
      loadNewsSources(contextTickers, { allowCache: false }),
      loadMarketContext(),
      loadFundamentalsSnapshot()
    ]);
    const scored = applyLearningSignal(scoreSeries(applyQuoteSnapshot(series, quotes.byTicker), news.byTicker[series.ticker] || news.byTicker[parsed.ticker] || []));
    await renderStockDetail(scored, news, marketContext, quotes, fundamentals);
  } catch (error) {
    console.error(error);
    els.detailOutput.innerHTML = `<div class="empty-state">Could not complete the stock detail scan. Check the connection and try again.</div>`;
  } finally {
    isDetailRunning = false;
    els.detailButton.disabled = false;
  }
}

async function renderStockDetail(item, news, marketContext, quoteSnapshot, snapshot) {
  const quote = item.quote || {};
  const fundamentals = await renderFundamentals(item, snapshot);
  if (!item.dataQuality?.eligible) {
    els.detailOutput.innerHTML = `<div class="empty-state"><h3>${escapeHtml(item.ticker)} · Analysis unavailable</h3><p>${escapeHtml(item.dataQuality?.reason || "Qualified price history is unavailable.")}</p>${Number.isFinite(quote.price) ? `<p>Latest quote ${formatNumber(quote.price)} ${escapeHtml(quote.currency || "")} · ${escapeHtml(quote.quoteTime?.toLocaleString() || "Timestamp unavailable")}</p>` : ""}<p>No buy, hold, or sell recommendation is generated from this data.</p></div>`;
    els.detailOutput.insertAdjacentHTML("beforeend", fundamentals);
    return;
  }
  const links = uniqueArticles((news.byTicker[item.ticker] || []).concat(item.outlooks || [], item.headlines || []))
    .map((entry) => ({ ...entry, safeUrl: safeArticleUrl(entry.link) }))
    .filter((entry) => entry.safeUrl)
    .sort((a, b) => Number(Boolean(b.directTickers?.includes(item.ticker))) - Number(Boolean(a.directTickers?.includes(item.ticker))))
    .slice(0, 8);
  const sellSignal = sellSignalFor(item);
  const holdSignal = holdSignalFor(item);
  const currentVerdict = sellSignal?.label || holdSignal?.label || item.setup?.signal || item.label;
  const dayRange = quote.dayLow && quote.dayHigh ? `${formatNumber(quote.dayLow)} - ${formatNumber(quote.dayHigh)}` : "-";
  const quoteTime = quote.quoteTime ? quote.quoteTime.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "latest chart point";

  els.detailOutput.innerHTML = `
    <article class="detail-card ${item.score >= 75 ? "grade-good" : item.score >= 60 ? "grade-watch" : item.score >= 45 ? "grade-mixed" : "grade-avoid"}">
      <div class="detail-hero">
        <div>
          <span>${escapeHtml(quote.name || item.ticker)}</span>
          <h3>${escapeHtml(item.ticker)}</h3>
          <p>${escapeHtml(currentVerdict)}</p>
        </div>
        <strong>${item.score}/100</strong>
      </div>
      <div class="detail-metrics">
        ${renderMetric("Last price", `${formatNumber(item.latest)} ${quote.currency || ""}`.trim(), quote.marketState || "Yahoo intraday/chart")}
        ${renderMetric("Today", formatPercent(item.oneDay), quote.dayChange ? formatNumber(quote.dayChange) : "daily move")}
        ${renderMetric("1M / 6M", `${formatPercent(item.oneMonth)} / ${formatPercent(item.sixMonth)}`, "trend")}
        ${renderMetric("Event risk", item.eventRisk?.level || "Low", item.eventRisk?.hits?.join(", ") || "headline scan")}
      </div>
      ${fundamentals}
      <div class="detail-columns">
        <section>
          <span>Reasons</span>
          <ul>${item.reasons.slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
        </section>
        <section>
          <span>Risk flags</span>
          <ul>${item.flags.slice(0, 3).map((flag) => `<li>${escapeHtml(flag)}</li>`).join("")}</ul>
        </section>
      </div>
      <details class="analysis-disclosure"><summary>Technical metrics &amp; scoring</summary>
        <div class="detail-metrics">
          ${renderMetric("Day range", dayRange, quoteTime)}
          ${renderMetric("Volume", compactMoney(item.latest * (quote.volume || item.averageVolume60)), "latest dollar volume")}
          ${renderMetric("Avg liquidity", compactMoney(item.averageDollarVolume), "average dollar volume")}
          ${renderMetric("Exchange", quote.exchange || "-", quote.currency || quote.quoteType || "metadata")}
          ${renderMetric("52W range", `${formatNumber(item.low52Week)} - ${formatNumber(item.high52Week)}`, "quote/chart")}
          ${renderMetric("SMA 50 / 200", `${formatNumber(item.sma50)} / ${formatNumber(item.sma200)}`, item.latest > item.sma200 ? "above 200D" : "below 200D")}
          ${renderMetric("RSI / MACD", `${Number.isFinite(item.rsi14) ? item.rsi14.toFixed(0) : "-"} / ${item.macd?.histogram >= 0 ? "positive" : "negative"}`, "momentum")}
          ${renderMetric("ATR / Vol", `${formatPercent(item.atrPercent)} / ${formatPercent(item.volatility)}`, "risk")}
        </div>
        ${renderCategoryBars(item.categories)}
        <div class="setup-line">
          <span>Entry ${escapeHtml(item.setup?.entryZone || "-")}</span>
          <span>Invalidation ${escapeHtml(item.setup ? formatNumber(item.setup.invalidation) : "-")}</span>
          <span>Support ${escapeHtml(formatNumber(item.support))}</span>
          <span>Resistance ${escapeHtml(formatNumber(item.resistance))}</span>
        </div>
      </details>
      <details class="analysis-disclosure"><summary>Company evidence &amp; market context (${links.length})</summary>
        <div class="setup-line"><span>Market ${escapeHtml(marketContext.label)}</span><span>${escapeHtml(quoteSnapshot?.label || "Quote data checked")}</span></div>
        <div class="detail-sources">
          ${links.length ? links.map((entry) => `<div class="detail-source-entry"><a href="${escapeHtml(entry.safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.source)}: ${escapeHtml(entry.title)}</a>
            <small>${escapeHtml(evidenceScope(entry, item.ticker))} · Published ${escapeHtml(articleDateLabel(entry.pubDate))}</small></div>`).join("") : '<p>No usable company or market source links matched this ticker in this scan.</p>'}
        </div>
      </details>
    </article>
  `;
}

function evidenceScope(entry, ticker) {
  if (entry.directTickers?.includes(ticker)) return "Direct company evidence";
  if (entry.sectorTickers?.includes(ticker)) return "Sector context";
  return "Market context";
}

function articleDateLabel(value) {
  const normalized = String(value || "").replace(/^(\d{8})T(\d{6})Z?$/, "$1$2");
  const time = dateValue(normalized);
  return time ? new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Date unavailable";
}

function safeArticleUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}

function renderMetric(label, value, note = "") {
  return `
    <article class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </article>
  `;
}
