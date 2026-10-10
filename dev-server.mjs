import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "./server/worker.mjs";
import { createLocalDatabase } from "./server/local-database.mjs";
import { generatePasswordSecrets } from "./server/auth.mjs";

const root = import.meta.dirname;
const port = Number(process.env.PORT || 4180);
await mkdir(resolve(root, ".sites-runtime"), { recursive: true });
const database = createLocalDatabase(resolve(root, ".sites-runtime/preview.sqlite"));
const types = { html: "text/html", css: "text/css", js: "text/javascript", json: "application/json", svg: "image/svg+xml" };
// Password preview uses the actual built asset gate and separate local data.
const passwordPreview = process.env.PREVIEW_PASSWORD ? {
  INVESTMENT_AUTH_MODE: "password", ...await generatePasswordSecrets(process.env.PREVIEW_PASSWORD)
} : null;
const app = passwordPreview ? (await import("./dist/server/index.js")).default : createApp({});
createServer(async (incoming, outgoing) => {
  try {
    const origin = `http://127.0.0.1:${port}`;
    const url = new URL(incoming.url, origin);
    let response;
    if (passwordPreview || url.pathname.startsWith("/api/")) {
      const headers = new Headers(incoming.headers);
      // Synthetic local identity is never bundled or accepted by the hosted Worker.
      headers.set("oai-authenticated-user-id", "local-preview-owner");
      const request = new Request(url, { method: incoming.method, headers,
        ...(!["GET", "HEAD"].includes(incoming.method) ? { body: incoming, duplex: "half" } : {}) });
      response = await app.fetch(request, { DB: database, ...passwordPreview });
    } else {
      const name = decodeURIComponent(url.pathname) === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1);
      const allowed = ["index.html", "styles.css", "app.js"].includes(name) || /^(?:js\/[^.][\w/.-]*\.js|data\/[\w-]+\.json)$/.test(name);
      const filename = resolve(root, name);
      if (!allowed || !filename.startsWith(`${root}\\`) && !filename.startsWith(`${root}/`)) response = new Response("Not found", { status: 404 });
      else {
        let bytes = await readFile(filename);
        if (name === "index.html") bytes = Buffer.from(bytes.toString().replace(/<html([^>]*)>/, (_, attrs) => `<html${attrs.replace(/\sdata-cloud-mode=["'][^"']*["']/g, "")} data-cloud-mode="sites">`));
        response = new Response(incoming.method === "HEAD" ? null : bytes, { headers: { "Content-Type": types[name.split(".").at(-1)] || "text/plain", "Cache-Control": "no-store" } });
      }
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500, { "Content-Type": "text/plain" }); outgoing.end("Preview request failed"); }
}).listen(port, "127.0.0.1", () => console.log(`Local: http://127.0.0.1:${port}/`));
