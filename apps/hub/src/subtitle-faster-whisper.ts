/**
 * faster-whisper (CTranslate2) ASR backend — opt-in with
 * SUBTITLE_ASR_BACKEND=faster_whisper. Python sidecar:
 * apps/hub/python/faster_whisper_asr.py, run with the WhisperX venv
 * (data/models/whisperx-venv) where faster-whisper is already installed.
 *
 * Measured on Apple Silicon (5.5 min song): whisper.cpp base ≈ 10 s (Metal),
 * faster-whisper base ≈ 31 s, small ≈ 68 s (CPU int8 — CTranslate2 has no
 * Metal backend). So it is NOT part of `auto`; it exists for machines without
 * whisper-cli or with a fast x86 CPU / CUDA.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubtitleCue } from "@promedia/shared";
import { resolvePythonFor, runPythonScript } from "./subtitle-python.js";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../python/faster_whisper_asr.py",
);

export type FasterWhisperResult = {
  cues: SubtitleCue[];
  sourceLang: string | null;
  whisperTranslatedToEn: boolean;
  model: string;
  elapsedMs: number;
};

export function fasterWhisperModel(): string {
  return process.env.SUBTITLE_FASTER_WHISPER_MODEL?.trim() || "base";
}

export async function fasterWhisperAvailable(): Promise<boolean> {
  return (await resolvePythonFor("faster_whisper")) !== null;
}

/** Parse the sidecar's stdout (exported for the smoke test). */
export function parseFasterWhisperOutput(
  stdout: string,
  translateToEn: boolean,
): FasterWhisperResult {
  let parsed: {
    ok?: boolean;
    error?: string;
    cues?: SubtitleCue[];
    language?: string;
    model?: string;
    elapsedMs?: number;
  };
  try {
    parsed = JSON.parse(stdout.trim() || "{}");
  } catch {
    throw new Error("faster_whisper_bad_json");
  }
  if (!parsed.ok || !Array.isArray(parsed.cues)) {
    throw new Error(`faster_whisper_failed: ${parsed.error ?? "no output"}`);
  }
  const cues = parsed.cues
    .map((c, i) => ({
      id: c.id || `fw_${i}`,
      startMs: Math.max(0, Math.round(Number(c.startMs) || 0)),
      endMs: Math.max(0, Math.round(Number(c.endMs) || 0)),
      text: String(c.text ?? "").trim(),
    }))
    .filter((c) => c.text && c.endMs > c.startMs);
  return {
    cues,
    sourceLang: translateToEn ? "en" : (parsed.language ?? null),
    whisperTranslatedToEn: translateToEn,
    model: parsed.model ?? "?",
    elapsedMs: Number(parsed.elapsedMs) || 0,
  };
}

export async function transcribeWithFasterWhisper(options: {
  wavPath: string;
  translateToEn: boolean;
  languageHint?: string | null;
  prompt?: string | null;
  onStatus?: (status: "downloading" | "transcribing") => void;
}): Promise<FasterWhisperResult> {
  const python = await resolvePythonFor("faster_whisper");
  if (!python) throw new Error("faster_whisper_missing");

  const timeoutMs = Math.max(
    60_000,
    Number(process.env.SUBTITLE_FASTER_WHISPER_TIMEOUT_MS) || 600_000,
  );
  const model = fasterWhisperModel();
  console.log(`[subtitle] ASR backend=faster_whisper model=${model}`);
  // First run downloads the model from Hugging Face.
  options.onStatus?.("transcribing");

  const run = await runPythonScript(
    python,
    SCRIPT,
    {
      audioPath: options.wavPath,
      model,
      computeType: process.env.SUBTITLE_FASTER_WHISPER_COMPUTE?.trim() || "int8",
      language: options.languageHint ?? null,
      translate: options.translateToEn,
      prompt: options.prompt ?? null,
    },
    { timeoutMs, label: "faster_whisper" },
  );
  if (!run.stdout.trim() && run.stderr.trim()) {
    throw new Error(`faster_whisper_failed: ${run.stderr.trim().slice(-200)}`);
  }
  const stdout = run.stdout;

  const result = parseFasterWhisperOutput(stdout, options.translateToEn);
  console.log(
    `[subtitle] faster_whisper done cues=${result.cues.length} in ${(result.elapsedMs / 1000).toFixed(1)}s`,
  );
  return result;
}
