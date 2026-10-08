import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

function node(dataset = {}) {
  const classes = new Set();
  return { dataset, hidden: false, open: false, textContent: "", value: "", attributes: {}, handlers: {},
    classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name) },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    focus() { this.focused = true; } };
}

const routes = ["dashboard", "screener", "portfolio", "performance", "detail", "research", "signals", "ask", "sources"];
const pages = routes.map((page) => node({ page }));
const links = routes.map((pageLink) => node({ pageLink }));
const nodes = new Map(["pageTitle", "navMore", "quickSearchForm", "quickSearchInput", "detailTickerInput"].map((id) => [id, node()]));
const replaced = [];
globalThis.document = { title: "", getElementById: (id) => nodes.get(id) || null,
  querySelectorAll: (selector) => selector === "[data-page]" ? pages : selector === "[data-page-link]" ? links : [] };
let hash = "";
globalThis.window = { location: { get hash() { return hash; }, set hash(value) { hash = value ? `#${String(value).replace(/^#/, "")}` : ""; } },
  history: { replaceState: (...args) => replaced.push(args) } };
const { syncActivePage, bindQuickSearch } = await import("../js/ui/navigation.js");

beforeEach(() => {
  window.location.hash = "";
  nodes.get("navMore").open = false;
  nodes.get("quickSearchInput").value = "";
  nodes.get("quickSearchInput").focused = false;
  replaced.length = 0;
});

test("direct links show exactly one page and reveal secondary navigation when needed", () => {
  for (const route of routes) {
    window.location.hash = `#${route}`;
    syncActivePage();
    assert.deepEqual(pages.filter((page) => !page.hidden).map((page) => page.dataset.page), [route]);
    assert.deepEqual(links.filter((link) => link.attributes["aria-current"] === "page").map((link) => link.dataset.pageLink), [route]);
    assert.equal(pages.find((page) => page.dataset.page === route).classList.contains("active"), true);
    if (["detail", "research", "signals", "ask", "sources"].includes(route)) assert.equal(nodes.get("navMore").open, true);
  }
});

test("an unknown or empty route returns to the overview with secondary tools initially collapsed", () => {
  window.location.hash = "#unknown";
  syncActivePage();
  assert.equal(nodes.get("pageTitle").textContent, "Overview");
  assert.equal(nodes.get("navMore").open, false);
  assert.equal(replaced.at(-1)[2], "#dashboard");
  window.location.hash = "";
  syncActivePage();
  assert.equal(pages.find((page) => page.dataset.page === "dashboard").hidden, false);
});

test("ticker search opens stock details while an empty query only focuses the field", () => {
  const queries = [];
  bindQuickSearch(() => queries.push(nodes.get("detailTickerInput").value));
  const submit = nodes.get("quickSearchForm").handlers.submit;
  let prevented = 0;
  submit({ preventDefault() { prevented++; } });
  assert.equal(nodes.get("quickSearchInput").focused, true);
  assert.deepEqual(queries, []);
  nodes.get("quickSearchInput").value = "  AAPL  ";
  submit({ preventDefault() { prevented++; } });
  assert.equal(window.location.hash, "#detail");
  assert.equal(nodes.get("navMore").open, true);
  assert.equal(nodes.get("pageTitle").textContent, "Stock details");
  assert.deepEqual(queries, ["AAPL"]);
  assert.equal(prevented, 2);
});
