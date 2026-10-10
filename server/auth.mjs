import { ApiError, checkSameOrigin, readBoundedText } from "./request-body.mjs";

const encoder = new TextEncoder();
const lifetimeSeconds = 30 * 24 * 60 * 60;
const attemptWindowMs = 10 * 60 * 1000;
const maximumAttempts = 5;
const maximumGlobalAttempts = 200;
const workspaceKey = "personal";
const emptyWorkspaceId = "personal-password-workspace";
const hex = (bytes) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
const bytes = (value) => Uint8Array.from(value.match(/../g), (pair) => parseInt(pair, 16));
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" };

export async function generatePasswordSecrets(password) {
  if (typeof password !== "string" || !password.length || password.length > 256) throw new Error("Choose a password between 1 and 256 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return { INVESTMENT_PASSWORD_HASH: `v1:100000:${hex(salt)}:${hex(derived)}`,
    INVESTMENT_SESSION_SECRET: hex(crypto.getRandomValues(new Uint8Array(32))) };
}

function passwordConfig(env) {
  const match = /^v1:100000:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(env.INVESTMENT_PASSWORD_HASH || "");
  if (!match || !/^[a-f0-9]{64}$/.test(env.INVESTMENT_SESSION_SECRET || "")) {
    throw new ApiError(503, "AUTH_UNAVAILABLE", "Password access is being configured. Please try again shortly.");
  }
  return { salt: bytes(match[1]), hash: bytes(match[2]) };
}

function database(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") throw new ApiError(503, "AUTH_UNAVAILABLE", "Private storage is temporarily unavailable. Please try again shortly.");
  return env.DB;
}

// This mapping keeps the original owner record and its revisions in place.
// Only a verified password/session may reach it; a request never supplies its ID.
export async function resolvePasswordWorkspace(env) {
  const db = database(env);
  const override = env.INVESTMENT_WORKSPACE_ID;
  if (override !== undefined && !validId(override)) throw new ApiError(503, "AUTH_UNAVAILABLE", "The private workspace needs configuration.");
  try {
    let mapping = await db.prepare("SELECT user_id FROM password_workspace WHERE workspace_key = ?").bind(workspaceKey).first();
    if (mapping) {
      if (!validId(mapping.user_id) || override !== undefined && override !== mapping.user_id) {
        throw new ApiError(503, "WORKSPACE_UNAVAILABLE", "The saved workspace needs configuration. Existing data was kept.");
      }
      return mapping.user_id;
    }
    const existing = (await db.prepare("SELECT user_id FROM portfolio_books UNION SELECT user_id FROM watchlists LIMIT 2").all()).results;
    if (!Array.isArray(existing) || existing.some((row) => !validId(row.user_id))) throw new Error("Invalid workspace records.");
    let candidate;
    if (override !== undefined) {
      const selected = await db.prepare("SELECT user_id FROM portfolio_books WHERE user_id = ? UNION SELECT user_id FROM watchlists WHERE user_id = ? LIMIT 1")
        .bind(override, override).first();
      if (existing.length && !selected) throw new ApiError(503, "WORKSPACE_UNAVAILABLE", "The configured workspace does not match saved data. Existing data was kept.");
      candidate = override;
    } else {
      if (existing.length > 1) throw new ApiError(503, "WORKSPACE_UNAVAILABLE", "More than one saved workspace exists. Configure the owner's workspace before continuing.");
      candidate = existing[0]?.user_id ?? emptyWorkspaceId;
    }
    // Recheck owner ambiguity in the same statement as first creation. This
    // avoids choosing an empty workspace if a prior deployment saves meanwhile.
    mapping = override === undefined
      ? await db.prepare("INSERT INTO password_workspace (workspace_key, user_id) SELECT ?, ? WHERE NOT EXISTS (SELECT user_id FROM portfolio_books WHERE user_id <> ? UNION ALL SELECT user_id FROM watchlists WHERE user_id <> ?) ON CONFLICT(workspace_key) DO NOTHING RETURNING user_id")
        .bind(workspaceKey, candidate, candidate, candidate).first()
      : await db.prepare("INSERT INTO password_workspace (workspace_key, user_id) VALUES (?, ?) ON CONFLICT(workspace_key) DO NOTHING RETURNING user_id")
        .bind(workspaceKey, candidate).first();
    mapping ||= await db.prepare("SELECT user_id FROM password_workspace WHERE workspace_key = ?").bind(workspaceKey).first();
    if (!mapping || !validId(mapping.user_id) || mapping.user_id !== candidate) {
      throw new ApiError(503, "WORKSPACE_UNAVAILABLE", "The saved workspace changed during setup. Existing data was kept; please retry.");
    }
    return mapping.user_id;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "AUTH_UNAVAILABLE", "Private storage is temporarily unavailable. Existing data was kept.");
  }
}

