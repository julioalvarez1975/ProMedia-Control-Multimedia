/**
 * Real-silence detection for karaoke cue placement (ffmpeg silencedetect).
 * Speech onsets = ends of silence regions; cues start airMs before each onset.
 */
import { spawn } from "node:child_process";
import {
  ensureAugmentedPath,
  missingBinHintFromError,
  resolveFfmpegBin,
} from "./subtitle-bins.js";

/** Air before the sung phrase after audio analysis (0,20 s). */
export const SILENCE_AIR_ANTICIPATION_MS = 200;

/** Minimum quiet stretch to count as a real phrase break. */
export const MIN_REAL_SILENCE_MS = 280;

/**
 * Stronger gaps preferred when mapping lyric sentences onto onsets
 * (instrumental beds create many short dips; sentences need room to breathe).
 */
export const PHRASE_SILENCE_MS = 420;

/**
 * Noise floor for silencedetect (dB below full scale).
 * Worship tracks keep a music bed — too low (−32) sees almost no “silence”.
 * −22 catches breath / phrase gaps without treating the whole song as quiet.
 */
export const SILENCE_NOISE_DB = -22;

export type SilenceRegion = {
  startMs: number;
  endMs: number;
  durationMs: number;
};

export type SilenceAnalysis = {
  /** Quiet stretches ≥ MIN_REAL_SILENCE_MS. */
  silences: SilenceRegion[];
  /**
   * Times when voice resumes after real silence (and 0 if the track
   * starts with audible audio).
   */
  speechOnsetsMs: number[];
  durationMs: number;
};

function runFfmpegSilenceDetect(
  mediaPath: string,
  noiseDb: number,
  minSilenceSec: number,
): Promise<{ code: number; stderr: string }> {
  ensureAugmentedPath();
  const bin = resolveFfmpegBin();
  const filter = `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        mediaPath,
        "-af",
        filter,
        "-f",
        "null",
        "-",
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: process.env,
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
  });
}

function parseDurationMs(stderr: string): number {
  // Duration: 00:03:45.12
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (![h, min, sec].every((n) => Number.isFinite(n))) return 0;
  return Math.round((h * 3600 + min * 60 + sec) * 1000);
}

function parseSilenceRegions(stderr: string): SilenceRegion[] {
  const starts: number[] = [];
  const ends: Array<{ end: number; duration: number }> = [];
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([-+]?\d+(?:\.\d+)?)/);
    if (startMatch) {
      starts.push(Number(startMatch[1]));
      continue;
    }
    const endMatch = line.match(
      /silence_end:\s*([-+]?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*([-+]?\d+(?:\.\d+)?)/,
    );
    if (endMatch) {
      ends.push({ end: Number(endMatch[1]), duration: Number(endMatch[2]) });
    }
  }

  const regions: SilenceRegion[] = [];
  const n = Math.min(starts.length, ends.length);
  for (let i = 0; i < n; i++) {
    const startSec = starts[i]!;
    const { end: endSec, duration: durSec } = ends[i]!;
    if (![startSec, endSec, durSec].every((v) => Number.isFinite(v))) continue;
    const startMs = Math.max(0, Math.round(startSec * 1000));
    const endMs = Math.max(startMs, Math.round(endSec * 1000));
    const durationMs = Math.max(0, Math.round(durSec * 1000));
    if (durationMs < MIN_REAL_SILENCE_MS) continue;
    regions.push({ startMs, endMs, durationMs });
  }
  // Orphan silence_start without end (EOF quiet) — still a break, no onset.
  return regions;
}

/**
 * Examine media (WAV preferred) for real silence → speech onsets.
 * Throws `ffmpeg_missing` / `ffmpeg_silence_failed`.
 */
export async function detectSpeechOnsetsFromSilence(
  mediaPath: string,
  options?: {
    noiseDb?: number;
    minSilenceMs?: number;
  },
): Promise<SilenceAnalysis> {
  const noiseDb = options?.noiseDb ?? SILENCE_NOISE_DB;
  const minSilenceMs = options?.minSilenceMs ?? MIN_REAL_SILENCE_MS;
  const minSilenceSec = Math.max(0.05, minSilenceMs / 1000);

  let code: number;
  let stderr: string;
  try {
    ({ code, stderr } = await runFfmpegSilenceDetect(
      mediaPath,
      noiseDb,
      minSilenceSec,
    ));
  } catch (err) {
    if (missingBinHintFromError(err, "ffmpeg")) {
      throw new Error("ffmpeg_missing");
    }
    throw err;
  }

  // silencedetect writes to stderr even when code===0; non-zero often still
  // has usable markers if the filter ran before an EOF quirk.
  const silences = parseSilenceRegions(stderr);
  const durationMs = parseDurationMs(stderr);

  if (code !== 0 && silences.length === 0 && durationMs <= 0) {
    const tail = stderr.split("\n").slice(-4).join(" ").trim().slice(0, 160);
    throw new Error(
      `ffmpeg_silence_failed${tail ? `: ${tail}` : ""}`,
    );
  }

  const speechOnsetsMs: number[] = [];
  const firstSilence = silences[0];
  // Karaoke: do NOT fire line 1 at t=0 when the track opens with a music bed
  // (typical worship intro). Only anchor at 0 when there is no silence map at
  // all (equal-time fallback) or the file opens with a short leading quiet.
  if (!firstSilence) {
    speechOnsetsMs.push(0);
  } else if (firstSilence.startMs <= 120) {
    // Leading silence — first voice is that silence's end (loop below).
  }
  // else: audio from the start → wait for the first real phrase break.
  for (const s of silences) {
    // Voice / next phrase resumes when silence ends.
    const onset = s.endMs;
    if (durationMs > 0 && onset >= durationMs - 40) continue;
    const prev = speechOnsetsMs[speechOnsetsMs.length - 1];
    if (prev != null && onset - prev < MIN_REAL_SILENCE_MS) continue;
    speechOnsetsMs.push(onset);
  }

  return { silences, speechOnsetsMs, durationMs };
}

/** Cue start = speech onset minus air anticipation (floored at 0). */
export function cueStartWithAirMs(
  onsetMs: number,
  airMs: number = SILENCE_AIR_ANTICIPATION_MS,
): number {
  return Math.max(0, Math.round(onsetMs) - Math.max(0, Math.round(airMs)));
}
