#!/usr/bin/env node
/**
 * Regenerates locales/<locale>.json from the compiled catalogs
 * (dist/index.js). Runs as part of `pnpm build` so the JSON files can never
 * drift from what the app actually shows.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { LOCALES, getCatalog } = await import(path.join(root, "dist/index.js"));
await mkdir(path.join(root, "locales"), { recursive: true });

let changed = 0;
for (const locale of LOCALES) {
  const file = path.join(root, "locales", `${locale}.json`);
  const next = `${JSON.stringify(getCatalog(locale), null, 2)}\n`;
  const prev = await readFile(file, "utf8").catch(() => "");
  if (prev !== next) {
    await writeFile(file, next, "utf8");
    changed += 1;
  }
}
console.log(`[i18n] locales/*.json ${changed ? `regenerated (${changed} changed)` : "up to date"}`);
