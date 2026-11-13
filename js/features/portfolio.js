import {technicalSignalFor,TECHNICAL_EXPLANATION} from "../analysis/technical-policy.js";
import {renderDataConfidence} from "../ui/components.js";
import { broadFunds } from "../config/settings.js";
import { calculateHoldings } from "../analysis/holdings.js";
import { calculatePortfolioTotals } from "../analysis/portfolio-totals.js";
import { holdingEurReturn } from "../analysis/portfolio-returns.js";
import { sortPortfolioHoldings } from "../analysis/portfolio-sort.js";
import { positionKey, positionOrganization } from "../analysis/portfolio-organization.js";
import { renderPortfolioAnalytics } from "./portfolio-analytics.js";
import { renderAllocationReport } from "./report-allocation.js";
import { renderEtfReport } from "./report-etf.js";
import { renderRetirementReport } from "./report-retirement.js";
import { getExchangeRate, normalizeExchangeRate } from "../data/exchange-rate.js";
import { formatNumber, formatPercent } from "../shared/format.js";
import { portfolioMoney } from "../shared/portfolio-money.js";
import { escapeHtml } from "../shared/text.js";
import { state } from "../storage.js";
import { getActivePortfolioBook, getPortfolioProjection } from "../portfolio-state.js";
import { els } from "../ui/dom.js";

const SORT_KEY = "investment-helper-portfolio-sort";
let portfolioSort = { by: "size", direction: "desc" };
let sortBound = false;

export function bindPortfolioSorting(onChange) {
  const by = document.getElementById("portfolioSortBy");
  const direction = document.getElementById("portfolioSortDirection");
  if (!by || !direction || sortBound) return;
  sortBound = true;
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY));
    if (["size", "performance", "name"].includes(saved?.by) && ["asc", "desc"].includes(saved?.direction)) portfolioSort = saved;
  } catch { /* A view preference must never prevent the portfolio from loading. */ }
  by.value = portfolioSort.by;
  direction.value = portfolioSort.direction;
  const changed = () => {
    portfolioSort = { by: by.value, direction: direction.value };
    try { localStorage.setItem(SORT_KEY, JSON.stringify(portfolioSort)); } catch { /* Session sorting still works. */ }
    onChange();
  };
  by.addEventListener("change", changed);
  direction.addEventListener("change", changed);
}

export function buildPortfolioReview(results, marketContext) {
  const calculated = calculateHoldings(getPortfolioHoldings(), results);
  const returnOptions = { eurCostBases: getPortfolioProjection()?.eurCostBases, exchangeRate: getExchangeRate() };
  const byTicker = new Map(results.map((item) => [item.ticker, item]));
  const byCurrency = new Map(calculated.groups.map((group) => [group.currency, group]));
  const enriched = calculated.holdings.map((holding) => {
    const item = byTicker.get(holding.ticker);
    const group = byCurrency.get(holding.currency);
    const eur = holdingEurReturn(holding, returnOptions);
    return {
      ...holding,
      label: holding.label === holding.ticker ? item?.quote?.name || holding.label : holding.label,
      eur,
      status: eur.gain === null ? holding.status : gainStatus(eur.gain),
      weight: group?.complete ? holding.weight : null,
      analysis: item || null,
      isCore: Boolean(item?.isFund) || broadFunds.has(holding.ticker) || /vanguard|ftse|all-world|index|etf/i.test(holding.label)
    };
  });
  enriched.forEach((holding) => { holding.review = portfolioHoldingReview(holding, marketContext); });
  const groups = calculated.groups.map((group) => {
    const holdings = enriched.filter((holding) => holding.currency === group.currency);
    const coreValue = holdings.filter((holding) => holding.isCore).reduce((sum, holding) => sum + (holding.currentValue || 0), 0);
    return { ...group, holdings, coreValue, stockValue: group.total === null ? null : group.total - coreValue };
  });
  const onlyGroup = groups.length === 1 ? groups[0] : null;
  const downCount = enriched.filter((holding) => holding.status === "down").length;
  return {
    holdings: enriched,
    groups,
    total: onlyGroup?.total ?? null,
    coreValue: onlyGroup?.coreValue ?? null,
    stockValue: onlyGroup?.stockValue ?? null,
    largest: onlyGroup ? onlyGroup.holdings.reduce((best, holding) => !best || holding.currentValue > best.currentValue ? holding : best, null) : null,
    missingCount: calculated.missingCount,
    downCount
  };
}

