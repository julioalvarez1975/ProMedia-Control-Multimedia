/**
 * Verify karaoke align for Camilo — Vida de Rico (yt:qKp1f7Vn9dM).
 * Usage: pnpm --filter @promedia/hub exec tsx scripts/verify-vida-de-rico.mts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  alignCancioneroLinesToTiming,
  anchorFirstCueToVoiceOnset,
  blankCuesAtPhraseSilence,
  ensureCancioneroCueTexts,
  resolveFirstVoiceOnsetMs,
  songCancioneroLines,
} from "../src/subtitle-cancionero.js";
import { detectSpeechOnsetsFromSilence, SILENCE_AIR_ANTICIPATION_MS } from "../src/subtitle-silence.js";
import { parseWhisperCppVttOrSrt } from "../src/subtitle-whisper-cpp.js";
import { libraryStore } from "../src/library-store.js";

const VIDEO_ID = "qKp1f7Vn9dM";
const SONG_ID = "6185ec43f6aeb231879e";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const VTT = path.join(
  ROOT,
  "data/subtitles/youtube-cache/qKp1f7Vn9dM.es-EkcP5AbUQBc.vtt",
);
const WAV = path.join(ROOT, "data/subtitles/youtube-cache/qKp1f7Vn9dM.wav");

function fmt(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, "0")}`;
}

async function main(): Promise<void> {
  const item = await libraryStore.get(SONG_ID);
  if (!item?.song) throw new Error(`song ${SONG_ID} missing from library`);
  const lines = songCancioneroLines(item.song);
  const vttRaw = await readFile(VTT, "utf8");
  const timing = parseWhisperCppVttOrSrt(vttRaw);
  console.log(
    `[verify] ${item.song.title} / ${VIDEO_ID} lines=${lines.length} vttCues=${timing.length} airMs=${SILENCE_AIR_ANTICIPATION_MS}`,
  );

  const silence = await detectSpeechOnsetsFromSilence(WAV);
  const firstVoice = resolveFirstVoiceOnsetMs(
    silence.silences,
    silence.speechOnsetsMs,
    timing[0]?.startMs ?? null,
  );
  console.log(
    `[verify] silence silences=${silence.silences.length} onsets=${silence.speechOnsetsMs.length} durationMs=${silence.durationMs} firstVoice=${firstVoice} (${fmt(firstVoice ?? 0)})`,
  );

  const aligned = alignCancioneroLinesToTiming(
    lines,
    timing,
    silence.durationMs,
  );
  console.log("\n[verify] raw align first 12 (before breath/air):");
  for (let i = 0; i < Math.min(12, aligned.cues.length); i++) {
    const a = aligned.cues[i]!;
    const t = timing[i]!;
    console.log(
      `  ${String(i).padStart(2, "0")} A=${a.startMs}→${a.endMs} V=${t.startMs}→${t.endMs} dS=${a.startMs - t.startMs} dE=${a.endMs - t.endMs}`,
    );
  }
  const karaoke = blankCuesAtPhraseSilence(
    ensureCancioneroCueTexts(
      anchorFirstCueToVoiceOnset(aligned.cues, firstVoice),
      lines,
    ),
    silence.silences,
    silence.durationMs,
    SILENCE_AIR_ANTICIPATION_MS,
  );

  console.log(
    `[verify] aligned synced=${aligned.synced} count=${aligned.alignedCount}/${lines.length} karaokeCues=${karaoke.length}`,
  );

  // Compare karaoke voice clocks (start+air) to official VTT starts.
  const air = SILENCE_AIR_ANTICIPATION_MS;
  const deltas: number[] = [];
  let textMismatch = 0;
  let endBeforeVtt = 0;
  for (let i = 0; i < Math.min(karaoke.length, timing.length); i++) {
    const k = karaoke[i]!;
    const t = timing[i]!;
    const impliedVoice = k.startMs + air;
    const dStart = impliedVoice - t.startMs;
    deltas.push(dStart);
    if (k.text.trim() !== lines[i]!.trim()) textMismatch += 1;
    // Hold should reach the official last-word end (allow 200ms slack).
    if (k.endMs + 200 < t.endMs) endBeforeVtt += 1;
  }
  deltas.sort((a, b) => a - b);
  const abs = deltas.map((d) => Math.abs(d));
  abs.sort((a, b) => a - b);
  const median = abs[Math.floor(abs.length / 2)] ?? 0;
  const p90 = abs[Math.floor(abs.length * 0.9)] ?? 0;
  const within400 = abs.filter((d) => d <= 400).length;
  const within800 = abs.filter((d) => d <= 800).length;

  console.log("\n[verify] first 8 karaoke cues vs VTT:");
  for (let i = 0; i < Math.min(8, karaoke.length); i++) {
    const k = karaoke[i]!;
    const t = timing[i]!;
    console.log(
      `  ${String(i).padStart(2, "0")} k=${fmt(k.startMs)}→${fmt(k.endMs)} vtt=${fmt(t.startMs)}→${fmt(t.endMs)} Δvoice=${Math.round(k.startMs + air - t.startMs)}ms | ${k.text.slice(0, 48)}`,
    );
  }

  console.log("\n[verify] mid/gap check (around instrumental ~1:00):");
  for (const i of [15, 16, 17, 18]) {
    if (!karaoke[i] || !timing[i]) continue;
    const k = karaoke[i]!;
    const t = timing[i]!;
    console.log(
      `  ${String(i).padStart(2, "0")} k=${fmt(k.startMs)}→${fmt(k.endMs)} vtt=${fmt(t.startMs)}→${fmt(t.endMs)} | ${k.text.slice(0, 40)}`,
    );
  }

  console.log(
    `\n[verify] startΔ |median|=${median}ms p90=${p90}ms ≤400ms=${within400}/${abs.length} ≤800ms=${within800}/${abs.length}`,
  );
  console.log(
    `[verify] textMismatch=${textMismatch} endBeforeOfficialLastWord=${endBeforeVtt}`,
  );
  console.log(
    `[verify] first karaoke @ ${fmt(karaoke[0]?.startMs ?? 0)} (voice~${fmt((karaoke[0]?.startMs ?? 0) + air)}) vtt0=${fmt(timing[0]?.startMs ?? 0)}`,
  );

  const ok =
    aligned.synced &&
    textMismatch === 0 &&
    karaoke.length === lines.length &&
    within400 >= Math.floor(abs.length * 0.7) &&
    Math.abs((karaoke[0]?.startMs ?? 0) + air - (timing[0]?.startMs ?? 0)) <= 500;

  if (!ok) {
    console.error("[verify] FAIL — karaoke does not track Vida de Rico well enough");
    process.exit(1);
  }
  console.log("[verify] OK — Vida de Rico captions ↔ cancionero timing looks aligned");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
