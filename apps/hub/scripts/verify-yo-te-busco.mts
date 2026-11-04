/**
 * Verify karaoke for Marcos Witt — Yo te busco (yt:_RRoI9yrL78).
 * No YouTube captions — needs WhisperX or silence fallback.
 */
import {
  alignCancioneroLinesToSilence,
  blankCuesAtPhraseSilence,
  ensureCancioneroCueTexts,
  anchorFirstCueToVoiceOnset,
  resolveFirstVoiceOnsetMs,
  songCancioneroLines,
} from "../src/subtitle-cancionero.js";
import { detectSpeechOnsetsFromSilence, SILENCE_AIR_ANTICIPATION_MS } from "../src/subtitle-silence.js";
import { alignLyricsWithWhisperx, whisperxAvailable } from "../src/subtitle-whisperx.js";
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

  const canWx = await whisperxAvailable();
  console.log(`[verify] whisperx available=${canWx}`);

  let karaoke;
  let mode = "";
  if (canWx) {
    const wx = await alignLyricsWithWhisperx({
      mediaPath: WAV,
      assetId: `yt_${VIDEO_ID}`,
      lines,
      language: "es",
      durationMs: silence.durationMs,
      airMs: SILENCE_AIR_ANTICIPATION_MS,
    });
    if (wx?.cues?.length) {
      karaoke = blankCuesAtPhraseSilence(
        ensureCancioneroCueTexts(
          anchorFirstCueToVoiceOnset(wx.cues, firstVoice ?? wx.cues[0]?.startMs),
          lines,
        ),
        silence.silences,
        silence.durationMs,
        SILENCE_AIR_ANTICIPATION_MS,
      );
      mode = "whisperx";
    }
  }

  if (!karaoke) {
    const aligned = alignCancioneroLinesToSilence(
      lines,
      silence.speechOnsetsMs,
      silence.durationMs,
      SILENCE_AIR_ANTICIPATION_MS,
      silence.silences,
    );
    karaoke = blankCuesAtPhraseSilence(
      ensureCancioneroCueTexts(
        anchorFirstCueToVoiceOnset(aligned.cues, firstVoice),
        lines,
      ),
      silence.silences,
      silence.durationMs,
      SILENCE_AIR_ANTICIPATION_MS,
    );
    mode = "silence_fallback";
  }

  console.log(`\n[verify] mode=${mode} cues=${karaoke.length}`);
  for (let i = 0; i < karaoke.length; i++) {
    const k = karaoke[i]!;
    console.log(
      `  ${String(i).padStart(2, "0")} ${fmt(k.startMs)}→${fmt(k.endMs)} | ${k.text}`,
    );
  }

  const ok =
    karaoke.length === lines.length &&
    karaoke[0]!.startMs < 30_000 &&
    karaoke.every((c) => c.endMs > c.startMs);
  if (!ok) {
    console.error("[verify] FAIL");
    process.exit(1);
  }
  console.log(
    `[verify] OK — first cue @ ${fmt(karaoke[0]!.startMs)} (anticipate voice). No YT captions on this video; mode=${mode}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
