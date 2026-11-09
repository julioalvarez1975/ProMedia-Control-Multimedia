import type {
  AudioPlaylistItem,
  HubMessage,
  PlaylistItem,
  SubtitleAgentState,
  SubtitleCue,
  SubtitleFontSize,
  SubtitleLeadMs,
  SubtitleTargetLang,
  SubtitleTimingMode,
  VideoPlaylistItem,
} from "@promedia/shared";
import {
  CANCIONERO_DEFAULT_LEAD_MS,
  cueIndexAtPositionMs,
  DEFAULT_SUBTITLE_LEAD_MS,
  emptySubtitleAgentState,
  normalizeSubtitleLeadMs,
} from "@promedia/shared";
import { rm } from "node:fs/promises";
import { assetStore } from "./asset-store.js";
import { broadcastSession } from "./broadcast.js";
import {
  ffmpegAvailable,
  mediaFileExists,
  transcribeLocalFile,
  whisperCliAvailable,
} from "./subtitle-asr.js";
import { isMissingBinHint, missingBinHintFromError } from "./subtitle-bins.js";
import { tryLocalCaptionTracks } from "./subtitle-local-tracks.js";
import { ensureSubtitleDirs } from "./subtitle-paths.js";
import { translateCuesLocal } from "./subtitle-translate.js";
import { filterSpeechCues } from "./subtitle-cue-text.js";
import { cuesLikelyInLanguage } from "./subtitle-lang-detect.js";
import {
  preserveNativeCaptionCues,
  shapeLyricLikeCues,
} from "./subtitle-lyric-shape.js";
import {
  applyRememberedCueStarts,
  cancioneroMediaKey,
  recallCancioneroByMedia,
  recallCancioneroByTitles,
  recallCancioneroTiming,
  rememberCancioneroMatch,
  rememberCancioneroTiming,
} from "./cancionero-memory.js";
import {
  alignCancioneroLinesToSilence,
  alignCancioneroLinesToTiming,
  anchorFirstCueToVoiceOnset,
  blankCuesAtPhraseSilence,
  buildKaraokeAlignPrompt,
  ensureCancioneroCueTexts,
  findCancioneroSongCandidates,
  packKaraokeDisplayCues,
  probeMediaDurationMs,
  resolveCancioneroSongById,
  resolveFirstVoiceOnsetMs,
  scoreSongLyricOverlap,
  scoreSongMatch,
  songCancioneroLines,
  songToSubtitleCues,
  titleFromAudioFilename,
  type CancioneroMatchHit,
} from "./subtitle-cancionero.js";
import {
  detectSpeechOnsetsFromSilence,
  SILENCE_AIR_ANTICIPATION_MS,
} from "./subtitle-silence.js";
import {
  alignLyricsWithWhisperx,
  whisperxAvailable,
} from "./subtitle-whisperx.js";
import { findLrclibSong, type LrclibSong } from "./subtitle-lrclib.js";
import { libraryStore } from "./library-store.js";
import { songIdentityKey } from "./quelea-import.js";
import {
  forgetReadyAgent,
  recallReadyAgent,
} from "./subtitle-ready-cache.js";
import {
  clearPersistMeta,
  forgetPersistedAgent,
  getPersistMeta,
  loadPersistedAgent,
  lyricsHash,
  setPersistMeta,
  type PersistedAgent,
} from "./subtitle-aligned-store.js";
import {
  ensureYoutubeAudio,
  expandCaptionPreferLangs,
  fetchYoutubeMeta,
  tryYoutubeCaptions,
  ytDlpAvailable,
} from "./subtitle-youtube.js";
import type { SessionRecord } from "./session-store.js";
import { sessionStore } from "./session-store.js";

/** Cap lang tag to 2-letter base (`es-419` → `es`). */
function langBase(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  if (l.startsWith("zh")) return "zh";
  return l.slice(0, 2);
}

/** In-flight jobs keyed by sessionId — cancel by generation bump. */
const jobGeneration = new Map<string, number>();

/**
 * Hard YouTube / extract failures: do not tight-loop retries on focus/Go Live.
 * Allow another attempt after backoff or when the user toggles the agent on.
 */
const HARD_YT_HINT_PREFIXES = [
  "youtube_download_failed",
  "youtube_cache_path_error",
  "youtube_cache_missing_after_download",
  "youtube_age_restricted",
  "youtube_blocked",
  "youtube_private",
  "youtube_unavailable",
  "youtube_invalid",
  "yt_dlp_spawn_failed",
  "ffmpeg_extract_failed",
] as const;

const YT_HARD_FAIL_BACKOFF_MS = 30_000;
const ytHardFailUntil = new Map<string, number>();

/**
 * Session closed: cancel its running karaoke/prepare job and drop every
 * per-session map entry (the next job of a dead session sees a stale
 * generation and stops).
 */
export function disposeSubtitleSession(sessionId: string): void {
  bumpJob(sessionId);
  jobGeneration.delete(sessionId);
  prepareTokens.delete(sessionId);
  inflightJobs.delete(sessionId);
  pendingAdds.delete(sessionId);
  forgetReadyAgent(sessionId);
}

function bumpJob(sessionId: string): number {
  const next = (jobGeneration.get(sessionId) ?? 0) + 1;
  jobGeneration.set(sessionId, next);
  return next;
}

function isCurrent(sessionId: string, gen: number): boolean {
  return jobGeneration.get(sessionId) === gen;
}

function isHardYoutubeHint(hint: string | null | undefined): boolean {
  if (!hint) return false;
  return HARD_YT_HINT_PREFIXES.some(
    (p) => hint === p || hint.startsWith(`${p}:`) || hint.startsWith(`${p}_`),
  );
}

function markYtHardFail(sessionId: string): void {
  ytHardFailUntil.set(sessionId, Date.now() + YT_HARD_FAIL_BACKOFF_MS);
}

function clearYtHardFail(sessionId: string): void {
  ytHardFailUntil.delete(sessionId);
}

function ytHardFailInBackoff(sessionId: string): boolean {
  const until = ytHardFailUntil.get(sessionId);
  if (!until) return false;
  if (Date.now() >= until) {
    ytHardFailUntil.delete(sessionId);
    return false;
  }
  return true;
}

function patchAndBroadcast(
  session: SessionRecord,
  patch: Partial<SubtitleAgentState>,
): void {
  const prev = session.live.subtitleAgent ?? emptySubtitleAgentState();
  session.live.subtitleAgent = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const message = sessionStore.touchSubtitleAgent(session);
  broadcastSession(session.id, message);
}

type AvPlaylistItem = VideoPlaylistItem | AudioPlaylistItem;

type ResolveOk = {
  ok: true;
  item: AvPlaylistItem;
  assetId: string;
  /** Absolute path once media is local (file or after yt-dlp). */
  mediaPath: string | null;
  youtube: null | { videoId: string; sourceUrl: string };
  /** Upload basename for sidecar caption lookup (local file/audio only). */
  originalName: string | null;
};

type ResolveFail = {
  ok: false;
  reason:
    | "no_item"
    | "not_video"
    | "no_asset"
    | "missing_file"
    | "bad_youtube";
  item: PlaylistItem | null;
};

function resolveMediaSource(
  session: SessionRecord,
  itemId: string | null | undefined,
): ResolveOk | ResolveFail {
  const id = itemId || session.live.currentItemId || null;
  if (!id) {
    return { ok: false, reason: "no_item", item: null };
  }
  const item = session.playlist.items.find((i) => i.id === id) ?? null;
  if (!item) {
    return { ok: false, reason: "no_item", item: null };
  }

  // Guion Audio tab (#76) — same ASR / sidecar path as local video files.
  if (item.type === "audio") {
    const assetId = item.payload.assetId;
    const asset = assetStore.get(session.id, assetId);
    if (!asset || asset.kind !== "audio") {
      return { ok: false, reason: "no_asset", item };
    }
    let mediaPath: string;
    try {
      mediaPath = assetStore.getAdapter().resolvePath(asset.storageKey);
    } catch {
      return { ok: false, reason: "missing_file", item };
    }
    return {
      ok: true,
      item,
      assetId,
      mediaPath,
      youtube: null,
      originalName: asset.originalName ?? null,
    };
  }

  if (item.type !== "video") {
    return { ok: false, reason: "not_video", item };
  }

  if (item.payload.sourceKind === "youtube") {
    const videoId = item.payload.videoId?.trim();
    const sourceUrl = item.payload.sourceUrl?.trim();
    if (!videoId) {
      return { ok: false, reason: "bad_youtube", item };
    }
    return {
      ok: true,
      item,
      assetId: `yt_${videoId}`,
      mediaPath: null,
      youtube: {
        videoId,
        sourceUrl: sourceUrl || `https://www.youtube.com/watch?v=${videoId}`,
      },
      originalName: null,
    };
  }

  const assetId = item.payload.assetId;
  const asset = assetStore.get(session.id, assetId);
  if (!asset || asset.kind !== "video") {
    return { ok: false, reason: "no_asset", item };
  }
  let mediaPath: string;
  try {
    mediaPath = assetStore.getAdapter().resolvePath(asset.storageKey);
  } catch {
    return { ok: false, reason: "missing_file", item };
  }
  return {
    ok: true,
    item,
    assetId,
    mediaPath,
    youtube: null,
    originalName: asset.originalName ?? null,
  };
}

function hintForReason(
  reason: ResolveFail["reason"],
  item: PlaylistItem | null,
): string {
  switch (reason) {
    case "not_video":
      if (item?.type === "text" || item?.type === "bible") {
        return "text_only_no_audio";
      }
      return "not_local_av";
    case "no_item":
      return "no_item";
    case "no_asset":
    case "missing_file":
      return "missing_local_file";
    case "bad_youtube":
      return "youtube_invalid";
    default:
      return "unsupported";
  }
}

/**
 * Finish job from caption/ASR cues.
 *
 * Native path (YouTube/sidecar matching UI lang): keep clocks + words as-is,
 * never Marian, exact timing (no intro-hold). ASR fallback may shape + assist.
 */
