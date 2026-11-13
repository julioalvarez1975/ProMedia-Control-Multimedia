/**
 * Verify karaoke timing helpers for Marcos Witt — Yo te busco (yt:_RRoI9yrL78).
 * Uses silence onsets + cancionero text (WhisperX removed).
 */
import {
  alignCancioneroLinesToSilence,
  blankCuesAtPhraseSilence,
  ensureCancioneroCueTexts,
  anchorFirstCueToVoiceOnset,
  resolveFirstVoiceOnsetMs,
  songCancioneroLines,
} from "../src/subtitle-cancionero.js";
import {
  detectSpeechOnsetsFromSilence,
  SILENCE_AIR_ANTICIPATION_MS,
} from "../src/subtitle-silence.js";
import { libraryStore } from "../src/library-store.js";
import {
  rememberCancioneroMatch,
  cancioneroMediaKey,
} from "../src/cancionero-memory.js";

const VIDEO_ID = "_RRoI9yrL78";
const SONG_ID = "8a7065087eac1c0877a1";
const WAV = new URL(
  "../../../data/subtitles/youtube-cache/_RRoI9yrL78.wav",
  import.meta.url,
).pathname;

function fmt(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, "0")}`;
}

async function main(): Promise<void> {
  const item = await libraryStore.get(SONG_ID);
  if (!item?.song) throw new Error(`song ${SONG_ID} missing`);
  const lines = songCancioneroLines(item.song);
  console.log(
    `[verify] ${item.song.title} / ${VIDEO_ID} lines=${lines.length} airMs=${SILENCE_AIR_ANTICIPATION_MS}`,
  );
  for (const [i, l] of lines.entries()) console.log(`  ${String(i).padStart(2, "0")}|${l}`);

  const mediaKey = cancioneroMediaKey({ youtubeVideoId: VIDEO_ID });
  await rememberCancioneroMatch({
    mediaKey,
    titles: ["Marcos Witt - Yo te busco", "Yo te busco", "Yo te Busco"],
    songId: SONG_ID,
    songTitle: item.song.title,
    source: "manual",
  });
  console.log(`[verify] memory seeded key=${mediaKey}`);

  const silence = await detectSpeechOnsetsFromSilence(WAV);
  const firstVoice = resolveFirstVoiceOnsetMs(
    silence.silences,
    silence.speechOnsetsMs,
    null,
  );
  console.log(
    `[verify] silence silences=${silence.silences.length} onsets=${silence.speechOnsetsMs.length} dur=${silence.durationMs} voice0=${firstVoice} (${fmt(firstVoice ?? 0)})`,
  );

  const aligned = alignCancioneroLinesToSilence(
    lines,
    silence.speechOnsetsMs,
    silence.durationMs,
    SILENCE_AIR_ANTICIPATION_MS,
    silence.silences,
  );
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
    `[verify] mode=silence cues=${karaoke.length} first=${fmt(karaoke[0]?.startMs ?? 0)} last=${fmt(karaoke.at(-1)?.startMs ?? 0)}`,
  );
  for (const [i, c] of karaoke.slice(0, 8).entries()) {
    console.log(`  ${String(i).padStart(2, "0")} ${fmt(c.startMs)}–${fmt(c.endMs)} ${c.text}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
