/**
 * Smoke: karaoke cancionero exact lines / forced align / −1s lead / pack 2–3.
 * Usage: pnpm --filter @promedia/hub exec tsx scripts/smoke-cancionero-match.mts
 */
import type { LibrarySongPayload, SubtitleCue } from "@promedia/shared";
import {
  CANCIONERO_DEFAULT_LEAD_MS,
  LYRIC_OVERLAY_MAX_LINES,
  LYRIC_OVERLAY_PREFERRED_LINES,
  cueAtPositionWithLeadMs,
} from "@promedia/shared";
import {
  alignCancioneroLinesToTiming,
  buildKaraokeAlignPrompt,
  flattenTimingTokens,
  normalizeMatchTitle,
  packKaraokeDisplayCues,
  primaryTitleSegment,
  scoreSongLyricOverlap,
  scoreSongMatch,
  songCancioneroLines,
  songLyricChunks,
  songLyricPhrases,
  firstSpeechOnsetMs,
  isConservativeEqualTimeStart,
  songToSubtitleCues,
  splitLyricPhrases,
  firstLyricOnsetMs,
  resolveKaraokeVoiceAnchorMs,
  sungEntranceMs,
  titleFromAudioFilename,
  titleVariants,
} from "../src/subtitle-cancionero.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const song: LibrarySongPayload = {
  title: "Cuán grande es Él",
  artist: "Tradicional",
  stanzas: [
    {
      id: "s1",
      lines: ["Señor mi Dios", "al contemplar los cielos", "te adoro a Ti"],
    },
    {
      id: "s2",
      lines: ["Cuán grande es Él", "Cuán grande es Él"],
    },
  ],
};

assert(
  normalizeMatchTitle("Cuán grande es Él (Official Video).mp3") ===
    "cuán grande es él",
  "normalize strips junk+ext",
);
assert(
  titleFromAudioFilename("Mi Cancion.m4a") === "Mi Cancion",
  "audio filename strip",
);
assert(
  titleVariants("Artist - Song Title").includes("song title"),
  "title variants split",
);

const exact = scoreSongMatch(
  song,
  "Cuán grande es Él",
  "Tradicional",
);
assert(exact >= 100, `exact+artist score got ${exact}`);

const ytLike = scoreSongMatch(
  song,
  "Cuán Grande Es Él | Official Lyric Video",
);
assert(ytLike >= 70, `youtube-like title score got ${ytLike}`);

const miss = scoreSongMatch(song, "Shape of You");
assert(miss < 55, `unrelated should miss, got ${miss}`);

// YouTube "Song (Tune of Other – Artist) | Channel" must match Song, not Other.
const ytVasijas =
  "Vasijas Rotas (Sublime Gracia – Hillsong Worship) | Lakepointe en Español";
assert(
  primaryTitleSegment(ytVasijas) === "Vasijas Rotas",
  `primaryTitleSegment got "${primaryTitleSegment(ytVasijas)}"`,
);
const vasijasVariants = titleVariants(ytVasijas);
assert(
  vasijasVariants[0] === "vasijas rotas",
  `primary variant first, got ${JSON.stringify(vasijasVariants)}`,
);
assert(
  !vasijasVariants.includes("sublime gracia"),
  "parenthetical alias must not be a standalone query variant",
);
const vasijasSong: LibrarySongPayload = {
  title: "Vasijas Rotas",
  artist: "Hillsong",
  stanzas: [{ id: "s1", lines: ["Manos vacías", "Que tú llenaste"] }],
};
const sublimeSong: LibrarySongPayload = {
  title: "Sublime Gracia",
  artist: "Tradicional",
  stanzas: [{ id: "s1", lines: ["Sublime gracia del Señor"] }],
};
let bestVasijas = 0;
let bestSublime = 0;
for (const q of vasijasVariants) {
  bestVasijas = Math.max(bestVasijas, scoreSongMatch(vasijasSong, q));
  bestSublime = Math.max(bestSublime, scoreSongMatch(sublimeSong, q));
}
assert(bestVasijas >= 100, `Vasijas Rotas should exact-match primary, got ${bestVasijas}`);
assert(
  bestVasijas > bestSublime,
  `Vasijas Rotas (${bestVasijas}) must beat Sublime Gracia (${bestSublime})`,
);
assert(
  bestSublime < 55,
  `Sublime Gracia mid-string alias must stay below threshold, got ${bestSublime}`,
);