function portfolioHoldingReview(holding,marketContext) {
  const item = holding.analysis, signal = technicalSignalFor(item);
  const concentration = Number.isFinite(holding.weight) && holding.weight > 10
    ? ' Position concentration is '+holding.weight.toFixed(1)+'% of its tracked currency group; this is separate from the technical signal.' : '';
  return {label:signal.label,
    className:['review','weak'].includes(signal.key)?'holding-danger':['favorable','constructive'].includes(signal.key)?'holding-good':'holding-watch',
    reason:item?.dataQuality?.eligible ? 'Technical Score '+item.score+'/100 from completed daily observations.' : item?.dataQuality?.reason || 'Qualified technical data is unavailable.',
    detail:TECHNICAL_EXPLANATION+concentration+(marketContext?.available===false?' Broader market context is unavailable.':'')};
}

export function renderPortfolioReview(portfolio, priceSource, { now = Date.now(), exchangeRate = getExchangeRate({ now }), projection = getPortfolioProjection(), sort = portfolioSort } = {}) {
  const rate = normalizeExchangeRate(exchangeRate, { now });
  const displayHoldings = portfolio.holdings.map((holding) => {
    const eur = holdingEurReturn(holding, { eurCostBases: projection?.eurCostBases, exchangeRate: rate });
    const organization = getActivePortfolioBook()?.organization;
    const annotation = positionOrganization(organization, holding);
    return { ...holding, eur, annotation, groupName: organization?.groups.find((group) => group.id === annotation.groupId)?.name || "",
      status: eur.gain === null ? holding.status : gainStatus(eur.gain) };
  });
  const groups = portfolio.groups.map((group) => {
    const holdings = sortPortfolioHoldings(displayHoldings.filter((holding) => holding.currency === group.currency), sort);
    const sumKnown = (key) => holdings.every((holding) => Number.isFinite(holding.eur[key]))
      ? holdings.reduce((sum, holding) => sum + holding.eur[key], 0) : null;
    return { ...group, holdings, eurCostBasis: sumKnown("costBasis"), eurGain: sumKnown("gain") };
  });
  renderPortfolioTotals(portfolio.holdings, rate, now);
  renderPortfolioAnalytics(displayHoldings);
  renderAllocationReport(displayHoldings);
  renderEtfReport(displayHoldings);
  renderRetirementReport(portfolio.holdings, rate);
  if (!portfolio.holdings.length) {
    els.portfolioReview.innerHTML = `<div class="empty-state">Add a holding to track its value and gain or loss.</div>`;
    return;
  }
  const sourceWarning = priceSource === "sample"
    ? '<p class="data-note">Sample prices cannot value holdings or support position signals. Legacy amounts remain as entered.</p>'
    : "";
  const money = (value, currency, signed = false, eurValue) => portfolioMoney(
    currency === "EUR" && eurValue !== undefined ? eurValue : value, currency,
    { exchangeRate: rate, signed, ...(eurValue !== undefined ? { eurValue } : {}) });
  const currencyNote = portfolio.groups.some((group) => group.currency === "USD")
    ? `<p class="data-note">${rate ? `Current EUR values use the ${escapeHtml(rate.date)} reference rate from the ECB. EUR costs use recorded purchase payments, including fees; EUR gains include currency changes.`
      : "EUR equivalents are unavailable because a recent exchange rate could not be loaded. USD values remain visible."}</p>` : "";
  const costNote = displayHoldings.some((holding) => holding.kind !== "manual" && holding.eur.costBasis === null)
    ? '<p class="data-note">EUR purchase costs are missing for some positions. Add the actual EUR cash paid in their buy transactions. Foreign opening positions need their purchase history to show an exact EUR return.</p>' : "";
  const groupOpenStates = new Map(Array.from(els.portfolioReview.querySelectorAll?.(":scope > details[data-portfolio-currency]") || [],
    (group) => [group.dataset.portfolioCurrency, group.open]));
  els.portfolioReview.innerHTML = `
    ${sourceWarning}
    ${currencyNote}
    ${costNote}
    ${groups.map((group) => `<details class="portfolio-currency-group" data-portfolio-currency="${escapeHtml(group.currency)}"${groupOpenStates.get(group.currency) === false ? "" : " open"}>
      <summary class="control-summary"><strong>${escapeHtml(group.currency)} holdings</strong></summary>
      <div class="portfolio-summary">
        <article><span>${group.complete ? "Tracked value" : "Known tracked value"}</span><strong>${escapeHtml(money(group.total, group.currency))}</strong></article>
        <article><span>Cost basis</span><strong>${escapeHtml(money(group.costBasis, group.currency, false, group.eurCostBasis))}</strong></article>
        <article><span>Unrealized gain / loss</span><strong>${escapeHtml(money(group.gain, group.currency, true, group.eurGain))}</strong></article>
      </div>
      ${group.legacyCount ? `<p class="data-note">${group.legacyCount} legacy amount${group.legacyCount === 1 ? " is" : "s are"} included as entered. Group cost basis and gain / loss need share quantities and purchase prices for every holding.</p>` : ""}
      <div class="holding-grid">${group.holdings.map((holding) => renderHoldingCard(holding, money)).join("")}</div>
    </details>`).join("")}
  `;
}

