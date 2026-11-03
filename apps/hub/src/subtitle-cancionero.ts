/**
 * Karaoke path for Guion Audio + YouTube:
 * Biblioteca / cancionero is the ONLY text source.
 * Preferred clocks: analyze audio (Whisper/captions + silence) → each
 * cancionero line 500 ms before that phrase is sung — never rewrite words.
 */
import { spawn } from "node:child_process";
import type {
  LibraryItem,
  LibrarySongPayload,
  SubtitleCue,
} from "@promedia/shared";
import {
  LYRIC_OVERLAY_MAX_LINES,
  LYRIC_OVERLAY_PREFERRED_LINES,
} from "@promedia/shared";
import {
  ensureAugmentedPath,
  resolveFfmpegBin,
} from "./subtitle-bins.js";
import { cleanCueText, filterSpeechCues } from "./subtitle-cue-text.js";
import {
  cueStartWithAirMs,
  PHRASE_SILENCE_MS,
  SILENCE_AIR_ANTICIPATION_MS,
  type SilenceRegion,
} from "./subtitle-silence.js";

const AUDIO_EXT_RE =
  /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|aiff|aif|caf|webm)$/i;

/** Junk tokens often appended to YouTube titles / audio filenames. */
const TITLE_JUNK_RE =
  /\b(official\s*(music\s*)?video|official\s*audio|lyrics?\s*(video)?|lyric\s*video|audio\s*oficial|vídeo\s*oficial|video\s*oficial|letra|hd|4k|remaster(ed)?|live|cover|karaoke|instrumental|mv|visualizer|with\s*lyrics)\b/gi;

const FEAT_RE = /\s*[(\[]?\s*(feat\.?|ft\.?|with)\s+[^)\]]+[)\]]?/gi;

export type CancioneroMatchQuery = {
  /** Raw titles to try (filename, payload.title, yt fulltitle, …). */
  titles: string[];
  /** Optional artist / track hints from metadata. */
  artists?: string[];
};

export type CancioneroMatchHit = {
  ok: true;
  item: LibraryItem;
  song: LibrarySongPayload;
  score: number;
  matchedQuery: string;
};

export type CancioneroMatchMiss = {
  ok: false;
  reason: "no_songs" | "no_query" | "no_match";
  tried: string[];
};

export type CancioneroMatchResult = CancioneroMatchHit | CancioneroMatchMiss;

/**
 * Head of a YouTube / media title: text before `(…)` / `[…]` / `| channel`.
 * Keeps "Vasijas Rotas" and drops "(Sublime Gracia – Hillsong) | Canal".
 */
export function primaryTitleSegment(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(AUDIO_EXT_RE, "");
  // Channel / site suffix: "Song | Artist channel"
  const pipe = s.search(/\s*[|｜]\s*/);
  if (pipe >= 0) s = s.slice(0, pipe).trim();
  // Parenthetical "tune of" / featuring / version — not the song name.
  const br = s.search(/[(\[{]/);
  if (br >= 0) s = s.slice(0, br).trim();
  return s.trim();
}

/**
 * Fold a media title / filename into a matchable song title.
 * Strips extension, feat/junk parentheticals, punctuation; lowercases.
 */
export function normalizeMatchTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";
  // Basename only if a path slipped in.
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(AUDIO_EXT_RE, "");
  // Drop YouTube trailing " - Topic" / " | Artist" noise carefully later.
  s = s.replace(FEAT_RE, " ");
  s = s.replace(TITLE_JUNK_RE, " ");
  // Drop bracketed leftover tags: (Official), [HD], …
  s = s.replace(/[(\[{][^)\]}]*[)\]}]/g, " ");
  // Separators → space
  s = s.replace(/[_|/·•]+/g, " ");
  // Strip punctuation except letters/digits/spaces (keep accented letters).
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, " ");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}

/**
 * Split "Title - Artist" / "Artist - Title" style strings into candidates.
 * Prefer the primary segment (before parentheses / `|`) so parenthetical
 * "also known as" titles do not compete as equal queries.
 */
export function titleVariants(raw: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    const n = normalizeMatchTitle(v);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  if (!raw?.trim()) return out;
  const primary = primaryTitleSegment(raw);
  // Primary first — findCancioneroSong keeps the best score; exact primary
  // titles (e.g. "vasijas rotas") must beat mid-string aliases.
  if (primary) push(primary);
  push(raw);
  // Dash-split only the primary head (never inside "(Sublime Gracia – …)").
  const splitSource = primary || String(raw);
  const parts = splitSource
    .split(/\s+[-–—]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 2) {
    push(parts[0]!);
    push(parts[1]!);
  } else if (parts.length > 2) {
    push(parts[0]!);
    push(parts.slice(1).join(" - "));
  }
  return out;
}

