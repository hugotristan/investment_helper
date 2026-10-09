import test from "node:test";
import assert from "node:assert/strict";
import { bindTickerAutocomplete } from "../js/ui/ticker-autocomplete.js";

class FakeEvent {
  constructor(type, options = {}) { this.type = type; this.bubbles = options.bubbles || false; Object.assign(this, options); this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}
class FakeNode {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.parentElement = null; this.children = [];
    this.attributes = new Map(); this.listeners = new Map(); this.dataset = {}; this.className = "";
    this.hidden = false; this.disabled = false; this.value = ""; this.textContent = "";
    this.classList = {
      add: (name) => { if (!this.className.split(" ").includes(name)) this.className = `${this.className} ${name}`.trim(); },
      toggle: (name, enabled) => { const names = this.className.split(" ").filter((value) => value && value !== name); if (enabled) names.push(name); this.className = names.join(" "); },
      contains: (name) => this.className.split(" ").includes(name)
    };
  }
  appendChild(node) { this.children.push(node); node.parentElement = this; return node; }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; for (const node of nodes) this.appendChild(node); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles && this.parentElement && !event.stopped) this.parentElement.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  contains(target) { for (let node = target; node; node = node.parentElement) if (node === this) return true; return false; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (selector === "[data-ticker-index]" && Object.hasOwn(node.dataset, "tickerIndex")) return node; return null; }
  scrollIntoView() { this.scrolled = true; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
}
class FakeDocument extends FakeNode {
  constructor() { super("document", null); this.ownerDocument = this; this.defaultView = { Event: FakeEvent }; }
  createElement(tag) { return new FakeNode(tag, this); }
}
const catalog = { entries: [
  { ticker: "AA", label: "Alpha Materials", type: "stock" },
  { ticker: "AAPL", label: "Apple Inc.", type: "stock" },
  { ticker: "AMZN", label: "Amazon.com Inc.", type: "stock" },
  { ticker: "ZZZ", label: "Zebra Holdings", type: "stock" }
] };
const settled = () => new Promise((resolve) => setImmediate(resolve));
function setup(options = {}) {
  const doc = new FakeDocument();
  const form = doc.createElement("form"); doc.appendChild(form);
  const input = doc.createElement("input"); form.appendChild(input);
  const controller = bindTickerAutocomplete(input, { loadCatalog: async () => catalog, ...options });
  return { doc, form, input, controller, list: form.children[1] };
}
function type(input, value) { input.value = value; input.dispatchEvent(new FakeEvent("input", { bubbles: true })); }
function key(input, value, extra = {}) { const event = new FakeEvent("keydown", { key: value, ...extra }); input.dispatchEvent(event); return event; }

test("combobox is bound once with accessible options and bounded first-letter suggestions", async () => {
  const { input, controller, list, form } = setup();
  assert.equal(bindTickerAutocomplete(input), controller);
  assert.equal(form.children.length, 2);
  assert.equal(input.getAttribute("role"), "combobox");
  assert.equal(input.getAttribute("aria-controls"), list.id);
  assert.equal(list.getAttribute("role"), "listbox");
  assert.equal(input.getAttribute("aria-expanded"), "false");
  type(input, "a"); await settled();
  assert.equal(list.children.length, 4);
  assert.equal(list.hidden, false);
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.equal(list.children[0].getAttribute("role"), "option");
  assert.equal(list.children[0].children[0].textContent, "AA");
  assert.equal(list.children[0].children[1].textContent, "Alpha Materials");
  controller.destroy();
});

