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
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubtitleCue } from "@promedia/shared";
import { promediaRoot } from "./subtitle-paths.js";

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

async function resolvePython(): Promise<string | null> {
  const root = promediaRoot();
  const candidates = [
    process.env.SUBTITLE_WHISPERX_PYTHON?.trim(),
    path.join(root, "data/models/whisperx-venv/bin/python"),
    path.join(root, "data/models/whisperx-venv/bin/python3"),
    path.join(root, "apps/hub/.venv-whisperx/bin/python"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      await access(c);
      return c;
    } catch {
      // next
    }
  }
  return null;
}

export async function fasterWhisperAvailable(): Promise<boolean> {
  return (await resolvePython()) !== null;
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
  const python = await resolvePython();
  if (!python) throw new Error("faster_whisper_missing");

  const timeoutMs = Math.max(
    60_000,
    Number(process.env.SUBTITLE_FASTER_WHISPER_TIMEOUT_MS) || 600_000,
  );
  const model = fasterWhisperModel();
  console.log(`[subtitle] ASR backend=faster_whisper model=${model}`);
  // First run downloads the model from Hugging Face.
  options.onStatus?.("transcribing");

  const request = JSON.stringify({
    audioPath: options.wavPath,
    model,
    computeType: process.env.SUBTITLE_FASTER_WHISPER_COMPUTE?.trim() || "int8",
    language: options.languageHint ?? null,
    translate: options.translateToEn,
    prompt: options.prompt ?? null,
  });

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(python, [SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("faster_whisper_timeout"));
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (!out.trim() && err.trim()) {
        reject(new Error(`faster_whisper_failed: ${err.trim().slice(-200)}`));
      } else {
        resolve(out);
      }
    });
    child.stdin.end(request);
  });

  const result = parseFasterWhisperOutput(stdout, options.translateToEn);
  console.log(
    `[subtitle] faster_whisper done cues=${result.cues.length} in ${(result.elapsedMs / 1000).toFixed(1)}s`,
  );
  return result;
}
