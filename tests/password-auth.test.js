import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../server/worker.mjs";
import { generatePasswordSecrets, resolvePasswordWorkspace } from "../server/auth.mjs";
import { createLocalDatabase } from "../server/local-database.mjs";
import { createPortfolioBook } from "../js/analysis/portfolio-ledger.js";

const ORIGIN = "https://investment.example.chatgpt.site";
const NOW = Date.parse("2026-10-11T12:00:00Z");
const PASSWORD = "synthetic-test-password-only";
const secrets = await generatePasswordSecrets(PASSWORD);
const assets = { "index.html": "<html>private application</html>", "styles.css": "body{color:gray}",
  "app.js": "private application script", "js/private.js": "private application module", "data/prices.json": "{}" };
const makeBook = () => createPortfolioBook({ now: NOW, startDate: "2020-01-01", holdings: [
  { id: "opening-msft", kind: "position", ticker: "MSFT", label: "Synthetic holding", shares: 2, averageCost: 100, currency: "USD" },
] });

function setup(t, options = {}) {
  const DB = createLocalDatabase();
  t.after(() => DB.close());
  return { app: createApp(assets, { now: NOW, ...options }), env: { DB, INVESTMENT_AUTH_MODE: "password", ...secrets }, DB };
}
function request(path, { method = "GET", cookie, form, value, body, headers = {}, origin = ORIGIN } = {}) {
  const fields = { ...headers, ...(cookie ? { Cookie: cookie } : {}) };
  const init = { method, headers: fields };
  if (form !== undefined) { init.body = new URLSearchParams(form).toString(); fields["content-type"] ??= "application/x-www-form-urlencoded"; }
  if (value !== undefined) { init.body = JSON.stringify(value); fields["content-type"] ??= "application/json"; }
  if (body !== undefined) { init.body = body; init.duplex = "half"; }
  return new Request(origin + path, init);
}
async function login(app, env, password = PASSWORD, options = {}) {
  return app.fetch(request("/login", { method: "POST", form: { password }, headers: { Origin: ORIGIN, "sec-fetch-site": "same-origin", "cf-connecting-ip": "192.0.2.10" }, ...options }), env);
}
const cookieFrom = (response) => response.headers.get("set-cookie")?.split(";")[0];
async function seed(DB, owner, { portfolio = true, watchlist = true } = {}) {
  if (portfolio) await DB.prepare("INSERT INTO portfolio_books (user_id, book, revision, updated_at) VALUES (?, ?, ?, ?)")
    .bind(owner, JSON.stringify(makeBook()), 7, new Date(NOW).toISOString()).run();
  if (watchlist) await DB.prepare("INSERT INTO watchlists (user_id, tickers, revision, updated_at) VALUES (?, ?, ?, ?)")
    .bind(owner, '["MSFT","VWCE.DE"]', 4, new Date(NOW).toISOString()).run();
}

test("password secrets use random salts and session keys without storing the password", async () => {
  const other = await generatePasswordSecrets(PASSWORD);
  assert.match(secrets.INVESTMENT_PASSWORD_HASH, /^v1:100000:[a-f0-9]{32}:[a-f0-9]{64}$/);
  assert.match(secrets.INVESTMENT_SESSION_SECRET, /^[a-f0-9]{64}$/);
  assert.notEqual(other.INVESTMENT_PASSWORD_HASH, secrets.INVESTMENT_PASSWORD_HASH);
  assert.notEqual(other.INVESTMENT_SESSION_SECRET, secrets.INVESTMENT_SESSION_SECRET);
  assert(!JSON.stringify(secrets).includes(PASSWORD));
  for (const invalid of ["", null, "x".repeat(257)]) await assert.rejects(generatePasswordSecrets(invalid));
});

test("anonymous and spoofed native identities cannot read pages, assets or any private API", async (t) => {
  const { app, env } = setup(t);
  const spoof = { "oai-authenticated-user-id": "original-owner", "x-expected-user-id": "original-owner" };
  for (const path of ["/", "/index.html", "/styles.css", "/app.js", "/js/private.js", "/data/prices.json", "/missing"]) {
    const response = await app.fetch(request(path, { headers: spoof }), env);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/login");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(await response.text(), "");
  }
  for (const path of ["/api", "/api/session", "/api/portfolio", "/api/watchlist", "/api/market/history?ticker=MSFT", "/api/exchange-rate", "/api/portfolio-fx", "/api/unknown"]) {
    const response = await app.fetch(request(path, { headers: spoof }), env);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "SIGN_IN_REQUIRED");
  }
  const health = await app.fetch(request("/api/health"), env);
  assert.deepEqual(await health.json(), { ok: true, cloud: true, storageAvailable: true });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM password_workspace").first()).count, 0);
});

