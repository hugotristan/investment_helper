import { ApiError } from "./request-body.mjs";

// Never serialize environment objects, request headers, raw test logs or native
// deployment responses. Only the explicitly selected schema reaches storage.
const secretPattern = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+|(?:password|secret|token|api[_ -]?key|cookie|authorization)\s*[:=]\s*[^\s,;]+|-----BEGIN [^-]*PRIVATE KEY-----)/gi;
const unsafePath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.aws|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)(?:\/|$)/i;
function text(value, max = 1000) {
  if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b-\x1f]/.test(value)) throw new Error("Invalid text");
  return value.replace(/^.*(?:(?:password|secret|token|api[_ -]?key|cookie|authorization)\s*[:=]|\b[A-Z][A-Z0-9_]{2,}\s*=).*$/gmi, "[REDACTED SENSITIVE LINE]")
    .replace(secretPattern, "[REDACTED]");
}
function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unsupported fields");
}
function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid timestamp");
  return new Date(value).toISOString();
}
export function validateChange(input) {
  try {
    fields(input, ["commitHash", "summary", "filesModified", "tests", "knownLimitations", "deployment"]);
    if (!/^[a-f0-9]{40}$/.test(input.commitHash)) throw new Error("Invalid commit");
    if (!Array.isArray(input.filesModified) || input.filesModified.length > 500 || !Array.isArray(input.knownLimitations) || input.knownLimitations.length > 30) throw new Error("Invalid lists");
    const filesModified = input.filesModified.map(file => {
      if (typeof file !== "string" || file.length > 240 || !/^[A-Za-z0-9_. /@()-]+$/.test(file)
        || file.startsWith("/") || file.split("/").some(part => part === "..") || unsafePath.test(file)) throw new Error("Unsafe path");
      return file;
    });
    fields(input.tests, ["files", "status", "passed", "failed", "skipped"]);
    if (!Array.isArray(input.tests.files) || input.tests.files.length > 100 || input.tests.files.some(file => !/^tests\/[A-Za-z0-9_.-]+\.test\.js$/.test(file))
      || !["passed", "failed", "not_run"].includes(input.tests.status)) throw new Error("Invalid tests");
    for (const key of ["passed", "failed", "skipped"]) if (!Number.isSafeInteger(input.tests[key]) || input.tests[key] < 0) throw new Error("Invalid counts");
    if (input.tests.status === "passed" && input.tests.failed !== 0) throw new Error("Conflicting tests");
    fields(input.deployment, ["status", "timestamp", "id"]);
    if (!["succeeded", "failed", "pending", "not_deployed"].includes(input.deployment.status)) throw new Error("Invalid deployment");
    if (input.deployment.id !== null && !/^appgdep_[a-zA-Z0-9_-]{1,100}$/.test(input.deployment.id)) throw new Error("Invalid deployment id");
    return { commitHash: input.commitHash, summary: text(input.summary), filesModified: [...new Set(filesModified)],
      tests: { files: [...input.tests.files], status: input.tests.status, passed: input.tests.passed, failed: input.tests.failed, skipped: input.tests.skipped },
      knownLimitations: input.knownLimitations.map(value => text(value)), deployment: { status: input.deployment.status,
        timestamp: input.deployment.timestamp === null && input.deployment.status === "not_deployed" ? null : timestamp(input.deployment.timestamp), id: input.deployment.id } };
  } catch { throw new ApiError(400, "INVALID_CHANGE_RECORD", "Supply only sanitized commit, summary, relative files, test counts, limitations and deployment receipt fields."); }
}

export async function saveChange(env, userId, input, now = Date.now()) {
  const record = validateChange(input);
  const completedAt = new Date(now).toISOString();
  try {
    // One record per completed commit. Retrying a timed-out upload is harmless.
    await env.DB.prepare("INSERT INTO development_changes (id, user_id, record, completed_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .bind(`${userId}:${record.commitHash}`, userId, JSON.stringify(record), completedAt).run();
    return { saved: true, commitHash: record.commitHash };
  } catch { throw new ApiError(503, "CHANGELOG_UNAVAILABLE", "The development changelog could not confirm the record. Retry the same commit safely."); }
}
export async function latestChanges(env, userId, limit = 1) {
  try {
    const rows = await env.DB.prepare("SELECT record, completed_at FROM development_changes WHERE user_id = ? ORDER BY completed_at DESC, id DESC LIMIT ?").bind(userId, limit).all();
    const changes = rows.results.map(row => ({ ...validateChange(JSON.parse(row.record)), completedAt: timestamp(row.completed_at) }));
    return { status: "available", latestSuccessfulUpdateAt: changes[0]?.completedAt ?? null, changes,
      errors: [], ...(changes.length ? {} : { message: "No completed coding tasks have been recorded yet." }) };
  } catch { throw new ApiError(503, "CHANGELOG_UNAVAILABLE", "The saved development changelog could not be loaded."); }
}
