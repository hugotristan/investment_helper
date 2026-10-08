import { applyLearningSignal, scoreSeries } from "../analysis/scoring.js";
import { holdSignalFor, sellSignalFor } from "../analysis/signals.js";
import { validHistoryPoints } from "../analysis/data-quality.js";
import { applyQuoteSnapshot, loadMarketContext, loadMarketSeries, loadQuoteSnapshots } from "../data/market.js";
import { uniqueArticles } from "../data/news-helpers.js";
import { loadNewsSources } from "../data/news.js";
import { loadFundamentalsSnapshot } from "../data/fundamentals.js";
import { renderFundamentals } from "./fundamentals.js";
import { formatNumber, formatPercent } from "../shared/format.js";
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
  els.detailOutput.innerHTML = `<div class="empty-state">Loading prices, company data, and matched articles for ${escapeHtml(parsed.ticker)}…</div>`;

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
  const currency = item.currency || quote.currency || "";
  const dayRange = Number.isFinite(quote.dayLow) && Number.isFinite(quote.dayHigh) ? `${formatNumber(quote.dayLow)} – ${formatNumber(quote.dayHigh)}` : "Unavailable";
  const quoteTime = quote.quoteTime ? new Date(quote.quoteTime).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Quote time unavailable";
  const historyDate = new Date(item.dataQuality.asOf).toLocaleDateString();

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
      <dl class="key-values">
        ${renderMetric("Price", `${formatNumber(item.latest)} ${currency}`.trim(), quote.quoteTime ? `${quote.source || "Quote"} · ${quoteTime}` : `Daily history · ${historyDate}`)}
        ${renderMetric("1D", formatPercent(item.oneDay))}
        ${renderMetric("History as of", historyDate)}
        ${renderMetric("Event risk", item.eventRisk?.level || "Unavailable")}
      </dl>
      ${item.eventRisk?.level === "High" ? `<p class="data-note">High event risk: ${escapeHtml(item.eventRisk.hits?.join(", ") || item.flags?.[0] || "Review matched articles before acting.")}</p>` : ""}
      ${renderDetailChart(item)}
      ${fundamentals}
      <details class="secondary-details"><summary>Signal reasons and risks</summary><div class="detail-columns">
        <section>
          <span>Reasons</span>
          <ul>${(item.reasons || []).slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
        </section>
        <section>
          <span>Risk flags</span>
          <ul>${(item.flags || []).slice(0, 3).map((flag) => `<li>${escapeHtml(flag)}</li>`).join("")}</ul>
        </section>
      </div></details>
      <details class="secondary-details"><summary>Technical checks</summary>
        <dl class="key-values">
          ${renderMetric("1M / 6M", `${formatPercent(item.oneMonth)} / ${formatPercent(item.sixMonth)}`)}
          ${renderMetric("Day range", `${dayRange} ${currency}`, quoteTime)}
          ${renderMetric("Average daily traded value", `${compactValue(item.averageDollarVolume)} ${currency}`)}
          ${renderMetric("Exchange", quote.exchange || "Unavailable", quote.quoteType || "")}
          ${renderMetric("52W range", `${formatNumber(item.low52Week)} – ${formatNumber(item.high52Week)} ${currency}`)}
          ${renderMetric("SMA 50 / 200", `${formatNumber(item.sma50)} / ${formatNumber(item.sma200)}`, item.latest > item.sma200 ? "Above 200D" : "Below 200D")}
          ${renderMetric("RSI / MACD", `${Number.isFinite(item.rsi14) ? item.rsi14.toFixed(0) : "Unavailable"} / ${Number.isFinite(item.macd?.histogram) ? item.macd.histogram >= 0 ? "positive" : "negative" : "unavailable"}`)}
          ${renderMetric("ATR / Volatility", `${formatPercent(item.atrPercent)} / ${formatPercent(item.volatility)}`)}
        </dl>
        ${renderCategoryBars(item.categories)}
        <div class="setup-line">
          <span>Entry ${escapeHtml(item.setup?.entryZone || "-")}</span>
          <span>Invalidation ${escapeHtml(item.setup ? formatNumber(item.setup.invalidation) : "-")}</span>
          <span>Support ${escapeHtml(formatNumber(item.support))}</span>
          <span>Resistance ${escapeHtml(formatNumber(item.resistance))}</span>
        </div>
      </details>
      <details class="secondary-details"><summary>Matched articles (${links.length})</summary>
        <p class="data-note">Market: ${escapeHtml(marketContext.label)} · ${escapeHtml(quoteSnapshot?.label || "Quote data checked")}</p>
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
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}${note ? `<small>${escapeHtml(note)}</small>` : ""}</dd></div>`;
}

export function renderDetailChart(item) {
  const now = Date.now();
  const points = validHistoryPoints(item).filter((point) => new Date(point.date).getTime() <= now).slice(-252)
    .map((point) => ({ ...point }));
  const last = points.at(-1);
  const daily = item.dailyClose;
  // A quote can overlay the last daily bar. Restore the original observed daily
  // price rather than presenting an intraday quote as historical chart data.
  if (last && daily && new Date(daily.asOf).getTime() === new Date(last.date).getTime()
    && daily.currency === item.currency && Number.isFinite(daily.price) && daily.price > 0) last.close = daily.price;
  else if (last && /\+ Yahoo intraday/.test(item.source || "")) points.pop();
  if (points.length < 2) return '<p class="data-note">Daily price chart unavailable.</p>';
  const low = Math.min(...points.map((point) => point.close));
  const high = Math.max(...points.map((point) => point.close));
  const range = high - low || Math.max(high * 0.01, 1);
  const firstTime = new Date(points[0].date).getTime();
  const lastTime = new Date(points.at(-1).date).getTime();
  const path = points.map((point, index) => `${index ? "L" : "M"}${(10 + (new Date(point.date).getTime() - firstTime) / (lastTime - firstTime) * 700).toFixed(1)},${(160 - (point.close - low) / range * 145).toFixed(1)}`).join(" ");
  const firstDate = new Date(firstTime).toLocaleDateString();
  const lastDate = new Date(lastTime).toLocaleDateString();
  return `<figure class="detail-price-chart"><svg viewBox="0 0 720 175" role="img" aria-label="${escapeHtml(`${item.ticker} daily price history from ${firstDate} to ${lastDate}, ranging from ${formatNumber(low)} to ${formatNumber(high)} ${item.currency || ""}`)}"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" /></svg><figcaption class="chart-caption"><span>${escapeHtml(firstDate)} – ${escapeHtml(lastDate)}</span><span>Daily prices · ${escapeHtml(item.currency || "Currency unavailable")}</span></figcaption></figure>`;
}

function compactValue(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value) : "Unavailable";
}
