import { els } from "./dom.js";

const pages = {
  dashboard: "Overview",
  screener: "Watchlist",
  detail: "Stock details",
  portfolio: "Portfolio",
  "portfolio-performance": "Portfolio performance",
  reports: "Reports",
  "report-allocation": "Allocation report",
  "report-investments": "Investment performance",
  "report-funding": "Contributions and withdrawals",
  "report-transactions": "Transaction report",
  "report-etf": "ETF exposure",
  performance: "Research picks",
  ask: "Stock check",
  signals: "Signals",
  research: "Market & research",
  sources: "Data sources",
};
let previousPage = null;

export function syncActivePage() {
  const requested = String(window.location.hash || "").replace(/^#/, "") || "dashboard";
  const activePage = Object.hasOwn(pages, requested) ? requested : "dashboard";
  els.viewPages.forEach((page) => {
    const active = page.dataset.page === activePage;
    page.hidden = !active;
    page.classList.toggle("active", active);
  });
  els.pageLinks.forEach((link) => {
    const active = link.dataset.pageLink === activePage;
    link.classList.toggle("active", active || link.dataset.pageLink === "reports" && activePage.startsWith("report-"));
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  els.pageTitle.textContent = pages[activePage];
  const more = document.getElementById("navMore");
  if (more && !["dashboard", "screener", "portfolio", "portfolio-performance", "reports"].includes(activePage) && !activePage.startsWith("report-")) more.open = true;
  document.title = `${pages[activePage]} · Investing`;
  if (requested !== activePage) window.history.replaceState(null, "", `#${activePage}`);
  if (previousPage !== activePage) window.scrollTo?.({ top: 0, left: 0, behavior: "instant" });
  previousPage = activePage;
}

export function bindQuickSearch(analyzeTicker) {
  els.quickSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = els.quickSearchInput.value.trim();
    if (!value) {
      els.quickSearchInput.focus();
      return;
    }
    els.detailTickerInput.value = value;
    window.location.hash = "detail";
    syncActivePage();
    analyzeTicker();
  });
}
