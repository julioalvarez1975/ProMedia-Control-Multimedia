/**
 * Test: aligned karaoke results persist to disk (only when source-backed).
 * Run: pnpm --filter @promedia/hub exec tsx scripts/test-aligned-store.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptySubtitleAgentState } from "@promedia/shared";

const dir = await mkdtemp(path.join(tmpdir(), "pm-aligned-"));
process.env.SUBTITLE_DATA_ROOT = dir;
const store = await import("../src/subtitle-aligned-store.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const agent = {
  ...emptySubtitleAgentState("es"),
  status: "ready" as const,
  assetId: "yt_abcdefghijk",
  itemId: "i1",
  cues: [{ id: "c0", startMs: 1000, endMs: 3000, text: "uno" }],
  lyricsSource: "lrclib" as const,
};

store.persistReadyAgent(agent); // no meta → must not be saved
await sleep(600);
assert.equal(await store.loadPersistedAgent("yt_abcdefghijk", "es"), null);

store.setPersistMeta("yt_abcdefghijk", {
  songId: "lrclib:1",
  lyricsHash: store.lyricsHash(["uno"]),
  source: "lrclib",
  lrclibSong: { title: "T", lines: ["uno"] },
});
store.persistReadyAgent(agent);
await sleep(700);
const got = await store.loadPersistedAgent("yt_abcdefghijk", "es");
assert.ok(got && got.agent.cues.length === 1 && got.lrclibSong?.title === "T");
assert.equal(store.lyricsHash([" uno ", ""]), store.lyricsHash(["uno"]), "hash ignores blanks/spaces");
assert.equal(await store.loadPersistedAgent("../evil", "es"), null, "path traversal rejected");

await store.forgetPersistedAgent("yt_abcdefghijk");
assert.equal(await store.loadPersistedAgent("yt_abcdefghijk", "es"), null);

// ---- local files are keyed by content, not by the per-upload asset id -----
import { writeFile } from "node:fs/promises";
const f1 = path.join(dir, "a.mp3");
const f2 = path.join(dir, "b.mp3"); // same bytes, other upload
const f3 = path.join(dir, "c.mp3"); // different bytes
await writeFile(f1, Buffer.alloc(5000, 7));
await writeFile(f2, Buffer.alloc(5000, 7));
await writeFile(f3, Buffer.alloc(5000, 9));
const k1 = await store.resolveCacheKey("asset_one", f1);
const k2 = await store.resolveCacheKey("asset_two", f2);
const k3 = await store.resolveCacheKey("asset_three", f3);
assert.match(k1 ?? "", /^fh_[0-9a-f]{40}$/);
assert.equal(k1, k2, "same file → same key across uploads");
assert.notEqual(k1, k3, "different file → different key");
assert.equal(await store.resolveCacheKey("asset_none", null), null);

const local = { ...agent, assetId: "asset_one", itemId: "i2" };
store.setPersistMeta("asset_one", {
  songId: "song1",
  lyricsHash: store.lyricsHash(["uno"]),
  source: "cancionero",
});
store.persistReadyAgent(local);
await sleep(700);
const again = await store.loadPersistedAgent(k2!, "es"); // restored via the other upload's key
assert.ok(again && again.source === "cancionero", "local song restored from disk");
await store.forgetPersistedAgent("asset_one");
assert.equal(await store.loadPersistedAgent(k1!, "es"), null);

await rm(dir, { recursive: true, force: true });
console.log("TEST_OK test-aligned-store");
process.exit(0);
