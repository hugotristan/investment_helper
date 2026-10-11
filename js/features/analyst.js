import { analystClient } from "../data/analyst-client.js";
import { cloudSession } from "../data/cloud-portfolio-store.js";
import { escapeHtml } from "../shared/text.js";

const el = (id) => document.getElementById(id);
const date = (value) => value ? String(value).slice(0, 10) : "Date unavailable";
const internalRoutes = new Set(["#portfolio", "#report-allocation", "#report-investments", "#portfolio-performance", "#sources", "#report-etf"]);
let initialized = false, busy = false, context = null, status = null, epoch = 0;

function controls() {
  el("analystAsk").disabled = busy || !status?.ready || !context || document.documentElement.dataset.privateBlocked === "true";
  el("analystRefresh").disabled = busy;
  el("analystQuestion").disabled = busy;
  el("analystIncludeNotes").disabled = busy;
  document.querySelectorAll("[data-analyst-question]").forEach((button) => { button.disabled = busy; });
  el("analystForm").setAttribute("aria-busy", String(busy));
}
function sourceUrl(url) {
  if (internalRoutes.has(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && ["finance.yahoo.com", "api.frankfurter.dev", "www.vanguard.co.uk"].includes(parsed.hostname)
      && !parsed.username && !parsed.password) return parsed.href;
  } catch { /* Unknown links are displayed as text. */ }
  return null;
}
function factsHtml(facts, sources, prefix) {
  return `<dl class="analyst-facts">${facts.map((fact, index) => {
    const linked = fact.sourceIds.map((id) => sources.find((source) => source.id === id)).filter(Boolean);
    return `<div id="${prefix}-${escapeHtml(fact.id)}" tabindex="-1"><dt><span class="analyst-fact-number">${index + 1}</span>${escapeHtml(fact.label)}</dt>
      <dd><strong>${escapeHtml(fact.display)}</strong><small>${escapeHtml(date(fact.asOf))} · ${internalRoutes.has(fact.route) ? `<a href="${escapeHtml(fact.route)}">Open report</a>` : "Recorded figure"}</small>
      <small>${linked.map((source) => { const url = sourceUrl(source.url); return url ? `<a href="${escapeHtml(url)}"${url.startsWith("https:") ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(source.name)}</a> · ${escapeHtml(date(source.asOf))}` : escapeHtml(source.name); }).join("; ")}</small></dd></div>`;
  }).join("")}</dl>`;
}
function renderAnswer(answer, question) {
  const byId = new Map(answer.facts.map((fact, index) => [fact.id, { ...fact, index }]));
  const paragraphs = answer.paragraphs.map((text) => escapeHtml(text).replace(/\{\{fact:([A-Za-z0-9.-]+)\}\}/g, (_, id) => {
    const fact = byId.get(id);
    return fact ? `<button type="button" class="analyst-citation" data-analyst-fact="${escapeHtml(id)}" aria-label="${escapeHtml(`${fact.display}; see supporting figure ${fact.index + 1}`)}">${escapeHtml(fact.display)}<sup>${fact.index + 1}</sup></button>` : "Figure unavailable";
  }));
  el("analystAnswer").innerHTML = `<div class="analyst-answer-heading"><h2>Answer</h2><button id="analystClear" type="button" class="ghost">Clear answer</button></div>
    <p class="analyst-asked">${escapeHtml(question)}</p>${paragraphs.map((text) => `<p>${text}</p>`).join("")}
    <p class="data-note">Portfolio revision ${escapeHtml(answer.portfolioRevision)} · Figures checked ${escapeHtml(date(answer.generatedAt))}.</p>
    ${answer.facts.length ? `<details id="analystEvidence" class="secondary-details"><summary>Supporting figures (${answer.facts.length})</summary>${factsHtml(answer.facts, answer.sources, "analyst-fact")}</details>` : ""}
    <details class="secondary-details"><summary>Data and calculation limits</summary><ul>${answer.limitations.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul></details>
    ${answer.followUpQuestions.length ? `<div class="analyst-examples">${answer.followUpQuestions.map((text) => `<button type="button" class="ghost" data-analyst-question="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("")}</div>` : ""}`;
  el("analystAnswer").hidden = false;
  el("analystClear").addEventListener("click", () => { el("analystAnswer").innerHTML = ""; el("analystAnswer").hidden = true; el("analystQuestion").focus(); });
}
async function refresh() {
  if (busy || !analystClient.isCloud) return;
  const ticket = ++epoch;
  busy = true; context = null; controls();
  el("analystStatus").textContent = "Checking the connection and portfolio figures…";
  el("analystFiguresBody").textContent = "Loading…";
  try {
    const [nextStatus, nextContext] = await Promise.all([analystClient.status(), analystClient.context()]);
    if (ticket !== epoch) return;
    status = nextStatus; context = nextContext;
    el("analystStatus").textContent = status.message;
    const selected = context.facts.filter((fact) => ["money-in", "total-value", "holdings-value", "cash", "usd-eur"].includes(fact.id));
    el("analystFiguresBody").innerHTML = factsHtml(selected, context.sources, "analyst-preview")
      + `<p class="data-note">Recorded revision ${escapeHtml(context.portfolioRevision)}. Missing values are withheld.</p>`;
  } catch (error) {
    if (ticket !== epoch) return;
    status = null;
    el("analystStatus").textContent = error.message;
    el("analystFiguresBody").textContent = "Portfolio figures could not be loaded.";
  } finally { if (ticket === epoch) { busy = false; controls(); } }
}

export function initializeAnalyst() {
  if (initialized || !el("analystForm")) return;
  initialized = true;
  if (!analystClient.isCloud) {
    el("analystStatus").textContent = "The AI analyst is available in the cloud app. This copy keeps your portfolio in this browser.";
    el("analystRefresh").hidden = true;
    el("analystCloudLink").hidden = false;
    controls();
    return;
  }
  el("analystRefresh").addEventListener("click", refresh);
  document.querySelector('[data-page="analyst"]').addEventListener("click", (event) => {
    const question = event.target.closest("[data-analyst-question]");
    if (question && !busy) { el("analystQuestion").value = question.dataset.analystQuestion; el("analystQuestion").focus(); }
    const citation = event.target.closest("[data-analyst-fact]");
    if (citation) { el("analystEvidence").open = true; const target = el(`analyst-fact-${citation.dataset.analystFact}`); target?.focus(); target?.scrollIntoView({ block: "center", behavior: "instant" }); }
  });
  el("analystForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = el("analystQuestion").value.trim();
    if (busy || !status?.ready || !context || !question) return;
    const ticket = ++epoch;
    busy = true; controls();
    el("analystStatus").textContent = "Reading the latest figures and answering your question…";
    try {
      const answer = await analystClient.ask(question, el("analystIncludeNotes").checked, context.portfolioRevision);
      if (ticket !== epoch) return;
      renderAnswer(answer, question);
      el("analystStatus").textContent = `${answer.remainingRequests} questions remaining today. Wait one minute between questions.`;
    } catch (error) {
      if (ticket !== epoch) return;
      el("analystStatus").textContent = error.message;
      if (error.code === "PORTFOLIO_CHANGED") context = null;
      if (error.code === "ANALYST_SETUP_REQUIRED") status = null;
    } finally { if (ticket === epoch) { busy = false; controls(); } }
  });
  cloudSession.subscribe((session) => {
    if (["ACCOUNT_CHANGED", "UNAUTHORIZED"].includes(session.errorCode)) {
      epoch++; busy = false; context = null; status = null;
      el("analystAnswer").innerHTML = ""; el("analystAnswer").hidden = true;
      el("analystFiguresBody").textContent = "Unlock the app to review your portfolio.";
      el("analystQuestion").value = "";
      el("analystStatus").textContent = session.message;
      controls();
    }
  });
  const onPage = () => { if (window.location.hash === "#analyst" && !context) refresh(); };
  window.addEventListener("hashchange", onPage);
  controls(); onPage();
}