async function sessionKey(env) {
  return crypto.subtle.importKey("raw", bytes(env.INVESTMENT_SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function cookieSettings(request) {
  const url = new URL(request.url);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new ApiError(503, "AUTH_UNAVAILABLE", "Use a secure connection to open this app.");
  return { name: local ? "investment_preview_session" : "__Host-investment_session", attributes: `Path=/; HttpOnly; ${local ? "" : "Secure; "}SameSite=Lax` };
}

async function signSession(env, now) {
  const payload = `${Math.floor(now / 1000) + lifetimeSeconds}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(env), encoder.encode(`${payload}.${env.INVESTMENT_PASSWORD_HASH}`));
  return `${payload}.${hex(signature)}`;
}

async function validSession(request, env, cookie, now) {
  const values = (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${cookie.name}=`));
  if (values.length !== 1) return false;
  const match = /^(\d{10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(values[0].slice(cookie.name.length + 1));
  const seconds = Math.floor(now / 1000);
  if (!match || Number(match[1]) <= seconds || Number(match[1]) > seconds + lifetimeSeconds) return false;
  return crypto.subtle.verify("HMAC", await sessionKey(env), bytes(match[3]), encoder.encode(`${match[1]}.${match[2]}.${env.INVESTMENT_PASSWORD_HASH}`));
}

async function correctPassword(password, config) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: config.salt, iterations: 100000 }, key, 256));
  let different = 0;
  for (let index = 0; index < actual.length; index++) different |= actual[index] ^ config.hash[index];
  return different === 0;
}

async function reserveLoginAttempt(request, env, now) {
  const db = database(env);
  // Only the edge-provided address is used. No raw address is stored or logged.
  // Without that header, anonymous attempts share one conservative bucket.
  const address = request.headers.get("cf-connecting-ip") || "unknown";
  const key = hex(await crypto.subtle.sign("HMAC", await sessionKey(env), encoder.encode(`login:${address}`)));
  const globalKey = hex(await crypto.subtle.sign("HMAC", await sessionKey(env), encoder.encode("login:global-limit")));
  try {
    await db.prepare("DELETE FROM password_login_attempts WHERE expires_at <= ? AND attempt_key <> ?").bind(now, key).run();
    async function reserve(bucketKey, limit) {
      const row = await db.prepare("INSERT INTO password_login_attempts (attempt_key, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(attempt_key) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE MIN(attempts + 1, ?) END, expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING attempts, expires_at")
        .bind(bucketKey, now + attemptWindowMs, now, limit + 1, now).first();
      if (!row || !Number.isSafeInteger(row.attempts) || !Number.isSafeInteger(row.expires_at)) throw new Error("Invalid login limit.");
      return { expiresAt: row.expires_at, allowed: row.attempts <= limit, retryAfter: Math.max(1, Math.ceil((row.expires_at - now) / 1000)) };
    }
    const local = await reserve(key, maximumAttempts);
    if (!local.allowed) return { ...local, key };
    const shared = await reserve(globalKey, maximumGlobalAttempts);
    return { ...local, key, allowed: shared.allowed, retryAfter: shared.allowed ? local.retryAfter : shared.retryAfter };
  } catch {
    throw new ApiError(503, "AUTH_UNAVAILABLE", "Sign-in is temporarily unavailable. Please try again shortly.");
  }
}