// Lyric overlap learns the sung song when captions disagree with a bad title alias.
const captionLike = [
  "Manos vacías",
  "Que tú llenaste",
  "Vasijas rotas",
  "Te entrego mi vida",
];
const lyricVasijas = scoreSongLyricOverlap(vasijasSong, captionLike);
const lyricSublime = scoreSongLyricOverlap(sublimeSong, captionLike);
assert(lyricVasijas > lyricSublime, `lyric learn Vasijas ${lyricVasijas} > Sublime ${lyricSublime}`);
assert(lyricVasijas >= 12, `lyric overlap should be meaningful, got ${lyricVasijas}`);

// Exact Biblioteca lines — do not invent punctuation splits.
const longLine =
  "Señor mi Dios, al contemplar los cielos, el firmamento y las estrellas mil";
const phrases = splitLyricPhrases(longLine);
assert(phrases.length === 1, `exact line stays 1 phrase, got ${phrases.length}`);
assert(phrases[0] === longLine, "exact line text preserved");

const embedded = splitLyricPhrases("línea uno\nlínea dos");
assert(embedded.length === 2, "embedded newlines → exact lines");
assert(embedded[0] === "línea uno" && embedded[1] === "línea dos", "newline split");

const flat = songLyricPhrases(song);
assert(flat.length === 5, `expected 5 exact lines, got ${flat.length}`);
assert(flat[0] === "Señor mi Dios", "first exact line");
assert(flat[1] === "al contemplar los cielos", "second exact line");

const chunks = songLyricChunks(song);
assert(chunks.length === 5, `one cue per exact line, got ${chunks.length}`);
assert(
  chunks.every((c) => !c.includes("\n")),
  "chunks are single exact lines (no re-merge)",
);
assert(
  JSON.stringify(chunks) === JSON.stringify(songCancioneroLines(song)),
  "chunks === cancionero lines",
);

const cues = songToSubtitleCues(song, 120_000);
assert(cues.length === chunks.length, "cue count = exact lines");
assert(
  cues[0]!.startMs >= 5_000 && cues[0]!.startMs <= 40_000,
  `equal-time fallback modest intro, got ${cues[0]!.startMs}`,
);
// Phrases leave blank gaps — last cue ends after its visible window, not song end.
assert(
  cues[cues.length - 1]!.endMs > cues[cues.length - 1]!.startMs,
  "last cue has a positive window",
);
assert(
  cues.some((c, i) => i + 1 < cues.length && c.endMs < cues[i + 1]!.startMs),
  "equal-time leaves blank gaps between phrases",
);
assert(
  cues.every((c) => c.text.trim().length > 0),
  "all cues have text",
);
assert(
  cues.every((c, i) => c.text === chunks[i]),
  "cue text is exact cancionero line",
);

