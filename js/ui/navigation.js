import { els } from "./dom.js";

const pages = {
  dashboard: "Overview",
  screener: "Watchlist",
  detail: "Stock details",
  portfolio: "Portfolio",
  performance: "Performance",
  ask: "Stock check",
  signals: "Signals",
  research: "Market & research",
  sources: "Data sources",
};

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
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  els.pageTitle.textContent = pages[activePage];
  const more = document.getElementById("navMore");
  if (more && !["dashboard", "screener", "portfolio", "performance"].includes(activePage)) more.open = true;
  document.title = `${pages[activePage]} · Investing`;
  if (requested !== activePage) window.history.replaceState(null, "", `#${activePage}`);
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
