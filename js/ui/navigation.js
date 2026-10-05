import { els } from "./dom.js";

const pages = {
  dashboard: ["Overview", "Your market, at a glance."],
  screener: ["Stock screener", "Discover the strongest setups in your watchlist."],
  detail: ["Stock detail", "A closer look at price action, risk, and research."],
  portfolio: ["My portfolio", "Your holdings, allocation, and market context."],
  ask: ["Ask the model", "Explore a stock with a focused market scan."],
  signals: ["Market signals", "Review the evidence behind buy, hold, and sell signals."],
  research: ["Research", "The sources and framework behind your market view."],
  sources: ["Data sources", "Follow the coverage behind each scan."],
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
  els.pageTitle.textContent = pages[activePage][0];
  els.pageDescription.textContent = pages[activePage][1];
  document.title = `${pages[activePage][0]} · Investing tool`;
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
