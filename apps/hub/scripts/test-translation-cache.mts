/**
 * Test: machine translations are cached on disk per language pair.
 * Run: pnpm --filter @promedia/hub exec tsx scripts/test-translation-cache.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "pm-tr-"));
process.env.SUBTITLE_DATA_ROOT = dir;
const cache = await import("../src/subtitle-translation-cache.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const calls: string[][] = [];
const fakeMt = async (missing: string[]) => {
  calls.push([...missing]);
  return missing.map((t) => `EN(${t})`);
};

const first = await cache.translateWithCache("es", "en", ["hola", "adiós", "hola"], fakeMt);
assert.deepEqual(first?.translations, ["EN(hola)", "EN(adiós)", "EN(hola)"]);
assert.deepEqual(calls[0], ["hola", "adiós"], "repeated lines are translated once");
assert.equal(first?.cached, 0);

const second = await cache.translateWithCache("es", "en", ["adiós", "gracias"], fakeMt);
assert.deepEqual(calls[1], ["gracias"], "only the new line goes to MT");
assert.equal(second?.cached, 1);

// Survives a hub restart: wait for the debounced write, drop memory, reload.
await sleep(800);
cache.resetTranslationCacheMemory();
const third = await cache.translateWithCache("es", "en", ["hola", "adiós", "gracias"], fakeMt);
assert.equal(calls.length, 2, "no MT call after restart — all from disk");
assert.equal(third?.cached, 3);
const onDisk = JSON.parse(await readFile(path.join(dir, "translations", "es-en.json"), "utf8"));
assert.equal(Object.keys(onDisk.entries).length, 3);

// MT unavailable → null and nothing cached.
const failing = await cache.translateWithCache("es", "pt", ["x"], async () => null);
assert.equal(failing, null);
const retry = await cache.translateWithCache("es", "pt", ["x"], fakeMt);
assert.deepEqual(retry?.translations, ["EN(x)"], "a failed attempt did not poison the cache");

await rm(dir, { recursive: true, force: true });
console.log("TEST_OK test-translation-cache");
process.exit(0);
