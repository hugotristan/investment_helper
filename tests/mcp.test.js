import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../server/worker.mjs";
import { createMcpData } from "../server/mcp-data.mjs";
import { createMcpHandler } from "../server/mcp.mjs";
import { createLocalDatabase } from "../server/local-database.mjs";
import { createPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { FUNDAMENTAL_METRICS } from "../js/analysis/fundamentals.js";
import { generatePasswordSecrets } from "../server/auth.mjs";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const SAVED = "2026-11-10T10:00:00.000Z";
const ORIGIN = "https://investment.example.chatgpt.site";
const OWNER = "synthetic-owner@example.com";
const identity = { "oai-authenticated-user-id": "site-scoped-owner", "oai-authenticated-user-email": OWNER };
const names = ["get_portfolio_holdings", "get_watchlists", "get_stock_prices", "get_financial_metrics", "get_data_loading_status"];
const noNetwork = async () => { throw new Error("Private network detail must not leak"); };

function rpc(method, params, { headers = identity, id = 1, raw, path = "/mcp" } = {}) {
  return new Request(ORIGIN + path, { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) });
}
const call = (name, args = {}, options) => rpc("tools/call", { name, arguments: args }, options);
const history = ticker => ({ ticker, currency: ticker === "VWCE.DE" ? "EUR" : "USD", instrumentType: "EQUITY",
  source: "Yahoo Finance chart", prices: [{ date: "2026-11-10T14:30:00Z", close: 100 }, { date: "2026-11-11T14:30:00Z", close: 105 }],
  splits: [], splitsComplete: true, quote: { ticker, currency: ticker === "VWCE.DE" ? "EUR" : "USD", price: 110,
    quoteTime: "2026-11-11T21:00:00Z", source: "Yahoo Finance published quote" } });
function financialSnapshot(retrievedAt = "2026-11-09T10:00:00Z", generatedAt = "2026-11-11T10:00:00Z") {
  return { schemaVersion: 1, generatedAt, providerStatus: "partial", failures: [{ ticker: "MSFT", reason: "Provider request failed" }],
    byTicker: { MSFT: { ticker: "MSFT", available: true, currency: "USD", companyName: "Microsoft", provider: "Yahoo Finance",
      retrievedAt, periodEnd: "2026-06-30", metrics: Object.fromEntries(FUNDAMENTAL_METRICS.map(key => [key, 10])),
      metricSources: { revenue: [{ unit: "USD", end: "2026-06-30", url: "https://finance.yahoo.com/quote/MSFT/financials/" }] } } } };
}

async function setup(t) {
  const DB = createLocalDatabase();
  t.after(() => DB.close());
  const book = createPortfolioBook({ now: NOW, startDate: "2026-01-01" });
  book.transactions = [
    { id: "deposit", type: "deposit", date: "2026-01-01", currency: "EUR", amount: 1000, note: "Private bank note", cashCurrency: "EUR", cashAmount: 1000 },
    { id: "buy", type: "buy", date: "2026-01-02", currency: "USD", ticker: "MSFT", quantity: 2, price: 100, fee: 1, note: "Private trade note", cashCurrency: "EUR", cashAmount: 180 },
  ];
  book.organization = { groups: [], positions: [{ ticker: "MSFT", currency: "USD", groupId: null, note: "Private position note" }] };
  await DB.prepare("INSERT INTO password_workspace (workspace_key, user_id) VALUES (?, ?)").bind("personal", "saved-workspace").run();
  await DB.prepare("INSERT INTO portfolio_books (user_id, book, revision, updated_at) VALUES (?, ?, ?, ?)").bind("saved-workspace", JSON.stringify(book), 7, SAVED).run();
  await DB.prepare("INSERT INTO watchlists (user_id, tickers, revision, updated_at) VALUES (?, ?, ?, ?)").bind("saved-workspace", '["MSFT","VWCE.DE"]', 4, SAVED).run();
  // Tools must remain read-only even if accidentally wired to a write helper.
  const statements = [];
  const readOnlyDB = { prepare(sql) { assert.match(sql, /^SELECT\b/); statements.push(sql); return DB.prepare(sql); } };
  const env = { DB: readOnlyDB, INVESTMENT_MCP_OWNER_EMAIL: OWNER, INVESTMENT_AUTH_MODE: "password" };
  const market = { loadHistory: async ticker => ticker === "MISSING" ? Promise.reject(new Error("Private error")) : history(ticker) };
  const data = createMcpData({ market, assets: { "data/fundamentals.json": JSON.stringify(financialSnapshot()) }, now: NOW, fetchImpl: noNetwork });
  return { DB, env, statements, data, handler: createMcpHandler({ data, now: NOW }) };
}
async function toolResult(handler, env, name, args = {}, options) {
  const response = await handler(call(name, args, options), env);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await response.json();
  return { response, body, result: body.result, value: body.result?.structuredContent };
}