test("arrow keys choose options and Enter prevents downstream search submission", async () => {
  const selected = [];
  const { input, list, form } = setup({ onSelect: (item) => selected.push(item) });
  let submissions = 0;
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.defaultPrevented) submissions += 1; });
  form.addEventListener("submit", () => { submissions += 1; });
  type(input, "a"); await settled();
  assert.equal(key(input, "ArrowDown").defaultPrevented, true);
  assert.equal(input.getAttribute("aria-activedescendant"), list.children[0].id);
  assert.equal(list.children[0].getAttribute("aria-selected"), "true");
  key(input, "ArrowDown");
  assert.equal(list.children[1].classList.contains("is-active"), true);
  key(input, "ArrowUp");
  const enter = key(input, "Enter");
  assert.equal(enter.defaultPrevented, true);
  assert.equal(input.value, "AA");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].ticker, "AA");
  assert.equal(submissions, 0);
  assert.equal(list.hidden, true);
  assert.equal(input.getAttribute("aria-activedescendant"), null);
  assert.equal(key(input, "Enter").defaultPrevented, false);
  assert.equal(submissions, 1);
});

test("pointer selection handles nested text, preserves free typing and never submits", async () => {
  const selected = [];
  const { input, list, form } = setup({ onSelect: (item) => selected.push(item.ticker) });
  let submissions = 0; let inputEvents = 0;
  form.addEventListener("submit", () => submissions += 1);
  input.addEventListener("input", () => inputEvents += 1);
  type(input, "apple"); await settled();
  const press = new FakeEvent("pointerdown", { bubbles: true, pointerType: "touch" });
  list.children[0].children[1].dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);
  assert.equal(input.value, "AAPL");
  assert.deepEqual(selected, ["AAPL"]);
  assert.equal(submissions, 0);
  assert.equal(inputEvents, 2);
  assert.equal(list.hidden, true);
  type(input, "UNLISTED.TICKER");
  assert.equal(input.value, "UNLISTED.TICKER");
  assert.equal(list.hidden, true);
});

test("Escape and outside pointer close suggestions; arrows wrap and IME Enter stays untouched", async () => {
  const { input, list, doc } = setup();
  type(input, "a"); await settled();
  key(input, "ArrowUp");
  assert.equal(input.getAttribute("aria-activedescendant"), list.children.at(-1).id);
  key(input, "ArrowDown");
  assert.equal(input.getAttribute("aria-activedescendant"), list.children[0].id);
  assert.equal(key(input, "Enter", { isComposing: true }).defaultPrevented, false);
  assert.equal(list.hidden, false);
  assert.equal(key(input, "Escape").defaultPrevented, true);
  assert.equal(list.hidden, true);
  assert.equal(input.value, "a");
  key(input, "ArrowDown");
  await settled();
  assert.equal(input.getAttribute("aria-activedescendant"), list.children[0].id);
  doc.dispatchEvent(new FakeEvent("pointerdown", { target: doc }));
  assert.equal(list.hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
});

test("late catalog loading paints only the latest query and never reopens dismissed suggestions", async () => {
  let resolve;
  const loading = new Promise((done) => { resolve = done; });
  const { input, list } = setup({ loadCatalog: () => loading });
  type(input, "a");
  type(input, "z");
  resolve(catalog); await settled();
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].children[0].textContent, "ZZZ");
  assert.equal(list.children[1].children[0].textContent, "AMZN");
  const other = setup({ loadCatalog: () => loading });
  type(other.input, "a"); key(other.input, "Escape"); await settled();
  assert.equal(other.list.hidden, true);
  assert.equal(other.input.getAttribute("aria-expanded"), "false");
});

test("late catalog label changes retain the highlighted ticker when the query is unchanged", async () => {
  let resolve;
  const { input, list } = setup({ loadCatalog: () => new Promise((done) => { resolve = done; }) });
  type(input, "aapl"); key(input, "ArrowDown");
  await Promise.resolve();
  resolve(catalog); await settled();
  assert.equal(input.getAttribute("aria-activedescendant"), list.children[0].id);
  assert.equal(list.children[0].getAttribute("aria-selected"), "true");
  assert.equal(key(input, "Enter").defaultPrevented, true);
  assert.equal(input.value, "AAPL");
});

