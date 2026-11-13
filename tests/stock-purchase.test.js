import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/worker.mjs";
import { createLocalDatabase } from "../server/local-database.mjs";
import { generatePasswordSecrets } from "../server/auth.mjs";
import { createPortfolioBook, projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { readCloudRecord } from "../server/cloud-store.mjs";
import { serializePortfolioBackup, parsePortfolioBackup } from "../js/data/portfolio-book-store.js";
import { transactionReport } from "../js/analysis/portfolio-reports.js";
import { calculatePortfolioPerformance } from "../js/analysis/portfolio-performance.js";

const NOW = Date.parse("2026-11-13T12:00:00Z"), ORIGIN = "https://investment.example";
const secrets = await generatePasswordSecrets("synthetic-purchase-test-password");
const identity = { "oai-authenticated-user-id": "owner", "oai-authenticated-user-email": "owner@example.com" };
const purchase = overrides => ({ ticker: "MSFT", quantity: 2, executed_at: "2026-10-10T14:00:00Z", currency: "USD", price_per_share: 100,
  fees: 1, total_native_cost: 201, eur_cost_basis: 180, cash_treatment: "deduct", idempotency_key: "purchase-test-001", ...overrides });
async function setup(t, entries = []) {
  const DB = createLocalDatabase(); t.after(() => DB.close());
  const book = createPortfolioBook({ now: NOW, startDate: "2026-01-01" });
  book.transactions = [{ id: "fund", type: "deposit", date: "2026-01-01", currency: "EUR", amount: 1000, cashCurrency: "EUR", cashAmount: 1000 }, ...entries];
  await DB.prepare("INSERT INTO password_workspace (workspace_key, user_id) VALUES (?, ?)").bind("personal", "workspace").run();
  await DB.prepare("INSERT INTO portfolio_books (user_id, book, revision, updated_at) VALUES (?, ?, ?, ?)").bind("workspace", JSON.stringify(book), 3, new Date(NOW).toISOString()).run();
  const app = createApp({}, { authMode: "password", now: NOW, fetchImpl() { throw new Error("Purchase recording must not call trading or price APIs"); } });
  const env = { DB, ...secrets, INVESTMENT_MCP_OWNER_EMAIL: "owner@example.com" };
  const login = await app.fetch(new Request(ORIGIN + "/login", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: "password=synthetic-purchase-test-password" }), env);
  const Cookie = login.headers.get("set-cookie").split(";")[0];
  const tool = async (args, headers = identity) => {
    const response = await app.fetch(new Request(ORIGIN + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_stock_purchase", arguments: args } }) }), env);
    const body = await response.json(); return { response, body, value: body.result?.structuredContent };
  };
  const review = async p => {
    const response = await app.fetch(new Request(p.confirmationUrl, { headers: { Cookie } }), env);
    const html = await response.text(); return { html, csrf: html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1] };
  };
  const confirm = async (p, csrf, { ack = true, origin = ORIGIN } = {}) => app.fetch(new Request(p.confirmationUrl, { method: "POST",
    headers: { Cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, action: "confirm", ...(ack ? { purchase_ack: "yes" } : {}) }) }), env);
  const saved = () => readCloudRecord(env, "workspace", "portfolio", NOW);
  const record = async overrides => { const p = (await tool(purchase(overrides))).value; const page = await review(p); assert.equal((await confirm(p, page.csrf)).status, 303); return p; };
  return { DB, app, env, book, tool, review, confirm, saved, record };
}

