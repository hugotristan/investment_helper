import { analystClient } from "../data/analyst-client.js";
import { cloudSession } from "../data/cloud-portfolio-store.js";
import { loadStockHistories } from "../data/stock-history.js";
import { loadExchangeRate } from "../data/exchange-rate.js";
import { loadPortfolioFx } from "../data/portfolio-history.js";
import { getActivePortfolioBook } from "../portfolio-state.js";
import { projectPortfolioBook } from "../analysis/portfolio-ledger.js";
import { buildAnalystContext } from "../analysis/portfolio-context.js";
import { buildPortfolioInsights, portfolioChatGPTSummary } from "../analysis/portfolio-insights.js";
import { escapeHtml } from "../shared/text.js";

const date = (value) => value ? String(value).slice(0, 10) : "Date unavailable";
const internalRoutes = new Set(["#portfolio", "#report-allocation", "#report-investments", "#portfolio-performance", "#sources", "#report-etf"]);
function sourceUrl(url) {
  if (internalRoutes.has(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && ["finance.yahoo.com", "api.frankfurter.dev", "www.vanguard.co.uk"].includes(parsed.hostname)
      && !parsed.username && !parsed.password) return parsed.href;
  } catch { /* Unknown links are displayed as text. */ }
  return null;
}
function factsHtml(facts, sources) {
  return `<dl class="analyst-facts">${facts.map((fact) => {
    const linked = fact.sourceIds.map((id) => sources.find((source) => source.id === id)).filter(Boolean);
    return `<div><dt>${escapeHtml(fact.label)}</dt><dd><strong>${escapeHtml(fact.display)}</strong><small>${escapeHtml(date(fact.asOf))}</small>
      <small>${linked.map((source) => { const url = sourceUrl(source.url); return url ? `<a href="${escapeHtml(url)}"${url.startsWith("https:") ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(source.name)}</a> · ${escapeHtml(date(source.asOf))}` : escapeHtml(source.name); }).join("; ")}</small></dd></div>`;
  }).join("")}</dl>`;
}
async function localContext(includeNotes) {
  const book = getActivePortfolioBook();
  if (!book) throw new Error("Start portfolio tracking in Portfolio to see your insights.");
  const projection = projectPortfolioBook(book);
  const tickers = [...new Set([...projection.holdings.map((holding) => holding.ticker).slice(0, 40),
    ...book.transactions.map((entry) => entry.ticker).filter(Boolean)])].slice(0, 59);
  const [histories, exchangeRate, fxHistory] = await Promise.all([loadStockHistories([...tickers, "SPY"]), loadExchangeRate(), loadPortfolioFx()]);
  if (getActivePortfolioBook() !== book) throw new Error("Your portfolio changed while loading. Refresh the figures.");
  return buildAnalystContext({ book, revision: book.updatedAt, histories, exchangeRate, fxHistory, includeNotes });
}

