import { cloudSession, CloudStorageError } from "./cloud-portfolio-store.js";

// Analyst failures must not put successful portfolio saves into an error state.
// Account/session failures still clear private views through the shared session.
export function createAnalystClient({ session = cloudSession, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 90000 } = {}) {
  async function request(path, body) {
    const account = await session.initialize();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(path, { method: body ? "POST" : "GET", credentials: "same-origin", signal: controller.signal,
        headers: { Accept: "application/json", "X-Expected-User-Id": account.userId, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
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
      if (!response.ok) throw new CloudStorageError(value?.code || "ANALYST_UNAVAILABLE", value?.error || "The analyst is unavailable. Try again later.");
      return value;
    } catch (error) {
      if (error instanceof CloudStorageError) throw error;
      throw new CloudStorageError("ANALYST_UNAVAILABLE", controller.signal.aborted ? "The analyst took too long. Try again later." : "The analyst could not connect. Try again later.");
    } finally { clearTimeout(timer); }
  }
  return { isCloud: session.isCloud, status: () => request("/api/analyst/status"), context: () => request("/api/analyst/context"),
    ask: (question, includeNotes, expectedRevision) => request("/api/analyst", { question, includeNotes, expectedRevision }) };
}

export const analystClient = createAnalystClient();
