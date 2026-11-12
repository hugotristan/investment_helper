import { usesCloudMarket } from "../data/cloud-mode.js";
import { retryTransient } from "../shared/batch.js";
import { cloudSession } from "../data/cloud-portfolio-store.js";

export function initializeLoadingDiagnostics({ document: doc = globalThis.document, window: win = globalThis.window,
  fetchImpl = (...args) => globalThis.fetch(...args), session = cloudSession } = {}) {
  const panel = doc.getElementById("loadingDiagnostics");
  if (!panel || !usesCloudMarket()) return;
  panel.hidden = false;
  const components = doc.getElementById("loadingComponents"), results = doc.getElementById("loadingTickerResults");
  const states = new Map(), rows = new Map();
  let busy = false, generation = 0, currentUser = null;
  const append = (parent, tag, value) => { const element = doc.createElement(tag); element.textContent = value; parent.appendChild(element); return element; };
  function render() {
    components.replaceChildren(); results.replaceChildren();
    for (const [name, value] of states) append(components, "p", `${name}: ${value}`);
    for (const [name, values] of rows) {
      append(results, "h3", name);
      for (const row of values) append(results, "p", `${row.ticker}: ${row.status} · ${row.priceType || "annual financials"} · ${row.currency || "currency unavailable"} · ${row.source || "source unavailable"} · ${row.latestSuccessfulUpdateAt || "no successful update"}${row.errors?.length ? " · " + row.errors.map(error => `${error.code}: ${error.message}`).join("; ") : ""}`);
    }
  }
  async function request(component, offset, signal) {
    return retryTransient(async () => {
      const query = new URLSearchParams({ component, offset: String(offset), batchSize: doc.getElementById("loadingBatchSize").value,
        concurrency: doc.getElementById("loadingConcurrency").value });
      const response = await fetchImpl(`/api/loading-status?${query}`, { credentials: "same-origin", cache: "no-store", signal });
      if (!response.ok) { const error = new Error(response.status === 401 ? "Unlock the app to check saved data." : "The diagnostic request failed. Retry the checks."); error.retryable = response.status >= 500; throw error; }
      const value = await response.json();
      if (currentUser && value.userId !== currentUser) { rows.clear(); states.clear(); throw new Error("The signed-in workspace changed. Reload this page."); }
      currentUser = value.userId;
      return value;
    }, { retryable: error => error.retryable === true || error instanceof TypeError });
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    const version = ++generation;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    for (const name of ["Portfolio", "Watchlist", "Prices", "Financial metrics"]) states.set(name, states.has(name) ? "refreshing; previous results remain visible" : "loading");
    render();
    try {
      // Record availability never waits for price/financial providers.
      const recordWork = request("records", 0, controller.signal).then(value => {
        if (version !== generation) return;
        for (const [name, key] of [["Portfolio", "portfolio"], ["Watchlist", "watchlist"]]) states.set(name, `${value[key].status} · saved ${value[key].savedAt || "never"}`);
        render();
      }).catch(() => {
        if (version === generation) { states.set("Portfolio", "unavailable; saved records were kept"); states.set("Watchlist", "unavailable; saved records were kept"); render(); }
      });
      await Promise.allSettled([recordWork, ...[["Prices", "prices"], ["Financial metrics", "financialMetrics"]].map(async ([name, component]) => {
        try {
          let offset = 0, collected = [], seen = new Set(), listRevision;
          do {
            if (seen.has(offset)) throw new Error("Diagnostic pagination did not advance.");
            seen.add(offset);
            const value = await request(component, offset, controller.signal);
            if (version !== generation) return;
            if (listRevision !== undefined && listRevision !== value.pagination.listRevision) throw new Error("Saved ticker list changed during loading. Refresh checks.");
            listRevision = value.pagination.listRevision;
            const data = value[component];
            collected.push(...(data?.prices || data?.companies || []));
            rows.set(name, collected);
            offset = value.pagination.nextOffset;
            const failed = collected.filter(row => row.status !== "available").length;
            states.set(name, `${offset === null ? "checked" : "loading"} ${collected.length}/${value.pagination.totalTickers} · ${failed} stale, partial or unavailable`);
            if (data?.status === "unavailable" && !data.prices && !data.companies) throw new Error("The source failed to provide ticker diagnostics.");
            render();
          } while (offset !== null);
        } catch { if (version === generation) { states.set(name, "check incomplete; retained results shown, retry available"); render(); } }
      })]);
    } finally { clearTimeout(timer); busy = false; }
  }
  session.subscribe(value => {
    if (["ACCOUNT_CHANGED", "UNAUTHORIZED"].includes(value.errorCode)) { generation++; currentUser = null; rows.clear(); states.clear(); render(); }
  });
  doc.getElementById("loadingRefresh").addEventListener("click", refresh);
  const whenVisible = () => { if (win.location.hash === "#sources" && !states.size) void refresh(); };
  win.addEventListener("hashchange", whenVisible); whenVisible();
  return { refresh };
}