test("login is standalone, uncached and does not expose credentials or load protected scripts", async (t) => {
  const { app, env } = setup(t);
  const response = await app.fetch(request("/login?next=/%23portfolio"), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /form-action 'self'/);
  const html = await response.text();
  assert.match(html, /type="password"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /value="\/#portfolio"/);
  assert.doesNotMatch(html, /<script|<link|border-radius:(?!0)/);
  assert(!html.includes(PASSWORD));
  assert(!html.includes(secrets.INVESTMENT_PASSWORD_HASH));
  assert.equal((await app.fetch(request("/login", { method: "HEAD" }), env)).body, null);
});

test("correct login creates a 30-day secure HttpOnly host cookie and permits private data", async (t) => {
  const { app, env } = setup(t);
  const response = await login(app, env, PASSWORD, { form: { password: PASSWORD, next: "/#portfolio" } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/#portfolio");
  const issued = response.headers.get("set-cookie");
  assert.match(issued, /^__Host-investment_session=\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  assert.doesNotMatch(issued, /Domain=|synthetic-test-password-only/);
  const cookie = cookieFrom(response);
  const sessionResponse = await app.fetch(request("/api/session", { cookie }), env);
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 200);
  assert.equal(session.cloud, true);
  assert.equal(session.authMode, "password");
  assert.equal(session.storageAvailable, true);
  assert.equal(session.userId, "personal-password-workspace");
  assert.equal(sessionResponse.headers.get("x-portfolio-user-id"), session.userId);
  assert.equal((await app.fetch(request("/app.js", { cookie }), env)).status, 200);
  assert.equal((await app.fetch(request("/login", { cookie }), env)).headers.get("location"), "/");
  // Successful login clears its own IP bucket but preserves the aggregate cap.
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM password_login_attempts").first()).count, 1);
  assert.equal((await env.DB.prepare("SELECT attempts FROM password_login_attempts").first()).attempts, 1);
});

test("session signature tampering, duplicates, expiration and credential rotation revoke access", async (t) => {
  let time = NOW;
  const { app, env } = setup(t, { now: () => time });
  const response = await login(app, env);
  const cookie = cookieFrom(response);
  const tokens = [cookie.slice(0, -1) + (cookie.endsWith("a") ? "b" : "a"), cookie.replace(/=\d+/, "=9999999999"), cookie + "; " + cookie,
    "__Host-investment_session=invalid"];
  for (const candidate of tokens) assert.equal((await app.fetch(request("/api/session", { cookie: candidate }), env)).status, 401);
  const rotatedPassword = await generatePasswordSecrets("another-synthetic-test-password");
  assert.equal((await app.fetch(request("/api/session", { cookie }), { ...env, INVESTMENT_PASSWORD_HASH: rotatedPassword.INVESTMENT_PASSWORD_HASH })).status, 401);
  assert.equal((await app.fetch(request("/api/session", { cookie }), { ...env, INVESTMENT_SESSION_SECRET: rotatedPassword.INVESTMENT_SESSION_SECRET })).status, 401);
  time += 30 * 24 * 60 * 60 * 1000;
  assert.equal((await app.fetch(request("/api/session", { cookie }), env)).status, 401);
});

test("password mode fails closed for incomplete config and unavailable D1 without falling back to native headers", async (t) => {
  const { app, env } = setup(t);
  const spoof = { "oai-authenticated-user-id": "owner" };
  for (const changes of [{ INVESTMENT_PASSWORD_HASH: undefined }, { INVESTMENT_PASSWORD_HASH: "invalid" }, { INVESTMENT_SESSION_SECRET: undefined }, { INVESTMENT_SESSION_SECRET: "invalid" }]) {
    for (const path of ["/", "/login", "/api/session"]) {
      const response = await app.fetch(request(path, { headers: spoof }), { ...env, ...changes });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "AUTH_UNAVAILABLE");
      assert.equal(response.headers.get("set-cookie"), null);
    }
  }
  for (const DB of [undefined, { prepare() { throw new Error("Synthetic database details must stay private"); } }]) {
    const response = await login(app, { ...env, DB });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.doesNotMatch(await response.text(), /Synthetic database details/);
  }
});

test("login and logout reject cross-site requests and unsupported methods", async (t) => {
  const { app, env } = setup(t);
  const cookie = cookieFrom(await login(app, env));
  for (const path of ["/login", "/logout"]) {
    for (const headers of [{ Origin: "https://attacker.example" }, { Origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }]) {
      const response = await app.fetch(request(path, { method: "POST", cookie, form: { password: PASSWORD }, headers }), env);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("set-cookie"), null);
    }
  }
  for (const method of ["PUT", "DELETE", "OPTIONS"]) {
    const response = await app.fetch(request("/login", { method }), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD, POST");
  }
  for (const method of ["GET", "HEAD", "PUT", "OPTIONS"]) {
    const response = await app.fetch(request("/logout", { method, cookie }), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  }
  const logout = await app.fetch(request("/logout", { method: "POST", cookie, headers: { Origin: ORIGIN } }), env);
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("location"), "/login");
  assert.match(logout.headers.get("set-cookie"), /^__Host-investment_session=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/);
  assert.equal((await app.fetch(request("/api/session"), env)).status, 401);
});

test("login rejects oversized streamed forms, duplicate fields and unsupported content types", async (t) => {
  const { app, env } = setup(t);
  assert.equal((await login(app, env, PASSWORD, { headers: { "content-type": "text/plain" } })).status, 415);
  for (const form of [{ password: "" }, { password: "x".repeat(257) }, { password: PASSWORD, userId: "other" }]) {
    assert.equal((await login(app, env, PASSWORD, { form })).status, 400);
  }
  const duplicate = await app.fetch(request("/login", { method: "POST", body: "password=first&password=second", headers: { "content-type": "application/x-www-form-urlencoded" } }), env);
  assert.equal(duplicate.status, 400);
  const claimed = await login(app, env, PASSWORD, { headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "2049" } });
  assert.equal(claimed.status, 413);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("password=" + "x".repeat(3000))); }, cancel() { cancelled = true; } });
  const oversized = await app.fetch(request("/login", { method: "POST", body: stream, headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "1" } }), env);
  assert.equal(oversized.status, 413);
  assert.equal(cancelled, true);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM password_login_attempts").first()).count, 0);
});