test("disabled inputs cannot repaint, select or intercept Enter", async () => {
  let resolve;
  const selected = [];
  const { input, list } = setup({ loadCatalog: () => new Promise((done) => { resolve = done; }), onSelect: (item) => selected.push(item) });
  type(input, "a"); await Promise.resolve();
  input.disabled = true;
  resolve(catalog); await settled();
  key(input, "ArrowDown");
  assert.equal(list.hidden, true);
  assert.equal(key(input, "Enter").defaultPrevented, false);
  type(input, "apple");
  assert.equal(list.hidden, true);
  assert.deepEqual(selected, []);
  assert.equal(input.value, "apple");
});

test("catalog labels render as literal text and destruction restores original ARIA attributes", async () => {
  const { doc, input, controller, form } = setup({ loadCatalog: async () => ({ entries: [{ ticker: "SAFE", label: '<img src=x onerror="alert(1)">', type: "stock" }] }) });
  type(input, "safe"); await settled();
  const list = form.children[1];
  assert.equal(list.children[0].children[1].textContent, '<img src=x onerror="alert(1)">');
  assert.equal(list.children[0].children[1].children.length, 0);
  controller.destroy();
  assert.equal(form.children.length, 1);
  assert.equal(input.getAttribute("role"), null);
  assert.equal(input.getAttribute("aria-controls"), null);
  assert.equal(doc.listeners.get("pointerdown").size, 0);
  type(input, "a");
  assert.equal(form.children.length, 1);
  input.setAttribute("role", "searchbox");
  input.setAttribute("autocomplete", "on");
  const replacement = bindTickerAutocomplete(input, { loadCatalog: async () => catalog });
  replacement.destroy();
  assert.equal(input.getAttribute("role"), "searchbox");
  assert.equal(input.getAttribute("autocomplete"), "on");
});

test("catalog failure retains configured suggestions and incomplete DOM fixtures safely skip binding", async () => {
  const { input, list } = setup({ loadCatalog: async () => { throw new Error("offline"); } });
  type(input, "apple"); await settled();
  assert.equal(list.children[0].children[0].textContent, "AAPL");
  assert.equal(bindTickerAutocomplete(null), null);
  assert.equal(bindTickerAutocomplete({ addEventListener() {}, setAttribute() {}, removeAttribute() {}, parentElement: { appendChild() {} }, ownerDocument: { addEventListener() {}, createElement() { return {}; } } }), null);
});

test("multiple mode replaces only the final token and keeps company names with spaces whole", async () => {
  const companies = { entries: [
    { ticker: "MSFT", label: "Microsoft Corp", type: "stock" },
    { ticker: "MS", label: "Morgan Stanley", type: "stock" }
  ] };
  const { input, list } = setup({ multiple: true, loadCatalog: async () => companies });
  type(input, "AAPL, mi"); await settled();
  assert.equal(list.children[0].children[0].textContent, "MSFT");
  key(input, "ArrowDown");
  assert.equal(key(input, "Enter").defaultPrevented, true);
  assert.equal(input.value, "AAPL, MSFT");
  type(input, "AAPL, MSFT;  Morgan Stanley"); await settled();
  key(input, "ArrowDown"); key(input, "Enter");
  assert.equal(input.value, "AAPL, MSFT;  MS");
  const single = setup({ loadCatalog: async () => companies });
  type(single.input, "Morgan Stanley"); await settled();
  key(single.input, "ArrowDown"); key(single.input, "Enter");
  assert.equal(single.input.value, "MS");
});

test("multiple mode checks the full input before a late repaint or selection", async () => {
  let resolve;
  const { input, list, controller } = setup({ multiple: true, loadCatalog: () => new Promise((done) => { resolve = done; }) });
  type(input, "AAPL, aapl"); key(input, "ArrowDown");
  await Promise.resolve();
  input.value = "AMZN, aapl";
  resolve({ entries: [{ ticker: "AAPL", label: "Newly loaded name", type: "stock" }] });
  await settled();
  assert.notEqual(list.children[0].children[1].textContent, "Newly loaded name");
  key(input, "Enter");
  assert.equal(input.value, "AMZN, aapl");
  controller.refresh();
  key(input, "ArrowDown"); key(input, "Enter");
  assert.equal(input.value, "AMZN, AAPL");
});