async function finishWithCues(options: {
  sessionId: string;
  gen: number;
  itemId: string;
  assetId: string;
  cues: import("@promedia/shared").SubtitleCue[];
  sourceLang: string | null;
  targetLang: SubtitleTargetLang;
  alreadyEnglish: boolean;
  /** Official captions / sidecar — skip shape + MT when lang matches UI. */
  nativeTrack?: boolean;
  preserveLyricsSource?: boolean;
  hint?: string | null;
  timingMode?: SubtitleTimingMode;
  /** Optional path default (e.g. cancionero −1s). */
  leadMs?: SubtitleLeadMs;
}): Promise<boolean> {
  const {
    sessionId,
    gen,
    itemId,
    assetId,
    targetLang,
    alreadyEnglish,
    preserveLyricsSource,
    nativeTrack,
  } = options;
  const speech = filterSpeechCues(options.cues).filter(
    (c) =>
      Number.isFinite(c.startMs) &&
      Number.isFinite(c.endMs) &&
      c.endMs > c.startMs,
  );
  let cues = nativeTrack
    ? preserveNativeCaptionCues(speech)
    : shapeLyricLikeCues(speech);
  let translated = alreadyEnglish && targetLang === "en";
  let hint = options.hint ?? null;
  let sourceLang = options.sourceLang;
  const srcBase = langBase(sourceLang) || (alreadyEnglish ? "en" : null);
  const tgtBase = langBase(targetLang) || targetLang;
  const sameLang =
    (srcBase !== null && srcBase === tgtBase) ||
    (speech.length > 0 && cuesLikelyInLanguage(speech, tgtBase));

  // Native matching-lang captions: never Marian, never reshape timings again.
  const skipMt =
    nativeTrack === true ||
    sameLang ||
    (preserveLyricsSource === true && sameLang);

  if (!cues.length) return false;

  if (!skipMt && (targetLang !== "en" || !alreadyEnglish)) {
    const live = sessionStore.get(sessionId);
    if (!live?.live.subtitleAgent?.enabled || !isCurrent(sessionId, gen)) {
      return false;
    }
    patchAndBroadcast(live, { status: "translating" });
    const mt = await translateCuesLocal({
      cues,
      sourceLang,
      targetLang,
      alreadyEnglish,
      // Cross-lang only reaches here; preserve still blocks Marian on lyrics.
      preserveLyricsSource: preserveLyricsSource === true,
    });
    cues = shapeLyricLikeCues(filterSpeechCues(mt.cues));
    translated = mt.translated || translated;
    if (mt.note && !mt.translated) {
      hint =
        mt.note === "mt_lyrics_preserved" ||
        mt.note.startsWith("mt_unavailable")
          ? "mt_source_only"
          : mt.note;
    }
    if (!sourceLang && alreadyEnglish) {
      sourceLang = "en";
    }
  } else if (sameLang && !sourceLang) {
    sourceLang = tgtBase;
  }

  if (!isCurrent(sessionId, gen)) return false;
  const liveFinal = sessionStore.get(sessionId);
  if (!liveFinal?.live.subtitleAgent?.enabled) return false;
  if (!cues.length) return false;

  const timingMode: SubtitleTimingMode =
    options.timingMode ?? (nativeTrack ? "exact" : "assisted");

  if (nativeTrack && !hint) {
    hint = "native_captions";
  }

  clearYtHardFail(sessionId);
  const leadPatch =
    options.leadMs !== undefined
      ? { leadMs: normalizeSubtitleLeadMs(options.leadMs) }
      : {};
  patchAndBroadcast(liveFinal, {
    status: "ready",
    cues,
    sourceLang,
    translated,
    timingMode,
    hint: hint ?? (nativeTrack ? "native_captions" : null),
    itemId,
    assetId,
    cueIndex: null,
    ...leadPatch,
  });
  return true;
}

function mediaKeyFromAssetId(assetId: string | null | undefined): string | null {
  const id = assetId?.trim();
  if (!id) return null;
  if (id.startsWith("yt_")) {
    return cancioneroMediaKey({ youtubeVideoId: id.slice(3) });
  }
  return cancioneroMediaKey({ assetId: id });
}

/** Stamp cue `index` to start at `positionMs`; keep neighbors monotonic. */
function retimedCuesAtIndex(
  cues: readonly SubtitleCue[],
  index: number,
  positionMs: number,
): SubtitleCue[] {
  if (index < 0 || index >= cues.length) return [...cues];
  const now = Math.max(0, Math.round(positionMs));
  const next = cues.map((c) => ({ ...c }));
  const cur = next[index]!;
  cur.startMs = now;
  if (index > 0) {
    const prev = next[index - 1]!;
    prev.endMs = Math.max(prev.startMs + 400, now);
  }
  if (index + 1 < next.length) {
    const following = next[index + 1]!;
    if (following.startMs < now + 400) {
      following.startMs = now + 400;
    }
    cur.endMs = Math.max(now + 500, following.startMs);
  } else {
    cur.endMs = Math.max(now + 800, cur.endMs);
  }
  // Repair forward chain if we pushed following starts.
  for (let i = index + 1; i < next.length; i++) {
    const a = next[i - 1]!;
    const b = next[i]!;
    if (b.startMs < a.startMs + 400) {
      b.startMs = a.startMs + 400;
    }
    a.endMs = Math.max(a.startMs + 400, b.startMs);
  }
  return next;
}

function isStickyMissingBin(agent: SubtitleAgentState | null | undefined): boolean {
  return Boolean(
    agent && agent.status === "error" && isMissingBinHint(agent.hint),
  );
}

function isStickyHardYoutube(
  agent: SubtitleAgentState | null | undefined,
): boolean {
  return Boolean(
    agent && agent.status === "error" && isHardYoutubeHint(agent.hint),
  );
}

/**
 * Timing-only probe for karaoke forced align. Captions/ASR clocks decide
 * *when* to reveal each Biblioteca line — never rewrite the text.
 */
/**
 * Temp-download (YouTube) / open local media → examine real silence → speech onsets.
 */
