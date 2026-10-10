import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

test("Sites build serves the full frontend and rejects anonymous private API access", async () => {
  execFileSync(process.execPath, ["scripts/build-sites.mjs"], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
  const { default: app } = await import("../dist/server/index.js?test-build");
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
