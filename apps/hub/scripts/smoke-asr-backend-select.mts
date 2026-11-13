/**
 * Smoke: auto ASR uses whisper.cpp (never Xenova on auto). Fast Whisper removed.
 */
import assert from "node:assert/strict";
import {
  asrBackendPreference,
  pickAsrEngine,
} from "../src/subtitle-asr.ts";

delete process.env.SUBTITLE_ASR_BACKEND;
assert.equal(asrBackendPreference(), "auto");
assert.equal(pickAsrEngine("auto"), "whisper_cpp");
assert.equal(pickAsrEngine("whisper_cpp"), "whisper_cpp");
assert.equal(pickAsrEngine("transformers"), "transformers");

process.env.SUBTITLE_ASR_BACKEND = "faster_whisper";
assert.equal(asrBackendPreference(), "whisper_cpp");

process.env.SUBTITLE_ASR_BACKEND = "whisper_cpp";
assert.equal(asrBackendPreference(), "whisper_cpp");

console.log(
  "SMOKE_OK (asr backend select: auto→whisper.cpp; faster_whisper legacy→whisper.cpp; transformers opt-in)",
);
