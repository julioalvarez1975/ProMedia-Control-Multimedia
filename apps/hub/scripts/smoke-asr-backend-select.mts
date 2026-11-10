/**
 * Smoke: auto ASR prefers faster-whisper when installed, else whisper.cpp (never Xenova on auto).
 * Does not download models or spawn real ASR.
 */
import {
  asrBackendPreference,
  pickAsrEngine,
  classifyWhisperLoadError,
} from "../src/subtitle-asr.ts";
import { resolveWhisperCliBin } from "../src/subtitle-bins.ts";
import { whisperCliAvailable } from "../src/subtitle-whisper-cpp.ts";

async function main(): Promise<void> {
  const prev = process.env.SUBTITLE_ASR_BACKEND;
  delete process.env.SUBTITLE_ASR_BACKEND;
  if (asrBackendPreference() !== "auto") {
    throw new Error(`default backend pref=${asrBackendPreference()}`);
  }

  process.env.SUBTITLE_ASR_BACKEND = "whisper_cpp";
  if (asrBackendPreference() !== "whisper_cpp") {
    throw new Error("forced whisper_cpp not honored");
  }
  process.env.SUBTITLE_ASR_BACKEND = "transformers";
  if (asrBackendPreference() !== "transformers") {
    throw new Error("forced transformers not honored");
  }
  process.env.SUBTITLE_ASR_BACKEND = "AUTO";
  if (asrBackendPreference() !== "auto") {
    throw new Error("AUTO should normalize to auto");
  }

  // Engine choice: auto prefers faster-whisper when installed, else whisper.cpp.
  if (pickAsrEngine("auto", true) !== "faster_whisper") throw new Error("auto+fw should pick faster_whisper");
  if (pickAsrEngine("auto", false) !== "whisper_cpp") throw new Error("auto without fw should pick whisper_cpp");
  if (pickAsrEngine("whisper_cpp", true) !== "whisper_cpp") throw new Error("forced whisper_cpp ignored");
  if (pickAsrEngine("faster_whisper", false) !== "faster_whisper") throw new Error("forced faster_whisper ignored");
  if (pickAsrEngine("transformers", true) !== "transformers") throw new Error("forced transformers ignored");

  if (prev === undefined) delete process.env.SUBTITLE_ASR_BACKEND;
  else process.env.SUBTITLE_ASR_BACKEND = prev;

  const bin = resolveWhisperCliBin();
  const available = await whisperCliAvailable();
  console.log("whisper-cli resolve:", bin, "available:", available);

  // Classification still maps the old Mac ONNX failure (legacy / forced path).
  const c = classifyWhisperLoadError(
    new Error("Unable to get model file path or buffer."),
  );
  if (c !== "model_path_error") throw new Error(`classify=${c}`);

  console.log(
    "SMOKE_OK (asr backend select: auto→faster-whisper, fallback whisper.cpp; transformers opt-in only)",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