export function createPortfolioInsightsController({ document: doc = globalThis.document, window: win = globalThis.window,
  client = analystClient, session = cloudSession, loadLocalContext = localContext, clipboard = globalThis.navigator?.clipboard } = {}) {
  const el = (id) => doc.getElementById(id);
  let context = null, sections = [], topic = "overview", busy = false, epoch = 0;
  const blocked = () => doc.documentElement.dataset.privateBlocked === "true";
  const setStatus = (text) => { el("insightsStatus").textContent = text; };
  function controls() {
    el("insightsRefresh").disabled = busy || blocked();
    el("insightsPrepare").disabled = busy || blocked();
    el("insightsCopy").disabled = busy || blocked() || !el("insightsSummary").value;
    el("insightsIncludeNotes").disabled = busy || blocked();
    el("insightsExportQuestion").disabled = busy || blocked();
    el("insightsPanel").setAttribute("aria-busy", String(busy));
  }
  function clearSummary() {
    el("insightsSummary").value = "";
    el("insightsSummaryLabel").hidden = true;
    el("insightsSummary").hidden = true;
    el("insightsChatGPTLink").hidden = true;
    el("insightsExportStatus").textContent = "";
    controls();
  }
  function render() {
    const selected = sections.find((section) => section.id === topic);
    doc.querySelectorAll("[data-insight-topic]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.insightTopic === topic)));
    if (!selected || !context) return;
    el("insightsBody").innerHTML = `<h3>${escapeHtml(selected.title)}</h3>${selected.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join("")}
      <a class="insights-report-link" href="${selected.route}">Open ${topic === "overview" ? "portfolio" : "report"} ↗</a>
      ${selected.facts.length ? `<details class="secondary-details"><summary>Supporting figures (${selected.facts.length})</summary>${factsHtml(selected.facts, context.sources)}</details>` : ""}`;
    el("insightsLimits").innerHTML = context.limitations.map((text) => `<li>${escapeHtml(text)}</li>`).join("");
  }
  const load = (notes) => client.isCloud ? client.context(notes) : loadLocalContext(notes);
  async function refresh({ summary = false } = {}) {
    if (busy || blocked()) return;
    const ticket = ++epoch;
    busy = true; context = null; sections = []; clearSummary(); controls();
    el("insightsBody").textContent = "Loading portfolio figures…";
    el("insightsLimits").innerHTML = "";
    setStatus("Reading your saved portfolio and dated market data…");
    try {
      const next = await load(summary && el("insightsIncludeNotes").checked);
      if (ticket !== epoch || blocked()) return;
      context = next; sections = buildPortfolioInsights(context); render();
      setStatus(`Figures checked ${date(context.generatedAt)}. Current quotes and historical daily closes can differ.`);
      if (summary) {
        el("insightsSummary").value = portfolioChatGPTSummary(context, { includeNotes: el("insightsIncludeNotes").checked, question: el("insightsExportQuestion").value });
        el("insightsSummaryLabel").hidden = false;
        el("insightsSummary").hidden = false;
        el("insightsChatGPTLink").hidden = false;
        el("insightsExportStatus").textContent = "Review the summary, copy it, then paste it into ChatGPT. Nothing is sent automatically.";
      }
    } catch (error) {
      if (ticket !== epoch) return;
      context = null; sections = [];
      setStatus(error.message);
      el("insightsBody").textContent = "Portfolio insights could not be loaded. Your saved transactions are available in Portfolio.";
    } finally { if (ticket === epoch) { busy = false; controls(); } }
  }
  async function copy() {
    if (busy || blocked() || !el("insightsSummary").value) return;
    const ticket = epoch, text = el("insightsSummary").value;
    try {
      if (!clipboard?.writeText) throw new Error("Clipboard unavailable");
      await clipboard.writeText(text);
      if (ticket === epoch && !blocked()) el("insightsExportStatus").textContent = "Summary copied. Paste it into ChatGPT when you are ready.";
    } catch {
      if (ticket !== epoch || blocked()) return;
      el("insightsSummary").focus(); el("insightsSummary").select();
      el("insightsExportStatus").textContent = "Automatic copying is unavailable. The summary is selected; copy it manually.";
    }
  }
  function invalidate(message = "Refresh the figures to review your latest portfolio.") {
    epoch++; busy = false; context = null; sections = [];
    el("insightsBody").textContent = "Figures need refreshing.";
    el("insightsLimits").innerHTML = "";
    clearSummary(); setStatus(message);
    if (win.location.hash === "#analyst" && !blocked()) void refresh();
  }
  function initialize() {
    if (!el("insightsPanel")) return;
    el("insightsRefresh").addEventListener("click", () => refresh());
    el("insightsPrepare").addEventListener("click", () => refresh({ summary: true }));
    el("insightsCopy").addEventListener("click", copy);
    el("insightsIncludeNotes").addEventListener("change", clearSummary);
    el("insightsExportQuestion").addEventListener("input", clearSummary);
    doc.querySelectorAll("[data-insight-topic]").forEach((button) => button.addEventListener("click", () => { topic = button.dataset.insightTopic; render(); }));
    session.subscribe((value) => {
      if (["ACCOUNT_CHANGED", "UNAUTHORIZED"].includes(value.errorCode)) {
        epoch++; busy = false; context = null; sections = [];
        el("insightsBody").textContent = "Unlock the app to see your insights.";
        el("insightsLimits").innerHTML = "";
        el("insightsExportQuestion").value = ""; el("insightsIncludeNotes").checked = false;
        clearSummary(); setStatus(value.message);
      }
    });
    const onPage = () => { if (win.location.hash === "#analyst") void refresh(); };
    win.addEventListener("hashchange", onPage);
    win.addEventListener("focus", onPage);
    controls(); onPage();
  }
  return { initialize, refresh, copy, invalidate };
}
let controller;
export function initializeAnalyst() { controller ||= createPortfolioInsightsController(); controller.initialize(); }
export function refreshPortfolioInsights() { controller?.invalidate(); }
