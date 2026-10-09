import { buildTickerCatalog, loadTickerCatalog, searchTickers } from "../data/ticker-search.js";

const bindings = new WeakMap();
let nextId = 0;

export function bindTickerAutocomplete(input, { loadCatalog = loadTickerCatalog, onSelect, limit = 8, multiple = false } = {}) {
  if (!input || (typeof input !== "object" && typeof input !== "function")) return null;
  if (bindings.has(input)) return bindings.get(input);
  const doc = input.ownerDocument || globalThis.document;
  const parent = input.parentElement;
  if (!doc?.createElement || !doc.addEventListener || !parent?.appendChild || !input.addEventListener
    || !input.setAttribute || !input.removeAttribute) return null;
  const list = doc.createElement("ul");
  if (!list?.setAttribute || !list.appendChild || !list.replaceChildren || !list.addEventListener
    || !list.contains || !list.remove || !list.classList) return null;
  list.id = `ticker-options-${++nextId}`;
  list.className = "ticker-suggestions";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Stock and ETF suggestions");
  list.hidden = true;
  parent.appendChild(list);
  parent.classList?.add("ticker-autocomplete");
  const attributes = ["role", "autocomplete", "aria-autocomplete", "aria-controls", "aria-expanded", "aria-activedescendant"];
  const originalAttributes = attributes.map((name) => [name, input.getAttribute?.(name) ?? null]);
  input.setAttribute("role", "combobox");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  let catalog = buildTickerCatalog();
  let catalogPromise = null;
  let catalogReady = false;
  let options = [];
  let active = -1;
  let displayedQuery = "";
  let displayedValue = "";
  let revision = 0;
  let destroyed = false;
  let selecting = false;

  function close() {
    if (destroyed) return;
    revision += 1;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    options = [];
    active = -1;
  }
  function setActive(index) {
    active = index;
    Array.from(list.children).forEach((option, optionIndex) => {
      const selected = optionIndex === active;
      option.setAttribute("aria-selected", String(selected));
      option.classList.toggle("is-active", selected);
      if (selected) { input.setAttribute("aria-activedescendant", option.id); option.scrollIntoView?.({ block: "nearest" }); }
    });
    if (active < 0) input.removeAttribute("aria-activedescendant");
  }
  function inputQuery() {
    const value = String(input.value || "");
    const delimiter = multiple ? Math.max(value.lastIndexOf(","), value.lastIndexOf(";")) : -1;
    const tail = value.slice(delimiter + 1);
    return { value, query: tail.trim(), prefix: delimiter >= 0 ? value.slice(0, delimiter + 1) + tail.match(/^\s*/)[0] : "" };
  }
  function paint(query, value) {
    const selectedTicker = displayedQuery === query && displayedValue === value && active >= 0 ? options[active]?.ticker : null;
    displayedQuery = query;
    displayedValue = value;
    options = searchTickers(query, { catalog, limit });
    list.replaceChildren();
    active = -1;
    input.removeAttribute("aria-activedescendant");
    for (const [index, item] of options.entries()) {
      const option = doc.createElement("li");
      option.id = `${list.id}-${index}`;
      option.className = "ticker-suggestion";
      option.dataset.tickerIndex = String(index);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      const symbol = doc.createElement("span");
      symbol.className = "ticker-suggestion-symbol";
      symbol.textContent = item.ticker;
      const label = doc.createElement("span");
      label.className = "ticker-suggestion-label";
      label.textContent = item.label;
      option.appendChild(symbol);
      option.appendChild(label);
      list.appendChild(option);
    }
    list.hidden = options.length === 0 || input.disabled;
    input.setAttribute("aria-expanded", String(!list.hidden));
    const selectedIndex = options.findIndex(({ ticker }) => ticker === selectedTicker);
    if (!list.hidden && selectedIndex >= 0) setActive(selectedIndex);
  }
  function refresh() {
    if (destroyed || selecting) return;
    const token = ++revision;
    const { query, value } = inputQuery();
    if (input.disabled || !query) { close(); return; }
    paint(query, value);
    if (catalogReady) return;
    if (!catalogPromise) catalogPromise = Promise.resolve().then(() => loadCatalog()).then((loaded) => {
      if (Array.isArray(loaded) || Array.isArray(loaded?.entries)) catalog = loaded;
    }).catch(() => {}).finally(() => { catalogReady = true; });
    catalogPromise.then(() => {
      if (!destroyed && token === revision && !input.disabled && String(input.value || "") === value) paint(query, value);
    });
  }
  function select(index) {
    const item = options[index];
    if (!item || input.disabled || destroyed) return;
    const { value, prefix } = inputQuery();
    if (value !== displayedValue) { close(); refresh(); return; }
    input.value = multiple ? prefix + item.ticker : item.ticker;
    close();
    selecting = true;
    try {
      const EventType = doc.defaultView?.Event || globalThis.Event;
      if (EventType && input.dispatchEvent) input.dispatchEvent(new EventType("input", { bubbles: true }));
    } finally { selecting = false; }
    onSelect?.(item, input);
  }
  function keydown(event) {
    if (input.disabled) { close(); return; }
    if (event.isComposing) return;
    if (event.key === "Escape") { if (!list.hidden) event.preventDefault(); close(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (list.hidden) refresh();
      if (!options.length) return;
      event.preventDefault();
      setActive(event.key === "ArrowDown" ? (active + 1) % options.length : (active < 0 ? options.length - 1 : (active - 1 + options.length) % options.length));
    } else if (event.key === "Enter" && !list.hidden && active >= 0) {
      event.preventDefault();
      select(active);
    }
  }
  function pointerdown(event) {
    const option = event.target?.closest?.("[data-ticker-index]");
    if (input.disabled) { close(); return; }
    if (!option || !list.contains(option)) return;
    event.preventDefault();
    select(Number(option.dataset.tickerIndex));
  }
  function outside(event) { if (event.target !== input && !list.contains(event.target)) close(); }
  const listeners = [[input, "input", refresh], [input, "focus", refresh], [input, "blur", close], [input, "keydown", keydown],
    [list, "pointerdown", pointerdown], [doc, "pointerdown", outside]];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);
  const Observer = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
  const observer = typeof Observer === "function" ? new Observer(() => { if (input.disabled) close(); }) : null;
  observer?.observe(input, { attributes: true, attributeFilter: ["disabled"] });
  const controller = {
    refresh, close,
    destroy() {
      close(); destroyed = true;
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
      observer?.disconnect();
      list.remove();
      for (const [name, value] of originalAttributes) value === null ? input.removeAttribute(name) : input.setAttribute(name, value);
      bindings.delete(input);
    }
  };
  bindings.set(input, controller);
  return controller;
}
