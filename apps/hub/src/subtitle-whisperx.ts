/**
 * WhisperX forced alignment for karaoke:
 * cancionero lines (exact text) → wav2vec2 clocks on local audio.
 * Python sidecar: apps/hub/python/whisperx_align.py
 */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubtitleCue } from "@promedia/shared";
import { ensureAugmentedPath } from "./subtitle-bins.js";
import { extractWav16k } from "./subtitle-asr.js";
import {
  ensureSubtitleDirs,
  promediaRoot,
  subtitleModelsRoot,
} from "./subtitle-paths.js";
import { cueStartWithAirMs, SILENCE_AIR_ANTICIPATION_MS } from "./subtitle-silence.js";

const ALIGN_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../python/whisperx_align.py",
);

export type WhisperxAlignResult = {
  cues: SubtitleCue[];
  language: string;
  alignModel: string;
  device: string;
  durationMs: number;
};

let cachedPython: string | null | undefined;
let cachedAvailable: boolean | undefined;

function venvPythonCandidates(): string[] {
  const root = promediaRoot();
  const envOverride = process.env.SUBTITLE_WHISPERX_PYTHON?.trim();
  const out: string[] = [];
  if (envOverride) out.push(envOverride);
  out.push(
    path.join(root, "data/models/whisperx-venv/bin/python"),
    path.join(root, "data/models/whisperx-venv/bin/python3"),
    path.join(root, "apps/hub/.venv-whisperx/bin/python"),
    "/opt/homebrew/bin/python3.12",
    "/usr/local/bin/python3.12",
    "python3.12",
    "python3",
  );
  return out;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

async function resolveWhisperxPython(): Promise<string | null> {
  if (cachedPython !== undefined) return cachedPython;
  ensureAugmentedPath();
  for (const candidate of venvPythonCandidates()) {
    if (candidate.includes(path.sep) || candidate.startsWith("/")) {
      if (!(await isExecutable(candidate))) continue;
    }
    const ok = await probeWhisperxImport(candidate);
    if (ok) {
      cachedPython = candidate;
      return candidate;
    }
  }
  cachedPython = null;
  return null;
}

function probeWhisperxImport(pythonBin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      pythonBin,
      ["-c", "import whisperx; print('ok')"],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      resolve(code === 0 && out.includes("ok"));
    });
  });
}

/** True when the WhisperX venv + package are ready for karaoke align. */
export async function whisperxAvailable(): Promise<boolean> {
  if (cachedAvailable !== undefined) return cachedAvailable;
  if (!(await isExecutable(ALIGN_SCRIPT)) && !(await fileExists(ALIGN_SCRIPT))) {
    cachedAvailable = false;
    return false;
  }
  const py = await resolveWhisperxPython();
  cachedAvailable = Boolean(py);
  return cachedAvailable;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runAlignScript(
  pythonBin: string,
  payload: unknown,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const models = subtitleModelsRoot();
    const child = spawn(pythonBin, [ALIGN_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HF_HOME: process.env.HF_HOME || models,
        HUGGINGFACE_HUB_CACHE:
          process.env.HUGGINGFACE_HUB_CACHE || models,
        TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE || models,
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("whisperx_timeout"));
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
}

function applyAirToCues(
  cues: SubtitleCue[],
  airMs: number,
): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    let startMs = cueStartWithAirMs(c.startMs, airMs);
    if (i > 0) startMs = Math.max(startMs, out[i - 1]!.startMs + 700);
    const nextDisplayStart =
      i + 1 < cues.length
        ? cueStartWithAirMs(cues[i + 1]!.startMs, airMs)
        : null;
    // End = last sung word of THIS line (+ small pad). Blank after — no stretch.
    let endMs = Math.max(startMs + 500, Math.round(c.endMs) + 120);
    if (nextDisplayStart != null) {
      endMs = Math.min(endMs, nextDisplayStart);
    }
    out.push({
      id: `cancionero_${i}`,
      startMs,
      endMs: Math.max(startMs + 500, endMs),
      text: c.text,
    });
  }
  return out;
}