test("return paths cannot redirect off-site, escape HTML or navigate arbitrary routes", async (t) => {
  const { app, env } = setup(t);
  for (const next of ["https://attacker.example", "//attacker.example", "/\\attacker.example", "/server/private", "/?secret=value", '/\" autofocus onfocus=\"alert(1)', "/#unknown"]) {
    const page = await app.fetch(request("/login?next=" + encodeURIComponent(next)), env);
    assert.match(await page.text(), /name="next" value="\/"/);
    const response = await login(app, env, PASSWORD, { form: { password: PASSWORD, next } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
  }
});

test("login throttling survives Worker recreation and resets only after its durable window", async (t) => {
  let time = NOW;
  const { env, DB } = setup(t);
  for (let index = 0; index < 5; index++) {
    const app = createApp(assets, { now: () => time });
    const response = await login(app, env, "synthetic-incorrect-password");
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  const freshApp = createApp(assets, { now: () => time });
  const denied = await login(freshApp, env);
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "600");
  const row = await DB.prepare("SELECT * FROM password_login_attempts").first();
  assert.equal(row.attempts, 6);
  assert.match(row.attempt_key, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(row).includes("192.0.2.10"));
  time += 10 * 60 * 1000;
  assert.equal((await login(freshApp, env)).status, 303);
});

test("concurrent login attempts reserve the shared limit atomically before verification", async (t) => {
  const { env, DB } = setup(t);
  const responses = await Promise.all(Array.from({ length: 12 }, () => login(createApp(assets, { now: NOW }), env, "synthetic-incorrect-password")));
  assert.equal(responses.filter((response) => response.status === 401).length, 5);
  assert.equal(responses.filter((response) => response.status === 429).length, 7);
  assert.equal((await DB.prepare("SELECT attempts FROM password_login_attempts").first()).attempts, 6);
  // An unrelated edge address uses a separate bucket.
  assert.equal((await login(createApp(assets, { now: NOW }), env, PASSWORD, { headers: { "cf-connecting-ip": "192.0.2.11" } })).status, 303);
});

test("the aggregate login cap survives success and bounds concurrent attempts from different addresses", async (t) => {
  const { app, env, DB } = setup(t);
  assert.equal((await login(app, env)).status, 303);
  // At this point only the durable aggregate bucket remains. Put it one
  // admitted attempt from the cap without spending 200 expensive verifications.
  await DB.prepare("UPDATE password_login_attempts SET attempts = ?").bind(199).run();
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => login(createApp(assets, { now: NOW }), env,
    "synthetic-incorrect-password", { headers: { "cf-connecting-ip": `192.0.2.${30 + index}` } })));
  assert.equal(responses.filter((response) => response.status === 401).length, 1);
  assert.equal(responses.filter((response) => response.status === 429).length, 5);
  assert.equal((await DB.prepare("SELECT MAX(attempts) AS count FROM password_login_attempts").first()).count, 201);
  assert.equal((await login(createApp(assets, { now: NOW }), env, PASSWORD, { headers: { "cf-connecting-ip": "192.0.2.90" } })).status, 429);
});