async function fetchSilenceSpeechOnsets(options: {
  sessionId: string;
  gen: number;
  resolved: ResolveOk;
  onStatus?: (
    status: "downloading" | "extracting" | "transcribing",
    hint: string,
  ) => void;
}): Promise<{
  onsetsMs: number[];
  silences: import("./subtitle-silence.js").SilenceRegion[];
  durationMs: number;
  assetId: string;
  mediaPath: string;
} | null> {
  const { sessionId, gen, resolved } = options;
  let mediaPath = resolved.mediaPath;
  let assetId = resolved.assetId;

  if (resolved.youtube) {
    const haveLocal = mediaPath ? await mediaFileExists(mediaPath) : false;
    if (!haveLocal) {
      options.onStatus?.("downloading", "silence_scan");
      try {
        const yt = await ensureYoutubeAudio({
          videoId: resolved.youtube.videoId,
          sourceUrl: resolved.youtube.sourceUrl,
        });
        if (!isCurrent(sessionId, gen)) return null;
        mediaPath = yt.mediaPath;
        assetId = yt.assetId;
      } catch (err) {
        console.warn(
          "[subtitle] silence-scan YT download failed:",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }
  }

  if (!mediaPath) return null;
  const exists = await mediaFileExists(mediaPath);
  if (!exists) return null;

  options.onStatus?.("extracting", "silence_scan");
  try {
    const analysis = await detectSpeechOnsetsFromSilence(mediaPath);
    if (!isCurrent(sessionId, gen)) return null;
    let durationMs = analysis.durationMs;
    if (durationMs <= 0) {
      durationMs = await probeMediaDurationMs(mediaPath);
    }
    console.log(
      `[subtitle] silence-scan onsets=${analysis.speechOnsetsMs.length} silences=${analysis.silences.length} airMs=${SILENCE_AIR_ANTICIPATION_MS}`,
    );
    return {
      onsetsMs: analysis.speechOnsetsMs,
      silences: analysis.silences,
      durationMs,
      assetId,
      mediaPath,
    };
  } catch (err) {
    console.warn(
      "[subtitle] silence-scan failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function fetchCancioneroTimingCues(options: {
  sessionId: string;
  gen: number;
  targetLang: SubtitleTargetLang;
  resolved: ResolveOk;
  /** Official cancionero lines → Whisper `-prompt` (clocks only). */
  alignPrompt?: string | null;
  onStatus?: (
    status: "downloading" | "extracting" | "transcribing",
    hint: string,
  ) => void;
}): Promise<{ cues: import("@promedia/shared").SubtitleCue[]; assetId: string } | null> {
  const { sessionId, gen, targetLang, resolved } = options;
  let mediaPath = resolved.mediaPath;
  let assetId = resolved.assetId;

  if (resolved.youtube) {
    options.onStatus?.("downloading", "cancionero_sync");
    const preferLangs = expandCaptionPreferLangs([targetLang]);
    try {
      const caps = await tryYoutubeCaptions({
        videoId: resolved.youtube.videoId,
        sourceUrl: resolved.youtube.sourceUrl,
        preferLangs,
      });
      if (!isCurrent(sessionId, gen)) return null;
      if (caps && caps.cues.length > 0) {
        const speech = filterSpeechCues(caps.cues);
        if (speech.length > 0) {
          console.log(
            `[subtitle] cancionero timing from YouTube captions kind=${caps.trackKind} n=${speech.length}`,
          );
          return { cues: speech, assetId: caps.assetId };
        }
      }
    } catch (err) {
      console.warn(
        "[subtitle] cancionero timing captions failed:",
        err instanceof Error ? err.message : err,
      );
    }

    options.onStatus?.("downloading", "cancionero_sync");
    try {
      const yt = await ensureYoutubeAudio({
        videoId: resolved.youtube.videoId,
        sourceUrl: resolved.youtube.sourceUrl,
      });
      if (!isCurrent(sessionId, gen)) return null;
      mediaPath = yt.mediaPath;
      assetId = yt.assetId;
    } catch (err) {
      console.warn(
        "[subtitle] cancionero timing YT audio failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  } else if (mediaPath) {
    options.onStatus?.("extracting", "cancionero_sync");
    try {
      const local = await tryLocalCaptionTracks({
        assetId,
        mediaPath,
        originalName: resolved.originalName,
      });
      if (!isCurrent(sessionId, gen)) return null;
      if (local && local.cues.length > 0) {
        const speech = filterSpeechCues(local.cues);
        if (speech.length > 0) {
          console.log(
            `[subtitle] cancionero timing from local captions origin=${local.origin} n=${speech.length}`,
          );
          return { cues: speech, assetId };
        }
      }
    } catch (err) {
      console.warn(
        "[subtitle] cancionero timing local captions failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (!mediaPath) return null;
  const exists = await mediaFileExists(mediaPath);
  if (!exists) return null;

  options.onStatus?.("transcribing", "cancionero_sync");
  try {
    const asr = await transcribeLocalFile({
      mediaPath,
      assetId,
      translateToEn: false,
      targetLang,
      // Karaoke: prompt biases clocks; ASR words never reach the overlay.
      prompt: options.alignPrompt ?? null,
      onStatus: (st) => options.onStatus?.(st, "cancionero_sync"),
    });
    if (!isCurrent(sessionId, gen)) return null;
    const speech = filterSpeechCues(asr.cues);
    if (speech.length === 0) return null;
    console.log(
      `[subtitle] karaoke timing from ASR n=${speech.length} prompt=${Boolean(options.alignPrompt)}`,
    );
    return { cues: speech, assetId };
  } catch (err) {
    console.warn(
      "[subtitle] karaoke timing ASR failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Guion Audio + YouTube — karaoke when the Biblioteca cancionero matches.
 * Miss / empty lyrics → return false so captions / Whisper auto-generate text.
 * Returns true when the job should stop (karaoke cues ready).
 */
async function tryCancioneroLyricPath(options: {
  sessionId: string;
  gen: number;
  targetLang: SubtitleTargetLang;
  resolved: ResolveOk;
  /** Operator-taught Biblioteca song (educate karaoke). */
  teachSongId?: string;
}): Promise<boolean> {
  const { sessionId, gen, targetLang, resolved, teachSongId } = options;
  const item = resolved.item;
  const isAudio = item.type === "audio";
  const isYoutube =
    item.type === "video" && item.payload.sourceKind === "youtube";
  if (!isAudio && !isYoutube) {
    return false;
  }

  const titles: string[] = [];
  const artists: string[] = [];
  let durationMs = 0;

  if (isAudio) {
    const payloadTitle =
      typeof item.payload.title === "string" ? item.payload.title.trim() : "";
    if (payloadTitle) titles.push(payloadTitle);
    const fromFile = titleFromAudioFilename(resolved.originalName);
    if (fromFile) titles.push(fromFile);
    if (resolved.mediaPath) {
      durationMs = await probeMediaDurationMs(resolved.mediaPath);
    }
  } else if (isYoutube && resolved.youtube) {
    const payloadTitle =
      typeof item.payload.title === "string" ? item.payload.title.trim() : "";
    if (payloadTitle) titles.push(payloadTitle);

    const liveLookup = sessionStore.get(sessionId);
    if (!liveLookup?.live.subtitleAgent?.enabled) return true;
    patchAndBroadcast(liveLookup, {
      enabled: true,
      targetLang,
      status: "downloading",
      itemId: item.id,
      assetId: resolved.assetId,
      hint: "cancionero_lookup",
      cues: [],
      translated: false,
      sourceLang: null,
    });

    const meta = await fetchYoutubeMeta({
      videoId: resolved.youtube.videoId,
      sourceUrl: resolved.youtube.sourceUrl,
    });
    if (!isCurrent(sessionId, gen)) return true;
    if (meta?.title) titles.push(meta.title);
    if (meta?.track) titles.push(meta.track);
    if (meta?.artist) artists.push(meta.artist);
    if (meta?.durationMs) durationMs = meta.durationMs;
  }

  const mediaKey = cancioneroMediaKey({
    youtubeVideoId: resolved.youtube?.videoId,
    assetId: resolved.assetId,
  });

  // 1) Operator teach → memory → fuzzy title match.
  let match: CancioneroMatchHit | null = null;
  /** Set when the lyrics came from LRCLIB (not a Biblioteca song). */
  let lrclib: LrclibSong | null = null;
  let learnSource: "exact" | "lyric" | "fuzzy" | "manual" = "fuzzy";
  if (teachSongId?.trim()) {
    const taught = await resolveCancioneroSongById(teachSongId.trim());
    if (taught) {
      match = taught;
      learnSource = "manual";
      console.log(
        `[subtitle] karaoke taught song="${taught.song.title}" id=${taught.item.id}`,
      );
    }
  }
  if (!match) {
    const remembered =
      (await recallCancioneroByMedia(mediaKey)) ??
      (await recallCancioneroByTitles(titles));
    if (remembered) {
      const hit = await resolveCancioneroSongById(remembered.songId);
      if (hit) {
        // Fuzzy memory once mapped "Dios ha sido fiel" → "Dios ha sido bueno".
        // Manual/exact memory wins; fuzzy must still agree with the media title.
        const titleScore = Math.max(
          0,
          ...titles.map((t) => scoreSongMatch(hit.song, t)),
        );
        const trustMemory =
          remembered.source === "manual" ||
          remembered.source === "exact" ||
          titleScore >= 70;
        if (trustMemory) {
          match = hit;
          learnSource = remembered.source;
          console.log(
            `[subtitle] karaoke memory hit key=${mediaKey ?? "title"} song="${hit.song.title}" source=${remembered.source} titleScore=${titleScore}`,
          );
        } else {
          console.warn(
            `[subtitle] karaoke memory rejected song="${hit.song.title}" source=${remembered.source} titleScore=${titleScore} — rematch by title`,
          );
        }
      }
    }
  }

  const listed = await findCancioneroSongCandidates(
    { titles, artists },
    { minScore: 40, limit: 5 },
  );
  if (!isCurrent(sessionId, gen)) return true;

  if (!match) {
    // Require a firmer title hit so near-miss hymns (fiel/bueno) do not stick.
    const strong = listed.candidates.filter((c) => c.score >= 70);
    if (strong.length === 0) {
      console.warn(
        `[subtitle] cancionero miss (${listed.reason ?? "no_match"}) tried=${JSON.stringify(listed.tried)}`,
      );
      // Biblioteca has no such song: try the open LRCLIB database for the real
      // lyrics before falling back to captions / Whisper's (often wrong) text.
      const lr = await findLrclibSong({ titles, artists, durationMs });
      if (!isCurrent(sessionId, gen)) return true;
      if (!lr) {
        console.warn(
          "[subtitle] lrclib miss — auto-generate lyrics via captions/Whisper",
        );
        // Continue runSubtitleJob → YouTube captions or Whisper ASR as lyric text.
        return false;
      }
      lrclib = lr;
      const now = new Date().toISOString();
      match = {
        ok: true,
        item: {
          id: lr.id,
          category: "canciones",
          title: lr.song.title,
          createdAt: now,
          updatedAt: now,
          song: lr.song,
        },
        song: lr.song,
        score: lr.score,
        matchedQuery: lr.matchedQuery,
      };
      // Like an operator-taught song: never swapped for a Biblioteca near-miss.
      learnSource = "manual";
      console.log(
        `[subtitle] lrclib hit "${lr.song.title}" by ${lr.song.artist ?? "?"} lines=${songCancioneroLines(lr.song).length} synced=${lr.syncedCues != null} score=${lr.score}`,
      );
    } else {
      match = strong[0]!;
      learnSource = match.score >= 100 ? "exact" : "fuzzy";
    }
  }

  // Merge memory + title candidates for lyric learning / disambiguation.
  const pool: CancioneroMatchHit[] = [];
  const seenIds = new Set<string>();
  const pushCand = (c: CancioneroMatchHit) => {
    if (seenIds.has(c.item.id)) return;
    seenIds.add(c.item.id);
    pool.push(c);
  };
  pushCand(match);
  for (const c of listed.candidates) pushCand(c);

  const ambiguous =
    pool.length > 1 &&
    (match.score < 95 ||
      (pool[1] != null && pool[1].score >= match.score - 25));

  // Karaoke phrase model: words until the singer breathes → blank on silence →
  // next Biblioteca renglón appears early (air) before the voice returns.
  const liveSync = sessionStore.get(sessionId);
  if (!liveSync?.live.subtitleAgent?.enabled) return true;

  let lines = songCancioneroLines(match.song);
  if (!lines.length) {
    console.warn(
      `[subtitle] cancionero empty lyrics for "${match.song.title}" — auto-generate via captions/Whisper`,
    );
    return false;
  }

  const statusPatch = (
    status: "downloading" | "extracting" | "transcribing",
    hint: string,
  ) => {
    if (!isCurrent(sessionId, gen)) return;
    const live = sessionStore.get(sessionId);
    if (!live?.live.subtitleAgent?.enabled) return;
    // Do NOT clear cues here — wiping them left Output blank while WhisperX ran.
    patchAndBroadcast(live, {
      status,
      hint,
      itemId: item.id,
      assetId: resolved.assetId,
    });
  };

  // Ensure local audio exists (YouTube download) before WhisperX / silence blank.
  let mediaPath = resolved.mediaPath;
  let assetId = resolved.assetId;
  if (resolved.youtube) {
    const haveLocal = mediaPath ? await mediaFileExists(mediaPath) : false;
    if (!haveLocal) {
      statusPatch("downloading", "whisperx_align");
      try {
        const yt = await ensureYoutubeAudio({
          videoId: resolved.youtube.videoId,
          sourceUrl: resolved.youtube.sourceUrl,
        });
        if (!isCurrent(sessionId, gen)) return true;
        mediaPath = yt.mediaPath;
        assetId = yt.assetId;
      } catch (err) {
        console.warn(
          "[subtitle] karaoke YT download failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  if (mediaPath) {
    const probed = await probeMediaDurationMs(mediaPath);
    if (probed > 0) durationMs = Math.max(durationMs, probed);
  }
  if (!isCurrent(sessionId, gen)) return true;

  let lineCues = lrclib?.syncedCues
    ? lrclib.syncedCues.map((c) => ({ ...c }))
    : songToSubtitleCues(match.song, durationMs);
  let synced = false;
  /** Lyric-confirmed clocks (captions / WhisperX). */
  let textSynced = false;
  let timingModeHint = "cancionero_match";
  let published = false;

  const publishKaraokeCues = async (
    nextLineCues: SubtitleCue[],
    hint: string,
  ): Promise<boolean> => {
    // One cue = one full Biblioteca renglón (never caption fragments).
    let nextCues = packKaraokeDisplayCues(
      ensureCancioneroCueTexts(nextLineCues, lines),
      1,
      1,
    );
    const taughtTiming = await recallCancioneroTiming(mediaKey);
    if (taughtTiming?.cueStarts?.length) {
      nextCues = applyRememberedCueStarts(nextCues, taughtTiming.cueStarts);
    }
    if (!nextCues.length) return false;
    // Declare what these cues are built from so they can be saved to disk.
    // Partial alignments are never persisted.
    const lyricsFrom: "cancionero" | "lrclib" = lrclib ? "lrclib" : "cancionero";
    if (!hint.endsWith("_partial") && match) {
      setPersistMeta(assetId, {
        songId: match.item.id,
        lyricsHash: lyricsHash(lines),
        source: lyricsFrom,
        lrclibSong: lrclib
          ? {
              title: lrclib.song.title,
              artist: lrclib.song.artist,
              lines: [...lines],
            }
          : undefined,
      });
    } else {
      clearPersistMeta(assetId);
    }
    const okPub = await finishWithCues({
      sessionId,
      gen,
      itemId: item.id,
      assetId,
      cues: nextCues,
      sourceLang: targetLang,
      targetLang,
      alreadyEnglish: targetLang === "en",
      nativeTrack: true,
      preserveLyricsSource: true,
      timingMode: "exact",
      hint,
      leadMs: CANCIONERO_DEFAULT_LEAD_MS,
    });
    if (okPub) {
      const liveSrc = sessionStore.get(sessionId);
      if (liveSrc?.live.subtitleAgent?.itemId === item.id) {
        patchAndBroadcast(liveSrc, { lyricsSource: lyricsFrom });
      }
      return true;
    }
    if (!isCurrent(sessionId, gen)) return false;
    const liveForce = sessionStore.get(sessionId);
    if (!liveForce?.live.subtitleAgent?.enabled) return false;
    patchAndBroadcast(liveForce, {
      status: "ready",
      cues: nextCues,
      sourceLang: targetLang,
      translated: false,
      timingMode: "exact",
      hint: hint || "cancionero_match_force",
      itemId: item.id,
      assetId,
      cueIndex: null,
      leadMs: CANCIONERO_DEFAULT_LEAD_MS,
      lyricsSource: lyricsFrom,
    });
    return true;
  };

  // Silence map runs in parallel with captions — used ONLY to blank at phrase end.
  const silencePromise = fetchSilenceSpeechOnsets({
    sessionId,
    gen,
    resolved: { ...resolved, mediaPath, assetId },
    onStatus: statusPatch,
  });

  // Do NOT publish equal-time placeholders. They look "ready" on first Go Live
  // with wrong clocks; after rewind the real captions already won and it
  // seemed to only work the second time. Keep status busy until real sync.
  statusPatch("extracting", "cancionero_align");
  if (!isCurrent(sessionId, gen)) return true;

  // 1) Captions/ASR clocks (YouTube official tracks are best for pop videos).
  let timing:
    | { cues: import("@promedia/shared").SubtitleCue[]; assetId: string }
    | null = null;
  {
    const alignPrompt = buildKaraokeAlignPrompt(lines);
    timing = await fetchCancioneroTimingCues({
      sessionId,
      gen,
      targetLang,
      resolved: { ...resolved, mediaPath, assetId },
      alignPrompt,
      onStatus: statusPatch,
    });
    if (!isCurrent(sessionId, gen)) return true;
  }

  const silence = await silencePromise;
  if (!isCurrent(sessionId, gen)) return true;
  if (silence && silence.durationMs > 0) {
    durationMs = Math.max(durationMs, silence.durationMs);
    assetId = silence.assetId || assetId;
    mediaPath = silence.mediaPath || mediaPath;
  }
  const phraseSilences = silence?.silences ?? [];
  const timingSpeech = timing ? filterSpeechCues(timing.cues) : [];
  const firstVoiceMs = resolveFirstVoiceOnsetMs(
    phraseSilences,
    silence?.onsetsMs ?? [],
    timingSpeech[0]?.startMs ?? null,
  );

  const withVoiceAndBlank = (cues: SubtitleCue[]): SubtitleCue[] =>
    blankCuesAtPhraseSilence(
      anchorFirstCueToVoiceOnset(cues, firstVoiceMs),
      phraseSilences,
      durationMs,
      SILENCE_AIR_ANTICIPATION_MS,
    );

  if (timing && timing.cues.length > 0) {
    const textAligned = alignCancioneroLinesToTiming(
      lines,
      timing.cues,
      durationMs,
    );
    if (textAligned.cues.length > 0) {
      // Caption clocks + first line on voice; silence only blanks after last word.
      lineCues = withVoiceAndBlank(textAligned.cues);
      textSynced = textAligned.synced;
      synced = textAligned.synced;
      assetId = timing.assetId || assetId;
      timingModeHint = synced
        ? "cancionero_match_captions"
        : "cancionero_match_captions_partial";
      console.log(
        `[subtitle] karaoke captions synced=${synced} aligned=${textAligned.alignedCount}/${lines.length} voice0=${firstVoiceMs ?? "n/a"} silenceBlank=${phraseSilences.length > 0}`,
      );
      published =
        (await publishKaraokeCues(lineCues, timingModeHint)) || published;
    }
  }

  // LRCLIB line clocks (community-timed to this audio, duration-checked).
  // On dense music wav2vec2 forced alignment can drift by 10+ s, so these
  // clocks win over WhisperX; silence only blanks at the breath.
  if (lrclib?.syncedCues && !textSynced) {
    lineCues = blankCuesAtPhraseSilence(
      lrclib.syncedCues,
      phraseSilences,
      durationMs,
      SILENCE_AIR_ANTICIPATION_MS,
    );
    textSynced = true;
    synced = true;
    timingModeHint = "cancionero_lrclib_synced";
    console.log(
      `[subtitle] karaoke lrclib clocks lines=${lineCues.length} first=${lineCues[0]?.startMs ?? "n/a"} silenceBlank=${phraseSilences.length > 0}`,
    );
    published =
      (await publishKaraokeCues(lineCues, timingModeHint)) || published;
  }

  // 2) WhisperX when captions did not lyric-confirm.
  const canWhisperx = mediaPath ? await whisperxAvailable() : false;
  if (!textSynced && canWhisperx && mediaPath) {
    const wx = await alignLyricsWithWhisperx({
      mediaPath,
      assetId,
      lines,
      language: targetLang === "en" ? "en" : "es",
      durationMs,
      // Air is applied once, by blankCuesAtPhraseSilence below.
      airMs: 0,
      onStatus: (st) => statusPatch(st, "whisperx_align"),
    });
    if (!isCurrent(sessionId, gen)) return true;
    if (wx && wx.cues.length > 0) {
      // Prefer WhisperX first-word clock when silence has no leading quiet.
      const wxVoice =
        resolveFirstVoiceOnsetMs(
          phraseSilences,
          silence?.onsetsMs ?? [],
          wx.cues[0]?.startMs ?? null,
        ) ?? firstVoiceMs;
      lineCues = blankCuesAtPhraseSilence(
        anchorFirstCueToVoiceOnset(wx.cues, wxVoice),
        phraseSilences,
        durationMs,
        SILENCE_AIR_ANTICIPATION_MS,
      );
      synced = wx.cues.length >= Math.max(1, Math.ceil(lines.length * 0.5));
      textSynced = synced;
      if (wx.durationMs > 0) durationMs = Math.max(durationMs, wx.durationMs);
      timingModeHint = synced
        ? "cancionero_match_whisperx"
        : "cancionero_match_whisperx_partial";
      console.log(
        `[subtitle] karaoke whisperx synced=${synced} lines=${wx.cues.length}/${lines.length} voice0=${wxVoice ?? "n/a"} silenceBlank=${phraseSilences.length > 0}`,
      );
      published =
        (await publishKaraokeCues(lineCues, timingModeHint)) || published;
    }
  } else if (!textSynced && !canWhisperx) {
    console.warn(
      "[subtitle] whisperx not installed — using caption karaoke align",
    );
  }

  // 3) Lyric disambiguation when several cancionero candidates compete.
  if (timing && (!textSynced || (ambiguous && learnSource !== "manual"))) {
    if (
      learnSource !== "manual" &&
      timing &&
      timing.cues.length > 0 &&
      (ambiguous || pool.length > 1)
    ) {
      const timingTexts = timing.cues.map((c) => c.text);
      let bestLyric: {
        hit: CancioneroMatchHit;
        lyric: number;
        combined: number;
      } | null = null;
      for (const cand of pool) {
        const lyric = scoreSongLyricOverlap(cand.song, timingTexts);
        const combined = Math.round(cand.score * 0.35 + lyric * 0.65);
        if (
          !bestLyric ||
          combined > bestLyric.combined ||
          (combined === bestLyric.combined && lyric > bestLyric.lyric)
        ) {
          bestLyric = { hit: cand, lyric, combined };
        }
      }
      if (
        bestLyric &&
        bestLyric.lyric >= 12 &&
        bestLyric.hit.item.id !== match.item.id
      ) {
        console.log(
          `[subtitle] karaoke lyric-learn switch "${match.song.title}" → "${bestLyric.hit.song.title}" lyric=${bestLyric.lyric} combined=${bestLyric.combined}`,
        );
        match = bestLyric.hit;
        learnSource = "lyric";
        lines = songCancioneroLines(match.song);
        const realigned = alignCancioneroLinesToTiming(
          lines,
          timing.cues,
          durationMs,
        );
        lineCues = withVoiceAndBlank(
          realigned.cues.length > 0
            ? realigned.cues
            : songToSubtitleCues(match.song, durationMs),
        );
        textSynced = realigned.synced;
        synced = realigned.synced;
      } else if (bestLyric && bestLyric.lyric >= 18) {
        learnSource = learnSource === "exact" ? "exact" : "lyric";
      }
    }

    if (!lines.length) {
      console.warn(
        "[subtitle] cancionero lines cleared after lyric-learn — auto-generate via captions/Whisper",
      );
      return false;
    }

    if (!textSynced && timing && timing.cues.length > 0) {
      const aligned = alignCancioneroLinesToTiming(
        lines,
        timing.cues,
        durationMs,
      );
      lineCues = withVoiceAndBlank(aligned.cues);
      textSynced = aligned.synced;
      synced = aligned.synced;
      assetId = timing.assetId || assetId;
      timingModeHint = synced
        ? "cancionero_match_captions"
        : "cancionero_match_captions_partial";
    }
  }

  // Equal-time fallback: still open on first voice, blank on phrase-end silence.
  if (!textSynced && lineCues.length > 0) {
    lineCues = withVoiceAndBlank(lineCues);
  }

  // Final publish if ASR/lyric-learn improved clocks after the baseline.
  if (lineCues.length > 0) {
    published =
      (await publishKaraokeCues(lineCues, timingModeHint)) || published;
  }

  if (!published && !lineCues.length) {
    const live = sessionStore.get(sessionId);
    if (!live?.live.subtitleAgent?.enabled) return true;
    patchAndBroadcast(live, {
      enabled: true,
      targetLang,
      status: "error",
      itemId: item.id,
      assetId,
      cues: [],
      translated: false,
      sourceLang: null,
      hint: "cancionero_empty",
      timingMode: "exact",
    });
    return true;
  }

  console.log(
    `[subtitle] karaoke match score=${match.score} q="${match.matchedQuery}" song="${match.song.title}" learn=${learnSource} lines=${lineCues.length} synced=${synced} published=${published}`,
  );

  // Remember for next time — never persist weak fuzzy near-misses.
  const rememberOk =
    learnSource === "manual" ||
    learnSource === "exact" ||
    learnSource === "lyric" ||
    match.score >= 85;
  // LRCLIB songs are not in the Biblioteca — their ids would not resolve later.
  if (rememberOk && !lrclib) {
    void rememberCancioneroMatch({
      mediaKey,
      titles,
      songId: match.item.id,
      songTitle: match.song.title,
      source: learnSource,
    }).catch((err) => {
      console.warn(
        "[subtitle] cancionero memory save failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }

  return published || lineCues.length > 0;
}

async function missingBinStillAbsent(hint: string): Promise<boolean> {
  if (hint === "yt_dlp_missing") {
    return !(await ytDlpAvailable());
  }
  if (hint === "ffmpeg_missing") {
    return !(await ffmpegAvailable());
  }
  if (hint === "whisper_cpp_missing") {
    return !(await whisperCliAvailable());
  }
  return true;
}

/**
 * Operator educates karaoke: bind current A/V media to a Biblioteca song,
 * remember it, and re-run forced align with that letter.
 */
export function teachSubtitleCancionero(
  session: SessionRecord,
  patch: { songId: string; itemId?: string },
): HubMessage {
  const songId = String(patch.songId ?? "").trim();
  const prev = session.live.subtitleAgent ?? emptySubtitleAgentState();
  if (!songId) {
    return sessionStore.touchSubtitleAgent(session);
  }
  const itemId = patch.itemId?.trim() || undefined;
  session.live.subtitleAgent = {
    ...prev,
    enabled: true,
    status: "idle",
    hint: "cancionero_teach",
    cues: [],
    cueIndex: null,
    translated: false,
    sourceLang: null,
    updatedAt: new Date().toISOString(),
  };
  const message = sessionStore.touchSubtitleAgent(session);
  forgetReadyAgent(session.id, itemId ?? session.live.currentItemId ?? undefined);
  {
    const target = resolveMediaSource(
      session,
      itemId ?? session.live.currentItemId ?? undefined,
    );
    if (target.ok) void forgetPersistedAgent(target.assetId);
  }
  void runSubtitleJob(session.id, itemId ?? session.live.currentItemId ?? undefined, {
    force: true,
    teachSongId: songId,
    source: "teach",
  });
  return message;
}

/**
 * Operator steps karaoke on Preview with ←/→ (does not seek the media clock).
 * → show next cue and teach “this line starts now” at positionMs.
 * ← previous cue, or blank (−1) before the first; delays the left-behind cue
 *   so auto timing will not flash it again at the current position.
 */
export function nudgeSubtitleCancionero(
  session: SessionRecord,
  patch: { delta: -1 | 1; positionMs?: number; itemId?: string },
): HubMessage {
  const prev = session.live.subtitleAgent ?? emptySubtitleAgentState();
  const cues = prev.cues;
  if (!prev.enabled || prev.status !== "ready" || cues.length === 0) {
    return sessionStore.touchSubtitleAgent(session);
  }

  const clock = session.live.mediaClock;
  const positionMs =
    typeof patch.positionMs === "number" && Number.isFinite(patch.positionMs)
      ? Math.max(0, patch.positionMs)
      : Math.max(0, clock?.positionMs ?? 0);

  // Manual blank (−1) must win over clock lookup.
  const current =
    prev.cueIndex === -1
      ? -1
      : prev.cueIndex != null &&
          prev.cueIndex >= 0 &&
          prev.cueIndex < cues.length
        ? prev.cueIndex
        : cueIndexAtPositionMs(cues, positionMs);

  const delta: -1 | 1 = patch.delta === -1 ? -1 : 1;
  let nextIndex: number;
  if (delta === 1) {
    nextIndex = current < 0 ? 0 : Math.min(cues.length - 1, current + 1);
  } else {
    // Allow stepping to blank before the first lyric.
    nextIndex = current <= 0 ? -1 : current - 1;
  }

  let nextCues = [...cues];
  if (delta === 1) {
    // → teaches: the line we land on starts at the operator’s wall clock.
    nextCues = retimedCuesAtIndex(cues, nextIndex, positionMs);
  } else if (current >= 0 && current < cues.length) {
    // ← means “too early”: push the cue we leave so it starts after now.
    const delayTo = Math.max(positionMs + 500, Math.round(positionMs) + 500);
    if (cues[current]!.startMs <= positionMs + 50) {
      nextCues = retimedCuesAtIndex(cues, current, delayTo);
    }
  }

  if (delta === 1 || (delta === -1 && current >= 0)) {
    const mediaKey = mediaKeyFromAssetId(prev.assetId);
    if (mediaKey) {
      void rememberCancioneroTiming({
        mediaKey,
        cueStarts: nextCues.map((c) => c.startMs),
      }).catch((err) => {
        console.warn(
          "[subtitle] cancionero timing save failed:",
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  session.live.subtitleAgent = {
    ...prev,
    cues: nextCues,
    cueIndex: nextIndex,
    hint: "cancionero_nudge",
    updatedAt: new Date().toISOString(),
  };

  return sessionStore.touchSubtitleAgent(session);
}

/**
 * Apply enable/lang patch and kick off local ASR when appropriate.
 * Always returns a HubMessage (session.updated).
 */
export function setSubtitleAgent(
  session: SessionRecord,
  patch: {
    enabled?: boolean;
    targetLang?: SubtitleTargetLang;
    fontSize?: SubtitleFontSize;
    leadMs?: SubtitleLeadMs;
    itemId?: string;
  },
): HubMessage {
  const prev = session.live.subtitleAgent ?? emptySubtitleAgentState();
  const enabled = patch.enabled ?? prev.enabled;
  const targetLang = patch.targetLang ?? prev.targetLang;
  const fontSize = patch.fontSize ?? prev.fontSize ?? "md";
  const leadMs =
    patch.leadMs !== undefined
      ? normalizeSubtitleLeadMs(patch.leadMs)
      : normalizeSubtitleLeadMs(prev.leadMs ?? DEFAULT_SUBTITLE_LEAD_MS);
  const wasOff = !prev.enabled;
  const stickyMissing = isStickyMissingBin(prev);
  // Size / lead-only: persist without restarting ASR.
  const displayOnly =
    (patch.fontSize !== undefined || patch.leadMs !== undefined) &&
    patch.enabled === undefined &&
    patch.targetLang === undefined &&
    patch.itemId === undefined;

  if (!enabled) {
    bumpJob(session.id);
    clearYtHardFail(session.id);
    session.live.subtitleAgent = {
      ...emptySubtitleAgentState(targetLang),
      enabled: false,
      status: "off",
      fontSize,
      leadMs,
      updatedAt: new Date().toISOString(),
    };
    return sessionStore.touchSubtitleAgent(session);
  }

  if (displayOnly) {
    session.live.subtitleAgent = {
      ...prev,
      enabled: true,
      fontSize,
      leadMs,
      updatedAt: new Date().toISOString(),
    };
    return sessionStore.touchSubtitleAgent(session);
  }

  // Keep missing-binary / hard YT visible when focus/lang changes; only clear
  // on toggle-on (wasOff). Cancionero miss falls through to auto ASR lyrics.
  const stickyHardYt = isStickyHardYoutube(prev);
  const keepSticky = (stickyMissing || stickyHardYt) && !wasOff;
  if (wasOff) {
    clearYtHardFail(session.id);
  }

  session.live.subtitleAgent = {
    ...prev,
    enabled: true,
    targetLang,
    fontSize,
    leadMs,
    status: keepSticky
      ? "error"
      : prev.status === "ready" && prev.targetLang === targetLang
        ? "ready"
        : "idle",
    hint: keepSticky ? prev.hint : null,
    updatedAt: new Date().toISOString(),
  };

  const message = sessionStore.touchSubtitleAgent(session);

  // Fire-and-forget local job (does not block WS).
  // force=true only when enabling from off (user toggle) — retries missing bins / YT.
  void runSubtitleJob(session.id, patch.itemId, {
    force: wasOff,
    source: "toggle_or_set",
  });

  return message;
}

/** Re-run when Go Live changes the A/V item under an active agent. */
export function maybeRefreshSubtitleAgent(session: SessionRecord): void {
  const agent = session.live.subtitleAgent;
  if (!agent?.enabled) return;
  const nextItemId = session.live.currentItemId ?? undefined;
  const resolved = nextItemId
    ? resolveMediaSource(session, nextItemId)
    : null;
  const nextAssetId = resolved?.ok ? resolved.assetId : null;
  const itemChanged =
    Boolean(nextItemId) &&
    (agent.itemId !== nextItemId ||
      (nextAssetId != null && agent.assetId !== nextAssetId));

  // Already aligned earlier: runSubtitleJob restores it right away, no blank gap.
  const cached =
    itemChanged && resolved?.ok
      ? recallReadyAgent(
          session.id,
          resolved.item.id,
          resolved.assetId,
          agent.targetLang,
        )
      : null;

  // Drop the previous theme's lyrics immediately — otherwise Output keeps
  // showing the old cancionero until (or instead of) the new align.
  if (itemChanged && !cached) {
    session.live.subtitleAgent = {
      ...agent,
      status: "downloading",
      itemId: nextItemId ?? null,
      assetId: nextAssetId,
      cues: [],
      cueIndex: null,
      hint: "cancionero_align",
      sourceLang: null,
      translated: false,
      updatedAt: new Date().toISOString(),
    };
    broadcastSession(
      session.id,
      sessionStore.touchSubtitleAgent(session),
    );
  }

  // Force on theme change so sticky-ready / YT backoff cannot skip the new song.
  if (itemChanged) {
    clearYtHardFail(session.id);
  }
  void runSubtitleJob(session.id, nextItemId, {
    force: itemChanged,
    source: "go_live",
  });
}

// ── Preparar Guion: pre-align every A/V item before the service ──────────

const prepareTokens = new Map<string, number>();

function isPrepareTarget(item: PlaylistItem): boolean {
  return (
    item.type === "audio" ||
    (item.type === "video" && item.payload.sourceKind === "youtube")
  );
}

function setPrepareState(
  session: SessionRecord,
  prepare: SubtitleAgentState["prepare"],
): HubMessage {
  const prev = session.live.subtitleAgent ?? emptySubtitleAgentState();
  session.live.subtitleAgent = {
    ...prev,
    prepare,
    updatedAt: new Date().toISOString(),
  };
  const message = sessionStore.touchSubtitleAgent(session);
  broadcastSession(session.id, message);
  return message;
}

/**
 * Operator asks to pre-align the whole Guion (queue, one item at a time).
 * Refused while an A/V item is projecting: the agent holds one item's cues
 * and processing another would blank the live karaoke.
 */
export function prepareSubtitleAgent(
  session: SessionRecord,
  patch: { cancel?: boolean },
): HubMessage | { error: string } {
  const prev = session.live.subtitleAgent ?? emptySubtitleAgentState();

  if (patch.cancel) {
    prepareTokens.set(session.id, (prepareTokens.get(session.id) ?? 0) + 1);
    return setPrepareState(
      session,
      prev.prepare ? { ...prev.prepare, running: false, currentItemId: null } : null,
    );
  }
  if (prev.prepare?.running) return { error: "prepare_running" };

  const liveItem = session.live.currentItemId
    ? session.playlist.items.find((i) => i.id === session.live.currentItemId)
    : null;
  if (liveItem && (liveItem.type === "video" || liveItem.type === "audio")) {
    return { error: "live_av_busy" };
  }
  const ids = session.playlist.items.filter(isPrepareTarget).map((i) => i.id);
  if (ids.length === 0) return { error: "no_av_items" };

  const token = (prepareTokens.get(session.id) ?? 0) + 1;
  prepareTokens.set(session.id, token);
  session.live.subtitleAgent = { ...prev, enabled: true };
  const message = setPrepareState(session, {
    running: true,
    total: ids.length,
    done: 0,
    failed: 0,
    currentItemId: null,
  });
  void runPrepare(session.id, ids, token);
  return message;
}

async function runPrepare(
  sessionId: string,
  ids: string[],
  token: number,
): Promise<void> {
  let done = 0;
  let failed = 0;
  console.log(`[subtitle] prepare start items=${ids.length}`);
  for (const id of ids) {
    const session = sessionStore.get(sessionId);
    if (!session || prepareTokens.get(sessionId) !== token) return;
    const live = session.live.currentItemId
      ? session.playlist.items.find((i) => i.id === session.live.currentItemId)
      : null;
    if (live && (live.type === "video" || live.type === "audio")) {
      console.log("[subtitle] prepare aborted: an A/V item went live");
      break;
    }
    setPrepareState(session, {
      running: true,
      total: ids.length,
      done,
      failed,
      currentItemId: id,
    });
    try {
      await runSubtitleJob(sessionId, id, { force: true, source: "prepare" });
      const st = sessionStore.get(sessionId)?.live.subtitleAgent;
      if (!st || st.itemId !== id || st.status !== "ready") failed += 1;
    } catch {
      failed += 1;
    }
    done += 1;
  }
  const session = sessionStore.get(sessionId);
  if (session && prepareTokens.get(sessionId) === token) {
    setPrepareState(session, {
      running: false,
      total: ids.length,
      done,
      failed,
      currentItemId: null,
    });
    console.log(`[subtitle] prepare done ok=${done - failed} failed=${failed}`);
  }
}

// ── Guardar la letra de LRCLIB en la Biblioteca (sugerida) ───────────────

function cleanSongTitle(raw: string): string {
  return raw
    .replace(
      /\s*[(\[](?:official|oficial|lyric|letra|video|v[ií]deo|audio|visualizer|hd|4k)[^)\]]*[)\]]\s*$/gi,
      "",
    )
    .trim();
}

function setAgentHint(sessionId: string, hint: string, extra?: Partial<SubtitleAgentState>): void {
  const s = sessionStore.get(sessionId);
  if (!s) return;
  patchAndBroadcast(s, { hint, ...extra });
}

/**
 * Save the LRCLIB lyrics behind the current item into the Biblioteca as a
 * "suggested" song (reviewed=false). Never overwrites an existing song.
 */
export function saveLrclibLyricsToLibrary(
  session: SessionRecord,
): HubMessage | { error: string } {
  const agent = session.live.subtitleAgent;
  if (!agent || agent.lyricsSource !== "lrclib" || !agent.assetId) {
    return { error: "no_lrclib_lyrics" };
  }
  const sessionId = session.id;
  const assetId = agent.assetId;
  const targetLang = agent.targetLang;
  void (async () => {
    try {
      const song =
        getPersistMeta(assetId)?.lrclibSong ??
        (await loadPersistedAgent(assetId, targetLang))?.lrclibSong;
      if (!song || song.lines.length === 0) {
        setAgentHint(sessionId, "lyrics_save_failed");
        return;
      }
      const title = cleanSongTitle(song.title) || song.title;
      const key = songIdentityKey(title, song.artist);
      const existing = (await libraryStore.list({ category: "canciones" })).find(
        (i) => i.song && songIdentityKey(i.song.title, i.song.artist) === key,
      );
      if (existing) {
        setAgentHint(sessionId, "lyrics_exists");
        return;
      }
      const created = await libraryStore.createSong({
        title,
        artist: song.artist,
        stanzas: [{ id: "lrclib", lines: song.lines }],
        source: "lrclib",
        reviewed: false,
      });
      if ("error" in created) {
        setAgentHint(sessionId, "lyrics_save_failed");
        return;
      }
      // Bind this video to the saved song so the next lookup finds it.
      await rememberCancioneroMatch({
        mediaKey: cancioneroMediaKey({ youtubeVideoId: assetId.replace(/^yt_/, "") }),
        titles: [title],
        songId: created.id,
        songTitle: title,
        source: "manual",
      });
      console.log(`[subtitle] lrclib lyrics saved to Biblioteca "${title}"`);
      setAgentHint(sessionId, "lyrics_saved", { lyricsSource: "cancionero" });
    } catch (err) {
      console.warn(
        "[subtitle] save lrclib lyrics failed:",
        err instanceof Error ? err.message : err,
      );
      setAgentHint(sessionId, "lyrics_save_failed");
    }
  })();
  return sessionStore.touchSubtitleAgent(session);
}

/**
 * When a YouTube (or audio) link lands in Guion: enable karaoke and examine
 * the downloaded media (silence → cancionero cues). Fire-and-forget.
 */
export function maybeStartKaraokeOnGuionItem(
  session: SessionRecord,
  item: PlaylistItem,
): void {
  const isYoutube =
    item.type === "video" && item.payload.sourceKind === "youtube";
  const isAudio = item.type === "audio";
  if (!isYoutube && !isAudio) return;

  // Another item is projecting: starting here would overwrite the agent state
  // (cues cleared) and blank the live karaoke. It is aligned on its own Go Live
  // (or restored from the per-item cache if it was already processed).
  const liveId = session.live.currentItemId;
  if (liveId && liveId !== item.id) {
    console.log(
      `[subtitle] skip prefetch item=${item.id} (live item ${liveId} is projecting)`,
    );
    return;
  }

  const prev = session.live.subtitleAgent ?? emptySubtitleAgentState();
  const targetLang = prev.targetLang ?? "es";
  session.live.subtitleAgent = {
    ...prev,
    enabled: true,
    targetLang,
    status: "idle",
    itemId: item.id,
    hint: isYoutube ? "silence_scan" : prev.hint,
    cues: prev.itemId === item.id ? prev.cues : [],
    updatedAt: new Date().toISOString(),
  };
  const message = sessionStore.touchSubtitleAgent(session);
  broadcastSession(session.id, message);
  void runSubtitleJob(session.id, item.id, { force: true, source: "guion_add" });
}

/** In-flight job per session — lets non-forced triggers join instead of restart. */
const inflightJobs = new Map<string, { key: string; at: number }>();
const INFLIGHT_MAX_AGE_MS = 5 * 60_000;
/** Guion adds waiting for the running job to finish (per session). */
const pendingAdds = new Map<string, string[]>();

/** Is a persisted result still trustworthy (lyrics unchanged)? */
async function persistedStillValid(saved: PersistedAgent): Promise<boolean> {
  if (saved.source === "lrclib") return true;
  const hit = await resolveCancioneroSongById(saved.songId);
  if (!hit) return false;
  return lyricsHash(songCancioneroLines(hit.song)) === saved.lyricsHash;
}

/**
 * Load a saved alignment for this YouTube video into the agent state.
 * Returns true when the agent now shows the restored (ready) cues.
 */
async function restorePersistedAgent(
  sessionId: string,
  itemId: string,
  assetId: string,
  targetLang: SubtitleTargetLang,
  cancelRunning: boolean,
): Promise<boolean> {
  const saved = await loadPersistedAgent(assetId, targetLang);
  if (!saved || !(await persistedStillValid(saved))) return false;
  const session = sessionStore.get(sessionId);
  const cur = session?.live.subtitleAgent;
  if (!session || !cur?.enabled) return false;
  if (cancelRunning) {
    bumpJob(sessionId); // cancel an in-flight job for another item
    inflightJobs.delete(sessionId);
  }
  setPersistMeta(assetId, {
    songId: saved.songId,
    lyricsHash: saved.lyricsHash,
    source: saved.source,
    lrclibSong: saved.lrclibSong,
  });
  session.live.subtitleAgent = {
    ...cur,
    enabled: true,
    status: "ready",
    targetLang,
    itemId,
    assetId,
    cues: saved.agent.cues.map((c) => ({ ...c })),
    hint: saved.agent.hint ?? "cancionero_restored",
    timingMode: saved.agent.timingMode,
    sourceLang: saved.agent.sourceLang,
    translated: saved.agent.translated,
    lyricsSource: saved.agent.lyricsSource ?? saved.source,
    leadMs: CANCIONERO_DEFAULT_LEAD_MS,
    cueIndex: null,
    updatedAt: new Date().toISOString(),
  };
  broadcastSession(sessionId, sessionStore.touchSubtitleAgent(session));
  console.log(
    `[subtitle] restored from disk item=${itemId} cues=${saved.agent.cues.length} source=${saved.source}`,
  );
  return true;
}

type JobSource =
  | "guion_add"
  | "toggle_or_set"
  | "go_live"
  | "prepare"
  | "teach"
  | "other";

/**
 * Entry point for every trigger (Guion add, toggle, Go Live, teach).
 * A non-forced trigger for the SAME item+asset+lang that is already being
 * processed is dropped: restarting would supersede the running job, wipe the
 * cues and redo the (slow) download / silence scan / alignment from scratch.
 */
async function runSubtitleJob(
  sessionId: string,
  preferredItemId?: string,
  options?: {
    force?: boolean;
    teachSongId?: string;
    source?: JobSource;
  },
): Promise<void> {
  const source = options?.source ?? "other";
  const peekSession = sessionStore.get(sessionId);
  const peekAgent = peekSession?.live.subtitleAgent;
  const peekResolved = peekSession
    ? resolveMediaSource(peekSession, preferredItemId)
    : null;
  const key =
    peekResolved?.ok && peekAgent
      ? `${peekResolved.item.id}|${peekResolved.assetId}|${peekAgent.targetLang}`
      : null;
  console.log(
    `[subtitle] job trigger src=${source} force=${options?.force === true} item=${preferredItemId ?? "-"} prev=${peekAgent?.status ?? "-"}/${peekAgent?.itemId ?? "-"} inflight=${inflightJobs.has(sessionId)}`,
  );

  // Instant switch: this item was already aligned in this session.
  if (
    peekSession &&
    peekAgent &&
    peekResolved?.ok &&
    !options?.teachSongId &&
    (source === "go_live" ||
      source === "prepare" ||
      (source === "toggle_or_set" && options?.force !== true))
  ) {
    const shown =
      peekAgent.status === "ready" &&
      peekAgent.itemId === peekResolved.item.id &&
      peekAgent.assetId === peekResolved.assetId;
    const hit = shown
      ? null
      : recallReadyAgent(
          sessionId,
          peekResolved.item.id,
          peekResolved.assetId,
          peekAgent.targetLang,
        );
    if (hit) {
      bumpJob(sessionId); // cancel any in-flight job for another item
      inflightJobs.delete(sessionId);
      pendingAdds.delete(sessionId);
      peekSession.live.subtitleAgent = {
        ...hit,
        enabled: true,
        fontSize: peekAgent.fontSize,
        leadMs: peekAgent.leadMs,
        cueIndex: null,
        updatedAt: new Date().toISOString(),
      };
      broadcastSession(sessionId, sessionStore.touchSubtitleAgent(peekSession));
      console.log(
        `[subtitle] restored cached cues item=${peekResolved.item.id} cues=${hit.cues.length}`,
      );
      return;
    }
  }

  // Restore from disk (survives hub restarts): the same video was aligned before.
  if (
    peekSession &&
    peekAgent &&
    peekResolved?.ok &&
    !options?.teachSongId &&
    (source === "guion_add" ||
      source === "prepare" ||
      source === "go_live" ||
      (source === "toggle_or_set" && options?.force !== true))
  ) {
    const busyOther = inflightJobs.get(sessionId);
    const sameKeyRunning = busyOther?.key === key;
    const shownNow =
      peekAgent.status === "ready" &&
      peekAgent.itemId === peekResolved.item.id &&
      peekAgent.assetId === peekResolved.assetId;
    // A guion_add must not hijack the agent while another item is processing.
    const mayRestore =
      !shownNow &&
      !sameKeyRunning &&
      (!busyOther || source === "go_live" || source === "toggle_or_set");
    if (
      mayRestore &&
      (await restorePersistedAgent(
        sessionId,
        peekResolved.item.id,
        peekResolved.assetId,
        peekAgent.targetLang,
        busyOther != null,
      ))
    ) {
      return;
    }
  }

  const running = inflightJobs.get(sessionId);

  // Guion adds while another item is being processed wait their turn instead
  // of superseding (and discarding) the running job.
  if (
    source === "guion_add" &&
    key &&
    running &&
    running.key !== key &&
    Date.now() - running.at < INFLIGHT_MAX_AGE_MS &&
    preferredItemId
  ) {
    const q = pendingAdds.get(sessionId) ?? [];
    if (!q.includes(preferredItemId)) q.push(preferredItemId);
    pendingAdds.set(sessionId, q);
    console.log(`[subtitle] job queued item=${preferredItemId} (another item is running)`);
    return;
  }

  if (
    key &&
    running?.key === key &&
    Date.now() - running.at < INFLIGHT_MAX_AGE_MS &&
    options?.force !== true &&
    !options?.teachSongId
  ) {
    console.log(`[subtitle] job already running for this item — not restarting`);
    return;
  }

  const token = { key: key ?? "", at: Date.now() };
  if (key) inflightJobs.set(sessionId, token);
  try {
    await runSubtitleJobInner(sessionId, preferredItemId, options);
  } finally {
    if (inflightJobs.get(sessionId) === token) {
      inflightJobs.delete(sessionId);
      // Still the current job (not superseded): start the next queued add.
      const next = pendingAdds.get(sessionId)?.shift();
      if (next) {
        void runSubtitleJob(sessionId, next, {
          force: true,
          source: "guion_add",
        });
      }
    }
  }
}

async function runSubtitleJobInner(
  sessionId: string,
  preferredItemId?: string,
  options?: { force?: boolean; teachSongId?: string; source?: JobSource },
): Promise<void> {
  const force = options?.force === true;
  const teachSongId = options?.teachSongId?.trim() || undefined;
  const sessionPeek = sessionStore.get(sessionId);
  const agentPeek = sessionPeek?.live.subtitleAgent;
  if (
    !force &&
    agentPeek &&
    isStickyMissingBin(agentPeek) &&
    agentPeek.hint &&
    (await missingBinStillAbsent(agentPeek.hint))
  ) {
    // Still missing — fail once; wait for toggle-off/on or deps to appear.
    return;
  }
  if (
    !force &&
    agentPeek &&
    isStickyHardYoutube(agentPeek) &&
    ytHardFailInBackoff(sessionId)
  ) {
    // Same hard YT failure — wait for backoff or user toggle-on.
    return;
  }
  const gen = bumpJob(sessionId);
  const session = sessionStore.get(sessionId);
  if (!session) return;

  const agent = session.live.subtitleAgent;
  if (!agent?.enabled) return;

  const targetLang = agent.targetLang;
  const resolved = resolveMediaSource(session, preferredItemId);

  if (!resolved.ok) {
    if (!isCurrent(sessionId, gen)) return;
    patchAndBroadcast(session, {
      enabled: true,
      targetLang,
      status: "unsupported",
      itemId: resolved.item?.id ?? null,
      assetId: null,
      sourceLang: null,
      translated: false,
      cues: [],
      hint: hintForReason(resolved.reason, resolved.item),
    });
    return;
  }

  // Same item+asset already ready for this target — keep cues
  // (unless operator is teaching a different cancionero song).
  // Reject corrupt clocks (NaN/undefined from short onset maps) so we rebuild.
  const cuesHealthy =
    agent.cues.length > 0 &&
    agent.cues.every(
      (c) =>
        Number.isFinite(c.startMs) &&
        Number.isFinite(c.endMs) &&
        c.endMs > c.startMs &&
        Boolean(String(c.text ?? "").trim()),
    );
  if (
    !teachSongId &&
    !force &&
    agent.status === "ready" &&
    agent.itemId === resolved.item.id &&
    agent.assetId === resolved.assetId &&
    agent.targetLang === targetLang &&
    cuesHealthy
  ) {
    return;
  }

  // New theme / asset: never leave the previous song's cues on screen.
  if (
    agent.itemId !== resolved.item.id ||
    agent.assetId !== resolved.assetId ||
    (agent.status === "ready" && agent.cues.length > 0 && force)
  ) {
    patchAndBroadcast(session, {
      status: "downloading",
      itemId: resolved.item.id,
      assetId: resolved.assetId,
      cues: [],
      cueIndex: null,
      hint: "cancionero_align",
      sourceLang: null,
      translated: false,
    });
  }

  let mediaPath: string | null = resolved.mediaPath;
  let assetId = resolved.assetId;

  try {
    await ensureSubtitleDirs();
    if (!isCurrent(sessionId, gen)) return;

    // Karaoke when cancionero matches (Audio / YouTube).
    // Miss → captions / Whisper auto-generate subtitle text below.
    // Local file video skips this path and uses sidecar / Whisper.
    const cancioneroDone = await tryCancioneroLyricPath({
      sessionId,
      gen,
      targetLang,
      resolved,
      teachSongId,
    });
    if (cancioneroDone) return;
    if (!isCurrent(sessionId, gen)) return;

    if (resolved.youtube) {
      patchAndBroadcast(session, {
        enabled: true,
        targetLang,
        status: "downloading",
        itemId: resolved.item.id,
        assetId,
        hint: "youtube_captions",
        cues: [],
        translated: false,
        sourceLang: null,
      });

      // Native agent: only captions matching UI language (no EN→Marian fallback).
      // Missing matching track → Whisper `-l <targetLang>` below.
      const preferLangs = expandCaptionPreferLangs([targetLang]);
      const caps = await tryYoutubeCaptions({
        videoId: resolved.youtube.videoId,
        sourceUrl: resolved.youtube.sourceUrl,
        preferLangs,
      });
      if (!isCurrent(sessionId, gen)) return;

      if (caps && caps.cues.length > 0) {
        const capBase = langBase(caps.sourceLang);
        const tgt = langBase(targetLang);
        // Only accept tracks that match the UI language (es/es-419…).
        if (capBase && tgt && capBase === tgt) {
          const ok = await finishWithCues({
            sessionId,
            gen,
            itemId: resolved.item.id,
            assetId: caps.assetId,
            cues: caps.cues,
            sourceLang: caps.sourceLang,
            targetLang,
            alreadyEnglish: false,
            nativeTrack: true,
            preserveLyricsSource: true,
            timingMode: "exact",
            hint:
              caps.trackKind === "manual"
                ? "native_captions"
                : "native_captions_auto",
          });
          if (ok) return;
        } else {
          console.warn(
            `[subtitle] skipping cross-lang YouTube captions (${caps.sourceLang}) for UI=${targetLang} — ASR -l ${targetLang}`,
          );
        }
        console.warn(
          "[subtitle] YouTube captions unused — falling back to Whisper ASR in target language",
        );
      }

      patchAndBroadcast(session, {
        enabled: true,
        targetLang,
        status: "downloading",
        itemId: resolved.item.id,
        assetId,
        hint: "youtube_audio",
        cues: [],
        translated: false,
        sourceLang: null,
      });

      const yt = await ensureYoutubeAudio({
        videoId: resolved.youtube.videoId,
        sourceUrl: resolved.youtube.sourceUrl,
      });
      if (!isCurrent(sessionId, gen)) return;
      mediaPath = yt.mediaPath;
      assetId = yt.assetId;
    }

    if (!mediaPath) {
      if (!isCurrent(sessionId, gen)) return;
      patchAndBroadcast(session, {
        enabled: true,
        targetLang,
        status: "error",
        itemId: resolved.item.id,
        assetId,
        cues: [],
        hint: "missing_local_file",
      });
      return;
    }

    const exists = await mediaFileExists(mediaPath);
    if (!exists) {
      if (!isCurrent(sessionId, gen)) return;
      patchAndBroadcast(session, {
        enabled: true,
        targetLang,
        status: "unsupported",
        itemId: resolved.item.id,
        assetId,
        cues: [],
        hint: "missing_local_file",
      });
      return;
    }

    // Local alternate agent (no Whisper): sidecars in data/subtitles/sidecars/
    // or embedded softsubs via ffmpeg. Prefer before ASR — reliable on Mac when
    // whisper-cli/ggml is missing or music-only ASR returns empty cues.
    if (!resolved.youtube) {
      patchAndBroadcast(session, {
        enabled: true,
        targetLang,
        status: "extracting",
        itemId: resolved.item.id,
        assetId,
        hint: "local_captions",
        cues: [],
        translated: false,
        sourceLang: null,
      });
      const local = await tryLocalCaptionTracks({
        assetId,
        mediaPath,
        originalName: resolved.originalName,
      });
      if (!isCurrent(sessionId, gen)) return;
      if (local && local.cues.length > 0) {
        const localBase = langBase(local.sourceLang);
        const tgt = langBase(targetLang);
        const langMatches =
          !local.sourceLang ||
          !localBase ||
          !tgt ||
          localBase === tgt ||
          cuesLikelyInLanguage(local.cues, tgt);
        if (langMatches) {
          const ok = await finishWithCues({
            sessionId,
            gen,
            itemId: resolved.item.id,
            assetId,
            cues: local.cues,
            sourceLang: local.sourceLang ?? tgt,
            targetLang,
            alreadyEnglish: false,
            nativeTrack: true,
            preserveLyricsSource: true,
            timingMode: "exact",
            hint:
              local.origin === "sidecar"
                ? "local_sidecar"
                : "local_embedded",
          });
          if (ok) return;
        }
      }
    }

    patchAndBroadcast(session, {
      enabled: true,
      targetLang,
      status: "extracting",
      itemId: resolved.item.id,
      assetId,
      hint: null,
      cues: [],
      translated: false,
      sourceLang: null,
    });

    // Prefer Whisper translate→EN when target is English (one model pass).
    const translateToEn = targetLang === "en";

    const asr = await transcribeLocalFile({
      mediaPath,
      assetId,
      translateToEn,
      targetLang,
      onStatus: (st) => {
        if (!isCurrent(sessionId, gen)) return;
        const live = sessionStore.get(sessionId);
        if (!live?.live.subtitleAgent?.enabled) return;
        patchAndBroadcast(live, { status: st, hint: null });
      },
    });

    if (!isCurrent(sessionId, gen)) return;
    const liveAfterAsr = sessionStore.get(sessionId);
    if (!liveAfterAsr?.live.subtitleAgent?.enabled) return;

    // Cancionero miss: Whisper types the lyrics, then empty spaces (silence)
    // pick where each sentence starts (same clock as karaoke, no air).
    // Drop stray ASR crumbs ("Y") — they would be held on screen for seconds.
    const shapedAsr = shapeLyricLikeCues(filterSpeechCues(asr.cues)).filter(
      (c) => c.text.trim().length >= 3,
    );
    const asrLines = shapedAsr.map((c) => c.text).filter(Boolean);
    const silenceAuto = await fetchSilenceSpeechOnsets({
      sessionId,
      gen,
      resolved: {
        ...resolved,
        mediaPath,
        assetId,
      },
      onStatus: (st, hint) => {
        if (!isCurrent(sessionId, gen)) return;
        const live = sessionStore.get(sessionId);
        if (!live?.live.subtitleAgent?.enabled) return;
        patchAndBroadcast(live, {
          status: st,
          hint: hint ?? "silence_scan",
        });
      },
    });
    if (!isCurrent(sessionId, gen)) return;

    // Silence can only place a line per onset. With far fewer onsets than ASR
    // lines (e.g. 10 onsets / 28 lines) it would squash the lyric chart, so
    // keep Whisper's own clocks and use silence only to blank at the breath.
    const silenceCoversLines =
      silenceAuto != null &&
      silenceAuto.onsetsMs.length >= Math.ceil(asrLines.length * 0.7);

    // whisper.cpp (base) segment times on music are unreliable — often snapped
    // to 30 s windows and tens of seconds early. Forced alignment of the ASR
    // text against the audio (WhisperX/wav2vec2) gives acoustic word clocks.
    let asrClockCues: SubtitleCue[] = shapedAsr;
    let wxRefined = false;
    const asrTextCues = shapedAsr.filter((c) => c.text.trim());
    if (
      asrTextCues.length > 0 &&
      asrTextCues.length === shapedAsr.length &&
      mediaPath &&
      (await whisperxAvailable())
    ) {
      const wx = await alignLyricsWithWhisperx({
        mediaPath,
        assetId,
        lines: asrLines,
        language:
          asr.whisperTranslatedToEn || asr.sourceLang === "en" ? "en" : "es",
        durationMs: silenceAuto?.durationMs ?? 0,
        // Air is applied once, by blankCuesAtPhraseSilence below.
        airMs: 0,
        onStatus: (st) => {
          if (!isCurrent(sessionId, gen)) return;
          const live = sessionStore.get(sessionId);
          if (!live?.live.subtitleAgent?.enabled) return;
          patchAndBroadcast(live, { status: st, hint: "whisperx_align" });
        },
      });
      if (!isCurrent(sessionId, gen)) return;
      if (wx && wx.cues.length === asrLines.length) {
        asrClockCues = wx.cues;
        wxRefined = true;
      }
    }

    if (
      !wxRefined &&
      silenceAuto &&
      silenceAuto.onsetsMs.length > 0 &&
      asrLines.length > 0 &&
      silenceCoversLines
    ) {
      const aligned = alignCancioneroLinesToSilence(
        asrLines,
        silenceAuto.onsetsMs,
        silenceAuto.durationMs,
        SILENCE_AIR_ANTICIPATION_MS,
        silenceAuto.silences,
      );
      const packed = packKaraokeDisplayCues(aligned.cues, 1, 1);
      console.log(
        `[subtitle] ASR silence-align synced=${aligned.synced} lines=${asrLines.length} onsets=${silenceAuto.onsetsMs.length} airMs=${SILENCE_AIR_ANTICIPATION_MS}`,
      );
      const okSilence = await finishWithCues({
        sessionId,
        gen,
        itemId: resolved.item.id,
        assetId: silenceAuto.assetId || assetId,
        cues: packed,
        sourceLang:
          asr.sourceLang ?? (asr.whisperTranslatedToEn ? "en" : targetLang),
        targetLang,
        alreadyEnglish: asr.whisperTranslatedToEn,
        // Keep silence clocks — do not reshape timings again.
        nativeTrack: true,
        preserveLyricsSource: true,
        timingMode: "exact",
        hint: aligned.synced ? "asr_silence_aligned" : "asr_silence_partial",
      });
      if (okSilence) return;
    }

    if (shapedAsr.length > 0 && (wxRefined || (silenceAuto && !silenceCoversLines))) {
      const blanked = packKaraokeDisplayCues(
        blankCuesAtPhraseSilence(
          asrClockCues,
          silenceAuto?.silences ?? [],
          silenceAuto?.durationMs ?? 0,
          SILENCE_AIR_ANTICIPATION_MS,
        ),
        1,
        1,
      );
      console.log(
        `[subtitle] ASR clocks${wxRefined ? " (whisperx)" : ""} + silence blank lines=${shapedAsr.length} onsets=${silenceAuto?.onsetsMs.length ?? 0} silences=${silenceAuto?.silences.length ?? 0} airMs=${SILENCE_AIR_ANTICIPATION_MS}`,
      );
      const okClocks = await finishWithCues({
        sessionId,
        gen,
        itemId: resolved.item.id,
        assetId: silenceAuto?.assetId || assetId,
        cues: blanked,
        sourceLang:
          asr.sourceLang ?? (asr.whisperTranslatedToEn ? "en" : targetLang),
        targetLang,
        alreadyEnglish: asr.whisperTranslatedToEn,
        nativeTrack: true,
        preserveLyricsSource: true,
        timingMode: "exact",
        hint: wxRefined ? "asr_whisperx_blank" : "asr_clocks_blank",
      });
      if (okClocks) return;
    }

    const okAsr = await finishWithCues({
      sessionId,
      gen,
      itemId: resolved.item.id,
      assetId,
      cues: shapedAsr.length > 0 ? shapedAsr : asr.cues,
      sourceLang: asr.sourceLang ?? (asr.whisperTranslatedToEn ? "en" : targetLang),
      targetLang,
      alreadyEnglish: asr.whisperTranslatedToEn,
      // Silence scan unavailable — shape + assisted timing fallback.
      nativeTrack: false,
      preserveLyricsSource: false,
      timingMode: "assisted",
      hint: "asr_auto_lyrics",
    });
    if (okAsr) return;

    // Job "succeeded" but every cue was filtered (e.g. only [MÚSICA]) or ASR
    // returned nothing — do NOT show a green "listo" with a blank overlay.
    if (!isCurrent(sessionId, gen)) return;
    const liveEmpty = sessionStore.get(sessionId);
    if (!liveEmpty?.live.subtitleAgent?.enabled) return;
    const hasWhisper = await whisperCliAvailable();
    patchAndBroadcast(liveEmpty, {
      status: "error",
      cues: [],
      sourceLang: asr.sourceLang,
      translated: false,
      hint: hasWhisper ? "no_speech" : "whisper_cpp_missing",
      itemId: resolved.item.id,
      assetId,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "asr_failed";
    const missingHint = missingBinHintFromError(err);
    const hint = missingHint ?? raw.slice(0, 180);
    // Log missing binaries once; sticky state prevents retry spam.
    if (missingHint) {
      console.error(`[subtitle] job failed: ${missingHint}`);
    } else if (hint.startsWith("ffmpeg_extract_failed")) {
      console.error("[subtitle] job failed: ffmpeg_extract_failed");
    } else {
      console.error("[subtitle] job failed:", raw);
    }
    if (isHardYoutubeHint(hint)) {
      markYtHardFail(sessionId);
    }
    // Drop bad YouTube cache so the next user toggle re-downloads once.
    if (
      hint.startsWith("ffmpeg_extract_failed") &&
      mediaPath &&
      resolved.youtube
    ) {
      void rm(mediaPath, { force: true }).catch(() => undefined);
    }
    if (!isCurrent(sessionId, gen)) return;
    const live = sessionStore.get(sessionId);
    if (!live) return;
    // Prefer stable hint codes for Control (strip long stderr tails).
    const uiHint = hint.startsWith("ffmpeg_extract_failed")
      ? "ffmpeg_extract_failed"
      : hint.startsWith("whisper_cpp_failed")
        ? "whisper_cpp_failed"
        : hint;
    patchAndBroadcast(live, {
      status: "error",
      cues: [],
      hint: uiHint,
      itemId: resolved.item.id,
      assetId: resolved.assetId,
    });
  }
}