/**
 * Force-align exact cancionero lines onto media with WhisperX.
 * Returns null when WhisperX is unavailable or alignment fails.
 */
export async function alignLyricsWithWhisperx(options: {
  mediaPath: string;
  assetId: string;
  lines: readonly string[];
  language?: string;
  durationMs?: number;
  airMs?: number;
  /** Silence speech onsets (ms) — seeds WhisperX windows across the song. */
  onsetHintsMs?: readonly number[];
  onStatus?: (status: "extracting" | "transcribing") => void;
}): Promise<WhisperxAlignResult | null> {
  const lines = options.lines.map((l) => String(l).trim()).filter(Boolean);
  if (!lines.length) return null;

  const pythonBin = await resolveWhisperxPython();
  if (!pythonBin) {
    console.warn("[subtitle] whisperx unavailable (install data/models/whisperx-venv)");
    return null;
  }

  const dirs = await ensureSubtitleDirs();
  const wavPath = path.join(
    dirs.wav,
    `whisperx_${options.assetId || "media"}.wav`,
  );

  options.onStatus?.("extracting");
  try {
    await extractWav16k(options.mediaPath, wavPath);
  } catch (err) {
    console.warn(
      "[subtitle] whisperx wav extract failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  options.onStatus?.("transcribing");
  // Default 3 min — long enough for align; never block karaoke forever.
  const timeoutMs = Math.max(
    60_000,
    Number(process.env.SUBTITLE_WHISPERX_TIMEOUT_MS) || 180_000,
  );

  let raw: { code: number; stdout: string; stderr: string };
  try {
    raw = await runAlignScript(
      pythonBin,
      {
        audioPath: wavPath,
        lines,
        language: options.language ?? "es",
        durationMs: options.durationMs ?? 0,
        device: process.env.SUBTITLE_WHISPERX_DEVICE ?? "auto",
        modelName: process.env.SUBTITLE_WHISPERX_ALIGN_MODEL ?? null,
        onsetHintsMs: options.onsetHintsMs ?? [],
      },
      timeoutMs,
    );
  } catch (err) {
    console.warn(
      "[subtitle] whisperx align spawn failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  let parsed: {
    ok?: boolean;
    error?: string;
    cues?: SubtitleCue[];
    language?: string;
    alignModel?: string;
    device?: string;
    durationMs?: number;
  };
  try {
    parsed = JSON.parse(raw.stdout.trim() || "{}") as typeof parsed;
  } catch {
    console.warn(
      "[subtitle] whisperx align bad JSON:",
      raw.stdout.slice(0, 200),
      raw.stderr.slice(-300),
    );
    return null;
  }

  if (!parsed.ok || !Array.isArray(parsed.cues) || parsed.cues.length === 0) {
    console.warn(
      "[subtitle] whisperx align failed:",
      parsed.error ?? `code=${raw.code}`,
      raw.stderr.slice(-400),
    );
    return null;
  }

  const air = options.airMs ?? SILENCE_AIR_ANTICIPATION_MS;
  const cues = applyAirToCues(
    parsed.cues.map((c, i) => ({
      id: c.id || `wx_${i}`,
      startMs: Math.max(0, Math.round(Number(c.startMs) || 0)),
      endMs: Math.max(
        Math.round(Number(c.startMs) || 0) + 500,
        Math.round(Number(c.endMs) || 0),
      ),
      // Always the full cancionero renglón — WhisperX only supplies clocks.
      text: String(lines[i] ?? c.text ?? "").trim(),
    })),
    air,
  );

  console.log(
    `[subtitle] whisperx aligned lines=${cues.length} model=${parsed.alignModel ?? "?"} device=${parsed.device ?? "?"} airMs=${air}`,
  );

  return {
    cues,
    language: parsed.language ?? options.language ?? "es",
    alignModel: parsed.alignModel ?? "whisperx",
    device: parsed.device ?? "cpu",
    durationMs: parsed.durationMs ?? options.durationMs ?? 0,
  };
}
