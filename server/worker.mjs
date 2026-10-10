import { ApiError, checkSameOrigin, readJsonRequest } from "./request-body.mjs";
import { readCloudRecord, saveCloudRecord, sitesUserId, storageAvailable, validateSaveEnvelope } from "./cloud-store.mjs";
import { createMarketData, marketTicker } from "./market-data.mjs";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Vary": "oai-authenticated-user-id",
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
  const market = createMarketData(options);
  const clock = () => typeof options.now === "function" ? options.now() : options.now ?? Date.now();
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      let userId = null;
      const userJson = (value, status = 200) => json({ ...value, userId }, status, { "X-Portfolio-User-Id": userId });
      try {
        if (url.pathname === "/api/health") {
          const denied = methodAllowed(request, ["GET"]);
          return denied || json({ ok: true, cloud: true, storageAvailable: storageAvailable(env) });
        }
        if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
          const recognized = ["/api/session", "/api/portfolio", "/api/watchlist", "/api/market/history", "/api/exchange-rate", "/api/portfolio-fx"].includes(url.pathname);
          if (!recognized) return json({ error: "API route not found.", code: "NOT_FOUND" }, 404);
          const methods = ["/api/portfolio", "/api/watchlist"].includes(url.pathname) ? ["GET", "PUT"] : ["GET"];
          const denied = methodAllowed(request, methods);
          if (denied) return denied;
          userId = sitesUserId(request);
          const expectedUserId = request.headers.get("x-expected-user-id");
          if (expectedUserId !== null && expectedUserId !== userId || request.method === "PUT" && expectedUserId === null) {
            throw new ApiError(409, "ACCOUNT_CHANGED", "Your signed-in account changed. Reload the app before opening or saving data.");
          }
          if (url.pathname === "/api/session") return userJson({ cloud: true, storageAvailable: storageAvailable(env) });
          if (url.pathname === "/api/market/history") {
            if (url.searchParams.getAll("ticker").length !== 1 || [...url.searchParams.keys()].some((key) => key !== "ticker")) {
              throw new ApiError(400, "INVALID_TICKER", "Request one ticker without additional options.");
            }
            return userJson(await market.loadHistory(marketTicker(url.searchParams.get("ticker"))));
          }
          if (url.pathname === "/api/exchange-rate") return userJson(await market.loadExchangeRate());
          if (url.pathname === "/api/portfolio-fx") return userJson(await market.loadHistoricalFx());
          const kind = url.pathname === "/api/portfolio" ? "portfolio" : "watchlist";
          if (request.method === "GET") return userJson(await readCloudRecord(env, userId, kind, clock()));
          checkSameOrigin(request);
          const input = validateSaveEnvelope(await readJsonRequest(request), kind, clock());
          return userJson(await saveCloudRecord(env, userId, kind, input.value, input.expectedRevision, clock()));
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
        return error instanceof ApiError ? send({ error: error.message, code: error.code }, error.status)
          : send({ error: "The request could not be completed.", code: "SERVER_ERROR" }, 500);
      }
    },
  };
}
