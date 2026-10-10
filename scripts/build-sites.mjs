import { build } from "esbuild";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const publicFiles = ["index.html", "styles.css", "app.js"];
const dataFiles = ["earnings-calendar.json", "exchange-rate.json", "fundamentals.json", "instruments.json", "portfolio-fx.json", "prices.json", "sec-tickers.json"];
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };
async function browserModules(directory) {
  const paths = [];
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (entry.isDirectory()) paths.push(...await browserModules(`${directory}/${entry.name}`));
    else if (entry.isFile() && entry.name.endsWith(".js")) paths.push(`${directory}/${entry.name}`);
  }
  return paths;
}
publicFiles.push(...await browserModules("js"), ...dataFiles.map((file) => `data/${file}`));
const assets = {};
for (const file of publicFiles.sort()) {
  let source = await readFile(resolve(root, file), "utf8");
  if (file === "index.html") source = source.replace(/<html([^>]*)>/, (_, attrs) => `<html${attrs.replace(/\sdata-cloud-mode=["'][^"']*["']/g, "")} data-cloud-mode="sites">`);
  const extension = file.slice(file.lastIndexOf("."));
  assets[file] = Buffer.byteLength(source) > 4096 ? {
    encoding: "gzip-base64", data: gzipSync(source, { level: 9 }).toString("base64"), contentType: mime[extension] || "text/plain"
  } : source;
}
const manifest = JSON.parse(await readFile(resolve(root, ".openai/hosting.json"), "utf8"));
if (!manifest.project_id || manifest.d1 !== "DB" || manifest.static) throw new Error("Sites requires the registered Worker manifest and DB binding.");
await mkdir(resolve(root, ".sites-runtime"), { recursive: true });
await mkdir(resolve(root, "dist/server"), { recursive: true });
await mkdir(resolve(root, "dist/.openai"), { recursive: true });
const entry = resolve(root, ".sites-runtime/sites-entry.mjs");
// The hosted bundle always requires the password gate, including when secrets
// or runtime mode settings are accidentally missing. Local/source tests retain
// the native identity mode for compatibility.
await writeFile(entry, `import { createApp } from "../server/worker.mjs";\nexport default createApp(${JSON.stringify(assets)}, { authMode: "password" });\n`);
await build({ entryPoints: [entry], outfile: resolve(root, "dist/server/index.js"), bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "none" });
await writeFile(resolve(root, "dist/.openai/hosting.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built private Sites Worker with ${publicFiles.length} browser assets.`);