test("a bundle-pinned password mode overrides native runtime flags and unknown modes fail closed", async (t) => {
  const { env } = setup(t);
  const forced = createApp(assets, { now: NOW, authMode: "password" });
  const owner = { "oai-authenticated-user-id": "spoof-owner" };
  const nativeRuntime = { ...env, INVESTMENT_AUTH_MODE: "chatgpt" };
  assert.equal((await forced.fetch(request("/", { headers: owner }), nativeRuntime)).status, 303);
  assert.equal((await forced.fetch(request("/api/session", { headers: owner }), nativeRuntime)).status, 401);
  const unconfigured = { DB: env.DB, INVESTMENT_AUTH_MODE: "chatgpt" };
  assert.equal((await forced.fetch(request("/", { headers: owner }), unconfigured)).status, 503);
  for (const mode of ["pasword", "", "public"]) {
    const app = createApp(assets, { now: NOW });
    assert.equal((await app.fetch(request("/", { headers: owner }), { ...env, INVESTMENT_AUTH_MODE: mode })).status, 503);
  }
});

test("sole existing owner data, row keys and revisions survive password login and native headers are ignored", async (t) => {
  const { app, env, DB } = setup(t);
  await seed(DB, "original-sites-owner");
  const beforeBook = await DB.prepare("SELECT * FROM portfolio_books").first();
  const beforeWatchlist = await DB.prepare("SELECT * FROM watchlists").first();
  const cookie = cookieFrom(await login(app, env));
  const spoof = { "oai-authenticated-user-id": "some-other-account" };
  const session = await (await app.fetch(request("/api/session", { cookie, headers: spoof }), env)).json();
  assert.equal(session.userId, "original-sites-owner");
  const portfolio = await (await app.fetch(request("/api/portfolio", { cookie, headers: spoof }), env)).json();
  const watchlist = await (await app.fetch(request("/api/watchlist", { cookie, headers: spoof }), env)).json();
  assert.equal(portfolio.revision, 7);
  assert.equal(portfolio.book.openingHoldings[0].label, "Synthetic holding");
  assert.equal(watchlist.revision, 4);
  assert.deepEqual(watchlist.tickers, ["MSFT", "VWCE.DE"]);
  assert.deepEqual(await DB.prepare("SELECT * FROM portfolio_books").first(), beforeBook);
  assert.deepEqual(await DB.prepare("SELECT * FROM watchlists").first(), beforeWatchlist);
  assert.equal((await DB.prepare("SELECT user_id FROM password_workspace").first()).user_id, "original-sites-owner");
  const failed = await app.fetch(request("/api/watchlist", { method: "PUT", cookie, headers: { "x-expected-user-id": "some-other-account" }, value: { tickers: ["AAPL"], expectedRevision: 4 } }), env);
  assert.equal(failed.status, 409);
  assert.equal((await failed.json()).code, "ACCOUNT_CHANGED");
  assert.deepEqual(await DB.prepare("SELECT * FROM watchlists").first(), beforeWatchlist);
  const saved = await app.fetch(request("/api/watchlist", { method: "PUT", cookie, headers: { Origin: ORIGIN, "x-expected-user-id": session.userId }, value: { tickers: ["AAPL"], expectedRevision: 4 } }), env);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 5);
  const stale = await app.fetch(request("/api/watchlist", { method: "PUT", cookie, headers: { "x-expected-user-id": session.userId }, value: { tickers: ["MSFT"], expectedRevision: 4 } }), env);
  assert.equal(stale.status, 409);
});

test("watchlist-only and portfolio-only existing workspaces are selected without inventing a new owner", async (t) => {
  for (const selection of [{ portfolio: true, watchlist: false }, { portfolio: false, watchlist: true }]) {
    const { app, env, DB } = setup(t);
    await seed(DB, "single-owner", selection);
    const cookie = cookieFrom(await login(app, env));
    assert.equal((await (await app.fetch(request("/api/session", { cookie }), env)).json()).userId, "single-owner");
  }
});

