import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { generatePasswordSecrets } from "../server/auth.mjs";
import { createLocalDatabase } from "../server/local-database.mjs";

test("Sites build serves the full frontend and rejects anonymous private API access", async () => {
  execFileSync(process.execPath, ["scripts/build-sites.mjs"], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
  const { default: app } = await import("../dist/server/index.js?test-build");
  const database = createLocalDatabase();
  const environment = { DB: database, ...await generatePasswordSecrets("build-check-password") };
  const loginRequest = new Request("https://investment.example/login", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://investment.example" },
    body: "password=build-check-password" });
  const login = await app.fetch(loginRequest, environment);
  assert.equal(login.status, 303);
  const headers = { Cookie: login.headers.get("set-cookie").split(";")[0] };
  const authorized = (path) => app.fetch(new Request(`https://investment.example${path}`, { headers }), environment);
  // Workers do not supply a browser/Node file URL through import.meta.url.
  // Loading shared parsers must not eagerly resolve browser snapshot paths.
  execFileSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { createContext, SourceTextModule } from "node:vm";
    import { gzipSync, gunzipSync } from "node:zlib";
    import { generatePasswordSecrets } from "./server/auth.mjs";
    import { createLocalDatabase } from "./server/local-database.mjs";
    // Model Workers' documented automatic Content-Encoding behavior.
    class WorkersResponse extends Response {
      constructor(body, init) {
        const compressed = body != null && new Headers(init?.headers).get("content-encoding") === "gzip"
          && init?.encodeBody !== "manual";
        super(compressed ? gzipSync(body) : body, init);
      }
    }
    const context = createContext({ URL, URLSearchParams, Request, Response: WorkersResponse, Headers,
      TextEncoder, TextDecoder, AbortController,
      fetch() { throw new Error("Runtime fetch is not ready before the request"); }, atob, btoa, crypto,
      setTimeout, clearTimeout });
    const worker = new SourceTextModule(readFileSync("dist/server/index.js", "utf8"), { context });
    await worker.link(() => { throw new Error("The Worker must be self-contained"); });
    await worker.evaluate();
    const response = await worker.namespace.default.fetch(new Request("https://investment.example/api/health"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).cloud, true);
    const database = createLocalDatabase();
    const environment = { DB: database, ...await generatePasswordSecrets("vm-check-password") };
    const login = await worker.namespace.default.fetch(new Request("https://investment.example/login", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://investment.example" }, body: "password=vm-check-password" }), environment);
    assert.equal(login.status, 303);
    const page = await worker.namespace.default.fetch(new Request("https://investment.example/", {
      headers: { Cookie: login.headers.get("set-cookie").split(";")[0] }
    }), environment);
    const html = gunzipSync(Buffer.from(await page.arrayBuffer())).toString();
    assert.match(html, /data-cloud-mode="sites"/);
    // The hosting runtime supplies its outbound fetch when requests run. It
    // must keep its global receiver rather than be captured as a bare callback.
    let providerCalls = 0;
    function runtimeFetch(url) {
      assert.equal(this?.fetch, runtimeFetch);
      assert.equal(url, "https://api.frankfurter.dev/v2/providers/ecb/rate/usd/eur");
      providerCalls++;
      return Promise.resolve(Response.json({ base: "USD", quote: "EUR", rate: 0.9,
        date: new Date().toISOString().slice(0, 10) }));
    }
    context.fetch = runtimeFetch;
    const rate = await worker.namespace.default.fetch(new Request("https://investment.example/api/exchange-rate", {
      headers: { Cookie: login.headers.get("set-cookie").split(";")[0] }
    }), environment);
    assert.equal(rate.status, 200);
    assert.equal((await rate.json()).rate, 0.9);
    assert.equal(providerCalls, 1);
    database.close();
  `], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
  const page = await authorized("/");
  assert.equal(page.status, 200);
  const html = gunzipSync(Buffer.from(await page.arrayBuffer())).toString();
  assert.match(html, /data-cloud-mode="sites"/);
  assert.match(html, /cloudStorageStatus/);
  const startup = await authorized("/app.js");
  assert.equal(startup.status, 200);
  assert.match(gunzipSync(Buffer.from(await startup.arrayBuffer())).toString(), /initializeCloudSync/);
  const anonymous = await app.fetch(new Request("https://investment.example/api/portfolio"), environment);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("cache-control"), /private, no-store/);
  for (const path of ["server/worker.mjs", ".openai/hosting.json", "package.json", ".env", "dev-server.mjs"]) {
    assert.equal((await authorized(`/${path}`)).status, 404);
  }
  const unavailable = await app.fetch(new Request("https://investment.example/"), { INVESTMENT_AUTH_MODE: "chatgpt" });
  assert.equal(unavailable.status, 503, "The hosted bundle cannot bypass password mode without secrets");
  const packed = JSON.parse(await readFile(new URL("../dist/.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(packed.d1, "DB");
  assert.equal(packed.static, undefined);
  database.close();
});
