/**
 * Karaoke path for Guion Audio + YouTube:
 * Biblioteca / cancionero is the ONLY text source.
 *
 * Phrase model:
 * - A phrase is words sung until the singer breathes.
 * - Breath (silence) → blank the caption.
 * - Before voice returns → show the next renglón early (air anticipation).
 *
 * Captions / WhisperX supply word clocks; silence is only breath → blank and
 * the cue to pull the next letter forward — never a snap of every line onto onsets.
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
  // Whole-title prefix/suffix of the query ("… | Official Lyric Video"):
  // the extra words are noise, not a different last word of the title.
  let wholeTitleMatch = false;

  if (songTitle === q) {
    score = 100;
  } else if (
    // "DIGNO – Marcos Brunet…" → q starts with exact short cancionero title.
    (q.startsWith(`${songTitle} `) || q.endsWith(` ${songTitle}`)) &&
    songTitle.length >= 4
  ) {
    score = 96;
    wholeTitleMatch = true;
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
  if (!wholeTitleMatch && qTokens.length >= 3 && sTokens.length >= 3) {
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
      if (titleSet.has(v)) continue;
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

/**
 * Force cue `.text` to the exact Biblioteca renglón (never caption/ASR fragments).
 */
export function ensureCancioneroCueTexts(
  cues: readonly SubtitleCue[],
  lines: readonly string[],
): SubtitleCue[] {
  const exact = lines.map((l) => String(l).trim()).filter(Boolean);
  if (cues.length === 0 || exact.length === 0) return cues.map((c) => ({ ...c }));
  return cues.map((c, i) => ({
    ...c,
    text: exact[i] ?? String(c.text ?? "").trim(),
  }));
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

  // Keep exactly n monotonic onsets inside the track — the old unique-filter
  // dropped duplicates and left trailing lines with undefined/NaN clocks.
  const lastLimit = Math.max(0, total - 1_200);
  const enforceGap = Math.max(
    600,
    Math.min(2_500, Math.floor(lastLimit / Math.max(1, n))),
  );
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let t =
      i < picked.length
        ? Math.max(0, Math.round(picked[i]!))
        : (out[out.length - 1] ?? 0) + enforceGap;
    if (out.length > 0) {
      t = Math.max(t, out[out.length - 1]! + enforceGap);
    }
    // Stay inside the song; if we ran past the end, pack remaining evenly.
    if (t > lastLimit) {
      const remain = n - out.length;
      const prev = out[out.length - 1] ?? Math.max(0, lastLimit - remain * enforceGap);
      const slice = Math.max(
        500,
        Math.floor((lastLimit - prev) / Math.max(1, remain)),
      );
      for (let j = 0; j < remain; j++) {
        out.push(Math.min(lastLimit, prev + (j + 1) * slice));
      }
      break;
    }
    out.push(t);
  }
  while (out.length < n) {
    const prev = out[out.length - 1] ?? 0;
    out.push(Math.min(lastLimit, prev + enforceGap));
  }
  return out.slice(0, n);
}

/**
 * Map exact cancionero / ASR lines onto speech onsets after real silence.
 * Each cue starts at the voice resume (airMs, default 0).
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

  // Display start = voice onset − air. End = when that phrase's voice stops
  // (first silence after onset / last word), NOT the next lyric line.
  const starts: number[] = picked.map((onset) =>
    cueStartWithAirMs(onset, airMs),
  );
  const voiceEnds = picked.map((onset, i) =>
    phraseVoiceEndMs(onset, i + 1 < picked.length ? picked[i + 1]! : total, silences),
  );
  const cues = cuesFromVoiceStarts(exactLines, starts, total, voiceEnds);

  // Silence has no lyric confirmation — never claim text-synced.
  // (Claiming synced here skipped WhisperX and froze bad mid-phrase cuts.)
  const alignedCount = Math.min(exactLines.length, onsets.length, picked.length);
  return { cues, alignedCount, synced: false };
}

/**
 * Phrase end without word clocks: only the breath that leads into the NEXT
 * onset. Mid-phrase music dips must NOT blank the line while still singing.
 */
