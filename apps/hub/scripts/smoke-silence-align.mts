/**
 * Smoke: silence air anticipation + line packing (no ffmpeg required).
 * Run: pnpm --filter @promedia/hub exec tsx scripts/smoke-silence-align.mts
 */
import assert from "node:assert/strict";
import {
  alignCancioneroLinesToSilence,
  blankCuesAtPhraseSilence,
} from "../src/subtitle-cancionero.js";
import {
  cueStartWithAirMs,
  SILENCE_AIR_ANTICIPATION_MS,
} from "../src/subtitle-silence.js";

assert.equal(SILENCE_AIR_ANTICIPATION_MS, 400);
assert.equal(cueStartWithAirMs(1000), 600);
assert.equal(cueStartWithAirMs(100), 0);
assert.equal(cueStartWithAirMs(1000, 0), 1000);

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
// Silence has no lyric confirmation — never claims text-synced.
assert.equal(synced, false);
assert.equal(cues[0]!.startMs, 5_000);
assert.equal(cues[1]!.startMs, 12_000);
assert.equal(cues[2]!.startMs, 20_000);
// Hold until THIS phrase's voice ends — blank before the next line air.
assert.ok(cues[0]!.endMs > cues[0]!.startMs);
assert.ok(cues[0]!.endMs <= cues[1]!.startMs);
assert.ok(cues[0]!.endMs < cues[1]!.startMs || cues[0]!.endMs === cues[1]!.startMs);
assert.equal(cues[0]!.text, "Línea uno");

// Breath → blank; next renglón pulled forward by air.
const voice = [
  { id: "a", startMs: 5_000, endMs: 8_000, text: "Línea uno" },
  { id: "b", startMs: 12_000, endMs: 15_000, text: "Línea dos" },
];
const blanked = blankCuesAtPhraseSilence(
  voice,
  [{ startMs: 8_300, endMs: 11_900 }],
  30_000,
  400,
);
assert.equal(blanked[0]!.startMs, 4_600);
assert.ok(blanked[0]!.endMs <= 8_300 + 120, "blank at breath (+pad)");
assert.equal(blanked[1]!.startMs, 11_600, "next line shown early");
assert.ok(blanked[0]!.endMs <= blanked[1]!.startMs, "no overlap");
assert.equal(blanked[1]!.text, "Línea dos");

console.log("smoke-silence-align: ok");
