import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalDatabase } from "../server/local-database.mjs";
import { validateChange, saveChange, latestChanges } from "../server/development-changes.mjs";
import { createApp } from "../server/worker.mjs";
import { generatePasswordSecrets } from "../server/auth.mjs";

const NOW = Date.parse("2026-11-12T21:00:00Z");
const record = () => ({ commitHash: "a".repeat(40), summary: "Add a persistent development changelog", filesModified: ["server/mcp.mjs"],
  tests: { files: ["tests/mcp.test.js"], status: "passed", passed: 11, failed: 0, skipped: 0 }, knownLimitations: [],
  deployment: { status: "succeeded", timestamp: "2026-11-12T20:00:00Z", id: "appgdep_synthetic" } });

test("changelog validates a bounded schema and redacts common credential/environment assignments", () => {
  const input = record();
  input.summary = "Fix token=private-example and PRIVATE_CONFIGURATION=hidden";
  input.knownLimitations = ["Bearer secret-credential-value", "sk-proj-abcdefghijklmnop", 'password="multiple words here"'];
  const serialized = JSON.stringify(validateChange(input));
  for (const value of ["private-example", "hidden", "secret-credential-value", "sk-proj-abcdefghijklmnop", "multiple words here"]) assert(!serialized.includes(value));
  for (const bad of [{ ...record(), environment: { private: "value" } }, { ...record(), filesModified: [".env.local"] },
    { ...record(), filesModified: ["../credentials"] }, { ...record(), deployment: { ...record().deployment, authorization: "secret" } },
    { ...record(), tests: { ...record().tests, output: "private logs" } }]) assert.throws(() => validateChange(bad), /Supply only sanitized/);
});

test("changelog survives database reopen, scopes readers, bounds results and retries without duplicates", async t => {
  const directory = await mkdtemp(join(tmpdir(), "investment-changelog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "test.sqlite");
  let DB = createLocalDatabase(filename);
  await saveChange({ DB }, "owner", record(), NOW);
  await saveChange({ DB }, "owner", record(), NOW + 1);
  DB.close();
  DB = createLocalDatabase(filename);
  try {
    assert.equal((await latestChanges({ DB }, "other")).changes.length, 0);
    const first = await latestChanges({ DB }, "owner");
    assert.equal(first.changes.length, 1);
    assert.equal(first.changes[0].completedAt, new Date(NOW).toISOString());
    await saveChange({ DB }, "owner", { ...record(), commitHash: "b".repeat(40) }, NOW + 10);
    assert.equal((await latestChanges({ DB }, "owner")).changes[0].commitHash, "b".repeat(40));
    assert.equal((await latestChanges({ DB }, "owner", 2)).changes.length, 2);
    assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM portfolio_books").first()).n, 0);
  } finally { DB.close(); }
});

test("completion ingestion uses existing password and expected-account guard; MCP exposes only owner-authorized reads", async t => {
  const DB = createLocalDatabase(); t.after(() => DB.close());
  const env = { DB, ...await generatePasswordSecrets("synthetic-test-password"), INVESTMENT_MCP_OWNER_EMAIL: "owner@example.com" };
  const app = createApp({}, { authMode: "password", now: NOW });
  const base = "https://investment.example";
  const post = (path, body, headers = {}) => new Request(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await app.fetch(post("/api/development-changes", record()), env)).status, 401);
  const login = await app.fetch(new Request(base + "/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base }, body: "password=synthetic-test-password" }), env);
  const Cookie = login.headers.get("set-cookie").split(";")[0];
  const { userId } = await (await app.fetch(new Request(base + "/api/session", { headers: { Cookie } }), env)).json();
  assert.equal((await app.fetch(post("/api/development-changes", record(), { Cookie }), env)).status, 409);
  assert.equal((await app.fetch(post("/api/development-changes", record(), { Cookie, Origin: "https://evil.example", "X-Expected-User-Id": userId }), env)).status, 403);
  assert.equal((await app.fetch(post("/api/development-changes", record(), { Cookie, Origin: base, "X-Expected-User-Id": userId }), env)).status, 200);
  const rpc = args => post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_latest_changes", arguments: args } },
    { "oai-authenticated-user-id": "owner-site-id", "oai-authenticated-user-email": "owner@example.com" });
  const first = await (await app.fetch(rpc({}), env)).json();
  assert.equal(first.result.structuredContent.changes[0].commitHash, record().commitHash);
  assert.equal(first.result.structuredContent.readOnly, true);
  assert.equal((await (await app.fetch(rpc({ limit: 21 }), env)).json()).error.code, -32602);
  assert.equal((await (await app.fetch(rpc({ password: "secret" }), env)).json()).error.code, -32602);
});