function tokenSet(s: string): Set<string> {
  return new Set(
    s
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Score how well a library song matches a query title (+ optional artist).
 * Higher is better; 0 = no usable match.
 */
export function scoreSongMatch(
  song: LibrarySongPayload,
  queryTitle: string,
  queryArtist?: string,
): number {
  const q = normalizeMatchTitle(queryTitle);
  if (!q || q.length < 2) return 0;
  const songTitle = normalizeMatchTitle(song.title);
  if (!songTitle) return 0;
  const songArtist = normalizeMatchTitle(song.artist ?? "");
  const qArtist = normalizeMatchTitle(queryArtist ?? "");

  let score = 0;

  if (songTitle === q) {
    score = 100;
  } else if (
    // "DIGNO – Marcos Brunet…" → q starts with exact short cancionero title.
    (q.startsWith(`${songTitle} `) || q.endsWith(` ${songTitle}`)) &&
    songTitle.length >= 4
  ) {
    score = 96;
  } else if (songTitle.includes(q) || q.includes(songTitle)) {
    const shorter = Math.min(songTitle.length, q.length);
    const longer = Math.max(songTitle.length, q.length);
    // Prefer near-equal contains (avoid "a" matching everything).
    // Also allow short exact titles inside long YouTube strings when they are
    // a whole-token prefix (handled above) or ratio is decent.
    if (shorter >= 4 && (shorter / longer >= 0.45 || q.startsWith(songTitle))) {
      score = 70 + Math.round(20 * Math.min(1, shorter / Math.max(longer * 0.45, 1)));
      // Prefix = real title. Mid-string = parenthetical "tune of X" noise.
      // e.g. q="vasijas rotas sublime gracia": vasijas rotas wins, sublime gracia loses.
      if (q.startsWith(songTitle) || songTitle.startsWith(q)) {
        score += 18;
      } else if (q.includes(songTitle) && !songTitle.includes(q)) {
        score -= 30;
      }
    }
  } else {
    const jac = jaccard(tokenSet(songTitle), tokenSet(q));
    if (jac >= 0.55) {
      score = Math.round(40 + jac * 40);
    } else if (jac >= 0.4 && Math.min(tokenSet(songTitle).size, tokenSet(q).size) >= 2) {
      score = Math.round(25 + jac * 30);
    }
  }

  if (score <= 0) return 0;

  // "Dios ha sido fiel" must not beat "Dios ha sido bueno" (shared prefix,
  // different last word) — that put the wrong cancionero on YouTube karaoke.
  const qTokens = [...tokenSet(q)];
  const sTokens = [...tokenSet(songTitle)];
  if (qTokens.length >= 3 && sTokens.length >= 3) {
    const qLast = qTokens[qTokens.length - 1]!;
    const sLast = sTokens[sTokens.length - 1]!;
    if (qLast !== sLast) {
      const shared = jaccard(tokenSet(songTitle), tokenSet(q));
      if (shared >= 0.45 && shared < 0.92) {
        score = Math.min(score, 48);
      }
    }
  }

  // Artist bonus / slight penalty.
  if (qArtist && songArtist) {
    if (songArtist === qArtist || songArtist.includes(qArtist) || qArtist.includes(songArtist)) {
      score += 15;
    } else if (jaccard(tokenSet(songArtist), tokenSet(qArtist)) >= 0.5) {
      score += 8;
    }
  }

  return score;
}

export type CancioneroCandidateList = {
  tried: string[];
  reason?: "no_songs" | "no_query";
  candidates: CancioneroMatchHit[];
};

/**
 * Rank Biblioteca songs for media titles (best first).
 * `minScore` default 40 casts a wider net for lyric verification.
 */
export async function findCancioneroSongCandidates(
  query: CancioneroMatchQuery,
  options?: { minScore?: number; limit?: number },
): Promise<CancioneroCandidateList> {
  const minScore = options?.minScore ?? 40;
  const limit = Math.max(1, options?.limit ?? 5);
  const tried: string[] = [];
  const titleSet = new Set<string>();
  for (const raw of query.titles) {
    for (const v of titleVariants(raw)) {
      titleSet.add(v);
      tried.push(v);
    }
  }
  const titles = [...titleSet];
  if (titles.length === 0) {
    return { tried, reason: "no_query", candidates: [] };
  }

  const { libraryStore } = await import("./library-store.js");
  const songs = await libraryStore.list({ category: "canciones" });
  const withSong = songs.filter((i) => i.song && i.song.title.trim());
  if (withSong.length === 0) {
    return { tried, reason: "no_songs", candidates: [] };
  }

  const artists = (query.artists ?? [])
    .map((a) => normalizeMatchTitle(a))
    .filter(Boolean);

  const byId = new Map<string, CancioneroMatchHit>();
  for (const item of withSong) {
    const song = item.song!;
    for (const q of titles) {
      const attempts: (string | undefined)[] =
        artists.length > 0 ? [...artists, undefined] : [undefined];
      for (const artist of attempts) {
        const score = scoreSongMatch(song, q, artist);
        if (score < minScore) continue;
        const prev = byId.get(item.id);
        if (!prev || score > prev.score) {
          byId.set(item.id, {
            ok: true,
            item,
            song,
            score,
            matchedQuery: q,
          });
        }
      }
    }
  }

  const candidates = [...byId.values()].sort((a, b) => b.score - a.score);
  return { tried, candidates: candidates.slice(0, limit) };
}

/**
 * How well cancionero lines overlap timing/caption words (0–100).
 * Used to learn the right song when YouTube titles mention another hymn.
 */
export function scoreSongLyricOverlap(
  song: LibrarySongPayload,
  timingTexts: readonly string[],
): number {
  const songBlob = songCancioneroLines(song).join(" ");
  const timingBlob = timingTexts.join(" ");
  const songTok = new Set(
    normalizeAlignText(songBlob)
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
  const timingTok = new Set(
    normalizeAlignText(timingBlob)
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
  if (songTok.size < 4 || timingTok.size < 4) return 0;
  return Math.round(jaccard(songTok, timingTok) * 100);
}

/**
 * Find the best Biblioteca canción for the given media titles.
 * Threshold: score ≥ 55 to accept (exact / strong contains / solid token overlap).
 */
export async function findCancioneroSong(
  query: CancioneroMatchQuery,
): Promise<CancioneroMatchResult> {
  const { tried, reason, candidates } = await findCancioneroSongCandidates(
    query,
    { minScore: 55, limit: 1 },
  );
  if (reason === "no_query") {
    return { ok: false, reason: "no_query", tried };
  }
  if (reason === "no_songs") {
    return { ok: false, reason: "no_songs", tried };
  }
  const best = candidates[0];
  if (!best || best.score < 55) {
    return { ok: false, reason: "no_match", tried };
  }
  return best;
}

/** Resolve a remembered library song id, if it still exists. */
export async function resolveCancioneroSongById(
  songId: string,
): Promise<CancioneroMatchHit | null> {
  const id = songId.trim();
  if (!id) return null;
  const { libraryStore } = await import("./library-store.js");
  const songs = await libraryStore.list({ category: "canciones" });
  const item = songs.find((s) => s.id === id && s.song?.title.trim());
  if (!item?.song) return null;
  return {
    ok: true,
    item,
    song: item.song,
    score: 120,
    matchedQuery: `memory:${id}`,
  };
}

/**
 * Exact Biblioteca line breaks only — never re-merge or invent phrase splits.
 * Embedded newlines inside one stanza cell become separate lines; punctuation
 * does not create new cue boundaries.
 */
export function splitLyricPhrases(raw: string): string[] {
  return String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Ordered cancionero lines (stanza order). One Biblioteca line → one phrase.
 * Stanza boundaries are preserved as sequence order only (no cross-merge).
 */
export function songCancioneroLines(song: LibrarySongPayload): string[] {
  const out: string[] = [];
  const stanzas =
    song.stanzas.length > 0
      ? song.stanzas
      : [{ id: "empty", lines: [] as string[] }];
  for (const stanza of stanzas) {
    for (const line of stanza.lines ?? []) {
      out.push(...splitLyricPhrases(String(line)));
    }
  }
  return out;
}

/** @deprecated Prefer songCancioneroLines — same exact-line semantics. */
export function songLyricPhrases(song: LibrarySongPayload): string[] {
  return songCancioneroLines(song);
}

/**
 * One cue text per exact cancionero line (Biblioteca stanza/line breaks).
 * Does not pack/re-split lines into invented multi-line phrase chunks.
 */
export function songLyricChunks(song: LibrarySongPayload): string[] {
  return songCancioneroLines(song);
}

/** Fold text for lyric↔ASR alignment (accents stripped, lowercase). */
export function normalizeAlignText(raw: string): string {
  return cleanCueText(raw)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function alignTokens(raw: string): string[] {
  return normalizeAlignText(raw)
    .split(/\s+/)
    .filter((t) => t.length >= 1);
}

function tokenCoverage(needle: string[], hay: string[]): number {
  if (needle.length === 0 || hay.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of hay) counts.set(t, (counts.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of needle) {
    const n = counts.get(t) ?? 0;
    if (n > 0) {
      hit += 1;
      counts.set(t, n - 1);
    }
  }
  return hit / needle.length;
}

function lineTimingScore(lineTokens: string[], windowText: string): number {
  const hay = alignTokens(windowText);
  if (lineTokens.length === 0 || hay.length === 0) return 0;
  const coverage = tokenCoverage(lineTokens, hay);
  const jac =
    coverage === 0
      ? 0
      : tokenCoverage(hay, lineTokens); // reverse coverage dampens huge windows
  const contains =
    normalizeAlignText(windowText).includes(lineTokens.join(" ")) ||
    lineTokens.join(" ").includes(normalizeAlignText(windowText));
  return coverage * 0.7 + jac * 0.2 + (contains ? 0.15 : 0);
}

export type CancioneroAlignResult = {
  cues: SubtitleCue[];
  /** How many cancionero lines got a voice-matched start (not equal-time fill). */
  alignedCount: number;
  /** True when enough lines locked to voice timing to trust the sync. */
  synced: boolean;
};

type TimedToken = { token: string; startMs: number; endMs: number };

/**
 * Flatten ASR/caption cues into a monotonic word stream with interpolated
 * clocks (karaoke-gen / Lyricsync style). Cue text is timing glue only.
 */
export function flattenTimingTokens(
  timingCues: readonly SubtitleCue[],
): TimedToken[] {
  const out: TimedToken[] = [];
  for (const cue of timingCues) {
    const toks = alignTokens(cue.text);
    if (toks.length === 0) continue;
    const span = Math.max(1, cue.endMs - cue.startMs);
    for (let i = 0; i < toks.length; i++) {
      const t0 = cue.startMs + Math.round((i / toks.length) * span);
      const t1 =
        cue.startMs + Math.round(((i + 1) / toks.length) * span);
      out.push({
        token: toks[i]!,
        startMs: t0,
        endMs: Math.max(t0 + 1, t1),
      });
    }
  }
  return out;
}

/**
 * Whisper `-prompt` seed from official cancionero lines (timing ASR only).
 * Truncated so whisper-cli stays stable; never shown on Output.
 */
export function buildKaraokeAlignPrompt(
  lines: readonly string[],
  maxChars = 220,
): string {
  const joined = lines
    .map((l) => String(l).trim())
    .filter(Boolean)
    .join(" ");
  if (!joined) return "";
  if (joined.length <= maxChars) return joined;
  const cut = joined.slice(0, maxChars);
  const sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut).trim();
}

/**
 * Pack per-line karaoke cues for display: default 2 phrases → 2 large lines.
 * Does NOT extend into the next pack — instrumental / no-voice gaps stay blank.
 */
export function packKaraokeDisplayCues(
  lineCues: readonly SubtitleCue[],
  preferredLines = LYRIC_OVERLAY_PREFERRED_LINES,
  maxLines = LYRIC_OVERLAY_MAX_LINES,
): SubtitleCue[] {
  if (lineCues.length === 0) return [];
  // Prefer 2 lines; never pack more than maxLines.
  const size = Math.min(
    Math.max(1, Math.trunc(maxLines) || 1),
    Math.max(1, Math.trunc(preferredLines) || 1),
  );
  const out: SubtitleCue[] = [];
  for (let i = 0; i < lineCues.length; i += size) {
    const group = lineCues.slice(i, i + size);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    // Keep the line's own end — do not hold until the next phrase starts.
    const endMs = Math.max(first.startMs + 800, last.endMs);
    out.push({
      id: `karaoke_${out.length}`,
      startMs: first.startMs,
      endMs,
      text: group.map((c) => c.text).join("\n"),
    });
  }
  return out;
}

/**
 * Pick one speech onset per lyric line, preferring gaps after real empty
 * space (long silence). Avoids even-sampling every micro-dip in a music bed.
 */
export function pickPhraseOnsetsForLines(
  speechOnsetsMs: readonly number[],
  lineCount: number,
  durationMs: number,
  silences: readonly SilenceRegion[] = [],
): number[] {
  const n = Math.max(0, Math.trunc(lineCount));
  if (n <= 0) return [];

  const onsets = [...speechOnsetsMs]
    .map((t) => Math.max(0, Math.round(t)))
    .filter((t, i, arr) => i === 0 || t > arr[i - 1]!)
    .sort((a, b) => a - b);
  if (onsets.length === 0) return [];

  const silenceByEnd = new Map<number, number>();
  for (const s of silences) {
    const end = Math.max(0, Math.round(s.endMs));
    const dur = Math.max(0, Math.round(s.durationMs));
    const prev = silenceByEnd.get(end) ?? 0;
    if (dur > prev) silenceByEnd.set(end, dur);
  }

  const weightAt = (onset: number): number => {
    // Never boost t≈0 — worship intros are audible music, not the first phrase.
    if (onset <= 40) return 0;
    let best = 0;
    for (const [end, dur] of silenceByEnd) {
      if (Math.abs(end - onset) <= 90) {
        best = Math.max(best, dur);
      }
    }
    return best;
  };

  const total = Math.max(
    durationMs > 0 ? durationMs : 0,
    onsets[onsets.length - 1]! + 4_000,
    n * 2_500,
  );

  // Prefer phrase-level empty space; fall back to all onsets if too few.
  // Skip t≈0 entirely (credits / music bed are not lyric phrases).
  const phraseOnsets = onsets.filter(
    (t) => t > 40 && weightAt(t) >= PHRASE_SILENCE_MS,
  );
  const pool = phraseOnsets.length >= Math.min(n, 2) ? phraseOnsets : onsets;

  if (pool.length <= n) {
    const picked = [...pool];
    while (picked.length < n) {
      const prev = picked[picked.length - 1] ?? 0;
      const remain = n - picked.length;
      const slice = Math.max(
        1_500,
        Math.floor((total - prev) / Math.max(1, remain)),
      );
      picked.push(prev + slice);
    }
    return picked;
  }

  // One onset per lyric window: in each slice of the song, take the onset
  // after the emptiest silence (not a uniform subsample of every dip).
  const minGap = Math.max(1_100, Math.floor(total / (n * 1.85)));
  const picked: number[] = [];
  for (let i = 0; i < n; i++) {
    const windowStart =
      i === 0 ? 0 : Math.round((i * total) / n) - Math.floor(minGap * 0.35);
    const windowEnd =
      i === n - 1
        ? total + 1
        : Math.round(((i + 1) * total) / n) + Math.floor(minGap * 0.35);
    const center = Math.round(((i + 0.45) * total) / n);
    let best: number | null = null;
    let bestScore = -Infinity;
    for (const onset of pool) {
      if (onset < windowStart || onset > windowEnd) continue;
      const prev = picked[picked.length - 1];
      if (prev != null && onset - prev < minGap * 0.72) continue;
      const silenceW = weightAt(onset);
      const dist = Math.abs(onset - center);
      const score = silenceW * 3 - dist * 0.35;
      if (score > bestScore) {
        bestScore = score;
        best = onset;
      }
    }
    if (best == null) {
      // Fallback: nearest unused pool onset after previous pick.
      const prev = picked[picked.length - 1] ?? -minGap;
      let nearest: number | null = null;
      let nearestDist = Infinity;
      for (const onset of pool) {
        if (onset <= prev + minGap * 0.5) continue;
        if (picked.includes(onset)) continue;
        const d = Math.abs(onset - center);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = onset;
        }
      }
      best = nearest ?? pool[Math.min(pool.length - 1, i)]!;
    }
    picked.push(best);
  }

  return picked
    .map((t) => Math.max(0, Math.round(t)))
    .filter((t, i, arr) => i === 0 || t > arr[i - 1]!);
}

/**
 * Map exact cancionero / ASR lines onto speech onsets after real silence.
 * Each cue starts `airMs` (default 200 ms) before the voice resumes.
 * Cue `.text` stays Biblioteca (or ASR text). Call packKaraokeDisplayCues.
 */
export function alignCancioneroLinesToSilence(
  lines: readonly string[],
  speechOnsetsMs: readonly number[],
  durationMs = 0,
  airMs: number = SILENCE_AIR_ANTICIPATION_MS,
  silences: readonly SilenceRegion[] = [],
): CancioneroAlignResult {
  const exactLines = lines.map((l) => String(l).trim()).filter(Boolean);
  if (exactLines.length === 0) {
    return { cues: [], alignedCount: 0, synced: false };
  }

  const onsets = [...speechOnsetsMs]
    .map((t) => Math.max(0, Math.round(t)))
    .filter((t, i, arr) => i === 0 || t > arr[i - 1]!)
    .sort((a, b) => a - b);

  const total = Math.max(
    durationMs > 0 ? durationMs : 0,
    onsets.length > 0 ? onsets[onsets.length - 1]! + 4_000 : 0,
    exactLines.length * 2_500,
  );

  if (onsets.length === 0) {
    return {
      cues: cuesFromEqualTime(exactLines, total),
      alignedCount: 0,
      synced: false,
    };
  }

  const picked = pickPhraseOnsetsForLines(
    onsets,
    exactLines.length,
    total,
    silences,
  );

  // Enforce monotonic starts after air anticipation.
  const starts: number[] = picked.map((onset) =>
    cueStartWithAirMs(onset, airMs),
  );
  const cues = cuesFromVoiceStarts(exactLines, starts, total);

  const alignedCount = Math.min(exactLines.length, onsets.length, picked.length);
  const synced =
    alignedCount >= Math.max(2, Math.ceil(exactLines.length * 0.35));
  return { cues, alignedCount, synced };
}

/**
 * Build display cues from voice-onset clocks (already −airMs applied to starts).
 * Holds each line until just before the next phrase so karaoke does not go
 * blank mid-song between short gaps.
 */
function cuesFromVoiceStarts(
  lines: readonly string[],
  startsIn: readonly number[],
  durationMs: number,
): SubtitleCue[] {
  const MIN_LINE_GAP_MS = 850;
  const GAP_BLANK_MS = 200;
  const MIN_PHRASE_MS = 1_400;
  const MAX_PHRASE_MS = 8_000;
  const starts: number[] = [];
  for (let i = 0; i < startsIn.length; i++) {
    let start = Math.max(0, Math.round(startsIn[i]!));
    if (i > 0) start = Math.max(start, starts[i - 1]! + MIN_LINE_GAP_MS);
    starts.push(start);
  }
  const total = Math.max(
    durationMs > 0 ? durationMs : 0,
    starts[starts.length - 1]! + 4_000,
    lines.length * 2_500,
  );
  return lines.map((text, index) => {
    const startMs = starts[index]!;
    const nextStart = index + 1 < lines.length ? starts[index + 1]! : total;
    let endMs =
      startMs +
      Math.min(
        MAX_PHRASE_MS,
        Math.max(MIN_PHRASE_MS, Math.floor((nextStart - startMs) * 0.88)),
      );
    if (nextStart - startMs > MIN_PHRASE_MS + GAP_BLANK_MS) {
      endMs = Math.min(endMs, nextStart - GAP_BLANK_MS);
    } else {
      endMs = Math.min(endMs, nextStart);
    }
    endMs = Math.max(startMs + 500, endMs);
    return { id: `cancionero_${index}`, startMs, endMs, text };
  });
}

/**
 * Snap ASR/caption voice clocks onto real silence onsets, then −airMs.
 * Silence onsets span the FULL track (backbone). ASR only nudges locally —
 * never pack every line into the first minute when captions die early.
 */
export function snapAlignedCuesToSilenceOnsets(
  alignedCues: readonly SubtitleCue[],
  speechOnsetsMs: readonly number[],
  durationMs = 0,
  airMs: number = SILENCE_AIR_ANTICIPATION_MS,
  silences: readonly SilenceRegion[] = [],
): CancioneroAlignResult {
  const exactLines = alignedCues
    .map((c) => String(c.text ?? "").trim())
    .filter(Boolean);
  if (exactLines.length === 0) {
    return { cues: [], alignedCount: 0, synced: false };
  }

  const asrStarts = alignedCues.map((c) => Math.max(0, Math.round(c.startMs)));
  const asrMin = asrStarts.length ? Math.min(...asrStarts) : 0;
  const asrMax = asrStarts.length ? Math.max(...asrStarts) : 0;
  const asrSpan = Math.max(0, asrMax - asrMin);

  if (speechOnsetsMs.length === 0) {
    // No silence map. If ASR/captions only cover the opening, redistribute
    // across the real duration so lyrics do not vanish after ~1 minute.
    const total = Math.max(
      durationMs > 0 ? durationMs : 0,
      asrMax + 4_000,
      exactLines.length * 2_500,
    );
    const asrTooShort =
      total >= 90_000 && asrSpan > 0 && asrSpan < Math.min(75_000, total * 0.45);
    if (asrTooShort) {
      const equal = cuesFromEqualTime(exactLines, total);
      return {
        cues: equal,
        alignedCount: 0,
        synced: false,
      };
    }
    const starts = asrStarts.map((onset) => cueStartWithAirMs(onset, airMs));
    const cues = cuesFromVoiceStarts(exactLines, starts, total);
    return {
      cues,
      alignedCount: cues.length,
      synced: cues.length >= 2,
    };
  }

  const onsets = [...speechOnsetsMs]
    .map((t) => Math.max(0, Math.round(t)))
    .filter((t) => t > 40)
    .filter((t, i, arr) => i === 0 || t > arr[i - 1]!)
    .sort((a, b) => a - b);

  if (onsets.length === 0) {
    return alignCancioneroLinesToSilence(
      exactLines,
      speechOnsetsMs,
      durationMs,
      airMs,
      silences,
    );
  }

  const total = Math.max(
    durationMs > 0 ? durationMs : 0,
    onsets[onsets.length - 1]! + 4_000,
    asrMax + 4_000,
    exactLines.length * 2_500,
  );

  // Backbone spans the whole song — prevents “lost after 1 minute” when ASR
  // captions only timed the opening verse.
  const backbone = pickPhraseOnsetsForLines(
    onsets,
    exactLines.length,
    total,
    silences,
  );

  const silenceByEnd = new Map<number, number>();
  for (const s of silences) {
    const end = Math.max(0, Math.round(s.endMs));
    const dur = Math.max(0, Math.round(s.durationMs));
    silenceByEnd.set(end, Math.max(silenceByEnd.get(end) ?? 0, dur));
  }
  const weightAt = (onset: number): number => {
    let best = 0;
    for (const [end, dur] of silenceByEnd) {
      if (Math.abs(end - onset) <= 90) best = Math.max(best, dur);
    }
    return best;
  };

  const firstPhrase =
    onsets.find((t) => weightAt(t) >= PHRASE_SILENCE_MS) ??
    backbone[0] ??
    onsets[0]!;

  // Trust ASR nudge only when its span covers a real share of the track.
  const asrTrusted =
    asrSpan >= 90_000 || (total > 0 && asrSpan >= total * 0.45);

  const MIN_LINE_GAP_MS = 850;
  const used = new Set<number>();
  const voiceOnsets: number[] = [];

  for (let i = 0; i < exactLines.length; i++) {
    const spread = backbone[i] ?? firstPhrase + i * 2_500;
    const asrHint = asrStarts[i] ?? spread;
    const prev = voiceOnsets[i - 1];
    const minOnset =
      prev != null ? prev + MIN_LINE_GAP_MS : Math.max(firstPhrase, 0);

    // Default target = silence backbone across full duration.
    let target = spread;
    if (asrTrusted && Math.abs(asrHint - spread) <= 12_000) {
      target = Math.max(minOnset, asrHint);
    }

    let best: number | null = null;
    let bestScore = -Infinity;
    for (const onset of onsets) {
      if (used.has(onset)) continue;
      if (onset < minOnset - 200) continue;
      const delta = onset - target;
      // Keep local to the backbone/ASR target — do not jump back to intro.
      if (Math.abs(delta) > 18_000) continue;
      const silenceW = weightAt(onset);
      const earlyPenalty = delta < 0 ? Math.abs(delta) * 1.4 : delta * 0.25;
      const score = silenceW * 2.2 - earlyPenalty;
      if (score > bestScore) {
        bestScore = score;
        best = onset;
      }
    }
    if (best == null) {
      for (const onset of onsets) {
        if (used.has(onset)) continue;
        if (onset < minOnset) continue;
        best = onset;
        break;
      }
    }
    if (best == null) {
      best = Math.max(minOnset, spread, (prev ?? firstPhrase) + 2_200);
    }
    used.add(best);
    voiceOnsets.push(best);
  }

  const startsBuilt = voiceOnsets.map((onset) =>
    cueStartWithAirMs(onset, airMs),
  );
  const cues = cuesFromVoiceStarts(exactLines, startsBuilt, total);
  const alignedCount = Math.min(
    exactLines.length,
    onsets.length,
    voiceOnsets.length,
  );
  const synced =
    alignedCount >= Math.max(2, Math.ceil(exactLines.length * 0.35));
  return { cues, alignedCount, synced };
}

/**
 * Map exact cancionero lines onto ASR/caption clocks (forced align).
 * Timing source text is used only for alignment — cue `.text` stays Biblioteca.
 * Returns one cue per exact line; call packKaraokeDisplayCues for 2–3 line UI.
 */
export function alignCancioneroLinesToTiming(
  lines: readonly string[],
  timingCues: readonly SubtitleCue[],
  durationMs = 0,
): CancioneroAlignResult {
  const speech = filterSpeechCues([...timingCues]);
  const exactLines = lines.map((l) => String(l).trim()).filter(Boolean);
  if (exactLines.length === 0) {
    return { cues: [], alignedCount: 0, synced: false };
  }

  const total = Math.max(
    durationMs > 0 ? durationMs : 0,
    speech.length > 0 ? speech[speech.length - 1]!.endMs : 0,
    exactLines.length * 2_500,
  );

  if (speech.length === 0) {
    return {
      cues: cuesFromEqualTime(exactLines, total),
      alignedCount: 0,
      synced: false,
    };
  }

  const stream = flattenTimingTokens(speech);
  const starts: number[] = new Array(exactLines.length).fill(-1);
  const ends: number[] = new Array(exactLines.length).fill(-1);
  let cursor = 0;
  let alignedCount = 0;
  /** Local search ahead of cursor — wide enough to recover mid-song, not so
   * wide that early weak matches latch the whole chart forward. */
  const TOKEN_SEARCH_AHEAD = 96;
  const CUE_SEARCH_AHEAD = 18;
  const MIN_LINE_GAP_MS = 850;
  /** Leave blank stage between phrases when the voice pauses. */
  const GAP_BLANK_MS = 350;
  const MIN_PHRASE_MS = 1_200;
  const MAX_PHRASE_MS = 5_500;

  for (let li = 0; li < exactLines.length; li++) {
    const lineTok = alignTokens(exactLines[li]!);
    if (lineTok.length === 0) continue;

    let bestScore = 0;
    let bestStart = -1;
    let bestEndMs = -1;
    let bestEndCursor = cursor;

    // Primary: sequential token-stream match (karaoke-gen forced align).
    if (stream.length > 0) {
      const need = Math.max(1, lineTok.length);
      const searchEnd = Math.min(
        stream.length,
        cursor + Math.max(TOKEN_SEARCH_AHEAD, need * 8),
      );
      for (let i = cursor; i < searchEnd; i++) {
        const maxJ = Math.min(stream.length, i + need + 3);
        for (let j = i; j < maxJ; j++) {
          const windowToks = stream.slice(i, j + 1).map((t) => t.token);
          const windowText = windowToks.join(" ");
          const score = lineTimingScore(lineTok, windowText);
          // Prefer stronger text match. On near-ties keep the LATER onset —
          // picking earlier pulled worship tracks into the intro/credits.
          if (score < 0.4) continue;
          const better =
            bestStart < 0 ||
            score > bestScore + 0.02 ||
            (score >= bestScore - 0.01 &&
              stream[i]!.startMs > bestStart);
          if (better) {
            bestScore = score;
            bestStart = stream[i]!.startMs;
            bestEndMs = stream[j]!.endMs;
            bestEndCursor = j + 1;
          }
        }
      }
    }

    // Fallback: multi-cue windows on the raw speech list.
    if (bestStart < 0) {
      const cueCursor = Math.min(
        speech.length - 1,
        Math.max(
          0,
          speech.findIndex((c) => c.startMs >= (stream[cursor]?.startMs ?? 0)),
        ),
      );
      const searchEnd = Math.min(
        speech.length,
        Math.max(0, cueCursor) + CUE_SEARCH_AHEAD,
      );
      for (let i = Math.max(0, cueCursor); i < searchEnd; i++) {
        let window = "";
        for (let j = i; j < Math.min(speech.length, i + 4); j++) {
          window = window ? `${window} ${speech[j]!.text}` : speech[j]!.text;
          const score = lineTimingScore(lineTok, window);
          if (
            score >= 0.45 &&
            (score > bestScore + 0.02 ||
              (score >= bestScore && bestStart < 0))
          ) {
            bestScore = score;
            bestStart = speech[i]!.startMs;
            bestEndMs = speech[j]!.endMs;
            // Advance token cursor past this cue's tokens.
            const cueEnd = speech[j]!.endMs;
            let tokEnd = cursor;
            while (
              tokEnd < stream.length &&
              stream[tokEnd]!.startMs < cueEnd
            ) {
              tokEnd += 1;
            }
            bestEndCursor = Math.max(cursor + 1, tokEnd);
          }
        }
      }
    }

    if (bestStart >= 0 && bestScore >= 0.4) {
      starts[li] = bestStart;
      ends[li] = Math.max(
        bestStart + MIN_PHRASE_MS,
        bestEndMs > bestStart ? bestEndMs : bestStart + MIN_PHRASE_MS,
      );
      cursor = Math.max(cursor + 1, bestEndCursor);
      alignedCount += 1;
    }
  }

  // Fill gaps monotonically so unaligned lines sit between neighbors
  // (still cancionero text — never ASR words).
  let last = -1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i]! >= 0) {
      if (last >= 0 && starts[i]! < starts[last]!) {
        starts[i] = starts[last]!;
      }
      last = i;
    }
  }

  // Leading unaligned → walk BACK from the first locked phrase.
  // Spreading from t=0 put lines over intros/credits (looked “adelantado”).
  const firstLocked = starts.findIndex((s) => s >= 0);
  if (firstLocked === -1) {
    return {
      cues: cuesFromEqualTime(exactLines, total),
      alignedCount: 0,
      synced: false,
    };
  }
  if (firstLocked > 0) {
    const backGap = Math.max(
      MIN_LINE_GAP_MS,
      Math.min(
        3_200,
        Math.floor(starts[firstLocked]! / Math.max(1, firstLocked + 1)),
      ),
    );
    for (let i = firstLocked - 1; i >= 0; i--) {
      starts[i] = Math.max(0, starts[i + 1]! - backGap);
    }
  }

  // Trailing / interior gaps: linear interpolate between locked anchors.
  for (let i = 0; i < starts.length; i++) {
    if (starts[i]! >= 0) continue;
    let prev = i - 1;
    while (prev >= 0 && starts[prev]! < 0) prev -= 1;
    let next = i + 1;
    while (next < starts.length && starts[next]! < 0) next += 1;
    if (prev >= 0 && next < starts.length) {
      const gap = next - prev;
      const t = (i - prev) / gap;
      starts[i] = Math.round(
        starts[prev]! + t * (starts[next]! - starts[prev]!),
      );
    } else if (prev >= 0) {
      const remain = starts.length - 1 - prev;
      const slice = Math.max(
        2_000,
        Math.floor((total - starts[prev]!) / Math.max(1, remain)),
      );
      starts[i] = starts[prev]! + (i - prev) * slice;
    } else if (next < starts.length) {
      starts[i] = Math.round((starts[next]! * (i + 1)) / (next + 1));
    } else {
      starts[i] =
        conservativeIntroMs(total, exactLines.length) + i * 2_500;
    }
  }

  // Enforce non-decreasing starts with a minimum gap so mid-song lines
  // do not collapse onto one timestamp (looks like lyrics "froze").
  for (let i = 1; i < starts.length; i++) {
    const minNext = starts[i - 1]! + MIN_LINE_GAP_MS;
    if (starts[i]! < minNext) {
      starts[i] = minNext;
    }
  }

  // Captions/ASR often end before the song — keep room for remaining lines.
  const speechEnd =
    speech.length > 0 ? speech[speech.length - 1]!.endMs : 0;
  const lastStart = starts[starts.length - 1] ?? 0;
  const paddedTotal = Math.max(
    total,
    durationMs > 0 ? durationMs : 0,
    lastStart + MIN_LINE_GAP_MS * 2,
    speechEnd > 0 && durationMs <= 0
      ? speechEnd + Math.max(0, exactLines.length - alignedCount) * 3_500
      : 0,
  );

  const cues: SubtitleCue[] = exactLines.map((text, index) => {
    const startMs = Math.max(0, Math.round(starts[index]!));
    const nextStart =
      index + 1 < exactLines.length
        ? Math.round(starts[index + 1]!)
        : paddedTotal;
    // Prefer voice-matched end; otherwise hold a phrase window — leave blank
    // before the next line when there is room (instrumental / breath gaps).
    let endMs =
      ends[index]! > startMs
        ? Math.round(ends[index]!)
        : startMs +
          Math.min(
            MAX_PHRASE_MS,
            Math.max(MIN_PHRASE_MS, Math.floor((nextStart - startMs) * 0.7)),
          );
    endMs = Math.max(startMs + 500, Math.min(endMs, startMs + MAX_PHRASE_MS));
    if (nextStart - startMs > MIN_PHRASE_MS + GAP_BLANK_MS) {
      endMs = Math.min(endMs, nextStart - GAP_BLANK_MS);
    } else {
      // Tight successive phrases: abut without inventing a long hold.
      endMs = Math.min(endMs, nextStart);
    }
    endMs = Math.max(startMs + 500, endMs);
    return {
      id: `cancionero_${index}`,
      startMs,
      endMs,
      text,
    };
  });

  const synced =
    alignedCount >= Math.max(2, Math.ceil(exactLines.length * 0.35));
  return { cues, alignedCount, synced };
}

/** Musical intro before equal-time fallback starts advancing lines. */
function conservativeIntroMs(totalMs: number, lineCount: number): number {
  // Worship tracks often have 20–40s of intro before vocals — keep lyrics dark.
  const byPct = Math.floor(totalMs * 0.12);
  const capped = Math.min(40_000, Math.max(5_000, byPct));
  const maxIntro = Math.max(0, totalMs - lineCount * 2_000);
  return Math.min(capped, maxIntro);
}

function cuesFromEqualTime(
  lines: readonly string[],
  durationMs: number,
): SubtitleCue[] {
  if (lines.length === 0) return [];
  const total = Math.max(
    durationMs > 0 ? durationMs : lines.length * 8_000,
    lines.length * 2_500,
  );
  const leadInMs = conservativeIntroMs(total, lines.length);
  const usable = Math.max(total - leadInMs, lines.length * 2_000);
  const slice = usable / lines.length;
  // Show ~70% of each slice; leave the rest blank (no-voice feel).
  const visible = Math.max(1_200, Math.floor(slice * 0.7));
  return lines.map((text, index) => {
    const startMs = Math.round(leadInMs + index * slice);
    const slotEnd = Math.round(
      index === lines.length - 1 ? total : leadInMs + (index + 1) * slice,
    );
    const endMs = Math.min(slotEnd, startMs + visible);
    return {
      id: `cancionero_${index}`,
      startMs: Math.max(0, startMs),
      endMs: Math.max(startMs + 500, endMs),
      text,
    };
  });
}

/**
 * Build timed cues from exact cancionero lines.
 * Equal-time fallback only — prefer alignCancioneroLinesToTiming when ASR /
 * captions clocks exist. Display lead is operator Adelante (default 0).
 */
export function songToSubtitleCues(
  song: LibrarySongPayload,
  durationMs: number,
): SubtitleCue[] {
  return cuesFromEqualTime(songLyricChunks(song), durationMs);
}

function runCmd(
  bin: string,
  args: string[],
): Promise<{ code: number; stderr: string; stdout: string }> {
  ensureAugmentedPath();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    let stdout = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr, stdout });
    });
  });
}

/** Probe media duration via ffprobe (ms). Returns 0 on failure. */
export async function probeMediaDurationMs(
  mediaPath: string,
): Promise<number> {
  if (!mediaPath) return 0;
  const ffmpeg = resolveFfmpegBin();
  const probeCandidates = [
    ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1"),
    "ffprobe",
  ];
  for (const bin of probeCandidates) {
    try {
      const result = await runCmd(bin, [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        mediaPath,
      ]);
      if (result.code !== 0 || !result.stdout.trim()) continue;
      const data = JSON.parse(result.stdout) as {
        format?: { duration?: string };
      };
      const sec = Number.parseFloat(data.format?.duration ?? "");
      if (Number.isFinite(sec) && sec > 0) {
        return Math.round(sec * 1000);
      }
    } catch {
      // try next
    }
  }
  return 0;
}

/** Strip extension from an audio filename for matching. */
export function titleFromAudioFilename(
  name: string | null | undefined,
): string {
  if (!name?.trim()) return "";
  let s = name.trim();
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (slash >= 0) s = s.slice(slash + 1);
  return s.replace(AUDIO_EXT_RE, "").trim();
}