function phraseVoiceEndMs(
  onsetMs: number,
  nextOnsetMs: number,
  silences: readonly SilenceRegion[],
): number {
  const onset = Math.max(0, Math.round(onsetMs));
  const next = Math.max(onset + 700, Math.round(nextOnsetMs));
  // Default: hold through the sung phrase; tiny blank before next line.
  let end = next - 100;
  let bestBreath = -1;
  for (const s of silences) {
    const sStart = Math.max(0, Math.round(s.startMs));
    const sEnd = Math.max(sStart, Math.round(s.endMs));
    // Silence that ends at the next voice onset = gap after last word.
    if (Math.abs(sEnd - next) <= 180 && sStart > onset + 500) {
      bestBreath = Math.max(bestBreath, sStart);
    }
  }
  if (bestBreath > 0) end = bestBreath;
  return Math.max(onset + 700, end);
}

/** Small pad so exclusive endMs (`t < end`) does not clip the last syllable. */
const LAST_WORD_HOLD_PAD_MS = 120;

/**
 * When the first lyric is actually sung.
 *
 * Word clocks (captions / LRCLIB / WhisperX first-word) are ground truth so
 * voz ↔ letra. Leading silence only floors a hint that landed inside the
 * opening quiet, or stands in when no word clock exists yet.
 */
export function resolveFirstVoiceOnsetMs(
  silences: readonly SilenceRegion[],
  speechOnsetsMs: readonly number[] = [],
  timingHintMs?: number | null,
): number | null {
  const leading = [...silences]
    .map((s) => ({
      startMs: Math.max(0, Math.round(s.startMs)),
      endMs: Math.max(0, Math.round(s.endMs)),
    }))
    .find((s) => s.startMs <= 200 && s.endMs > s.startMs + 400);
  const leadEnd = leading ? leading.endMs : null;
  const hint =
    typeof timingHintMs === "number" && Number.isFinite(timingHintMs)
      ? Math.max(0, Math.round(timingHintMs))
      : null;

  const firstStrongOnset = (() => {
    for (const raw of speechOnsetsMs) {
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      const t = Math.max(0, Math.round(raw));
      if (t >= 2_500) return t;
    }
    return null;
  })();

  if (hint != null) {
    // Hint during the opening silence cannot be the sung lyric — wait for voice.
    if (leadEnd != null && hint + 120 < leadEnd) return leadEnd;
    // Hint in the music bed before the first real phrase break (common WX miss).
    if (firstStrongOnset != null && hint + 1_500 < firstStrongOnset) {
      return firstStrongOnset;
    }
    return hint;
  }

  if (leadEnd != null) return leadEnd;
  if (firstStrongOnset != null) return firstStrongOnset;

  for (const raw of speechOnsetsMs) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const t = Math.max(0, Math.round(raw));
    if (t <= 40 && speechOnsetsMs.some((x) => Number(x) > 2_000)) continue;
    return t;
  }
  return null;
}

/**
 * Shift the whole lyric chart so cue[0] starts when the voice appears.
 * Relative gaps between lines stay the same.
 */
export function anchorFirstCueToVoiceOnset(
  cues: readonly SubtitleCue[],
  voiceOnsetMs: number | null | undefined,
): SubtitleCue[] {
  if (
    cues.length === 0 ||
    voiceOnsetMs == null ||
    !Number.isFinite(voiceOnsetMs)
  ) {
    return cues.map((c) => ({ ...c }));
  }
  const voice = Math.max(0, Math.round(voiceOnsetMs));
  const first = Math.max(0, Math.round(cues[0]!.startMs));
  const delta = voice - first;
  // Even a 40 ms drift is worth correcting so cue[0] = “cuando empieza la voz”.
  if (Math.abs(delta) < 40) return cues.map((c) => ({ ...c }));
  // Guard against a wild silence false-positive yanking the chart.
  if (Math.abs(delta) > 90_000) return cues.map((c) => ({ ...c }));
  console.log(
    `[subtitle] voice-anchor shift=${delta}ms first=${first} → voice=${voice}`,
  );
  return cues.map((c) => {
    const startMs = Math.max(0, Math.round(c.startMs) + delta);
    const endMs = Math.max(startMs + 500, Math.round(c.endMs) + delta);
    return { ...c, startMs, endMs };
  });
}