function returnPath(value) {
  // The app uses hash navigation. Only its root page and known views may be
  // destinations; URL hosts, query parameters and arbitrary paths are rejected.
  return typeof value === "string" && /^\/(?:#(?:dashboard|portfolio|portfolio-performance|screener|research|opportunities))?$/.test(value) ? value : "/";
}

function loginPage(message = "", status = 200, next = "/", extraHeaders = {}) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#dedfdd"><title>Investment Helper — Sign in</title><style>
    *{box-sizing:border-box}body{margin:0;background:#dedfdd;color:#222823;font:16px/1.5 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}main{width:min(100%,420px);padding:36px;background:#eeefed;border:1px solid #bfc3be}h1{font-size:26px;line-height:1.2;margin:0 0 12px;font-weight:600}p{color:#50594f;margin:0 0 26px}label{display:block;margin:0 0 8px}input,button{width:100%;border-radius:0;font:inherit;padding:12px;border:1px solid #9da79c}input{background:#f8f8f7;color:#222823}button{background:#234634;color:#fff;border-color:#234634;margin-top:18px;cursor:pointer}input:focus,button:focus{outline:2px solid #376b4f;outline-offset:3px}.error{margin:16px 0 0;color:#963c35;font-size:14px}
  </style></head><body><main><h1>Investment Helper</h1><p>Enter your password to open your portfolio.</p><form method="post" action="/login"><input type="hidden" name="next" value="${returnPath(next)}"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256" autofocus>${message ? `<p class="error" role="alert">${message}</p>` : ""}<button type="submit">Open portfolio</button></form></main></body></html>`, { status, headers: {
    ...privateHeaders, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...extraHeaders,
  } });
}

const redirect = (path, cookie) => new Response(null, { status: 303, headers: { ...privateHeaders, Location: path, ...(cookie ? { "Set-Cookie": cookie } : {}) } });
const unauthorized = () => Response.json({ error: "Enter your password to open your saved data.", code: "SIGN_IN_REQUIRED" }, { status: 401, headers: privateHeaders });
const methodDenied = (allowed) => new Response("Method not allowed", { status: 405, headers: { ...privateHeaders, Allow: allowed.join(", ") } });

export function createPasswordAuth({ now: suppliedNow } = {}) {
  const clock = () => typeof suppliedNow === "function" ? suppliedNow() : suppliedNow ?? Date.now();
  return async function passwordGate(request, env) {
    const url = new URL(request.url);
    const config = passwordConfig(env);
    const cookie = cookieSettings(request);
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new ApiError(503, "AUTH_UNAVAILABLE", "Sign-in is temporarily unavailable.");
    if (url.pathname === "/login" && !["GET", "HEAD", "POST"].includes(request.method)) return { response: methodDenied(["GET", "HEAD", "POST"]) };
    if (url.pathname === "/logout") {
      if (request.method !== "POST") return { response: methodDenied(["POST"]) };
      checkSameOrigin(request);
      return { response: redirect("/login", `${cookie.name}=; ${cookie.attributes}; Max-Age=0`) };
    }
    if (url.pathname === "/login" && request.method === "POST") {
      checkSameOrigin(request);
      if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(request.headers.get("content-type") || "")) {
        return { response: loginPage("Please enter your password.", 415) };
      }
      const form = new URLSearchParams(await readBoundedText(request, 2048));
      if ([...form.keys()].some((key) => !["password", "next"].includes(key)) || form.getAll("password").length !== 1 || form.getAll("next").length > 1) {
        return { response: loginPage("Please enter your password.", 400) };
      }
      const password = form.get("password");
      const next = returnPath(form.get("next"));
      if (!password || password.length > 256) return { response: loginPage("Please enter your password.", 400, next) };
      const attempt = await reserveLoginAttempt(request, env, now);
      if (!attempt.allowed) return { response: loginPage("Too many attempts. Please try again in ten minutes.", 429, next, { "Retry-After": String(attempt.retryAfter) }) };
      if (!await correctPassword(password, config)) return { response: loginPage("That password is incorrect. Please try again.", 401, next) };
      await resolvePasswordWorkspace(env);
      // Only clear an admitted attempt. A simultaneous success must not delete
      // a newly reserved window after the current one expired.
      try { await database(env).prepare("DELETE FROM password_login_attempts WHERE attempt_key = ? AND expires_at = ?").bind(attempt.key, attempt.expiresAt).run(); }
      catch { throw new ApiError(503, "AUTH_UNAVAILABLE", "Sign-in could not be confirmed. Please try again shortly."); }
      return { response: redirect(next, `${cookie.name}=${await signSession(env, now)}; ${cookie.attributes}; Max-Age=${lifetimeSeconds}`) };
    }
    if (!await validSession(request, env, cookie, now)) {
      if (url.pathname === "/login" && ["GET", "HEAD"].includes(request.method)) {
        const response = loginPage("", 200, returnPath(url.searchParams.get("next")));
        return { response: request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response };
      }
      return { response: url.pathname.startsWith("/api/") || url.pathname === "/api" ? unauthorized() : redirect("/login") };
    }
    const userId = await resolvePasswordWorkspace(env);
    if (url.pathname === "/login") return { response: redirect(returnPath(url.searchParams.get("next"))) };
    return { userId };
  };
}
