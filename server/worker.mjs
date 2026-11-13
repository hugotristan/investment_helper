import {coveragePlan,acceptCoverageResults} from "./coverage-updater.mjs";
import {createRefreshAuthorization} from "./refresh-auth.mjs";
import { createPersistentMarketCache, createCompanyProvider, persistentMarket, createPriceProviderFetch } from "./market-coverage.mjs";
import { ApiError, checkSameOrigin, readJsonRequest } from "./request-body.mjs";
import { readCloudRecord, saveCloudRecord, sitesUserId, storageAvailable, validateSaveEnvelope } from "./cloud-store.mjs";
import { createMarketAssetReader, createMarketData, marketTicker } from "./market-data.mjs";
import { createPasswordAuth } from "./auth.mjs";
import { createMcpData } from "./mcp-data.mjs";
import { createMcpHandler } from "./mcp.mjs";
import { loadAnalystContext } from "./analyst-context.mjs";
import { createFundData } from "./fund-data.mjs";
import { saveChange } from "./development-changes.mjs";
import { normalizeErrors } from "./data-errors.mjs";
import { cashConfirmation } from "./cash-confirmation.mjs";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Vary": "Cookie, oai-authenticated-user-id",
};
const contentTypes = { html: "text/html", css: "text/css", js: "text/javascript", json: "application/json",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", ico: "image/x-icon", woff2: "font/woff2" };

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, { status, headers: { ...privateHeaders, ...extraHeaders } });
}

function methodAllowed(request, methods) {
  if (!methods.includes(request.method)) return json({ error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: methods.join(", ") });
  return null;
}

function publicAsset(path) {
  return ["index.html", "app.js", "styles.css", "favicon.svg", "favicon.ico", "robots.txt"].includes(path)
    || /^(?:js|data|assets)\/[A-Za-z0-9_.\/-]+\.(?:js|json|css|svg|png|jpg|jpeg|webp|ico|woff2)$/.test(path)
      && !path.split("/").some((segment) => segment === "." || segment === "..");
}