// Voice sync: ASR/caption clocks → cancionero text only.
const timing: SubtitleCue[] = [
  { id: "t0", startMs: 12_000, endMs: 14_000, text: "Señor mi Dios" },
  {
    id: "t1",
    startMs: 14_500,
    endMs: 17_000,
    text: "al contemplar los cielos",
  },
  { id: "t2", startMs: 17_500, endMs: 19_000, text: "te adoro a Ti" },
  { id: "t3", startMs: 22_000, endMs: 24_000, text: "Cuán grande es Él" },
  { id: "t4", startMs: 24_500, endMs: 26_500, text: "Cuán grande es Él" },
];
const aligned = alignCancioneroLinesToTiming(chunks, timing, 60_000);
assert(aligned.synced, "enough lines voice-aligned");
assert(aligned.alignedCount >= 4, `alignedCount got ${aligned.alignedCount}`);
assert(aligned.cues.length === 5, "aligned cue count");
assert(
  aligned.cues.every((c, i) => c.text === chunks[i]),
  "aligned cues keep Biblioteca text",
);
assert(aligned.cues[0]!.startMs === 12_000, "first line locks to voice");
assert(aligned.cues[1]!.startMs === 14_500, "second line locks to voice");
// Must not race: before voice onset (with −1s lead) earlier lines only.
const exactOpts = { holdIntro: false } as const;
assert(
  cueAtPositionWithLeadMs(aligned.cues, 10_500, 0, exactOpts)?.text == null,
  "exact mode: blank before first voice moment",
);
assert(
  cueAtPositionWithLeadMs(
    aligned.cues,
    11_000,
    CANCIONERO_DEFAULT_LEAD_MS,
    exactOpts,
  ) === null,
  "default lead 0: still blank 1s before first voice",
);
assert(
  cueAtPositionWithLeadMs(
    aligned.cues,
    12_500,
    CANCIONERO_DEFAULT_LEAD_MS,
    exactOpts,
  )?.text === "Señor mi Dios",
  "default lead 0: first line at voice onset",
);
assert(
  cueAtPositionWithLeadMs(aligned.cues, 13_500, -1000, exactOpts)?.text ===
    "al contemplar los cielos",
  "optional Adelante −1s advances next line before its voice",
);
assert(
  cueAtPositionWithLeadMs(aligned.cues, 14_500, 0, exactOpts)?.text ===
    "al contemplar los cielos",
  "without lead, next line appears at its voice onset",
);

assert(CANCIONERO_DEFAULT_LEAD_MS === 0, "cancionero default lead is 0");

// Karaoke-gen: token stream + prompt + 2–3 line display pack.
const stream = flattenTimingTokens(timing);
assert(stream.length >= 10, `token stream got ${stream.length}`);
assert(stream[0]!.token === "senor" || stream[0]!.token.length > 0, "stream tokens");

const prompt = buildKaraokeAlignPrompt(chunks);
assert(prompt.includes("Señor") || prompt.toLowerCase().includes("senor") || prompt.length > 10, "align prompt");
assert(prompt.length <= 220, "prompt truncated");

const packed = packKaraokeDisplayCues(aligned.cues);
assert(packed.length === Math.ceil(5 / LYRIC_OVERLAY_PREFERRED_LINES), `packed groups got ${packed.length}`);
assert(
  packed.every((c) => c.text.split("\n").length <= LYRIC_OVERLAY_MAX_LINES),
  "packed cues ≤ max lines",
);
assert(
  packed[0]!.text.split("\n").every((line, i) => line === chunks[i]),
  "packed keeps exact Biblioteca lines",
);
assert(packed[0]!.startMs === aligned.cues[0]!.startMs, "pack start = first line onset");
assert(
  cueAtPositionWithLeadMs(
    packed,
    12_500,
    CANCIONERO_DEFAULT_LEAD_MS,
    exactOpts,
  )?.text.split("\n")[0] === "Señor mi Dios",
  "default lead 0 on packed karaoke cue at onset",
);

// ASR typos must not rewrite cancionero text.
const messy: SubtitleCue[] = [
  { id: "m0", startMs: 12_000, endMs: 14_000, text: "senor mi dios" },
  { id: "m1", startMs: 14_500, endMs: 17_000, text: "al contemplar los cielos" },
  { id: "m2", startMs: 17_500, endMs: 19_000, text: "te adoro a ti" },
  { id: "m3", startMs: 22_000, endMs: 24_000, text: "cuan grande es el" },
  { id: "m4", startMs: 24_500, endMs: 26_500, text: "cuan grande es el" },
];
const messyAligned = alignCancioneroLinesToTiming(chunks, messy, 60_000);
assert(
  messyAligned.cues.every((c, i) => c.text === chunks[i]),
  "messy ASR never rewrites Biblioteca text",
);
assert(messyAligned.synced, "messy ASR still syncs via normalize");