test("confirmed purchase appends history and computes weighted native/EUR cost bases and cash once", async t => {
  const s = await setup(t), before = await s.saved();
  const p = (await s.tool(purchase())).value;
  assert.equal(p.status, "confirmation_required"); assert.equal((await s.saved()).revision, 3);
  const page = await s.review(p); assert.match(page.html, /Exact EUR cost basis/); assert.match(page.html, /decrease by 180/);
  assert.equal((await s.confirm(p, page.csrf, { ack: false })).status, 400);
  assert.equal((await s.confirm(p, page.csrf)).status, 303);
  const first = projectPortfolioBook((await s.saved()).book);
  assert.equal(first.holdings[0].shares, 2); assert.equal(first.holdings[0].averageCost, 100.5);
  assert.equal(first.eurCostBases[0].costBasis, 180); assert.equal(first.reportingCash.amount, 820);
  await s.record({ quantity: 1, price_per_share: 150, fees: 0.5, total_native_cost: 150.5, eur_cost_basis: 140,
    executed_at: "2026-10-11T14:00:00Z", idempotency_key: "purchase-test-002" });
  const after = await s.saved(), projection = projectPortfolioBook(after.book);
  assert.equal(projection.holdings[0].shares, 3); assert.equal(projection.holdings[0].averageCost, 351.5 / 3);
  assert.equal(projection.eurCostBases[0].costBasis, 320); assert.equal(projection.reportingCash.amount, 680);
  assert.deepEqual(after.book.transactions[0], before.book.transactions[0]);
  assert.equal(after.book.transactions[1].executedAt, "2026-10-10T14:00:00.000Z");
});

test("already-recorded cash preserves cash while retaining the exact EUR basis; reports show no second movement", async t => {
  const s = await setup(t);
  await s.record({ cash_treatment: "already_recorded" });
  const { book } = await s.saved(), projection = projectPortfolioBook(book);
  assert.equal(book.transactions.length, 2, "No fabricated offsetting deposit is inserted");
  assert.equal(projection.reportingCash.amount, 1000); assert.equal(projection.eurCostBases[0].costBasis, 180);
  assert.equal(transactionReport(book, { now: NOW }).rows.find(row => row.type === "buy").cash.amount, 0);
  const performance = calculatePortfolioPerformance({ book, now: NOW });
  assert(performance.reasons.some(reason => reason.includes("already reflected in recorded cash")));
  const restored = parsePortfolioBackup(serializePortfolioBackup(book, { now: NOW }), { now: NOW });
  assert.equal(restored.book.transactions[1].cashAlreadyRecorded, true);
  assert.equal(restored.book.transactions[1].cashAmount, 180);
});

test("historical insertion replays later sales without rewriting existing entries or losing proportional EUR basis", async t => {
  const original = [
    { id: "earlier-buy", type: "buy", date: "2026-10-10", executedAt: "2026-10-10T14:00:00.000Z", ticker: "MSFT", quantity: 2, price: 100, fee: 1, currency: "USD", cashCurrency: "EUR", cashAmount: 180 },
    { id: "later-sale", type: "sell", date: "2026-10-11", ticker: "MSFT", quantity: 1, price: 120, fee: 1, currency: "USD", cashCurrency: "EUR", cashAmount: 108 },
  ];
  const s = await setup(t, original), before = await s.saved();
  await s.record({ quantity: 1, price_per_share: 50, fees: 0, total_native_cost: 50, eur_cost_basis: 45, executed_at: "2026-10-09T14:00:00Z" });
  const { book } = await s.saved(), p = projectPortfolioBook(book);
  assert.deepEqual(book.transactions.slice(0, 3), before.book.transactions);
  assert.equal(p.holdings[0].shares, 2); assert(Math.abs(p.holdings[0].averageCost - 251 / 3) < 1e-9);
  assert.equal(p.eurCostBases[0].costBasis, 150); assert.equal(p.reportingCash.amount, 883);
});

test("same-day timed purchases replay before later timed sales and respect timezone-derived Tallinn dates", async t => {
  const s = await setup(t, [
    { id: "buy", type: "buy", date: "2026-10-10", executedAt: "2026-10-10T14:00:00.000Z", ticker: "MSFT", quantity: 1, price: 100, fee: 0, currency: "USD", cashCurrency: "EUR", cashAmount: 90 },
    { id: "sale", type: "sell", date: "2026-10-10", executedAt: "2026-10-10T16:00:00.000Z", ticker: "MSFT", quantity: 1, price: 120, fee: 0, currency: "USD", cashCurrency: "EUR", cashAmount: 110 },
  ]);
  await s.record({ quantity: 1, price_per_share: 50, fees: 0, total_native_cost: 50, eur_cost_basis: 45, executed_at: "2026-10-10T18:00:00+03:00" });
  const p = projectPortfolioBook((await s.saved()).book);
  assert.equal(p.holdings[0].shares, 1); assert.equal(p.holdings[0].averageCost, 75); assert.equal(p.eurCostBases[0].costBasis, 67.5);
});

