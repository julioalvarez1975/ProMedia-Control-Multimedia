/**
 * LRCLIB (https://lrclib.net) — community lyrics database used ONLY when the
 * Biblioteca cancionero has no match. Free API, no key.
 *
 * - Text: real lyrics instead of Whisper's misheard transcript.
 * - Clocks (optional): `syncedLyrics` line starts, used as a fallback when
 *   WhisperX cannot refine them.
 *
 * Every failure (offline, timeout, no result, bad JSON) resolves to `null` so
 * the caller falls back to captions / Whisper exactly as before.
 * Disable with PROMEDIA_LRCLIB=0.
 */
import type { LibrarySongPayload, SubtitleCue } from "@promedia/shared";
import {
  normalizeMatchTitle,
  primaryTitleSegment,
  scoreSongMatch,
  songCancioneroLines,
  titleVariants,
} from "./subtitle-cancionero.js";

const API = "https://lrclib.net/api";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REQUESTS = 6;
/** Reject a different cut of the song (live, extended, wrong track). */
export const LRCLIB_MAX_DURATION_DELTA_MS = 6_000;
/** Minimum title score (same scale as the cancionero matcher). */
export const LRCLIB_MIN_TITLE_SCORE = 70;
const CACHE_TTL_MS = 10 * 60_000;
const USER_AGENT =
  "ProMedia/0.0 (https://github.com/julioalvarez1975/ProMedia-Control-Multimedia)";

export type LrclibRecord = {
  id?: number;
  trackName?: string;
  artistName?: string;
  /** Seconds. */
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
};

export type LrclibSong = {
  /** Stable id for logs only — never persisted as a Biblioteca id. */
  id: string;
  song: LibrarySongPayload;
  /** One cue per cancionero line when LRC timing lines up 1:1, else null. */
  syncedCues: SubtitleCue[] | null;
  score: number;
  matchedQuery: string;
};

export type LrclibFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type LrclibQuery = {
  titles: readonly string[];
  artists?: readonly string[];
  /** Media duration in ms (0 / undefined = unknown). */
  durationMs?: number;
  fetchImpl?: LrclibFetch;
};

export function lrclibEnabled(): boolean {
  return process.env.PROMEDIA_LRCLIB?.trim() !== "0";
}

type LrcEntry = { startMs: number; text: string };

/** `[mm:ss.xx] text` → entries sorted by time. Metadata tags are ignored. */
export function parseLrc(raw: string): LrcEntry[] {
  const out: LrcEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (stamps.length === 0) continue;
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(m[3].padEnd(3, "0").slice(0, 3)) : 0;
      const startMs =
        Number(m[1]) * 60_000 + Number(m[2]) * 1_000 + frac;
      if (Number.isFinite(startMs)) out.push({ startMs, text });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Plain lyrics → non-empty lines (stanza breaks dropped). */
export function plainLyricsToLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function lrcToCues(entries: readonly LrcEntry[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (!e.text) continue;
    const next = entries[i + 1];
    const cap = e.startMs + 10_000;
    const endMs = Math.max(
      e.startMs + 500,
      Math.min(next ? next.startMs - 40 : cap, cap),
    );
    cues.push({
      id: `lrclib_${cues.length}`,
      startMs: e.startMs,
      endMs,
      text: e.text,
    });
  }
  return cues;
}

/**
 * Build a Biblioteca-shaped song (+ optional 1:1 line clocks) from a record.
 * Returns null for instrumentals / empty lyrics.
 */
export function lrclibRecordToSong(
  rec: LrclibRecord,
): { song: LibrarySongPayload; syncedCues: SubtitleCue[] | null } | null {
  if (rec.instrumental) return null;
  const title = String(rec.trackName ?? "").trim();
  if (!title) return null;

  const synced = rec.syncedLyrics ? lrcToCues(parseLrc(rec.syncedLyrics)) : [];
  const lines =
    synced.length > 0
      ? synced.map((c) => c.text)
      : plainLyricsToLines(String(rec.plainLyrics ?? ""));
  if (lines.length === 0) return null;

  const song: LibrarySongPayload = {
    title,
    artist: String(rec.artistName ?? "").trim() || undefined,
    stanzas: [{ id: "lrclib", lines }],
  };
  // Cancionero lines may split long renglones — only trust LRC clocks when the
  // count still matches 1:1.
  const finalLines = songCancioneroLines(song);
  const syncedCues =
    synced.length > 0 && finalLines.length === synced.length
      ? synced.map((c, i) => ({ ...c, text: finalLines[i]! }))
      : null;
  return { song, syncedCues };
}

function cleanArtist(raw: string): string {
  return raw
    .replace(/\s*-\s*topic$/i, "")
    .split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b| x )\s*/i)[0]!
    .trim();
}

