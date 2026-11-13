import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/worker.mjs";
import { createLocalDatabase } from "../server/local-database.mjs";
import { generatePasswordSecrets } from "../server/auth.mjs";
import { createPortfolioBook, portfolioToday, projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { readCloudRecord } from "../server/cloud-store.mjs";
import { prepareCashOperation, cashConfirmationView, confirmCashOperation } from "../server/cash-operations.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.parse("2026-11-12T22:30:00Z"), ORIGIN = "https://investment.example.chatgpt.site";
const secrets = await generatePasswordSecrets("cash-test-password");
const identity = { "oai-authenticated-user-id": "site-owner", "oai-authenticated-user-email": "owner@example.com" };
async function setup(t) {
  const DB = createLocalDatabase(); t.after(() => DB.close());
  let now = NOW;
  const env = { DB, ...secrets, INVESTMENT_MCP_OWNER_EMAIL: "owner@example.com" };
  const app = createApp({ "index.html": "private website" }, { authMode: "password", now: () => now,
    fetchImpl() { throw new Error("Cash operations must not contact a bank, broker or market provider"); } });
  const book = createPortfolioBook({ now: NOW, startDate: "2026-01-01", holdings: [
    { id: "original-holding", kind: "position", ticker: "MSFT", label: "Microsoft", shares: 2, averageCost: 100, currency: "USD" },
  ] });
  book.transactions.push({ id: "original-funding", type: "deposit", date: "2026-01-01", currency: "EUR", amount: 1000, cashCurrency: "EUR", cashAmount: 1000, note: "Keep original note" });
  await DB.prepare("INSERT INTO password_workspace (workspace_key, user_id) VALUES (?, ?)").bind("personal", "workspace").run();
  await DB.prepare("INSERT INTO portfolio_books (user_id, book, revision, updated_at) VALUES (?, ?, ?, ?)").bind("workspace", JSON.stringify(book), 7, new Date(NOW).toISOString()).run();
  await DB.prepare("INSERT INTO watchlists (user_id, tickers, revision, updated_at) VALUES (?, ?, ?, ?)").bind("workspace", '["MSFT","VICR"]', 4, new Date(NOW).toISOString()).run();
  const login = await app.fetch(new Request(ORIGIN + "/login", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: "password=cash-test-password" }), env);
  const Cookie = login.headers.get("set-cookie").split(";")[0];
  const tool = async (name, args, headers = identity) => {
    const response = await app.fetch(new Request(ORIGIN + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env);
    return { response, body: await response.json() };
  };
  const prepare = async args => (await tool("add_cash_deposit", { amount: 250, idempotency_key: "deposit-test-001", ...args })).body.result.structuredContent;
  const review = async operationId => {
    const response = await app.fetch(new Request(`${ORIGIN}/cash-operations/${operationId}`, { headers: { Cookie } }), env);
    const html = await response.text();
    return { response, html, csrf: html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1] };
  };
  const submit = (operationId, csrf, fields = {}, headers = {}) => app.fetch(new Request(`${ORIGIN}/cash-operations/${operationId}`, {
    method: "POST", headers: { Cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ csrf, action: "confirm", ...fields }),
  }), env);
  const saved = () => readCloudRecord(env, "workspace", "portfolio", now);
  return { DB, env, app, book, Cookie, prepare, review, submit, tool, saved, setNow: value => { now = value; } };
}

test("deposit prepares without changing cash; authenticated human confirmation appends one transaction and audit", async t => {
  const s = await setup(t);
  const before = await s.saved(), p = await s.prepare();
  assert.equal(p.status, "confirmation_required"); assert.equal(p.proposal.currency, "EUR");
  assert.equal(p.proposal.date, portfolioToday(NOW));
  assert.equal((await s.saved()).revision, 7);
  assert.equal(projectPortfolioBook((await s.saved()).book).reportingCash.amount, 1000);
  const page = await s.review(p.operationId);
  assert.match(page.html, /Confirm deposit/); assert.match(page.html, /No bank transfer or trade/);
  assert.match(page.response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.response.headers.get("referrer-policy"), "same-origin", "Browser form submissions must preserve a checkable same-origin Origin");
  assert.equal((await s.submit(p.operationId, page.csrf)).status, 303);
  const after = await s.saved();
  assert.equal(after.revision, 8);
  assert.equal(projectPortfolioBook(after.book).reportingCash.amount, 1250);
  assert.deepEqual(after.book.openingHoldings, before.book.openingHoldings);
  assert.deepEqual(after.book.transactions.slice(0, before.book.transactions.length), before.book.transactions);
  const receipt = (await s.tool("get_cash_operation", { operation_id: p.operationId })).body.result.structuredContent;
  assert.equal(receipt.status, "confirmed"); assert.deepEqual(receipt.audit.map(row => row.event), ["prepared", "confirmed"]);
  assert(!JSON.stringify(receipt).includes(page.csrf));
  assert.equal((await s.DB.prepare("SELECT revision FROM watchlists").first()).revision, 4);
});