test("idempotency and separate-key duplicate detection prevent duplicate shares and cash deductions", async t => {
  const s = await setup(t);
  const [a, b] = await Promise.all([s.tool(purchase()), s.tool(purchase())]);
  assert.equal(a.value.operationId, b.value.operationId);
  const page = await s.review(a.value);
  const results = await Promise.all([s.confirm(a.value, page.csrf), s.confirm(a.value, page.csrf)]);
  assert(results.every(result => result.status === 303)); assert.equal((await s.saved()).book.transactions.length, 2);
  assert.equal((await s.tool(purchase())).value.status, "confirmed");
  assert.equal((await s.tool(purchase({ idempotency_key: "new-duplicate-key" }))).value.errors[0].code, "DUPLICATE_PURCHASE");
  assert.equal((await s.tool(purchase({ eur_cost_basis: 181 }))).value.errors[0].code, "IDEMPOTENCY_CONFLICT");
});

test("invalid costs, missing cash treatment, future/invalid times, unauthorized users and confirmation bypass fail closed", async t => {
  const s = await setup(t);
  for (const bad of [{ total_native_cost: 200 }, { eur_cost_basis: 0 }, { fees: -1 }, { quantity: 0 }, { currency: "EUR" },
    { executed_at: "2026-02-30T12:00:00Z" }, { executed_at: "2099-01-01T12:00:00Z" }, { executed_at: "2026-10-10T12:00:00" },
    { executed_at: "2025-12-31T12:00:00Z" }, { cash_treatment: "unknown" }]) {
    assert.equal((await s.tool(purchase(bad))).value.status, "unavailable");
  }
  const missing = purchase(); delete missing.cash_treatment;
  assert.equal((await s.tool(missing)).body.error.code, -32602);
  assert.equal((await s.tool({ ...purchase(), confirmed: true })).body.error.code, -32602);
  assert.equal((await s.tool(purchase(), {})).response.status, 401);
  assert.equal((await s.tool(purchase(), { ...identity, "oai-authenticated-user-email": "other@example.com" })).response.status, 403);
  assert.equal((await s.saved()).revision, 3);
});

test("fractional shares retain rounded broker total in native weighted cost", async t => {
  const s = await setup(t);
  await s.record({ quantity: 0.333333, price_per_share: 10, fees: 0.01, total_native_cost: 3.34, eur_cost_basis: 3.34, currency: "EUR" });
  const p = projectPortfolioBook((await s.saved()).book);
  assert.equal(p.holdings[0].averageCost, 3.34 / 0.333333);
  assert.equal(p.eurCostBases[0].costBasis, 3.34);
});

test("a portfolio edit invalidates a purchase proposal and an audit failure rolls back purchase holdings and cash", async t => {
  const s = await setup(t);
  const stale = (await s.tool(purchase())).value, review = await s.review(stale);
  await s.DB.prepare("UPDATE portfolio_books SET revision = revision + 1 WHERE user_id = ?").bind("workspace").run();
  assert.equal((await s.confirm(stale, review.csrf)).status, 409);
  const fresh = (await s.tool(purchase({ idempotency_key: "purchase-fresh-002" }))).value, page = await s.review(fresh);
  await s.DB.prepare("INSERT INTO cash_audit (id, user_id, operation_id, event, actor, occurred_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(`${fresh.operationId}:confirmed`, "workspace", fresh.operationId, "synthetic-audit-collision", "test", new Date(NOW).toISOString()).run();
  assert.equal((await s.confirm(fresh, page.csrf)).status, 503);
  const saved = await s.saved();
  assert.equal(saved.revision, 4); assert.equal(saved.book.transactions.length, 1);
  assert.equal(projectPortfolioBook(saved.book).holdings.length, 0); assert.equal(projectPortfolioBook(saved.book).reportingCash.amount, 1000);
});