/**
 * Breath + anticipation on caption/WhisperX word clocks.
 *
 * 1) Keep first-word clocks from the aligner (not silence onsets).
 * 2) Blank when the singer breathes (first silence after the last word).
 * 3) Pull each start earlier by airMs so the next renglón is already on
 *    screen before the voice returns after that breath.
 */
export function blankCuesAtPhraseSilence(
  cues: readonly SubtitleCue[],
  silences: readonly SilenceRegion[],
  durationMs = 0,
  airMs: number = SILENCE_AIR_ANTICIPATION_MS,
): SubtitleCue[] {
  if (cues.length === 0) return [];

  const air = Math.max(0, Math.round(airMs));
  const sorted = [...silences].sort(
    (a, b) => Math.round(a.startMs) - Math.round(b.startMs),
  );

  // Voice clocks (first word / last word) before anticipation.
  const voiceStarts = cues.map((c) => Math.max(0, Math.round(c.startMs)));
  const lastWords = cues.map((c, i) =>
    Math.max(voiceStarts[i]! + 500, Math.round(c.endMs)),
  );

  const breathStarts: number[] = cues.map((_, i) => {
    const voiceStart = voiceStarts[i]!;
    const lastWord = lastWords[i]!;
    const nextVoice =
      i + 1 < cues.length
        ? voiceStarts[i + 1]!
        : Math.max(
            lastWord + 500,
            durationMs > 0 ? durationMs : lastWord + 2_000,
          );
    if (!sorted.length) return -1;
    const searchFrom = Math.max(voiceStart + 700, lastWord - 60);
    for (const s of sorted) {
      const sStart = Math.max(0, Math.round(s.startMs));
      if (sStart < searchFrom) continue;
      if (sStart >= nextVoice - 40) break;
      // Breath after the sung words of this phrase.
      return sStart;
    }
    return -1;
  });

  const out: SubtitleCue[] = [];
  for (let i = 0; i < cues.length; i++) {
    const voiceStart = voiceStarts[i]!;
    const lastWord = lastWords[i]!;
    const nextVoice =
      i + 1 < cues.length
        ? voiceStarts[i + 1]!
        : Math.max(
            lastWord + 500,
            durationMs > 0 ? durationMs : lastWord + 2_000,
          );

    // Cue 0: show with the sung word (voz ↔ letra). Later lines may appear
    // slightly early after a breath so the next renglón is readable in time.
    let startMs =
      i === 0 ? voiceStart : cueStartWithAirMs(voiceStart, air);
    if (i > 0) {
      // After previous breath blank — never overlap the prior renglón.
      startMs = Math.max(startMs, out[i - 1]!.endMs);
    }

    const breathAt = breathStarts[i]!;
    // Hold through last word (or breath). Do NOT cut early for next-line air —
    // anticipation only pulls the NEXT startMs forward.
    let endMs =
      breathAt > 0
        ? breathAt + LAST_WORD_HOLD_PAD_MS
        : lastWord + LAST_WORD_HOLD_PAD_MS;
    if (i + 1 < cues.length) {
      endMs = Math.min(endMs, Math.max(startMs + 500, nextVoice));
    } else if (durationMs > 0) {
      endMs = Math.min(endMs, Math.max(startMs + 500, durationMs));
    }
    endMs = Math.max(startMs + 500, endMs);

    out.push({
      ...cues[i]!,
      id: cues[i]!.id || `cancionero_${i}`,
      startMs,
      endMs,
    });
  }
  return out;
}

/**
 * Build display cues from voice clocks (starts already −airMs).
 * Keep each phrase/line on screen until its last sung word ends —
 * then blank until the next phrase starts.
 */
