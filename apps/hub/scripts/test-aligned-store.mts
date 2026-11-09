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

await rm(dir, { recursive: true, force: true });
console.log("TEST_OK test-aligned-store");
process.exit(0);