test("MCP discovers exactly five read-only tools and supports stateless protocol negotiation", async t => {
  const { handler, env, statements } = await setup(t);
  const discovery = await (await handler(rpc("server/discover", {}, { headers: {} }), env)).json();
  assert(discovery.result.supportedVersions.includes("2026-07-28"));
  assert.deepEqual(discovery.result.capabilities, { tools: {} });
  const listed = await (await handler(rpc("tools/list", {}, { headers: {} }), env)).json();
  assert.deepEqual(listed.result.tools.map(tool => tool.name), names);
  for (const tool of listed.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const initialized = await (await handler(rpc("initialize", { protocolVersion: "2025-06-18" }), env)).json();
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  assert.equal((await handler(rpc("notifications/initialized", {}, { raw: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), env)).status, 202);
  assert.equal(statements.length, 0, "Discovery never loads private records");
});

test("every data tool requires a verified owner identity, not a cookie, account argument or another visitor", async t => {
  const { handler, env, statements } = await setup(t);
  for (const name of names) for (const headers of [{}, { Cookie: "__Host-investment_session=untrusted" },
    { ...identity, "oai-authenticated-user-email": "someone-else@example.com" }, { "oai-authenticated-user-email": OWNER }]) {
    const { response, body } = await toolResult(handler, env, name, name === "get_stock_prices" || name === "get_financial_metrics" ? { tickers: ["MSFT"] } : {}, { headers });
    assert([401, 403].includes(response.status));
    assert.equal(body.result, undefined);
  }
  assert.equal(statements.length, 0);
  const missing = await toolResult(handler, { ...env, INVESTMENT_MCP_OWNER_EMAIL: undefined }, "get_watchlists");
  assert.equal(missing.value.errors[0].code, "MCP_NOT_CONFIGURED");
  assert.equal(missing.result.isError, true);
  assert.equal(statements.length, 0);
});

test("record tools read the existing workspace without mutations, raw transactions or private notes", async t => {
  const { handler, env, DB } = await setup(t);
  const before = await DB.prepare("SELECT * FROM portfolio_books").all();
  const p = await toolResult(handler, env, "get_portfolio_holdings");
  assert.equal(p.value.latestSuccessfulUpdateAt, SAVED);
  assert.equal(p.value.checkedAt, new Date(NOW).toISOString());
  assert.equal(p.value.revision, 7);
  assert.equal(p.value.holdings[0].shares, 2);
  assert.equal(p.value.holdings[0].nativeCostBasis, 201);
  assert.equal(p.value.holdings[0].eurCostBasis, 180);
  assert.equal(p.value.recordedCash.amount, 820);
  assert.equal(p.value.readOnly, true);
  assert(!JSON.stringify(p.value).includes("Private"));
  assert(!JSON.stringify(p.value).includes("transactions"));
  const w = await toolResult(handler, env, "get_watchlists");
  assert.equal(w.value.revision, 4);
  assert.deepEqual(w.value.watchlists[0].tickers, ["MSFT", "VWCE.DE"]);
  assert.equal(w.value.latestSuccessfulUpdateAt, SAVED);
  assert.deepEqual(await DB.prepare("SELECT * FROM portfolio_books").all(), before);
});

test("price tools preserve quote and completed-close dates, partial failures and exact exchange currency", async t => {
  const { handler, env } = await setup(t);
  const { value, result } = await toolResult(handler, env, "get_stock_prices", { tickers: ["MSFT", "VWCE.DE", "MISSING"] });
  assert.equal(result.isError, false);
  assert.equal(value.status, "partial");
  assert.equal(value.latestSuccessfulUpdateAt, "2026-11-11T21:00:00.000Z");
  assert.equal(value.prices[0].price, 110);
  assert.equal(value.prices[0].source, "Yahoo Finance published quote");
  assert.equal(value.prices[0].realtime, false);
  assert.equal(value.prices[1].currency, "EUR");
  assert.equal(value.prices[2].price, null);
  assert.equal(value.prices[2].latestSuccessfulUpdateAt, null);
  assert(!JSON.stringify(value).includes("Private error"));
  const data = createMcpData({ market: { loadHistory: async ticker => ({ ...history(ticker), quote: null }) }, assets: {}, now: NOW });
  const close = await data.prices(["MSFT"]);
  assert.equal(close.prices[0].priceType, "completed_daily_close");
  assert.equal(close.prices[0].latestSuccessfulUpdateAt, "2026-11-11T14:30:00.000Z");
  const unavailable = await toolResult(handler, env, "get_stock_prices", { tickers: ["MISSING"] });
  assert.equal(unavailable.result.isError, true);
});

test("financial metrics retain successful retrieval dates after failed refreshes and label stale/missing figures", async t => {
  const { handler, env } = await setup(t);
  const { value } = await toolResult(handler, env, "get_financial_metrics", { tickers: ["MSFT", "VWCE.DE"] });
  assert.equal(value.status, "partial");
  assert.equal(value.companies[0].latestSuccessfulUpdateAt, "2026-11-09T10:00:00.000Z");
  assert.equal(value.companies[0].lastUpdateAttemptAt, "2026-11-11T10:00:00.000Z");
  assert.equal(value.companies[0].retained, true);
  assert.equal(value.companies[0].metrics.revenue, 10);
  assert(value.companies[0].warnings.some(error => error.code === "FUNDAMENTALS_REFRESH_FAILED"));
  assert.equal(value.companies[1].metrics, null);
  const snapshot = financialSnapshot("2026-10-01T00:00:00Z");
  snapshot.byTicker.MSFT.metrics.netIncome = null;
  const data = createMcpData({ market: {}, assets: { "data/fundamentals.json": JSON.stringify(snapshot) }, now: NOW, fetchImpl: noNetwork });
  const stale = await data.metrics(["MSFT"]);
  assert.equal(stale.companies[0].status, "stale");
  assert.equal(stale.companies[0].metrics.netIncome, null);
  assert.equal(stale.latestSuccessfulUpdateAt, "2026-10-01T00:00:00.000Z");
  assert(stale.errors.some(error => error.code === "METRICS_STALE"));
});

test("status checks report actual source timestamps and explicitly bound ticker coverage", async t => {
  const { handler, env, DB } = await setup(t);
  await DB.prepare("UPDATE watchlists SET tickers = ?").bind(JSON.stringify(Array.from({ length: 25 }, (_, i) => `S${i}`))).run();
  const { value } = await toolResult(handler, env, "get_data_loading_status");
  assert.equal(value.portfolio.latestSuccessfulUpdateAt, SAVED);
  assert.equal(value.watchlist.latestSuccessfulUpdateAt, SAVED);
  assert.equal(value.inspectedTickers.length, 20);
  assert.equal(value.uninspectedTickerCount, 6);
  assert.match(value.scope, /Browser scan progress is not available/);
  assert(value.latestSuccessfulUpdateAt < value.checkedAt);
  const explicit = await toolResult(handler, env, "get_data_loading_status", { tickers: ["MISSING"] });
  assert.equal(explicit.value.prices.status, "unavailable");
  assert(explicit.value.prices.errors.length);
});

test("published financial refresh keeps a newer retained success and never relabels it as a new success", async () => {
  const embedded = financialSnapshot("2026-11-10T10:00:00Z", "2026-11-10T11:00:00Z");
  const published = financialSnapshot("2026-11-09T10:00:00Z", "2026-11-12T11:00:00Z");
  let requests = 0;
  const data = createMcpData({ market: {}, assets: { "data/fundamentals.json": JSON.stringify(embedded) }, now: NOW,
    fetchImpl: async (url, init) => {
      requests++;
      assert.equal(url, "https://hugotristan.github.io/investment_helper/data/fundamentals.json");
      assert.equal(Object.hasOwn(init, "credentials"), false);
      assert.equal(init.redirect, "manual");
      return Response.json(published);
    } });
  const result = await data.metrics(["MSFT"]);
  assert.equal(result.companies[0].latestSuccessfulUpdateAt, "2026-11-10T10:00:00.000Z");
  assert.equal(result.companies[0].lastUpdateAttemptAt, "2026-11-12T11:00:00.000Z");
  await data.metrics(["MSFT"]);
  assert.equal(requests, 1);
  // Equal successful records use the more recent attempt's diagnostics.
  published.byTicker.MSFT.retrievedAt = embedded.byTicker.MSFT.retrievedAt;
  const equalData = createMcpData({ market: {}, assets: { "data/fundamentals.json": JSON.stringify(embedded) }, now: NOW,
    fetchImpl: async () => Response.json(published) });
  const equal = await equalData.metrics(["MSFT"]);
  assert.equal(equal.companies[0].latestSuccessfulUpdateAt, "2026-11-10T10:00:00.000Z");
  assert.equal(equal.companies[0].lastUpdateAttemptAt, "2026-11-12T11:00:00.000Z");
});

test("malformed requests, unsupported operations and unbounded arguments never reach storage or providers", async t => {
  const { handler, env, statements } = await setup(t);
  for (const args of [{ tickers: [] }, { tickers: ["MSFT", "MSFT"] }, { tickers: ["msft"] }, { tickers: ["https://example.com"] },
    { tickers: Array.from({ length: 21 }, (_, i) => `S${i}`) }, { tickers: ["MSFT"], userId: "someone-else" }, { tickers: ["MSFT"], url: "https://example.com" }]) {
    assert.equal((await toolResult(handler, env, "get_stock_prices", args)).body.error.code, -32602);
  }
  for (const name of ["buy_stock", "sell_stock", "save_portfolio", "put_watchlist", "__proto__"]) {
    assert.equal((await toolResult(handler, env, name)).body.error.code, -32602);
  }
  assert.equal((await (await handler(rpc("portfolio/put", {}), env)).json()).error.code, -32601);
  assert.equal((await (await handler(rpc("tools/list", {}, { raw: "{" }), env)).json()).error.code, -32700);
  assert.equal((await handler(rpc("tools/list", {}, { raw: " ".repeat(32769) }), env)).status, 413);
  assert.equal((await handler(call("get_watchlists", {}, { headers: { ...identity, Origin: "https://evil.example" } }), env)).status, 403);
  assert.equal(statements.length, 0);
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await handler(new Request(ORIGIN + "/mcp", { method }), env)).status, 405);
});

