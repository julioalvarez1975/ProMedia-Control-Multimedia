/**
 * Results calculated by an older procedure are ignored and purged at start;
 * current ones are kept.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "promedia-cachever-"));
process.env.SUBTITLE_DATA_ROOT = root;
process.env.SUBTITLE_MODELS_ROOT = path.join(root, "models");

const { ALIGNED_CACHE_VERSION, loadPersistedAgent, purgeStaleAlignedCache } =
  await import("../src/subtitle-aligned-store.ts");
const { ASR_CACHE_VERSION, purgeStaleAsrCache } = await import("../src/subtitle-asr.ts");

const cue = { startMs: 0, endMs: 1000, text: "x" };
const aligned = (v: number, key: string) => ({
  version: v,
  fileKey: key,
  targetLang: "es",
  songId: "s",
  lyricsHash: "h",
  source: "cancionero",
  savedAt: new Date().toISOString(),
  agent: { cues: [cue], hint: null, timingMode: "exact", sourceLang: "es", translated: false },
});

try {
  const alignedDir = path.join(root, "aligned");
  const cacheDir = path.join(root, "cache");
  await mkdir(alignedDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  // aligned results: old, current, corrupt
  await writeFile(path.join(alignedDir, "yt_OLDOLDOLD11.es.json"), JSON.stringify(aligned(1, "yt_OLDOLDOLD11")));
  await writeFile(path.join(alignedDir, "yt_NEWNEWNEW11.es.json"), JSON.stringify(aligned(ALIGNED_CACHE_VERSION, "yt_NEWNEWNEW11")));
  await writeFile(path.join(alignedDir, "yt_BADBADBAD11.es.json"), "{not json");

  assert.equal(await loadPersistedAgent("yt_OLDOLDOLD11", "es"), null, "old version is not loaded");
  assert.ok(await loadPersistedAgent("yt_NEWNEWNEW11", "es"), "current version loads");
  assert.equal(await purgeStaleAlignedCache(), 2, "old + corrupt aligned files removed");
  assert.deepEqual(await readdir(alignedDir), ["yt_NEWNEWNEW11.es.json"], "only the current result is kept");

  // ASR transcripts: old, current, and an unrelated json that must be left alone
  const asr = (v?: number) => ({ ...(v ? { procVersion: v } : {}), assetId: "a", sourceHash: "h", sourceLang: "es", whisperTranslatedToEn: false, cues: [cue], createdAt: "" });
  await writeFile(path.join(cacheDir, "old.json"), JSON.stringify(asr()));
  await writeFile(path.join(cacheDir, "new.json"), JSON.stringify(asr(ASR_CACHE_VERSION)));
  await writeFile(path.join(cacheDir, "other.json"), JSON.stringify({ hello: "world" }));
  assert.equal(await purgeStaleAsrCache(), 1, "only the old transcript is removed");
  assert.deepEqual((await readdir(cacheDir)).sort(), ["new.json", "other.json"], "current + unrelated files stay");
  console.log("all passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