function durationOk(rec: LrclibRecord, durationMs: number): boolean {
  if (!durationMs || !rec.duration) return true;
  return (
    Math.abs(rec.duration * 1000 - durationMs) <= LRCLIB_MAX_DURATION_DELTA_MS
  );
}

const cache = new Map<string, { at: number; value: LrclibSong | null }>();

/** Test hook. */
export function clearLrclibCache(): void {
  cache.clear();
}

export async function findLrclibSong(
  query: LrclibQuery,
): Promise<LrclibSong | null> {
  if (!lrclibEnabled()) return null;
  const rawTitles = [
    ...new Set(query.titles.map((t) => String(t).trim()).filter(Boolean)),
  ];
  // "Artist - Song (Official Video)" → head/tail variants, like the cancionero.
  const variants = [...new Set(rawTitles.flatMap((t) => titleVariants(t)))];
  if (rawTitles.length === 0) return null;
  const artists = [
    ...new Set(
      (query.artists ?? []).map((a) => cleanArtist(String(a))).filter(Boolean),
    ),
  ];
  const durationMs = Math.max(0, Math.round(query.durationMs ?? 0));

  const cacheKey = JSON.stringify([rawTitles, artists, Math.round(durationMs / 2000)]);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const doFetch: LrclibFetch =
    query.fetchImpl ??
    ((url, init) => fetch(url, init) as ReturnType<LrclibFetch>);
  let requests = 0;

  const get = async (path: string, params: Record<string, string>) => {
    if (requests >= MAX_REQUESTS) return null;
    requests++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = `${API}/${path}?${new URLSearchParams(params).toString()}`;
      const res = await doFetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const consider = (
    rec: LrclibRecord,
    matchedQuery: string,
  ): LrclibSong | null => {
    if (!durationOk(rec, durationMs)) return null;
    const built = lrclibRecordToSong(rec);
    if (!built) return null;
    const score = Math.max(
      0,
      ...variants.map((t) => scoreSongMatch(built.song, t)),
      ...variants.flatMap((t) =>
        artists.map((a) => scoreSongMatch(built.song, t, a)),
      ),
    );
    if (score < LRCLIB_MIN_TITLE_SCORE) return null;
    return {
      id: `lrclib:${rec.id ?? normalizeMatchTitle(built.song.title)}`,
      song: built.song,
      syncedCues: built.syncedCues,
      score,
      matchedQuery,
    };
  };

  let best = null as LrclibSong | null;
  const keep = (c: LrclibSong | null) => {
    if (c && (!best || c.score > best.score)) best = c;
  };

  // 1) Exact lookup: artist + track + duration (cheap, most precise).
  const trackNames = [
    ...new Set(rawTitles.map((t) => primaryTitleSegment(t) || t)),
  ].slice(0, 2);
  if (artists.length > 0 && durationMs > 0) {
    for (const artist of artists.slice(0, 1)) {
      for (const track of trackNames) {
        const rec = (await get("get", {
          artist_name: artist,
          track_name: track,
          duration: String(Math.round(durationMs / 1000)),
        })) as LrclibRecord | null;
        if (rec && typeof rec === "object" && "trackName" in rec) {
          keep(consider(rec, `${artist} / ${track}`));
        }
        if (best) break;
      }
    }
  }

  // 2) Free-text search over each raw title (YouTube titles carry the artist).
  if (!best) {
    for (const q of rawTitles.slice(0, 3)) {
      const list = (await get("search", { q })) as LrclibRecord[] | null;
      if (!Array.isArray(list)) continue;
      for (const rec of list.slice(0, 15)) keep(consider(rec, q));
      if (best) break;
    }
  }

  cache.set(cacheKey, { at: Date.now(), value: best });
  return best;
}