test("missing records or workspace fail clearly without automatically creating records", async t => {
  const { handler, env, DB } = await setup(t);
  await DB.prepare("DELETE FROM portfolio_books").run();
  await DB.prepare("DELETE FROM watchlists").run();
  assert.equal((await toolResult(handler, env, "get_portfolio_holdings")).value.errors[0].code, "NO_PORTFOLIO");
  assert.equal((await toolResult(handler, env, "get_watchlists")).value.errors[0].code, "NO_WATCHLIST");
  assert.equal((await toolResult(handler, env, "get_data_loading_status")).result.isError, true);
  await DB.prepare("DELETE FROM password_workspace").run();
  assert.equal((await toolResult(handler, env, "get_watchlists")).value.errors[0].code, "WORKSPACE_UNAVAILABLE");
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM password_workspace").first()).n, 0);
});

test("MCP routing leaves website password protection and data-editing APIs unchanged", async t => {
  const { env } = await setup(t);
  const secrets = await generatePasswordSecrets("disposable-test-password");
  const app = createApp({ "index.html": "Private website" }, { authMode: "password", now: NOW, fetchImpl: noNetwork });
  const configured = { ...env, ...secrets };
  const listing = await app.fetch(rpc("tools/list", {}, { headers: {} }), configured);
  assert.equal(listing.status, 200);
  for (const path of ["/", "/index.html", "/mcp/", "/mcp-data.mjs"]) {
    const response = await app.fetch(new Request(ORIGIN + path, { headers: identity }), configured);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/login");
  }
  const api = await app.fetch(new Request(ORIGIN + "/api/portfolio", { headers: identity }), configured);
  assert.equal(api.status, 401);
  assert.equal((await api.json()).code, "SIGN_IN_REQUIRED");
  assert.equal((await app.fetch(call("get_watchlists"), configured)).status, 200);
});