function renderPortfolioTotals(holdings, exchangeRate, now) {
  const target = globalThis.document?.getElementById("portfolioTotals");
  if (!target) return;
  const totals = calculatePortfolioTotals({ holdings, book: getActivePortfolioBook(),
    projection: getPortfolioProjection(), exchangeRate, now });
  target.innerHTML = `<article><span>Money put in</span><strong>${escapeHtml(portfolioMoney(totals.contributed, "EUR"))}</strong></article>
    <article><span>Total value</span><strong>${escapeHtml(portfolioMoney(totals.totalValue, "EUR"))}</strong></article>
    ${totals.reasons.length ? `<p class="portfolio-total-note">${totals.reasons.slice(0, 2).map(escapeHtml).join(" ")}</p>` : ""}`;
}

function renderHoldingCard(holding, money) {
  const item = holding.analysis;
  const manual = holding.kind === "manual";
  const status = holding.status === "down" ? "In loss" : holding.status === "up" ? "In profit" : holding.status === "flat" ? "At cost" : "Gain / loss unavailable";
  const returnPercent = holding.eur.gainPercent ?? (holding.eur.costBasis === null ? holding.gainPercent : null);
  const returnCurrency = holding.eur.costBasis === null ? holding.currency : "EUR";
  const values = manual
    ? `<div><span>Entered amount</span><strong>${escapeHtml(money(holding.amount, holding.currency))}</strong></div>`
    : `<div><span>Shares</span><strong>${escapeHtml(quantity(holding.shares))}</strong></div>
      <div><span>Average purchase</span><strong>${escapeHtml(money(holding.averageCost, holding.currency, false, holding.eur.costBasis === null ? null : holding.eur.costBasis / holding.shares))}</strong></div>
      <div><span>Cost basis</span><strong>${escapeHtml(money(holding.costBasis, holding.currency, false, holding.eur.costBasis))}</strong></div>
      <div><span>Current value</span><strong>${escapeHtml(money(holding.currentValue, holding.currency))}</strong></div>
      <div><span>Unrealized gain / loss</span><strong>${escapeHtml(money(holding.gain, holding.currency, true, holding.eur.gain))}${Number.isFinite(returnPercent) ? ` <small>${escapeHtml(formatPercent(returnPercent))} ${escapeHtml(returnCurrency)}</small>` : ""}</strong></div>`;
  return `
    <article class="holding-card ${holding.review.className}">
      <div class="holding-head">
        <div>
          <span>${escapeHtml(manual ? `Manual status: ${holding.status}` : holding.eur.gain === null && holding.currency !== "EUR" ? `${holding.currency}: ${status} · EUR return unavailable` : status)}</span>
          <h3>${escapeHtml(holding.label || holding.ticker)}</h3>
        </div>
        <strong>${Number.isFinite(holding.weight) ? `${holding.weight.toFixed(1)}%` : "Weight unavailable"}</strong>
      </div>
      <p class="muted-line">${escapeHtml(holding.ticker)} · ${escapeHtml(holding.currency)}${holding.groupName ? ` · ${escapeHtml(holding.groupName)}` : ""}</p>
      <div class="holding-values">${values}</div>
      <p class="data-note">${manual ? "Legacy amount stays as entered. Edit its opening position to add shares and average purchase price." : Number.isFinite(holding.price)
        ? `Price ${escapeHtml(money(holding.price, holding.currency))} · ${holding.source === "quote" ? "quote" : "daily close"} as of ${escapeHtml(holdingDate(holding.asOf))}`
        : escapeHtml(holding.valuationError || "A qualified price in the purchase currency is unavailable.")}</p>
      <details class="secondary-details"><summary>Position checks · ${escapeHtml(holding.review.label)}</summary>
        <p>${escapeHtml(holding.review.reason)} ${escapeHtml(holding.review.detail)}</p>
        ${item?.dataQuality?.eligible ? renderDataConfidence(item,{compact:true})+`<dl class="key-values"><div><dt>Technical Score v2</dt><dd>${item.score}/100</dd></div><div><dt>1M</dt><dd>${formatPercent(item.oneMonth)}</dd></div><div><dt>Technical risk</dt><dd>${escapeHtml(item.setup?.riskLevel || "Unavailable")}</dd></div></dl>` : ""}
      </details>
      ${holding.annotation.note ? `<details class="secondary-details"><summary>Note</summary><p class="portfolio-position-note">${escapeHtml(holding.annotation.note)}</p></details>` : ""}
      ${getActivePortfolioBook() ? `<div class="holding-actions"><button type="button" class="ghost" data-portfolio-transactions>View transactions</button><button type="button" class="ghost" data-portfolio-note="${escapeHtml(positionKey(holding))}">Group &amp; note</button></div>` : `<button type="button" class="ghost" data-edit-holding="${escapeHtml(holding.id)}">Edit holding</button>`}
    </article>
  `;
}

