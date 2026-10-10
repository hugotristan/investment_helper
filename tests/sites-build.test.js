import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

test("Sites build serves the full frontend and rejects anonymous private API access", async () => {
  execFileSync(process.execPath, ["scripts/build-sites.mjs"], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
  const { default: app } = await import("../dist/server/index.js?test-build");
  // Workers do not supply a browser/Node file URL through import.meta.url.
  // Loading shared parsers must not eagerly resolve browser snapshot paths.
  execFileSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { createContext, SourceTextModule } from "node:vm";
    import { gzipSync, gunzipSync } from "node:zlib";
    // Model Workers' documented automatic Content-Encoding behavior.
    class WorkersResponse extends Response {
      constructor(body, init) {
        const compressed = body != null && new Headers(init?.headers).get("content-encoding") === "gzip"
          && init?.encodeBody !== "manual";
        super(compressed ? gzipSync(body) : body, init);
      }
    }
    const context = createContext({ URL, URLSearchParams, Request, Response: WorkersResponse, Headers,
      TextEncoder, TextDecoder, AbortController, fetch, atob, btoa, crypto,
      setTimeout, clearTimeout });
    const worker = new SourceTextModule(readFileSync("dist/server/index.js", "utf8"), { context });
    await worker.link(() => { throw new Error("The Worker must be self-contained"); });
    await worker.evaluate();
    const response = await worker.namespace.default.fetch(new Request("https://investment.example/api/health"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).cloud, true);
    const page = await worker.namespace.default.fetch(new Request("https://investment.example/"));
    const html = gunzipSync(Buffer.from(await page.arrayBuffer())).toString();
    assert.match(html, /data-cloud-mode="sites"/);
  `], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
  const page = await app.fetch(new Request("https://investment.example/"));
  assert.equal(page.status, 200);
  const html = gunzipSync(Buffer.from(await page.arrayBuffer())).toString();
  assert.match(html, /data-cloud-mode="sites"/);
  assert.match(html, /cloudStorageStatus/);
  const startup = await app.fetch(new Request("https://investment.example/app.js"));
  assert.equal(startup.status, 200);
  assert.match(gunzipSync(Buffer.from(await startup.arrayBuffer())).toString(), /initializeCloudSync/);
  const anonymous = await app.fetch(new Request("https://investment.example/api/portfolio"));
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("cache-control"), /private, no-store/);
  for (const path of ["server/worker.mjs", ".openai/hosting.json", "package.json", ".env", "dev-server.mjs"]) {
    assert.equal((await app.fetch(new Request(`https://investment.example/${path}`))).status, 404);
  }
  const packed = JSON.parse(await readFile(new URL("../dist/.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(packed.d1, "DB");
  assert.equal(packed.static, undefined);
});