test("empty databases map once to a stable personal workspace during concurrent first login", async (t) => {
  const { app, env, DB } = setup(t);
  const responses = await Promise.all([login(app, env), login(createApp(assets, { now: NOW }), env)]);
  assert(responses.every((response) => response.status === 303));
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM password_workspace").first()).count, 1);
  const ids = await Promise.all(responses.map(async (response) => (await (await app.fetch(request("/api/session", { cookie: cookieFrom(response) }), env)).json()).userId));
  assert.deepEqual(ids, ["personal-password-workspace", "personal-password-workspace"]);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM portfolio_books").first()).count, 0);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM watchlists").first()).count, 0);
});

test("ambiguous owner records fail closed; an exact trusted override chooses without deleting other records", async (t) => {
  const { app, env, DB } = setup(t);
  await seed(DB, "owner-a", { portfolio: true, watchlist: false });
  await seed(DB, "owner-b", { portfolio: false, watchlist: true });
  const response = await login(app, env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "WORKSPACE_UNAVAILABLE");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM password_workspace").first()).count, 0);
  for (const override of ["unknown-owner", "invalid owner"]) {
    assert.equal((await login(app, { ...env, INVESTMENT_WORKSPACE_ID: override })).status, 503);
  }
  const selectedEnv = { ...env, INVESTMENT_WORKSPACE_ID: "owner-a" };
  const accepted = await login(app, selectedEnv);
  assert.equal(accepted.status, 303);
  const cookie = cookieFrom(accepted);
  assert.equal((await (await app.fetch(request("/api/session", { cookie }), selectedEnv)).json()).userId, "owner-a");
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM portfolio_books").first()).count, 1);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM watchlists").first()).count, 1);
  // Later configuration cannot silently remap a persisted workspace.
  assert.equal((await app.fetch(request("/api/session", { cookie }), { ...env, INVESTMENT_WORKSPACE_ID: "owner-b" })).status, 503);
});

test("a record arriving during first workspace setup cannot be orphaned under a new key", async (t) => {
  const { env, DB } = setup(t);
  let intervened = false;
  const raced = { prepare(sql) {
    const prepared = DB.prepare(sql);
    if (!sql.includes("SELECT user_id FROM portfolio_books UNION")) return prepared;
    return { async all() {
      const result = await prepared.all();
      if (!intervened) { intervened = true; await seed(DB, "late-original-owner"); }
      return result;
    } };
  } };
  await assert.rejects(resolvePasswordWorkspace({ ...env, DB: raced }), (error) => error.code === "WORKSPACE_UNAVAILABLE");
  assert.equal((await DB.prepare("SELECT COUNT(*) AS count FROM password_workspace").first()).count, 0);
  assert.equal(await resolvePasswordWorkspace(env), "late-original-owner");
});

test("only loopback HTTP previews use the non-secure development cookie; public HTTP fails closed", async (t) => {
  const { app, env } = setup(t);
  const response = await app.fetch(request("/login", { origin: "http://127.0.0.1:4180", method: "POST", form: { password: PASSWORD }, headers: { Origin: "http://127.0.0.1:4180" } }), env);
  assert.equal(response.status, 303);
  assert.match(response.headers.get("set-cookie"), /^investment_preview_session=/);
  assert.doesNotMatch(response.headers.get("set-cookie"), /Secure/);
  assert.equal((await app.fetch(request("/api/session", { origin: "http://127.0.0.1:4180", cookie: cookieFrom(response) }), env)).status, 200);
  assert.equal((await app.fetch(request("/api/session", { origin: "http://public.example" }), env)).status, 503);
  assert.equal((await app.fetch(request("/api/session", { cookie: cookieFrom(response) }), env)).status, 401);
});

test("password-authenticated mutations retain same-origin, expected-identity and CAS protections", async (t) => {
  const { app, env } = setup(t);
  const cookie = cookieFrom(await login(app, env));
  const userId = "personal-password-workspace";
  const value = { book: makeBook(), expectedRevision: 0 };
  const missingExpected = await app.fetch(request("/api/portfolio", { cookie, method: "PUT", value }), env);
  assert.equal(missingExpected.status, 409);
  const crossed = await app.fetch(request("/api/portfolio", { cookie, method: "PUT", value, headers: { "x-expected-user-id": userId, Origin: "https://attacker.example" } }), env);
  assert.equal(crossed.status, 403);
  const write = () => app.fetch(request("/api/portfolio", { cookie, method: "PUT", value, headers: { "x-expected-user-id": userId, Origin: ORIGIN } }), env);
  assert.deepEqual((await Promise.all([write(), write()])).map((response) => response.status).sort(), [200, 409]);
});
