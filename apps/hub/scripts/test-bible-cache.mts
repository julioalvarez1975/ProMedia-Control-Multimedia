/**
 * Test: a Bible file is parsed once; re-importing the same file hits the
 * cache (and a changed file or name does not).
 * Run: pnpm --filter @promedia/hub exec tsx scripts/test-bible-cache.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importBibleFile } from "../src/bible-import.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const bytes = await readFile(path.join(here, "../src/bible/fixtures/sample-bcv.xml"));
const dir = await mkdtemp(path.join(tmpdir(), "pm-bible-"));
const cacheDir = path.join(dir, "cache");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const first = await importBibleFile({ bytes, originalName: "reina-valera.xml", cacheDir });
assert.ok(first.ok, "fixture imports");
await sleep(300);
const files = await readdir(cacheDir);
assert.equal(files.length, 1, "one cache file written");

// Prove the 2nd import reads the cache: tamper with the cached label.
const cachePath = path.join(cacheDir, files[0]!);
const cached = JSON.parse(await readFile(cachePath, "utf8"));
cached.canon.label = "FROM-CACHE";
await writeFile(cachePath, JSON.stringify(cached));
const second = await importBibleFile({ bytes, originalName: "reina-valera.xml", cacheDir });
assert.ok(second.ok && second.canon.label === "FROM-CACHE", "second import served from cache");

// Different name or bytes → different key → parsed again.
const other = await importBibleFile({ bytes, originalName: "otra.xml", cacheDir });
assert.ok(other.ok && other.canon.label !== "FROM-CACHE");
await sleep(300);
assert.equal((await readdir(cacheDir)).length, 2);

// Failures are never cached.
const bad = await importBibleFile({ bytes: Buffer.from("<x/>"), originalName: "x.xml", cacheDir });
assert.equal(bad.ok, false);
await sleep(200);
assert.equal((await readdir(cacheDir)).length, 2, "errors not cached");

// A corrupt cache file falls back to a fresh parse (and is quarantined).
await writeFile(cachePath, "{ broken");
const healed = await importBibleFile({ bytes, originalName: "reina-valera.xml", cacheDir });
assert.ok(healed.ok && healed.canon.label !== "FROM-CACHE");

await sleep(300); // let the background cache write finish
await rm(dir, { recursive: true, force: true });
console.log("TEST_OK test-bible-cache");
process.exit(0);
