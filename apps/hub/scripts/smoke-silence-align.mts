/**
 * Smoke: silence air anticipation + line packing (no ffmpeg required).
 * Run: pnpm --filter @promedia/hub exec tsx scripts/smoke-silence-align.mts
 */
import assert from "node:assert/strict";
import {
  alignCancioneroLinesToSilence,
} from "../src/subtitle-cancionero.js";
import {
  cueStartWithAirMs,
  SILENCE_AIR_ANTICIPATION_MS,
} from "../src/subtitle-silence.js";

assert.equal(SILENCE_AIR_ANTICIPATION_MS, 0);
assert.equal(cueStartWithAirMs(1000), 1000);
assert.equal(cueStartWithAirMs(100), 100);

const lines = ["Línea uno", "Línea dos", "Línea tres"];
const onsets = [5_000, 12_000, 20_000];
const { cues, synced, alignedCount } = alignCancioneroLinesToSilence(
  lines,
  onsets,
  30_000,
  0,
);

assert.equal(cues.length, 3);
assert.equal(alignedCount, 3);
assert.equal(synced, true);
assert.equal(cues[0]!.startMs, 5_000);
assert.equal(cues[1]!.startMs, 12_000);
assert.equal(cues[2]!.startMs, 20_000);
// Hold until THIS phrase's voice ends — blank before the next line air.
assert.ok(cues[0]!.endMs > cues[0]!.startMs);
assert.ok(cues[0]!.endMs <= cues[1]!.startMs);
assert.ok(cues[0]!.endMs < cues[1]!.startMs || cues[0]!.endMs === cues[1]!.startMs);
assert.equal(cues[0]!.text, "Línea uno");

console.log("smoke-silence-align: ok");
