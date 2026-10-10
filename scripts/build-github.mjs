import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// GitHub Pages remains a browser-local copy and publishes only public assets.
const root = resolve(import.meta.dirname, "..");
const target = resolve(root, "dist/github");
await mkdir(target, { recursive: true });
for (const name of ["index.html", "styles.css", "app.js", "js", "data"]) {
  await cp(resolve(root, name), resolve(target, name), { recursive: true });
}
console.log("Prepared browser-local GitHub Pages assets.");
