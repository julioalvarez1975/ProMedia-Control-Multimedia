/**
 * Test: JSON stores never lose data on a corrupt file; writes are atomic.
 * Run: pnpm --filter @promedia/hub exec tsx scripts/test-json-file.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../src/json-file.ts";

const dir = await mkdtemp(path.join(tmpdir(), "pm-json-"));
const file = path.join(dir, "index.json");

assert.equal((await readJsonFile(file, "t")).status, "missing");

await writeJsonAtomic(file, { items: [1, 2] });
const ok = await readJsonFile<{ items: number[] }>(file, "t");
assert.equal(ok.status, "ok");
assert.deepEqual(ok.status === "ok" && ok.value.items, [1, 2]);
assert.deepEqual(
  (await readdir(dir)).filter((n) => n.endsWith(".tmp")),
  [],
  "no temp file left behind",
);

await writeFile(file, '{"items": [1, 2', "utf8"); // truncated
const bad = await readJsonFile(file, "t");
assert.equal(bad.status, "corrupt");
assert.ok(bad.status === "corrupt" && bad.movedTo, "corrupt file moved aside");
assert.equal((await readJsonFile(file, "t")).status, "missing", "original path is free");
assert.equal(
  await readFile(bad.status === "corrupt" ? bad.movedTo! : "", "utf8"),
  '{"items": [1, 2',
  "the corrupt copy is preserved, not deleted",
);

// Library store: a corrupt index is quarantined, never wiped by the next write.
process.env.LIBRARY_ROOT = path.join(dir, "lib");
const { LibraryStore } = await import("../src/library-store.ts");
const libIndex = path.join(process.env.LIBRARY_ROOT, "index.json");
const first = new LibraryStore();
const created = await first.createSong({ title: "Canción A", stanzas: [{ id: "s", lines: ["uno", "dos"] }] });
assert.ok(!("error" in created));
await writeFile(libIndex, "{ not json", "utf8");
const second = new LibraryStore();
assert.equal((await second.list({})).length, 0, "starts empty after corruption");
assert.ok(
  (await readdir(process.env.LIBRARY_ROOT)).some((n) => n.startsWith("index.json.corrupt-")),
  "a corrupt copy was kept for recovery",
);

await rm(dir, { recursive: true, force: true });
console.log("TEST_OK test-json-file");