test("idempotency survives duplicate preparation and concurrent double confirmation; changed payload conflicts", async t => {
  const s = await setup(t);
  const [first, retry] = await Promise.all([s.prepare(), s.prepare()]);
  assert.equal(first.operationId, retry.operationId);
  assert.equal((await s.DB.prepare("SELECT COUNT(*) AS n FROM cash_audit").first()).n, 1);
  const page = await s.review(first.operationId);
  const responses = await Promise.all([s.submit(first.operationId, page.csrf), s.submit(first.operationId, page.csrf)]);
  assert(responses.every(response => response.status === 303));
  assert.equal((await s.saved()).book.transactions.length, 2);
  assert.equal((await s.prepare()).status, "confirmed");
  s.setNow(NOW + 86400000);
  assert.equal((await s.prepare()).proposal.date, portfolioToday(NOW), "Default dates are frozen for idempotent retries across midnight");
  const conflict = await s.prepare({ amount: 251 });
  assert.equal(conflict.errors[0].code, "IDEMPOTENCY_CONFLICT");
});

test("server requires authenticated owner, real review CSRF and same origin; no model confirmed flag bypass", async t => {
  const s = await setup(t);
  for (const headers of [{}, { ...identity, "oai-authenticated-user-email": "other@example.com" }]) {
    assert([401, 403].includes((await s.tool("add_cash_deposit", { amount: 250, idempotency_key: "deposit-auth-001" }, headers)).response.status));
  }
  assert.equal((await s.tool("add_cash_deposit", { amount: 250, idempotency_key: "deposit-auth-001", confirmed: true })).body.error.code, -32602);
  const p = await s.prepare(), page = await s.review(p.operationId);
  const anonymous = await s.app.fetch(new Request(`${ORIGIN}/cash-operations/${p.operationId}`), s.env);
  assert.equal(anonymous.status, 303); assert.match(anonymous.headers.get("location"), /^\/login\?next=/);
  assert.equal((await s.submit(p.operationId, "fake-token")).status, 403);
  assert.equal((await s.submit(p.operationId, page.csrf, {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await s.submit(p.operationId, page.csrf, {}, { Origin: "" })).status, 403);
  assert.equal((await s.submit(p.operationId, page.csrf, {}, { Origin: "null" })).status, 403);
  assert.equal((await s.saved()).revision, 7);
  assert.equal((await s.DB.prepare("SELECT COUNT(*) AS n FROM cash_operations").first()).n, 1);
});

test("validation rejects zero, negative, invalid precision/currency/dates without staging a proposal", async t => {
  const s = await setup(t);
  for (const args of [{ amount: 0 }, { amount: -1 }, { amount: 0.001 }, { amount: 1e12 }, { currency: "XXX" },
    { date: null }, { currency: null },
    { date: "2026-02-30" }, { date: "2020-01-01" }, { date: "2099-01-01" }, { idempotency_key: "short" }]) {
    const result = await s.prepare(args); assert.equal(result.status, "unavailable");
  }
  assert.equal((await s.DB.prepare("SELECT COUNT(*) AS n FROM cash_operations").first()).n, 0);
});

test("foreign cash uses the user's exact reporting-currency settlement and supports comma input", async t => {
  const s = await setup(t), p = await s.prepare({ amount: 200, currency: "USD", date: "2026-10-01" });
  const page = await s.review(p.operationId);
  assert.match(page.html, /Exact EUR amount credited/);
  assert.equal((await s.submit(p.operationId, page.csrf)).status, 400);
  assert.equal((await s.submit(p.operationId, page.csrf, { cash_amount: "180,25" })).status, 303);
  const book = (await s.saved()).book;
  assert.equal(book.transactions.at(-1).currency, "USD"); assert.equal(book.transactions.at(-1).cashAmount, 180.25);
  assert.equal(projectPortfolioBook(book).reportingCash.amount, 1180.25);
});

test("expired, cancelled or revision-conflicting proposals cannot modify the ledger", async t => {
  const s = await setup(t);
  const cancelled = await s.prepare(), cancelPage = await s.review(cancelled.operationId);
  assert.equal((await s.submit(cancelled.operationId, cancelPage.csrf, { action: "cancel" })).status, 303);
  assert.equal((await s.submit(cancelled.operationId, cancelPage.csrf)).status, 409);
  const expired = await s.prepare({ idempotency_key: "deposit-expired-001" }), expiredPage = await s.review(expired.operationId);
  s.setNow(NOW + 16 * 60000);
  assert.equal((await s.submit(expired.operationId, expiredPage.csrf)).status, 409);
  s.setNow(NOW);
  const changed = await s.prepare({ idempotency_key: "deposit-changed-001" }), changedPage = await s.review(changed.operationId);
  await s.DB.prepare("UPDATE portfolio_books SET revision = revision + 1 WHERE user_id = ?").bind("workspace").run();
  assert.equal((await s.submit(changed.operationId, changedPage.csrf)).status, 409);
  assert.equal((await s.saved()).book.transactions.length, 1);
});

test("reversal appends an exact compensating entry, preserves history, and cannot be applied twice", async t => {
  const s = await setup(t), p = await s.prepare({ date: "2026-10-01" }), page = await s.review(p.operationId);
  await s.submit(p.operationId, page.csrf);
  const original = (await s.saved()).book.transactions.at(-1);
  const reverse = await s.tool("reverse_cash_deposit", { operation_id: p.operationId, idempotency_key: "reversal-test-001" });
  const r = reverse.body.result.structuredContent, review = await s.review(r.operationId);
  assert.match(review.html, /Confirm reversal/);
  assert.equal((await s.submit(r.operationId, review.csrf)).status, 303);
  const book = (await s.saved()).book;
  assert.equal(projectPortfolioBook(book).reportingCash.amount, 1000);
  assert.deepEqual(book.transactions[1], original);
  assert.equal(book.transactions[2].type, "withdrawal"); assert.equal(book.transactions[2].date, original.date);
  assert.equal(book.transactions[2].cashAmount, original.cashAmount);
  const duplicate = await s.tool("reverse_cash_deposit", { operation_id: p.operationId, idempotency_key: "reversal-test-002" });
  assert.equal(duplicate.body.result.structuredContent.errors[0].code, "ALREADY_REVERSED");
});

test("an audit failure rolls back cash, portfolio revision and operation confirmation atomically", async t => {
  const s = await setup(t), p = await s.prepare(), page = await s.review(p.operationId);
  await s.DB.prepare("INSERT INTO cash_audit (id, user_id, operation_id, event, actor, occurred_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(`${p.operationId}:confirmed`, "workspace", p.operationId, "synthetic-injected-failure", "test", new Date(NOW).toISOString()).run();
  assert.equal((await s.submit(p.operationId, page.csrf)).status, 503);
  assert.equal((await s.saved()).revision, 7);
  assert.equal((await s.saved()).book.transactions.length, 1);
  assert.equal((await s.DB.prepare("SELECT status FROM cash_operations WHERE id = ?").bind(p.operationId).first()).status, "pending");
});

test("idempotency and confirmation receipts survive database reopen", async t => {
  const directory = await mkdtemp(join(tmpdir(), "investment-cash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "cash.sqlite");
  let DB = createLocalDatabase(filename);
  const book = createPortfolioBook({ now: NOW, startDate: "2026-01-01" });
  await DB.prepare("INSERT INTO portfolio_books (user_id, book, revision, updated_at) VALUES (?, ?, ?, ?)").bind("workspace", JSON.stringify(book), 1, new Date(NOW).toISOString()).run();
  const input = { amount: 25, idempotency_key: "persistent-key-001" }, context = { now: NOW, origin: ORIGIN };
  const prepared = await prepareCashOperation({ DB }, "workspace", "owner", input, context);
  const view = await cashConfirmationView({ DB }, "workspace", prepared.operationId, NOW);
  await confirmCashOperation({ DB }, "workspace", prepared.operationId, view.csrf, { now: NOW });
  DB.close();
  DB = createLocalDatabase(filename);
  try {
    const retry = await prepareCashOperation({ DB }, "workspace", "owner", input, { ...context, now: NOW + 86400000 });
    assert.equal(retry.operationId, prepared.operationId); assert.equal(retry.status, "confirmed");
    assert.equal((await readCloudRecord({ DB }, "workspace", "portfolio", NOW + 86400000)).book.transactions.length, 1);
  } finally { DB.close(); }
});

test("two independently prepared reversal requests cannot both apply", async t => {
  const s = await setup(t), p = await s.prepare(), page = await s.review(p.operationId);
  await s.submit(p.operationId, page.csrf);
  const prepareReverse = async key => (await s.tool("reverse_cash_deposit", { operation_id: p.operationId, idempotency_key: key })).body.result.structuredContent;
  const [a, b] = await Promise.all([prepareReverse("reversal-race-001"), prepareReverse("reversal-race-002")]);
  const [aPage, bPage] = await Promise.all([s.review(a.operationId), s.review(b.operationId)]);
  const responses = await Promise.all([s.submit(a.operationId, aPage.csrf), s.submit(b.operationId, bPage.csrf)]);
  assert.equal(responses.filter(response => response.status === 303).length, 1);
  assert.equal((await s.saved()).book.transactions.length, 3);
  assert.equal(projectPortfolioBook((await s.saved()).book).reportingCash.amount, 1000);
});
