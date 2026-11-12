import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validateChange } from "../server/development-changes.mjs";

const root = resolve(import.meta.dirname, "..");
const origin = "https://investment-helper.ingrvi.chatgpt.site";
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export async function completeTask(input, { fetchImpl = (url, init) => globalThis.fetch(url, init) } = {}) {
  if (!input || Object.keys(input).some(key => !["password", "summary", "knownLimitations", "testFiles", "deployment"].includes(key))) throw new Error("Unsupported completion fields");
  if (git(["status", "--porcelain"])) throw new Error("Commit the completed task before recording it.");
  const commitHash = git(["rev-parse", "HEAD"]);
  const filesModified = git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"]).split(/\r?\n/).filter(Boolean);
  const testFiles = input.testFiles ?? [];
  // Validate all supplied public metadata before logging in or running tests.
  const record = validateChange({ commitHash, filesModified, summary: input.summary ?? git(["log", "-1", "--format=%s"]),
    knownLimitations: input.knownLimitations ?? [], tests: { files: testFiles, status: "not_run", passed: 0, failed: 0, skipped: 0 },
    deployment: input.deployment ?? { status: "not_deployed", timestamp: null, id: null } });
  if (typeof input.password !== "string" || !input.password || input.password.length > 256) throw new Error("Provide the existing app password through hidden stdin.");
  if (testFiles.length) {
    for (const file of testFiles) if (!realpathSync(resolve(root, file)).startsWith(realpathSync(resolve(root, "tests")) + sep)) throw new Error("Test file outside tests directory");
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    const counts = Object.fromEntries(["pass", "fail", "skipped"].map(key => [key, Number(result.stdout?.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] ?? 0)]));
    record.tests = { files: testFiles, status: result.status === 0 && !result.error && counts.pass > 0 ? "passed" : "failed",
      passed: counts.pass, failed: counts.fail || (result.status !== 0 || result.error ? 1 : 0), skipped: counts.skipped };
  }
  // Same existing password login and account/revision guard as the website.
  // No new write tool, API key or environment dump is introduced.
  const login = await fetchImpl(origin + "/login", { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin }, body: new URLSearchParams({ password: input.password }) });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (login.status !== 303 || !cookie) throw new Error("Changelog authentication failed; no record was uploaded.");
  const session = await fetchImpl(origin + "/api/session", { headers: { Cookie: cookie } });
  if (!session.ok) throw new Error("Changelog session is unavailable.");
  const { userId } = await session.json();
  if (typeof userId !== "string" || !userId) throw new Error("Changelog session identity is unavailable.");
  const safeRecord = JSON.parse(JSON.stringify(record).split(input.password).join("[REDACTED]"));
  const saved = await fetchImpl(origin + "/api/development-changes", { method: "POST", headers: {
    Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-Expected-User-Id": userId,
  }, body: JSON.stringify(safeRecord) });
  if (!saved.ok) throw new Error("Changelog upload failed; retry this completed commit safely.");
  return { commitHash, saved: true, tests: record.tests, deployment: record.deployment };
}

async function hiddenInput() {
  return new Promise((resolveInput, reject) => {
    let value = "";
    const terminal = process.stdin.isTTY;
    if (terminal) { process.stdin.setRawMode(true); process.stderr.write("Ready for completion JSON on stdin (input is hidden).\n"); }
    process.stdin.setEncoding("utf8");
    const finish = error => {
      if (terminal) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      if (error) reject(error); else { try { resolveInput(JSON.parse(value)); } catch { reject(new Error("Invalid completion JSON")); } }
    };
    const onData = chunk => { value += chunk; if (value.includes("\u0003") || value.length > 65536) finish(new Error("Completion cancelled or input too large")); else if (terminal && /[\r\n]/.test(value)) finish(); };
    const onEnd = () => finish();
    process.stdin.on("data", onData); process.stdin.once("end", onEnd); process.stdin.resume();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await completeTask(await hiddenInput()))); }
  catch { console.error("Task completion was not confirmed. Check the committed state, allowed metadata, tests and app access; retry safely. Credentials and raw logs were omitted."); process.exitCode = 1; }
}
