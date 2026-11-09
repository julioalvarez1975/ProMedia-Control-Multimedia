/**
 * Smoke: faster-whisper backend (opt-in). No model download, no ASR run.
 * Run: pnpm --filter @promedia/hub exec tsx scripts/smoke-faster-whisper.mts
 */
import assert from "node:assert/strict";
import { asrBackendPreference } from "../src/subtitle-asr.ts";
import {
  fasterWhisperAvailable,
  parseFasterWhisperOutput,
} from "../src/subtitle-faster-whisper.ts";

const prev = process.env.SUBTITLE_ASR_BACKEND;
process.env.SUBTITLE_ASR_BACKEND = "faster_whisper";
assert.equal(asrBackendPreference(), "faster_whisper");
delete process.env.SUBTITLE_ASR_BACKEND;
assert.equal(asrBackendPreference(), "auto", "auto stays the default");
if (prev !== undefined) process.env.SUBTITLE_ASR_BACKEND = prev;

const ok = parseFasterWhisperOutput(
  JSON.stringify({
    ok: true,
    language: "es",
    model: "base",
    elapsedMs: 1234,
    cues: [
      { id: "fw_0", startMs: 0, endMs: 1000, text: " hola " },
      { id: "fw_1", startMs: 1000, endMs: 1000, text: "sin duración" },
      { id: "fw_2", startMs: 2000, endMs: 3000, text: "   " },
    ],
  }),
  false,
);
assert.equal(ok.cues.length, 1, "empty / zero-length cues dropped");
assert.equal(ok.cues[0]!.text, "hola");
assert.equal(ok.sourceLang, "es");
assert.equal(ok.whisperTranslatedToEn, false);

assert.equal(parseFasterWhisperOutput(JSON.stringify({ ok: true, cues: [] }), true).sourceLang, "en");
assert.throws(() => parseFasterWhisperOutput("not json", false), /bad_json/);
assert.throws(
  () => parseFasterWhisperOutput(JSON.stringify({ ok: false, error: "boom" }), false),
  /boom/,
);

console.log("faster-whisper venv available:", await fasterWhisperAvailable());
console.log("SMOKE_OK smoke-faster-whisper");