function gainStatus(gain) { return gain > 0 ? "up" : gain < 0 ? "down" : "flat"; }

export function getPortfolioHoldings() {
  if (getPortfolioProjection()) return getPortfolioProjection().holdings;
  if (Array.isArray(state.holdings)) return state.holdings;
  return parsePortfolioPositions(state.myPortfolioInput).map((holding, index) => ({
    ...holding, id: `legacy-${index}`, kind: "manual", currency: state.currency || "EUR"
  }));
}

function quantity(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(value) : "Unavailable";
}

function holdingDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable";
}

export function parsePortfolioPositions(value) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[|,\t]+/).map((part) => part.trim()).filter(Boolean);
      const ticker = String(parts[0] || "")
        .toUpperCase()
        .replace(/[^A-Z0-9.^-]/g, "");
      const label = parts[1] && !/^\d/.test(parts[1]) ? parts[1] : ticker;
      const amountPart = parts.find((part, index) => index > 0 && /[\d]/.test(part) && Number.isFinite(parseMoneyNumber(part)));
      const amount = parseMoneyNumber(amountPart);
      const statusText = parts.join(" ").toLowerCase();
      const status = /\b(up|profit|green|positive)\b/.test(statusText)
        ? "up"
        : /\b(down|loss|red|negative)\b/.test(statusText)
          ? "down"
          : "unknown";
      return ticker && amount > 0 ? { ticker, label, amount, status } : null;
    })
    .filter(Boolean);
}

function parseMoneyNumber(value) {
  const cleaned = String(value || "").replace(/[^0-9.,-]/g, "").replace(",", ".");
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : 0;
}
