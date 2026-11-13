/**
 * Karaoke align quality gates: timeline plausibility and stale-cache
 * detection for LRCLIB / caption charts.
 */
import type { SubtitleCue } from "@promedia/shared";

/**
 * Reject charts that open long before the first real post-silence voice
 * resume, or that crush many lines into the opening of a long track.
 */
export function audioAlignTimelinePlausible(
  cues: readonly SubtitleCue[],
  speechOnsetsMs: readonly number[] = [],
  durationMs = 0,
): boolean {
  if (!cues.length) return false;
  const first = Math.max(0, Math.round(cues[0]!.startMs));
  const last = Math.max(
    first,
    Math.round(cues[cues.length - 1]!.startMs),
  );

  const strongOnsets = speechOnsetsMs
    .map((t) => Math.max(0, Math.round(Number(t) || 0)))
    .filter((t) => t >= 2_500)
    .sort((a, b) => a - b);
  const firstStrong = strongOnsets[0];
  if (firstStrong != null && first + 1_500 < firstStrong) {
    return false;
  }

  const dur = Math.max(0, Math.round(durationMs));
  if (dur >= 60_000 && last < dur * 0.35) {
    return false;
  }
  if (cues.length >= 8 && last - first < 8_000) {
    return false;
  }
  return true;
}

/**
 * Cached “ready” charts that open too early on a long lyric song are almost
 * always a false intro pack — rebuild instead of keep/restore.
 */
export function cuesSuspiciouslyEarly(
  cues: readonly SubtitleCue[],
): boolean {
  if (cues.length < 12) return false;
  const first = Math.max(0, Math.round(cues[0]!.startMs));
  if (first < 800) return true;
  if (cues.length >= 40 && first < 5_000) return true;
  return false;
}