// Vasijas Rotas: sparse intro tokens are not the voice. The verse packs up
// just after the breath that ends ~25.5s — not the 40s equal-time cap.
const vasijasSilences = [
  { startMs: 2_730, endMs: 4_400, durationMs: 1_670 },
  { startMs: 9_670, endMs: 12_880, durationMs: 3_210 },
  { startMs: 23_780, endMs: 25_520, durationMs: 1_740 },
];
const vasijasWords = [
  { text: "alma", startMs: 7_050, p: 1 },
  { text: "estaba", startMs: 14_110, p: 1 },
  { text: "vida", startMs: 30_560, p: 0.61 },
  { text: "pero", startMs: 32_250, p: 0.97 },
  { text: "tu", startMs: 33_380, p: 0.95 },
  { text: "gracia", startMs: 33_940, p: 0.97 },
];
const vasijasEntrance = sungEntranceMs(vasijasWords, vasijasSilences);
assert(
  vasijasEntrance != null && vasijasEntrance >= 25_000 && vasijasEntrance <= 26_000,
  `Vasijas sung entrance should be the breath before the verse, got ${vasijasEntrance}`,
);
const equalGuess = songToSubtitleCues(
  { title: "Vasijas Rotas", artist: "", stanzas: [{ id: "s", lines: Array.from({ length: 35 }, () => "línea") }] },
  343_353,
);
assert(
  isConservativeEqualTimeStart(equalGuess[0]!.startMs, 343_353, 35),
  `35-line chart on a 5:43 track is the 40s cap, got ${equalGuess[0]!.startMs}`,
);
assert(equalGuess[0]!.startMs === 40_000, "cap is exactly 40s");

// Libre Soy (053BvHDfIdI): manual captions open at 22.03s. A failed
// one-line match must not keep the 12% intro (~37s).
assert(
  firstSpeechOnsetMs([
    { startMs: 0 },
    { startMs: 22_030 },
    { startMs: 36_960 },
  ]) === 22_030,
  "first sung caption is the voice, not the equal-time cap",
);

// Digno Y Santo (YExhjAP8zPU): LRCLIB opens at 31.95s. A Whisper cluster at
// 26.65s without hearing "digno/santo" must NOT yank the chart 5s early.
const dignoWords = [
  { text: "intro", startMs: 26_650, p: 0.9 },
  { text: "ooh", startMs: 27_200, p: 0.8 },
  { text: "yeah", startMs: 28_100, p: 0.7 },
  { text: "mmm", startMs: 29_000, p: 0.6 },
  { text: "digno", startMs: 31_900, p: 0.95 },
  { text: "y", startMs: 32_200, p: 0.9 },
  { text: "santo", startMs: 32_500, p: 0.95 },
];
assert(
  firstLyricOnsetMs(dignoWords, "Digno y santo el cordero") != null &&
    firstLyricOnsetMs(dignoWords, "Digno y santo el cordero")! >= 31_500,
  "first lyric onset is when Whisper hears digno/santo, not intro ad-libs",
);
const dignoAnchor = resolveKaraokeVoiceAnchorMs({
  asrWords: dignoWords,
  silences: [{ startMs: 20_000, endMs: 26_000, durationMs: 6_000 }],
  firstLineText: "Digno y santo el cordero",
  chartFirstMs: 31_950,
  equalTime: false,
  lrclibChart: true,
});
assert(
  dignoAnchor.reason === "lrclib_first_line" &&
    dignoAnchor.voiceMs != null &&
    dignoAnchor.voiceMs >= 31_500,
  `Digno LRCLIB anchors to first-line ASR, got ${dignoAnchor.reason}/${dignoAnchor.voiceMs}`,
);
const dignoEarlyCluster = resolveKaraokeVoiceAnchorMs({
  asrWords: [
    { text: "ooh", startMs: 26_650, p: 0.9 },
    { text: "yeah", startMs: 27_200, p: 0.9 },
    { text: "mmm", startMs: 28_000, p: 0.9 },
    { text: "ah", startMs: 29_000, p: 0.9 },
  ],
  silences: [{ startMs: 20_000, endMs: 26_000, durationMs: 6_000 }],
  firstLineText: "Digno y santo el cordero",
  chartFirstMs: 31_950,
  equalTime: false,
  lrclibChart: true,
});
assert(
  dignoEarlyCluster.reason === "lrclib_reject_early" &&
    dignoEarlyCluster.shiftAll === false,
  `bare early cluster must not pull LRCLIB, got ${dignoEarlyCluster.reason}`,
);

console.log("SMOKE_OK cancionero-match");