function cuesFromVoiceStarts(
  lines: readonly string[],
  startsIn: readonly number[],
  durationMs: number,
  voiceEndsIn: readonly number[] = [],
): SubtitleCue[] {
  const MIN_LINE_GAP_MS = 850;
  const MIN_PHRASE_MS = 1_200;
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = startsIn[i];
    let start =
      typeof raw === "number" && Number.isFinite(raw)
        ? Math.max(0, Math.round(raw))
        : starts.length > 0
          ? starts[starts.length - 1]! + MIN_LINE_GAP_MS
          : 0;
    if (i > 0) start = Math.max(start, starts[i - 1]! + MIN_LINE_GAP_MS);
    starts.push(start);
  }
  const total = Math.max(
    durationMs > 0 ? durationMs : 0,
    (starts[starts.length - 1] ?? 0) + 4_000,
    lines.length * 2_500,
  );
  return lines.map((text, index) => {
    const startMs = starts[index]!;
    const nextStart = index + 1 < lines.length ? starts[index + 1]! : total;
    const rawEnd = voiceEndsIn[index];
    let endMs =
      typeof rawEnd === "number" && Number.isFinite(rawEnd)
        ? Math.round(rawEnd) + LAST_WORD_HOLD_PAD_MS
        : startMs +
          Math.max(
            MIN_PHRASE_MS,
            Math.floor((nextStart - startMs) * 0.9),
          );
    // Hold through last word of this line — blank before the next lyric line.
    endMs = Math.max(startMs + 500, endMs);
    if (index + 1 < lines.length) {
      endMs = Math.min(endMs, Math.max(startMs + 500, nextStart - 40));
    } else if (durationMs > 0) {
      endMs = Math.min(endMs, Math.max(startMs + 500, durationMs));
    }
    if (!Number.isFinite(endMs)) endMs = startMs + MIN_PHRASE_MS;
    return { id: `cancionero_${index}`, startMs, endMs, text };
  });
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
  const MIN_PHRASE_MS = 1_200;

  const lineCoverage: number[] = new Array(exactLines.length).fill(0);

  for (let li = 0; li < exactLines.length; li++) {
    const lineTok = alignTokens(exactLines[li]!);
    if (lineTok.length === 0) continue;

    let bestScore = 0;
    let bestStart = -1;
    let bestStartIdx = -1;
    let bestEndMs = -1;
    let bestEndCursor = cursor;
    let bestCoverage = 0;

    // Primary: sequential token-stream match — take the FULL renglón.
    if (stream.length > 0) {
      const need = Math.max(1, lineTok.length);
      const searchEnd = Math.min(
        stream.length,
        cursor + Math.max(TOKEN_SEARCH_AHEAD, need * 8),
      );
      // Stay near the previous lock — do not leap to a later chorus repeat.
      const prevLockMs = li > 0 && starts[li - 1]! >= 0 ? starts[li - 1]! : -1;
      const earliestMs =
        prevLockMs >= 0
          ? prevLockMs + 400
          : stream[cursor]?.startMs ?? 0;
      const latestMs = earliestMs + Math.max(18_000, need * 1_800);

      for (let i = cursor; i < searchEnd; i++) {
        const onset = stream[i]!.startMs;
        if (onset < earliestMs - 200) continue;
        if (onset > latestMs) break;
        // Window must be able to hold every word of the Biblioteca line.
        const maxJ = Math.min(stream.length, i + need + 12);
        for (let j = i; j < maxJ; j++) {
          const windowLen = j - i + 1;
          // Skip tiny windows that can only cover a fragment of a long line.
          if (need >= 4 && windowLen < Math.ceil(need * 0.6)) continue;
          const windowToks = stream.slice(i, j + 1).map((t) => t.token);
          const coverage = tokenCoverage(lineTok, windowToks);
          if (coverage < 0.5) continue;
          const score = lineTimingScore(lineTok, windowToks.join(" "));
          if (score < 0.4) continue;
          // Sequential karaoke: full coverage first, then earlier onset
          // (same lyric repeats later — never jump forward on a tie).
          // Once coverage is full, prefer the SHORTEST window (true last word).
          const better =
            bestStart < 0 ||
            coverage > bestCoverage + 0.04 ||
            (coverage >= bestCoverage - 0.02 && score > bestScore + 0.03) ||
            (coverage >= bestCoverage - 0.02 &&
              score >= bestScore - 0.02 &&
              onset < bestStart - 40) ||
            (coverage >= 0.95 &&
              bestCoverage >= 0.95 &&
              Math.abs(onset - bestStart) <= 80 &&
              stream[j]!.endMs < bestEndMs) ||
            (coverage < 0.95 &&
              coverage >= bestCoverage - 0.02 &&
              score >= bestScore - 0.02 &&
              Math.abs(onset - bestStart) <= 80 &&
              stream[j]!.endMs > bestEndMs);
          if (better) {
            bestScore = score;
            bestCoverage = coverage;
            bestStart = onset;
            bestStartIdx = i;
            bestEndMs = stream[j]!.endMs;
            bestEndCursor = j + 1;
          }
          // Full renglón found at this onset — stop growing the window.
          if (coverage >= 0.95 && windowLen >= need) break;
        }
      }

      // Stretch only while coverage of THIS renglón still improves.
      if (bestStartIdx >= 0 && bestCoverage < 0.95) {
        const i = bestStartIdx;
        const extendTo = Math.min(stream.length, i + need + 10);
        for (let j = bestEndCursor; j < extendTo; j++) {
          const windowToks = stream.slice(i, j + 1).map((t) => t.token);
          const coverage = tokenCoverage(lineTok, windowToks);
          if (coverage <= bestCoverage + 0.005) break;
          bestCoverage = coverage;
          bestEndMs = stream[j]!.endMs;
          bestEndCursor = j + 1;
          bestScore = Math.max(
            bestScore,
            lineTimingScore(lineTok, windowToks.join(" ")),
          );
          if (bestCoverage >= 0.98) break;
        }
      }
    }

    // Fallback: multi-cue windows on the raw speech list (still full line).
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
        for (let j = i; j < Math.min(speech.length, i + 8); j++) {
          window = window ? `${window} ${speech[j]!.text}` : speech[j]!.text;
          const windowToks = alignTokens(window);
          const coverage = tokenCoverage(lineTok, windowToks);
          if (coverage < 0.5) continue;
          const score = lineTimingScore(lineTok, window);
          if (score < 0.45) continue;
          const better =
            bestStart < 0 ||
            coverage > bestCoverage + 0.04 ||
            (coverage >= bestCoverage - 0.02 && score > bestScore + 0.02);
          if (better) {
            bestScore = score;
            bestCoverage = coverage;
            bestStart = speech[i]!.startMs;
            bestEndMs = speech[j]!.endMs;
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

    // Lock only when we covered most of the renglón (or a strong full match).
    if (
      bestStart >= 0 &&
      bestScore >= 0.4 &&
      (bestCoverage >= 0.7 || bestScore >= 0.62)
    ) {
      starts[li] = bestStart;
      ends[li] = Math.max(
        bestStart + MIN_PHRASE_MS,
        bestEndMs > bestStart ? bestEndMs : bestStart + MIN_PHRASE_MS,
      );
      lineCoverage[li] = bestCoverage;
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
    const words = Math.max(1, alignTokens(text).length);
    // Full renglón floor: ~300ms/word so fragment matches don't cut mid-line.
    const minByWords = startMs + Math.min(words * 300, nextStart - startMs);
    const matchedEnd = ends[index]! > startMs ? Math.round(ends[index]!) : -1;
    const coverage = lineCoverage[index] ?? 0;
    let voiceEnd =
      matchedEnd > startMs
        ? matchedEnd + LAST_WORD_HOLD_PAD_MS
        : startMs +
          Math.max(
            MIN_PHRASE_MS,
            Math.floor((nextStart - startMs) * 0.9),
          );
    // Incomplete line match → hold through a full-line duration estimate.
    if (matchedEnd > startMs && (coverage < 0.85 || matchedEnd + 200 < minByWords)) {
      voiceEnd = Math.max(voiceEnd, minByWords);
    }
    let endMs = Math.max(startMs + 500, voiceEnd);
    if (index + 1 < exactLines.length) {
      // Never spill into the next lyric line (blank until it starts).
      endMs = Math.min(endMs, Math.max(startMs + 500, nextStart - 40));
    } else if (durationMs > 0) {
      endMs = Math.min(endMs, Math.max(startMs + 500, durationMs));
    }
    endMs = Math.max(startMs + 500, endMs);
    return {
      id: `cancionero_${index}`,
      startMs,
      endMs,
      // Always the exact Biblioteca renglón — never a caption fragment.
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