export function createApp(assets, options = {}) {
  const fundData = createFundData(options);
  const clock = () => typeof options.now === "function" ? options.now() : options.now ?? Date.now();
  const passwordGate = createPasswordAuth({ now: clock });
  const authorizeRefresh = createRefreshAuthorization({...options,now:clock});
  const services = new WeakMap();
  function service(env) {
    const key = env.DB || assets;
    if (!services.has(key)) {
      const cache = createPersistentMarketCache(env.DB, {now:clock});
      const fetchImpl = createPriceProviderFetch(env.DB, {...options,now:clock});
      const baseMarket = createMarketData({...options,fetchImpl,readMarketAsset:createMarketAssetReader(assets)});
      const market = persistentMarket(baseMarket, cache, clock);
      const companyProvider = createCompanyProvider({cache, readAsset:createMarketAssetReader(assets), ...options, now:clock, DB:env.DB, resolveHistory:market.loadHistory});
      const diagnostics = createMcpData({...options,assets,market,now:clock,companyProvider});
      services.set(key,{market,diagnostics,companyProvider,mcp:createMcpHandler({data:diagnostics,now:clock})});
    }
    return services.get(key);
  }
  async function refreshCoverage(env, userId, diagnostics, reset = false) {
    if (!env.DB) return;
    const [portfolio, watchlist] = await Promise.all([diagnostics.portfolio(env,userId),diagnostics.watchlists(env,userId)]);
    const revision = String(portfolio.revision) + ":" + String(watchlist.revision);
    const held = [...new Set(portfolio.holdings.map(row => row.ticker).filter(Boolean))];
    const tracked = [...new Set([...held,...watchlist.watchlists.flatMap(list => list.tickers)])];
    const row = await env.DB.prepare("SELECT * FROM coverage_scans WHERE user_id = ?").bind(userId).first();
    const cursor = reset || row?.revision !== revision ? 0 : row?.cursor || 0;
    const claim = await env.DB.prepare(`INSERT INTO coverage_scans (user_id,cursor,revision,next_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET next_at = excluded.next_at WHERE coverage_scans.next_at <= ? OR coverage_scans.revision != excluded.revision`)
      .bind(userId,cursor,revision,clock()+30000,clock()).run();
    if (!claim.meta.changes) return {status:"busy", retryAfterMs:Math.max(1000,(row?.next_at || clock()+30000)-clock())};
    const cached = await env.DB.prepare("SELECT key FROM market_cache WHERE key LIKE ?").bind("history:%").all();
    const present = new Set(cached.results.map(row => row.key));
    const newHoldings = held.filter(ticker => !present.has("history:"+ticker));
    const tickers = newHoldings.length ? newHoldings.slice(0,2) : tracked.slice(cursor,cursor+2);
    const batch = await diagnostics.status(env,userId,tickers,{batchSize:2,concurrency:2});
    const next = newHoldings.length ? cursor : cursor+tickers.length < tracked.length ? cursor+tickers.length : 0;
    await env.DB.prepare("UPDATE coverage_scans SET cursor = ?, revision = ?, next_at = ? WHERE user_id = ?")
      .bind(next,revision,clock()+(next === 0 && !newHoldings.length ? 300000 : 30000),userId).run();
    return {status:batch.status,checkedCount:tickers.length,complete:next === 0 && !newHoldings.length,remainingCount:Math.max(0,tracked.length-next),retryAfterMs:0};
  }
  return {
    async fetch(request, env = {}, context = {}) {
      const {market,diagnostics,mcp,companyProvider} = service(env);
      const url = new URL(request.url);
      const backgroundEligible = ["/api/session","/api/portfolio","/api/watchlist"].includes(url.pathname) || url.pathname === "/api/loading-status" && url.searchParams.get("component") === "records";
      let userId = null;
      const userJson = (value, status = 200) => json({ ...value, userId }, status, { "X-Portfolio-User-Id": userId });
      try {
        // The production bundle pins password mode so missing/changed runtime
        // flags cannot expose static assets through the legacy native path.
        const authMode = options.authMode ?? env.INVESTMENT_AUTH_MODE ?? "chatgpt";
        if (!["password", "chatgpt"].includes(authMode)) throw new ApiError(503, "AUTH_UNAVAILABLE", "Private access needs configuration.");
        // MCP has its own Sites identity + owner authorization. No other route
        // can use it to bypass the website's unchanged password/session gate.
        if (["/api/market/refresh", "/api/market/refresh-results"].includes(url.pathname)) {
          const denied = methodAllowed(request,["POST"]); if (denied) return denied;
          if (url.search) throw new ApiError(400,"INVALID_OPTIONS","Market upkeep accepts no ticker list or payload.");
          await authorizeRefresh(request);
          const owner = await env.DB?.prepare("SELECT user_id FROM password_workspace WHERE workspace_key = ?").bind("personal").first();
          if (!owner?.user_id) throw new ApiError(503,"WORKSPACE_UNAVAILABLE","The existing personal workspace is unavailable.");
          return json(url.pathname.endsWith("-results")
            ? await acceptCoverageResults(env,owner.user_id,await readJsonRequest(request,2*1024*1024),diagnostics,companyProvider,{now:clock()})
            : await coveragePlan(env,owner.user_id,diagnostics,companyProvider,{now:clock()}));
        }
        if (url.pathname === "/mcp") return await mcp(request, env);
        if (url.pathname === "/api/health") {
          const denied = methodAllowed(request, ["GET"]);
          return denied || json({ ok: true, cloud: true, storageAvailable: storageAvailable(env) });
        }
        // The public brand icon contains no app or portfolio data.
        if (authMode === "password" && url.pathname !== "/favicon.svg") {
          const access = await passwordGate(request, env);
          if (access.response) return access.response;
          userId = access.userId;
        }
        if (backgroundEligible && userId && context.waitUntil) context.waitUntil(refreshCoverage(env,userId,diagnostics).catch(() => {}));
        const confirmation = /^\/cash-operations\/([a-f0-9]{32})$/.exec(url.pathname);
        if (confirmation) {
          if (authMode !== "password" || !userId) throw new ApiError(403, "PASSWORD_CONFIRMATION_REQUIRED", "Open this confirmation page with the app's password login.");
          return await cashConfirmation(request, env, userId, confirmation[1], clock());
        }
        if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
          const recognized = ["/api/session", "/api/portfolio", "/api/watchlist", "/api/market/history", "/api/exchange-rate", "/api/portfolio-fx", "/api/fund-holdings",
            "/api/analyst", "/api/analyst/status", "/api/analyst/context", "/api/development-changes", "/api/loading-status", "/api/market/fundamentals"].includes(url.pathname);
          if (!recognized) return json({ error: "API route not found.", code: "NOT_FOUND" }, 404);
          const methods = ["/api/analyst", "/api/development-changes"].includes(url.pathname) ? ["POST"] : ["/api/portfolio", "/api/watchlist"].includes(url.pathname) ? ["GET", "PUT"] : ["GET"];
          const denied = methodAllowed(request, methods);
          if (denied) return denied;
          userId ||= sitesUserId(request);
          if (backgroundEligible && authMode === "chatgpt" && context.waitUntil) context.waitUntil(refreshCoverage(env,userId,diagnostics).catch(() => {}));
          const expectedUserId = request.headers.get("x-expected-user-id");
          if (expectedUserId !== null && expectedUserId !== userId || ["PUT", "POST"].includes(request.method) && expectedUserId === null) {
            throw new ApiError(409, "ACCOUNT_CHANGED", "Your signed-in account changed. Reload the app before opening or saving data.");
          }
          if (url.pathname === "/api/session") return userJson({ cloud: true, authMode, storageAvailable: storageAvailable(env) });
          if (url.pathname === "/api/loading-status") {
            const args = {};
            for (const [key, value] of url.searchParams) {
              if (!["offset", "batchSize", "concurrency", "component"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new ApiError(400, "INVALID_OPTIONS", "Use supported diagnostic pagination options.");
              args[key] = key === "component" ? value : /^\d+$/.test(value) ? Number(value) : NaN;
            }
            if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset > 10000)
              || args.batchSize !== undefined && (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > 20)
              || args.concurrency !== undefined && (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 3)
              || args.component !== undefined && !["all", "records", "prices", "financialMetrics"].includes(args.component)) throw new ApiError(400, "INVALID_OPTIONS", "Choose batchSize 1–20 and concurrency 1–3 with a valid offset/component.");
            return userJson(normalizeErrors(await diagnostics.status(env, userId, undefined, args)));
          }
          if (url.pathname === "/api/development-changes") {
            checkSameOrigin(request);
            return userJson(await saveChange(env, userId, await readJsonRequest(request, 65536), clock()));
          }
          if (url.pathname === "/api/analyst/status") return userJson({ ready: true, mode: "calculated", message: "Portfolio insights use recorded figures. No AI API is used." });
          if (url.pathname === "/api/analyst/context") {
            if ([...url.searchParams.keys()].some((key) => key !== "includeNotes") || url.searchParams.getAll("includeNotes").length > 1
              || url.searchParams.has("includeNotes") && !["true", "false"].includes(url.searchParams.get("includeNotes"))) {
              throw new ApiError(400, "INVALID_OPTIONS", "Choose whether to include position notes.");
            }
            return userJson(await loadAnalystContext({ env, userId, market, fundData, includeNotes: url.searchParams.get("includeNotes") === "true", now: clock }));
          }
          if (url.pathname === "/api/analyst") {
            return userJson({ code: "ANALYST_RETIRED", error: "Paid AI requests have been removed. Open Portfolio insights and copy a summary for ChatGPT." }, 410);
          }
          if (url.pathname === "/api/market/fundamentals") return userJson(await diagnostics.financialSnapshot(marketTicker(url.searchParams.get("ticker")),env));
          if (url.pathname === "/api/market/history") {
            if (url.searchParams.getAll("ticker").length !== 1 || [...url.searchParams.keys()].some((key) => key !== "ticker")) {
              throw new ApiError(400, "INVALID_TICKER", "Request one ticker without additional options.");
            }
            return userJson(await market.loadHistory(marketTicker(url.searchParams.get("ticker")), {background:context.waitUntil?.bind(context)}));
          }
          if (url.pathname === "/api/exchange-rate") return userJson(await market.loadExchangeRate());
          if (url.pathname === "/api/portfolio-fx") return userJson(await market.loadHistoricalFx());
          if (url.pathname === "/api/fund-holdings") {
            if (url.search) throw new ApiError(400, "INVALID_OPTIONS", "Fund holdings do not accept additional options.");
            return userJson({ schemaVersion: 1, funds: await fundData.loadFunds() });
          }
          const kind = url.pathname === "/api/portfolio" ? "portfolio" : "watchlist";
          if (request.method === "GET") return userJson(await readCloudRecord(env, userId, kind, clock()));
          checkSameOrigin(request);
          const input = validateSaveEnvelope(await readJsonRequest(request), kind, clock());
          const saved = await saveCloudRecord(env, userId, kind, input.value, input.expectedRevision, clock());
          if (context.waitUntil) context.waitUntil(refreshCoverage(env,userId,diagnostics,true).catch(() => {}));
          return userJson(saved);
        }
        const denied = methodAllowed(request, ["GET", "HEAD"]);
        if (denied) return denied;
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (!publicAsset(file) || !Object.hasOwn(assets, file)) return new Response("Not found", { status: 404, headers: privateHeaders });
        const extension = file.split(".").at(-1);
        const type = contentTypes[extension] || "text/plain";
        const asset = assets[file];
        if (asset && typeof asset === "object" && asset.encoding === "gzip-base64") {
          const bytes = request.method === "HEAD" ? null : Uint8Array.from(atob(asset.data), (character) => character.charCodeAt(0));
          // These bytes are already compressed. Workers otherwise gzip them again.
          return new Response(bytes, { encodeBody: "manual", headers: { ...privateHeaders, "Content-Type": asset.contentType || type,
            "Content-Encoding": "gzip" } });
        }
        return new Response(request.method === "HEAD" ? null : asset, {
          headers: { ...privateHeaders, "Content-Type": type + (["html", "css", "js", "json", "svg"].includes(extension) ? "; charset=utf-8" : "") },
        });
      } catch (error) {
        const send = userId ? userJson : json;
        return error instanceof ApiError ? send({ error: error.message, code: error.code,
          ...(error.providerFailures ? { providerFailures: error.providerFailures } : {}) }, error.status)
          : send({ error: "The request could not be completed.", code: "SERVER_ERROR" }, 500);
      }
    },
  };
}
