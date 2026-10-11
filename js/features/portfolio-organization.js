import { normalizePortfolioOrganization, positionKey, positionOrganization, removePortfolioGroup, setPositionOrganization } from "../analysis/portfolio-organization.js";
import { getActivePortfolioBook } from "../portfolio-state.js";
import { getPortfolioHoldings } from "./portfolio.js";
import { savePortfolioOrganization } from "./portfolio-book.js";
import { escapeHtml } from "../shared/text.js";

export function createPortfolioOrganizationController({ document: doc = globalThis.document,
  readBook = getActivePortfolioBook, readHoldings = getPortfolioHoldings,
  save = savePortfolioOrganization, uuid = () => crypto.randomUUID() } = {}) {
  const el = (id) => doc.getElementById(id);
  const panel = el("portfolioOrganization");
  let formBook = null, selectedKey = "", dirty = false, busy = false, bound = false, removed = null;
  const say = (text) => { el("portfolioOrganizationStatus").textContent = text; };
  const organization = () => formBook?.organization || { groups: [], positions: [] };

  function loadNote() {
    const holding = readHoldings().find((item) => positionKey(item) === selectedKey);
    const entry = holding ? positionOrganization(organization(), holding) : { groupId: null, note: "" };
    el("portfolioPositionGroup").value = entry.groupId || "";
    el("portfolioPositionNote").value = entry.note;
    el("portfolioNoteSave").disabled = !holding;
  }

  function render({ force = false } = {}) {
    if (!panel || busy) return;
    const book = readBook();
    panel.hidden = !book || doc.documentElement?.dataset?.privateBlocked === "true";
    if (panel.hidden) {
      formBook = null; dirty = false; removed = null;
      el("portfolioPositionNote").value = "";
      el("portfolioNewGroupName").value = "";
      el("portfolioGroupRows").innerHTML = "";
      return;
    }
    if (dirty && !force) return;
    dirty = false;
    formBook = book;
    const holdings = [...new Map(readHoldings().map((holding) => [positionKey(holding), holding])).values()];
    if (!holdings.some((holding) => positionKey(holding) === selectedKey)) selectedKey = holdings[0] ? positionKey(holdings[0]) : "";
    el("portfolioNotePosition").innerHTML = holdings.map((holding) => `<option value="${escapeHtml(positionKey(holding))}">${escapeHtml(holding.ticker)} · ${escapeHtml(holding.currency)}</option>`).join("");
    el("portfolioNotePosition").value = selectedKey;
    el("portfolioNotePosition").disabled = !holdings.length;
    el("portfolioPositionGroup").innerHTML = '<option value="">Ungrouped</option>' + organization().groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join("");
    el("portfolioGroupRows").innerHTML = organization().groups.map((group) => `<form class="portfolio-group-row" data-rename-group="${escapeHtml(group.id)}">
      <input aria-label="Rename ${escapeHtml(group.name)} group" data-group-name="${escapeHtml(group.id)}" value="${escapeHtml(group.name)}" maxlength="80" required>
      <button type="submit" class="ghost">Rename</button><button type="button" class="ghost" data-remove-group="${escapeHtml(group.id)}" aria-label="Remove ${escapeHtml(group.name)} group">Remove</button>
    </form>`).join("");
    el("portfolioGroupUndo").hidden = !removed;
    loadNote();
  }

  async function persist(next, { undoSnapshot = null, expectedUpdatedAt = formBook?.updatedAt,
    consumeNote = false, consumeNewGroup = false, consumeGroupId = null } = {}) {
    if (busy || !formBook || panel.hidden) return false;
    const current = readHoldings().find((holding) => positionKey(holding) === selectedKey);
    const previous = current ? positionOrganization(organization(), current) : { groupId: null, note: "" };
    const draft = !consumeNote && (el("portfolioPositionNote").value !== previous.note
      || (el("portfolioPositionGroup").value || null) !== previous.groupId)
      ? { note: el("portfolioPositionNote").value, groupId: el("portfolioPositionGroup").value } : null;
    const groupDrafts = [...el("portfolioGroupRows").querySelectorAll("[data-group-name]")]
      .filter((input) => input.dataset.groupName !== consumeGroupId
        && input.value !== organization().groups.find((group) => group.id === input.dataset.groupName)?.name)
      .map((input) => ({ id: input.dataset.groupName, name: input.value }));
    const newGroupDraft = consumeNewGroup ? "" : el("portfolioNewGroupName").value;
    busy = true;
    for (const control of panel.querySelectorAll("input, select, textarea, button")) control.disabled = true;
    let saved = false;
    try {
      saved = Boolean(await save(normalizePortfolioOrganization(next), expectedUpdatedAt));
      if (saved) {
        removed = undoSnapshot ? { organization: undoSnapshot, updatedAt: readBook().updatedAt } : null;
        dirty = false;
        el("portfolioNewGroupName").value = "";
        say("Saved.");
      }
    } catch (error) { say(error.message || "The change could not be saved."); }
    finally {
      busy = false;
      for (const control of panel.querySelectorAll("input, select, textarea, button")) control.disabled = false;
      if (saved) {
        render({ force: true });
        if (draft) {
          el("portfolioPositionNote").value = draft.note;
          el("portfolioPositionGroup").value = organization().groups.some((group) => group.id === draft.groupId) ? draft.groupId : "";
          dirty = true;
        }
        for (const input of el("portfolioGroupRows").querySelectorAll("[data-group-name]")) {
          const edited = groupDrafts.find((group) => group.id === input.dataset.groupName);
          if (edited) { input.value = edited.name; dirty = true; }
        }
        el("portfolioNewGroupName").value = newGroupDraft;
        if (newGroupDraft) dirty = true;
        if (dirty) say("Saved. Other edits are still unsaved.");
      }
    }
    return saved;
  }

  function open(key) {
    if (busy || !readBook()) return;
    if (dirty) { panel.open = true; say("Save or cancel your current edits first."); return; }
    selectedKey = key;
    render({ force: true });
    panel.open = true;
    el("portfolioPositionNote").focus();
  }

  function initialize() {
    if (!panel || bound) return;
    bound = true;
    panel.addEventListener("input", (event) => { if (!busy && event.target.id !== "portfolioNotePosition") dirty = true; });
    el("portfolioPositionGroup").addEventListener("change", () => { dirty = true; });
    el("portfolioNotePosition").addEventListener("change", () => {
      if (dirty) { el("portfolioNotePosition").value = selectedKey; say("Save or cancel your current edits before switching positions."); return; }
      selectedKey = el("portfolioNotePosition").value;
      loadNote();
    });
    el("portfolioNoteCancel").addEventListener("click", () => { if (!busy) { el("portfolioNewGroupName").value = ""; render({ force: true }); say(""); } });
    el("portfolioNoteForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const holding = readHoldings().find((item) => positionKey(item) === selectedKey);
      if (!holding) return;
      try { void persist(setPositionOrganization(organization(), holding,
        { groupId: el("portfolioPositionGroup").value || null, note: el("portfolioPositionNote").value }), { consumeNote: true }); }
      catch (error) { say(error.message); }
    });
    el("portfolioGroupForm").addEventListener("submit", (event) => {
      event.preventDefault();
      void persist({ ...organization(), groups: [...organization().groups, { id: uuid(), name: el("portfolioNewGroupName").value }] }, { consumeNewGroup: true });
    });
    el("portfolioGroupRows").addEventListener("submit", (event) => {
      event.preventDefault();
      const row = event.target.closest?.("[data-rename-group]");
      if (!row) return;
      void persist({ ...organization(), groups: organization().groups.map((group) => group.id === row.dataset.renameGroup
        ? { ...group, name: row.querySelector("[data-group-name]").value } : group) }, { consumeGroupId: row.dataset.renameGroup });
    });
    el("portfolioGroupRows").addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-remove-group]");
      if (!button) return;
      const before = structuredClone(organization());
      void persist(removePortfolioGroup(before, button.dataset.removeGroup), { undoSnapshot: before, consumeGroupId: button.dataset.removeGroup });
    });
    el("portfolioGroupUndo").addEventListener("click", () => {
      if (removed) void persist(removed.organization, { expectedUpdatedAt: removed.updatedAt });
    });
    doc.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-portfolio-note]");
      if (button) open(button.dataset.portfolioNote);
    });
    render();
  }
  return { initialize, render, open };
}

let controller;
export function initializePortfolioOrganization() { controller ||= createPortfolioOrganizationController(); controller.initialize(); }
export function refreshPortfolioOrganization() { controller?.render(); }
