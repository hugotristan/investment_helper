import { cloudSession, CloudStorageError } from "./cloud-portfolio-store.js";

// Insight failures must not put successful portfolio saves into an error state.
// Account/session failures still clear private views through the shared session.
export function createAnalystClient({ session = cloudSession, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 90000 } = {}) {
  async function request(path) {
    const account = await session.initialize();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(path, { method: "GET", credentials: "same-origin", signal: controller.signal,
        headers: { Accept: "application/json", "X-Expected-User-Id": account.userId } });
      const value = await response.json();
      const identity = response.headers.get("X-Portfolio-User-Id");
      if (response.status === 401 || value?.code === "ACCOUNT_CHANGED" || identity && identity !== account.userId
        || response.ok && value?.userId !== account.userId || session.state.userId !== account.userId
        || ["ACCOUNT_CHANGED", "UNAUTHORIZED"].includes(session.state.errorCode)) {
        const code = response.status === 401 ? "UNAUTHORIZED" : "ACCOUNT_CHANGED";
        const message = code === "UNAUTHORIZED" ? "Your session expired. Unlock the app again." : "Your account changed. Reload the app before accessing portfolio data.";
        session.update({ source: "analyst", status: "error", errorCode: code, message });
        throw new CloudStorageError(code, message);
      }
      if (!response.ok) throw new CloudStorageError(value?.code || "ANALYST_UNAVAILABLE", value?.error || "Portfolio insights are unavailable. Try again later.");
      return value;
    } catch (error) {
      if (error instanceof CloudStorageError) throw error;
      throw new CloudStorageError("ANALYST_UNAVAILABLE", controller.signal.aborted ? "Loading portfolio figures took too long. Try again later." : "Portfolio figures could not be loaded. Try again later.");
    } finally { clearTimeout(timer); }
  }
  return { isCloud: session.isCloud, context: (includeNotes = false) => request(`/api/analyst/context${includeNotes ? "?includeNotes=true" : ""}`) };
}

export const analystClient = createAnalystClient();
