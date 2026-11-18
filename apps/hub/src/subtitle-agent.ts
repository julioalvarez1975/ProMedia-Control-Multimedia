import {
  deriveItemProgress,
  forgetItemProgress,
  isItemReady,
  setBgProgress,
} from "./subtitle-item-progress.js";
import { AsyncLocalStorage } from "node:async_hooks";
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
  subtitleOverallPercent,
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
  cancioneroMediaKey,
  forgetCancioneroTiming,
  recallCancioneroByMedia,
  recallCancioneroByTitles,
  rememberCancioneroMatch,
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
  firstSpeechOnsetMs,
  isConservativeEqualTimeStart,
  resolveFirstVoiceOnsetMs,
  resolveKaraokeVoiceAnchorMs,
  scoreSongLyricOverlap,
  sungEntranceMs,
  type LyricWordStamp,
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
  audioAlignTimelinePlausible,
  cuesSuspiciouslyEarly,
} from "./subtitle-align-quality.js";
import { findLrclibSong, type LrclibSong } from "./subtitle-lrclib.js";
import { libraryStore } from "./library-store.js";
import { songIdentityKey } from "./quelea-import.js";
import {
  forgetAllReadyAgents,
  forgetReadyAgent,
  recallReadyAgent,
  rememberReadyAgent,
} from "./subtitle-ready-cache.js";
import {
  getPersistMeta,
  cacheKeyOf,
  loadPersistedAgent,
  resolveCacheKey,
  lyricsHash,
  persistReadyAgent,
  flushPersistedAgents,
  purgeAlignedCacheForLibrarySong,
  purgeKaraokeCacheForSong,
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
  bumpBg(sessionId);
  bgGeneration.delete(sessionId);
  bgQueued.delete(sessionId);
  bgCurrent.delete(sessionId);
  bgDraining.delete(sessionId);
  clearBgBroadcastTimer(sessionId);
  void flushPersistedAgents();
  bumpJob(sessionId);
  jobGeneration.delete(sessionId);
  inflightJobs.delete(sessionId);
  pendingAdds.delete(sessionId);
  forgetReadyAgent(sessionId);
  forgetItemProgress(sessionId);
}

function bumpJob(sessionId: string): number {
  const next = (jobGeneration.get(sessionId) ?? 0) + 1;
  jobGeneration.set(sessionId, next);
  return next;
}

/**
 * Background row jobs (the hub's own Guion queue) use NEGATIVE generations on a
 * separate counter: selecting rows / Go Live (which bump `jobGeneration`) never
 * cancels them; only disabling the agent or cancelling the queue does.
 */
const bgGeneration = new Map<string, number>();
let bgCounter = 0;

function bumpBg(sessionId: string): number {
  bgCounter += 1;
  const next = -bgCounter;
  bgGeneration.set(sessionId, next);
  return next;
}

function isCurrent(sessionId: string, gen: number): boolean {
  if (gen < 0) return bgGeneration.get(sessionId) === gen;
  return jobGeneration.get(sessionId) === gen;
}

/** Private agent state of the background row job running in this async context. */
type BgCtx = { itemId: string; agent: SubtitleAgentState };
const bgStore = new AsyncLocalStorage<BgCtx>();
/** Rows waiting for / being processed by the background queue, per session. */
const bgQueued = new Map<string, Set<string>>();
const bgCurrent = new Map<string, string | null>();
/** Sessions currently walking that queue (one drain loop at a time). */
const bgDraining = new Set<string>();

/**
 * Browser protection: background % updates are coalesced so Control/Output
 * are not flooded with full `session.updated` clones on every Whisper tick.
 * Ready / failed / focused-row mirror always flush immediately.
 */
const BG_PROGRESS_BROADCAST_MS = 450;
const BG_PROGRESS_BROADCAST_BUSY_MS = 900;
const BG_QUEUE_YIELD_MS = 280;
const BG_QUEUE_BUSY_THRESHOLD = 6;
const bgBroadcastTimer = new Map<string, ReturnType<typeof setTimeout>>();

function clearBgBroadcastTimer(sessionId: string): void {
  const t = bgBroadcastTimer.get(sessionId);
  if (t) clearTimeout(t);
  bgBroadcastTimer.delete(sessionId);
}

function bgQueuedDepth(sessionId: string): number {
  return (bgQueued.get(sessionId)?.size ?? 0) + (bgCurrent.get(sessionId) ? 1 : 0);
}

function flushBgProgressBroadcast(sessionId: string): void {
  bgBroadcastTimer.delete(sessionId);
  const live = sessionStore.get(sessionId);
  if (!live?.live.subtitleAgent?.enabled) return;
  broadcastSession(sessionId, sessionStore.touchSubtitleAgent(live));
}

/**
 * @param immediate — terminal state or operator is watching this row.
 */
function scheduleBgProgressBroadcast(
  session: SessionRecord,
  immediate: boolean,
): void {
  const sessionId = session.id;
  if (immediate) {
    clearBgBroadcastTimer(sessionId);
    broadcastSession(sessionId, sessionStore.touchSubtitleAgent(session));
    return;
  }
  if (bgBroadcastTimer.has(sessionId)) return;
  const delay =
    bgQueuedDepth(sessionId) >= BG_QUEUE_BUSY_THRESHOLD
      ? BG_PROGRESS_BROADCAST_BUSY_MS
      : BG_PROGRESS_BROADCAST_MS;
  bgBroadcastTimer.set(
    sessionId,
    setTimeout(() => flushBgProgressBroadcast(sessionId), delay),
  );
}

/** Test hook: run `fn` as a background row job with a private agent state. */
export function runInBackgroundContextForTest<T>(
  itemId: string,
  agent: SubtitleAgentState,
  fn: () => T,
): T {
  return bgStore.run({ itemId, agent }, fn);
}

/** Test hook. */
export function patchAgentForTest(
  session: SessionRecord,
  patch: Partial<SubtitleAgentState>,
): void {
  patchAndBroadcast(session, patch);
}

function isRowQueued(sessionId: string, itemId: string): boolean {
  return bgQueued.get(sessionId)?.has(itemId) === true || bgCurrent.get(sessionId) === itemId;
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

/**
 * yt-dlp download percent → agent state (drives the Guion row percentage).
 * Throttled to whole-percent changes; ignored once the job is superseded.
 */
function ytDownloadProgress(
  sessionId: string,
  gen: number,
): (percent: number) => void {
  let last = -1;
  // Background rows: coarser steps (broadcasts are also coalesced).
  const step = gen < 0 ? 5 : 2;
  return (percent) => {
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    if (pct === last || (pct < 100 && last >= 0 && pct - last < step)) return;
    if (!isCurrent(sessionId, gen)) return;
    last = pct;
    const live = sessionStore.get(sessionId);
    if (!live?.live.subtitleAgent?.enabled) return;
    patchAndBroadcast(live, { downloadPercent: pct });
  };
}

/**
 * A background row job reports into its OWN agent state. It never touches the
 * agent the operator sees; when the job finishes the result goes to the
 * per-item caches (memory + disk) and, if that row is the focused one, onto the
 * screen. Progress feeds the Guion row percentage.
 *
 * Intermediate % ticks are coalesced (see scheduleBgProgressBroadcast) so the
 * browser is not flooded with full session snapshots while Whisper runs.
 */
function applyBackgroundPatch(
  session: SessionRecord,
  bg: BgCtx,
  patch: Partial<SubtitleAgentState>,
): void {
  bg.agent = {
    ...bg.agent,
    ...patch,
    itemId: bg.itemId,
    updatedAt: new Date().toISOString(),
  };
  const a = bg.agent;
  let changed = false;
  let terminal = false;
  if (a.status === "ready" && a.cues.length > 0) {
    rememberReadyAgent(session.id, a);
    persistReadyAgent(a);
    changed = setBgProgress(session.id, bg.itemId, { percent: 100, ready: true });
    terminal = true;
  } else if (a.status === "error" || a.status === "unsupported") {
    changed = setBgProgress(session.id, bg.itemId, { percent: 0, ready: false, failed: true });
    terminal = true;
  } else {
    changed = setBgProgress(session.id, bg.itemId, {
      percent: subtitleOverallPercent(a.status, a.downloadPercent),
      ready: false,
    });
  }
  const live = session.live.subtitleAgent;
  let mirrored = false;
  // The operator is looking at this row: show its progress / its finished cues.
  if (live?.enabled && live.itemId === bg.itemId) {
    session.live.subtitleAgent =
      a.status === "ready" && a.cues.length > 0
        ? {
            ...live,
            ...a,
            enabled: true,
            fontSize: live.fontSize,
            leadMs: a.leadMs ?? live.leadMs,
            itemProgress: live.itemProgress,
            updatedAt: new Date().toISOString(),
          }
        : {
            ...live,
            status: a.status,
            hint: a.hint,
            assetId: a.assetId ?? live.assetId,
            downloadPercent: a.downloadPercent,
            updatedAt: new Date().toISOString(),
          };
    mirrored = true;
  }
  if (changed || mirrored) {
    // Keep itemProgress on the in-memory agent in sync even when the WS
    // broadcast is deferred (tests + any hub reader).
    if (session.live.subtitleAgent) {
      session.live.subtitleAgent = {
        ...session.live.subtitleAgent,
        itemProgress: deriveItemProgress(
          session.id,
          session.live.subtitleAgent,
          session.playlist.items.map((i) => i.id),
        ),
        updatedAt: new Date().toISOString(),
      };
    }
    scheduleBgProgressBroadcast(session, terminal || mirrored);
  }
}

function patchAndBroadcast(
  session: SessionRecord,
  patch: Partial<SubtitleAgentState>,
): void {
  const bg = bgStore.getStore();
  if (bg) {
    applyBackgroundPatch(session, bg, patch);
    return;
  }
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
          onProgress: ytDownloadProgress(sessionId, gen),
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
}): Promise<{
  cues: import("@promedia/shared").SubtitleCue[];
  assetId: string;
  words: LyricWordStamp[];
} | null> {
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
          return { cues: speech, assetId: caps.assetId, words: [] };
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
        onProgress: ytDownloadProgress(sessionId, gen),
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
          return { cues: speech, assetId, words: [] };
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
    if (speech.length === 0) {
      console.warn("[subtitle] karaoke timing ASR returned no speech");
      return null;
    }
    console.log(
      `[subtitle] karaoke timing from ASR n=${speech.length} prompt=${Boolean(options.alignPrompt)}`,
    );
    return { cues: speech, assetId, words: asr.words ?? [] };
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
}): Promise<boolean> {
  const { sessionId, gen, targetLang, resolved } = options;
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

  // Memory, then fuzzy title match.
  let match: CancioneroMatchHit | null = null;
  /** Set when the lyrics came from LRCLIB (not a Biblioteca song). */
  let lrclib: LrclibSong | null = null;
  let learnSource: "exact" | "lyric" | "fuzzy" | "manual" = "fuzzy";
  {
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
    // Do NOT clear cues here — wiping them left Output blank while align runs.
    patchAndBroadcast(live, {
      status,
      hint,
      itemId: item.id,
      assetId: resolved.assetId,
    });
  };

  // Download audio for silence blanks; timed clocks come from LRCLIB / captions.
  let mediaPath = resolved.mediaPath;
  let assetId = resolved.assetId;
  if (resolved.youtube) {
    const haveLocal = mediaPath ? await mediaFileExists(mediaPath) : false;
    if (!haveLocal) {
      statusPatch("downloading", "silence_scan");
      try {
        const yt = await ensureYoutubeAudio({
          videoId: resolved.youtube.videoId,
          sourceUrl: resolved.youtube.sourceUrl,
          onProgress: ytDownloadProgress(sessionId, gen),
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
  /** Lyric clocks confirmed (LRCLIB LRC or captions). */
  let textSynced = false;
  let timingModeHint = "cancionero_match";
  let published = false;

  // Silence map for breath blanks (not for inventing lyric clocks).
  statusPatch("extracting", "cancionero_align");
  const silence = await fetchSilenceSpeechOnsets({
    sessionId,
    gen,
    resolved: { ...resolved, mediaPath, assetId },
    onStatus: statusPatch,
  });
  if (!isCurrent(sessionId, gen)) return true;
  if (silence && silence.durationMs > 0) {
    durationMs = Math.max(durationMs, silence.durationMs);
    assetId = silence.assetId || assetId;
    mediaPath = silence.mediaPath || mediaPath;
  }
  const phraseSilences = silence?.silences ?? [];
  /** Whisper token clocks for this recording. Every song is measured. */
  let asrWords: LyricWordStamp[] = [];
  let timing:
    | {
        cues: import("@promedia/shared").SubtitleCue[];
        assetId: string;
        words: LyricWordStamp[];
      }
    | null = null;

  // Whisper on this audio decides when the voice starts. LRCLIB / equal-time
  // only supply the lyric chart; the first line is moved onto that onset.
  const withVoiceAndBlank = (cues: SubtitleCue[]): SubtitleCue[] => {
    const wordHint = cues[0]?.startMs ?? null;
    const entrance = sungEntranceMs(asrWords, phraseSilences);
    const equalTime =
      wordHint != null &&
      isConservativeEqualTimeStart(
        wordHint,
        durationMs,
        Math.max(cues.length, lines.length),
      );
    const lrclibChart = timingModeHint.includes("lrclib");
    // A failed line-match publishes equal-time (Libre Soy opened at 37s).
    // The manual captions already start at the voice (22.03s). Do not pull a
    // real LRCLIB chart to that cue — only the equal-time guess.
    const captionVoice = equalTime
      ? firstSpeechOnsetMs(timing?.cues ?? [])
      : null;
    let voiceMs: number | null = null;
    let shiftAll = false;
    let anchorReason = "none";
    if (wordHint != null && (equalTime || lrclibChart)) {
      const anchor = resolveKaraokeVoiceAnchorMs({
        asrWords,
        silences: phraseSilences,
        firstLineText: cues[0]?.text ?? lines[0] ?? "",
        chartFirstMs: wordHint,
        equalTime,
        lrclibChart,
        captionVoiceMs: captionVoice,
      });
      voiceMs = anchor.voiceMs;
      shiftAll = anchor.shiftAll;
      anchorReason = anchor.reason;
    } else if (entrance != null) {
      voiceMs = entrance;
      shiftAll = false;
      anchorReason = "caption_entrance";
    } else if (textSynced && wordHint != null) {
      voiceMs = resolveFirstVoiceOnsetMs(
        phraseSilences,
        silence?.onsetsMs ?? [],
        wordHint,
      );
      shiftAll = true;
      anchorReason = "text_synced_onset";
    } else {
      voiceMs = wordHint;
      anchorReason = "chart_first";
    }
    if (cues.length > 0 && voiceMs != null) {
      console.log(
        `[subtitle] voice↔lyric anchor: first line at ${Math.round(cues[0]!.startMs)}ms, sung onset ${Math.round(voiceMs)}ms → shift ${Math.round(voiceMs - cues[0]!.startMs)}ms (silence onsets=${silence?.onsetsMs?.length ?? 0} entrance=${entrance ?? "n/a"} caption=${captionVoice ?? "n/a"} equalTime=${equalTime} reason=${anchorReason})`,
      );
    }
    let placed = cues.map((c) => ({ ...c }));
    if (shiftAll) {
      placed = anchorFirstCueToVoiceOnset(placed, voiceMs);
    } else if (voiceMs != null && placed[0] && !lrclibChart) {
      const next = placed[1]?.startMs ?? voiceMs + 4_000;
      const startMs = Math.max(0, Math.min(Math.round(voiceMs), next - 700));
      if (Math.abs(startMs - placed[0].startMs) >= 40) {
        const endMs = Math.max(
          startMs + 500,
          Math.min(Math.max(placed[0].endMs, startMs + 500), next - 40),
        );
        placed = [{ ...placed[0], startMs, endMs }, ...placed.slice(1)];
      }
    }
    return blankCuesAtPhraseSilence(
      placed,
      phraseSilences,
      durationMs,
      SILENCE_AIR_ANTICIPATION_MS,
    );
  };

  const publishKaraokeCues = async (
    nextLineCues: SubtitleCue[],
    hint: string,
  ): Promise<boolean> => {
    const voiceLocked = withVoiceAndBlank(nextLineCues);
    const nextCues = packKaraokeDisplayCues(
      ensureCancioneroCueTexts(voiceLocked, lines),
      1,
      1,
    );
    if (!nextCues.length) return false;
    const lyricsFrom: "cancionero" | "lrclib" = lrclib ? "lrclib" : "cancionero";
    if (match) {
      await resolveCacheKey(assetId, resolved.mediaPath);
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
      if (liveSrc && (bgStore.getStore() || liveSrc.live.subtitleAgent?.itemId === item.id)) {
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

  // Whisper analyzes this recording before any chart is published.
  // `--prompt` biases the clocks; word stamps anchor cue 0 to the voice.
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
    if (timing?.words.length) asrWords = timing.words;
    const entrance = sungEntranceMs(asrWords, phraseSilences);
    console.log(
      `[subtitle] whisper voice scan words=${asrWords.length} cues=${timing?.cues.length ?? 0} entrance=${entrance ?? "n/a"}ms`,
    );
    if (timing && entrance != null) {
      const kept = timing.cues.filter((c) => c.startMs >= entrance - 400);
      if (kept.length > 0 && kept.length < timing.cues.length) {
        console.log(
          `[subtitle] drop intro ASR before sung entrance ${entrance}ms kept=${kept.length}/${timing.cues.length}`,
        );
        timing = { ...timing, cues: kept };
      }
    }
  }

  // 1) PRIMARY — LRCLIB synced LRC clocks + cancionero/Biblioteca text.
  let lrclibClocks: SubtitleCue[] | null =
    lrclib?.syncedCues?.map((c) => ({ ...c })) ?? null;
  if (!lrclibClocks) {
    try {
      const lrTiming = await findLrclibSong({ titles, artists, durationMs });
      if (!isCurrent(sessionId, gen)) return true;
      if (lrTiming?.syncedCues && lrTiming.syncedCues.length > 0) {
        lrclibClocks = lrTiming.syncedCues.map((c) => ({ ...c }));
        console.log(
          `[subtitle] lrclib clocks for cancionero "${match.song.title}" n=${lrclibClocks.length} first=${lrclibClocks[0]?.startMs ?? "n/a"}`,
        );
      }
    } catch (err) {
      console.warn(
        "[subtitle] lrclib clock probe failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (lrclibClocks && lrclibClocks.length > 0) {
    const clocked = ensureCancioneroCueTexts(lrclibClocks, lines);
    const plausible = audioAlignTimelinePlausible(
      clocked,
      silence?.onsetsMs ?? [],
      durationMs,
    );
    lineCues = clocked;
    textSynced = true;
    synced = plausible;
    timingModeHint = "cancionero_lrclib_synced";
    console.log(
      `[subtitle] karaoke lrclib clocks lines=${lineCues.length} first=${lineCues[0]?.startMs ?? "n/a"} plausible=${plausible} silenceBlank=${phraseSilences.length > 0}`,
    );
    published =
      (await publishKaraokeCues(lineCues, timingModeHint)) || published;
  }

  // 2) Whisper / caption clocks when LRCLIB had no synced chart.
  if (!textSynced && timing && timing.cues.length > 0) {
    const textAligned = alignCancioneroLinesToTiming(
      lines,
      timing.cues,
      durationMs,
    );
    if (textAligned.cues.length > 0) {
      lineCues = textAligned.cues;
      textSynced = textAligned.synced;
      synced = textAligned.synced;
      assetId = timing.assetId || assetId;
      timingModeHint = synced
        ? "cancionero_match_captions"
        : "cancionero_match_captions_partial";
      console.log(
        `[subtitle] karaoke captions synced=${synced} aligned=${textAligned.alignedCount}/${lines.length} first=${lineCues[0]?.startMs ?? "n/a"} silenceBlank=${phraseSilences.length > 0}`,
      );
      published =
        (await publishKaraokeCues(lineCues, timingModeHint)) || published;
    }
  }

  // 3) Lyric disambiguation — captions identify the song; re-align TEXT to audio.
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
        textSynced = false;
        synced = false;
        published = false;
        // Re-probe LRCLIB clocks for the switched song; else caption map.
        try {
          const lrTiming = await findLrclibSong({
            titles: [bestLyric.hit.song.title, ...titles],
            artists,
            durationMs,
          });
          if (!isCurrent(sessionId, gen)) return true;
          if (lrTiming?.syncedCues && lrTiming.syncedCues.length > 0) {
            lineCues = ensureCancioneroCueTexts(lrTiming.syncedCues, lines);
            textSynced = true;
            synced = true;
            timingModeHint = "cancionero_lrclib_synced";
          }
        } catch {
          /* fall through to captions */
        }
        if (!textSynced && timing && timing.cues.length > 0) {
          const realigned = alignCancioneroLinesToTiming(
            lines,
            timing.cues,
            durationMs,
          );
          lineCues =
            realigned.cues.length > 0
              ? realigned.cues
              : songToSubtitleCues(match.song, durationMs);
          textSynced = realigned.synced;
          synced = realigned.synced;
          timingModeHint = synced
            ? "cancionero_match_captions"
            : "cancionero_match_captions_partial";
        }
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
      lineCues = aligned.cues;
      textSynced = aligned.synced;
      synced = aligned.synced;
      assetId = timing.assetId || assetId;
      timingModeHint = synced
        ? "cancionero_match_captions"
        : "cancionero_match_captions_partial";
    }
  }

  // Final publish of raw clocks (FW / LRCLIB / captions). Blank once inside.
  if (!published && lineCues.length > 0) {
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
 * Preview ←/→ only changes which cue is shown.
 * Cue clocks stay on the Whisper voice anchor — a manual nudge must not move them.
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

  const current =
    prev.cueIndex === -1
      ? -1
      : prev.cueIndex != null &&
          prev.cueIndex >= 0 &&
          prev.cueIndex < cues.length
        ? prev.cueIndex
        : cueIndexAtPositionMs(cues, positionMs);

  const delta: -1 | 1 = patch.delta === -1 ? -1 : 1;
  const nextIndex =
    delta === 1
      ? current < 0
        ? 0
        : Math.min(cues.length - 1, current + 1)
      : current <= 0
        ? -1
        : current - 1;

  session.live.subtitleAgent = {
    ...prev,
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
    bumpBg(session.id);
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

  if (wasOff) {
    // Turn-on: calculate every A/V row already in the Guion in the background.
    maybeStartKaraokeOnGuionItems(session);
  } else {
    // Focus / lang change: only the preferred row (or current) if needed.
    void runSubtitleJob(session.id, patch.itemId, {
      force: false,
      source: "toggle_or_set",
    });
  }

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

  // Switch theme: show ready lyrics at once if we have them; otherwise clear
  // the previous song so Output does not keep old cancionero text.
  if (itemChanged) {
    clearYtHardFail(session.id);
    const cached =
      resolved?.ok
        ? recallReadyAgent(
            session.id,
            resolved.item.id,
            resolved.assetId,
            agent.targetLang,
          )
        : null;
    if (
      cached &&
      cached.cues.length > 0 &&
      cuesSuspiciouslyEarly(cached.cues) &&
      resolved?.ok
    ) {
      forgetReadyAgent(session.id, resolved.item.id);
    } else if (cached && cached.cues.length > 0) {
      session.live.subtitleAgent = {
        ...cached,
        enabled: true,
        fontSize: agent.fontSize,
        leadMs: agent.leadMs,
        cueIndex: null,
        updatedAt: new Date().toISOString(),
      };
      broadcastSession(session.id, sessionStore.touchSubtitleAgent(session));
    } else if (
      agent.status === "ready" &&
      agent.itemId === nextItemId &&
      agent.cues.length > 0 &&
      !cuesSuspiciouslyEarly(agent.cues)
    ) {
      // Same song already at 100% — keep cues (do not flash back to 0%).
      session.live.subtitleAgent = {
        ...agent,
        assetId: nextAssetId ?? agent.assetId,
        cueIndex: null,
        updatedAt: new Date().toISOString(),
      };
      broadcastSession(session.id, sessionStore.touchSubtitleAgent(session));
    } else {
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
  }
  // Do not force-restart a finished song — runSubtitleJob keeps ready cues.
  void runSubtitleJob(session.id, nextItemId, {
    force: false,
    source: "go_live",
  });
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
        (await loadPersistedAgent(cacheKeyOf(assetId) ?? assetId, targetLang))?.lrclibSong;
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

function isKaraokeGuionItem(item: PlaylistItem): boolean {
  if (item.type === "audio") return true;
  return item.type === "video" && item.payload.sourceKind === "youtube";
}

/**
 * Ensure karaoke is on without stealing the focused / En vivo row.
 * Background jobs report into their own agent state + per-row percent.
 */
function ensureKaraokeEnabledForBackground(session: SessionRecord): void {
  const prev = session.live.subtitleAgent ?? emptySubtitleAgentState();
  if (prev.enabled && prev.status !== "off") return;
  const targetLang = prev.targetLang ?? "es";
  session.live.subtitleAgent = {
    ...emptySubtitleAgentState(targetLang),
    enabled: true,
    status: "idle",
    targetLang,
    fontSize: prev.fontSize,
    leadMs: prev.leadMs,
    updatedAt: new Date().toISOString(),
  };
  broadcastSession(session.id, sessionStore.touchSubtitleAgent(session));
}

/**
 * Queue one Guion A/V row for flag calculation. Does not require selecting the
 * row. Progress appears on that row; the result lands in the per-item cache.
 */
function enqueueBackgroundKaraoke(
  session: SessionRecord,
  itemId: string,
  opts?: { deferBroadcast?: boolean },
): void {
  if (isItemReady(session.id, itemId)) return;
  if (bgCurrent.get(session.id) === itemId) return;
  let q = bgQueued.get(session.id);
  if (!q) {
    q = new Set();
    bgQueued.set(session.id, q);
  }
  if (q.has(itemId)) return;
  q.add(itemId);
  if (setBgProgress(session.id, itemId, { percent: 0, ready: false })) {
    // Bulk import: one coalesced broadcast for all rows, not N full snapshots.
    if (opts?.deferBroadcast) {
      scheduleBgProgressBroadcast(session, false);
    } else {
      scheduleBgProgressBroadcast(session, true);
    }
  }
}

/**
 * Walk the Guion queue one song at a time. Each job uses a private agent
 * state so En vivo / Vista previa are never wiped mid-song.
 */
async function drainBackgroundKaraoke(sessionId: string): Promise<void> {
  if (bgDraining.has(sessionId)) return;
  bgDraining.add(sessionId);
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const q = bgQueued.get(sessionId);
      if (!q || q.size === 0) break;
      const itemId = q.values().next().value as string;
      q.delete(itemId);
      bgCurrent.set(sessionId, itemId);

      const session = sessionStore.get(sessionId);
      if (!session?.live.subtitleAgent?.enabled) {
        bgCurrent.set(sessionId, null);
        break;
      }

      try {
        await prepareRowInBackground(session, itemId);
      } catch (err) {
        console.warn(
          `[subtitle] background row failed item=${itemId}:`,
          err instanceof Error ? err.message : err,
        );
        if (setBgProgress(sessionId, itemId, { percent: 0, ready: false, failed: true })) {
          const live = sessionStore.get(sessionId);
          if (live) {
            scheduleBgProgressBroadcast(live, true);
          }
        }
      } finally {
        bgCurrent.set(sessionId, null);
      }

      // Yield between songs so Control/Output can paint and the hub event
      // loop is not starved when many rows are queued.
      const more = (bgQueued.get(sessionId)?.size ?? 0) > 0;
      if (more) {
        await new Promise<void>((r) => setTimeout(r, BG_QUEUE_YIELD_MS));
      }
    }
  } finally {
    bgDraining.delete(sessionId);
    const q = bgQueued.get(sessionId);
    if (
      q &&
      q.size > 0 &&
      sessionStore.get(sessionId)?.live.subtitleAgent?.enabled
    ) {
      void drainBackgroundKaraoke(sessionId);
    }
  }
}

/**
 * Restore from memory/disk or run Whisper for this Guion row in the background.
 */
async function prepareRowInBackground(
  session: SessionRecord,
  itemId: string,
): Promise<void> {
  const sessionId = session.id;
  const liveAgent = session.live.subtitleAgent;
  if (!liveAgent?.enabled) return;

  const resolved = resolveMediaSource(session, itemId);
  if (!resolved.ok) {
    setBgProgress(sessionId, itemId, { percent: 0, ready: false, failed: true });
    broadcastSession(sessionId, sessionStore.touchSubtitleAgent(session));
    return;
  }

  const targetLang = liveAgent.targetLang;
  const hit = recallReadyAgent(
    sessionId,
    itemId,
    resolved.assetId,
    targetLang,
  );
  if (
    hit &&
    hit.cues.length > 0 &&
    !cuesSuspiciouslyEarly(hit.cues) &&
    (await agentLyricsStillCurrent(hit, resolved.mediaPath))
  ) {
    setBgProgress(sessionId, itemId, { percent: 100, ready: true });
    if (liveAgent.itemId === itemId) {
      session.live.subtitleAgent = {
        ...liveAgent,
        ...hit,
        enabled: true,
        itemId,
        assetId: resolved.assetId,
        status: "ready",
        cueIndex: null,
        updatedAt: new Date().toISOString(),
      };
    }
    broadcastSession(sessionId, sessionStore.touchSubtitleAgent(session));
    console.log(
      `[subtitle] background cache hit item=${itemId} cues=${hit.cues.length}`,
    );
    return;
  }

  const fileKey = await resolveCacheKey(resolved.assetId, resolved.mediaPath);
  if (fileKey) {
    const saved = await loadPersistedAgent(fileKey, targetLang);
    if (saved && (await persistedStillValid(saved))) {
      const restored: SubtitleAgentState = {
        ...emptySubtitleAgentState(targetLang),
        ...saved.agent,
        enabled: true,
        status: "ready",
        targetLang,
        itemId,
        assetId: resolved.assetId,
        cues: saved.agent.cues.map((c) => ({ ...c })),
        hint: saved.agent.hint ?? "cancionero_restored",
        lyricsSource: saved.agent.lyricsSource ?? saved.source,
        leadMs: CANCIONERO_DEFAULT_LEAD_MS,
        cueIndex: null,
        updatedAt: new Date().toISOString(),
      };
      setPersistMeta(resolved.assetId, {
        songId: saved.songId,
        lyricsHash: saved.lyricsHash,
        source: saved.source,
        lrclibSong: saved.lrclibSong,
      });
      rememberReadyAgent(sessionId, restored);
      setBgProgress(sessionId, itemId, { percent: 100, ready: true });
      if (session.live.subtitleAgent?.itemId === itemId) {
        session.live.subtitleAgent = {
          ...session.live.subtitleAgent,
          ...restored,
          fontSize: session.live.subtitleAgent.fontSize,
        };
      }
      broadcastSession(sessionId, sessionStore.touchSubtitleAgent(session));
      console.log(
        `[subtitle] background disk restore item=${itemId} cues=${restored.cues.length}`,
      );
      return;
    }
  }

  bumpBg(sessionId);
  const privateAgent: SubtitleAgentState = {
    ...emptySubtitleAgentState(targetLang),
    enabled: true,
    status: "idle",
    targetLang,
    itemId,
    assetId: resolved.assetId,
    fontSize: liveAgent.fontSize,
    leadMs: liveAgent.leadMs,
  };
  console.log(`[subtitle] background calculate item=${itemId}`);
  await bgStore.run({ itemId, agent: privateAgent }, async () => {
    await runSubtitleJobInner(sessionId, itemId, {
      force: true,
      source: "guion_add",
    });
  });
}

/**
 * When a YouTube / audio item lands in Guion: enable karaoke and queue the
 * flag calculation in the background. The operator does not need to select
 * the row — each song gets its own progress % and per-item cache.
 */
export function maybeStartKaraokeOnGuionItem(
  session: SessionRecord,
  item: PlaylistItem,
): void {
  if (!isKaraokeGuionItem(item)) return;
  ensureKaraokeEnabledForBackground(session);
  enqueueBackgroundKaraoke(session, item.id);
  void drainBackgroundKaraoke(session.id);
}

/**
 * Queue every A/V row already in the Guion (import, toggle-on, bulk add).
 */
export function maybeStartKaraokeOnGuionItems(
  session: SessionRecord,
  items?: readonly PlaylistItem[],
): void {
  const list = items ?? session.playlist.items;
  const karaoke = list.filter(isKaraokeGuionItem);
  if (karaoke.length === 0) return;
  ensureKaraokeEnabledForBackground(session);
  for (const item of karaoke) {
    enqueueBackgroundKaraoke(session, item.id, { deferBroadcast: true });
  }
  // One flush for the batch of 0 % rows, then start the drain.
  scheduleBgProgressBroadcast(session, true);
  void drainBackgroundKaraoke(session.id);
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
 * Live / session-cache cues still match the current Biblioteca cancionero.
 * If the operator edited the song, we must recalculate before showing cues.
 */
async function agentLyricsStillCurrent(
  agent: SubtitleAgentState,
  mediaPath?: string | null,
): Promise<boolean> {
  if (agent.lyricsSource === "lrclib") return true;
  const assetId = agent.assetId;
  if (!assetId) return false;
  let meta = getPersistMeta(assetId);
  if (!meta) {
    const fileKey = await resolveCacheKey(assetId, mediaPath ?? null);
    if (!fileKey) return false;
    const saved = await loadPersistedAgent(fileKey, agent.targetLang);
    if (!saved) return false;
    meta = {
      songId: saved.songId,
      lyricsHash: saved.lyricsHash,
      source: saved.source,
      lrclibSong: saved.lrclibSong,
    };
  }
  if (meta.source === "lrclib") return true;
  const hit = await resolveCancioneroSongById(meta.songId);
  if (!hit) return false;
  return lyricsHash(songCancioneroLines(hit.song)) === meta.lyricsHash;
}

/** Biblioteca song edited → drop karaoke caches so Guion add re-checks lyrics. */
export async function invalidateKaraokeAfterLibrarySongEdit(
  songId: string,
): Promise<void> {
  forgetAllReadyAgents();
  await purgeAlignedCacheForLibrarySong(songId);
}

/**
 * Load a saved alignment for this YouTube video into the agent state.
 * Returns true when the agent now shows the restored (ready) cues.
 */
/** Kept for manual recovery / tests; normal jobs purge cache before each song. */
export async function restorePersistedAgent(
  sessionId: string,
  itemId: string,
  assetId: string,
  mediaPath: string | null,
  targetLang: SubtitleTargetLang,
  cancelRunning: boolean,
): Promise<boolean> {
  const fileKey = await resolveCacheKey(assetId, mediaPath);
  if (!fileKey) return false;
  const saved = await loadPersistedAgent(fileKey, targetLang);
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
  | "other";

/**
 * Entry point for every trigger (Guion add, toggle, Go Live).
 * A non-forced trigger for the SAME item+asset+lang that is already being
 * processed is dropped: restarting would supersede the running job, wipe the
 * cues and redo the (slow) download / silence scan / alignment from scratch.
 */
async function runSubtitleJob(
  sessionId: string,
  preferredItemId?: string,
  options?: {
    force?: boolean;
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

  // En vivo with lyrics already ready → keep them. Never wipe 100% back to 0%.
  if (
    peekSession &&
    peekAgent &&
    peekResolved?.ok &&
    (source === "go_live" ||
      (source === "toggle_or_set" && options?.force !== true))
  ) {
    const cuesOk =
      peekAgent.cues.length > 0 &&
      peekAgent.cues.every(
        (c) =>
          Number.isFinite(c.startMs) &&
          Number.isFinite(c.endMs) &&
          c.endMs > c.startMs &&
          Boolean(String(c.text ?? "").trim()),
      );
    const shownReady =
      peekAgent.status === "ready" &&
      peekAgent.itemId === peekResolved.item.id &&
      peekAgent.assetId === peekResolved.assetId &&
      cuesOk;
    if (shownReady && cuesSuspiciouslyEarly(peekAgent.cues)) {
      console.warn(
        `[subtitle] ready cues suspiciously early first=${peekAgent.cues[0]?.startMs ?? "n/a"} — rebuilding`,
      );
      forgetReadyAgent(sessionId, peekResolved.item.id);
    } else if (shownReady) {
      const meta = peekAgent.assetId
        ? getPersistMeta(peekAgent.assetId)
        : null;
      const lyricsChanged =
        meta != null &&
        meta.source !== "lrclib" &&
        !(await agentLyricsStillCurrent(peekAgent, peekResolved.mediaPath));
      if (!lyricsChanged) {
        // Already calculated for this item. En vivo must not restart 0→100%.
        console.log(
          `[subtitle] keep ready cues on ${source} item=${peekResolved.item.id} n=${peekAgent.cues.length}`,
        );
        return;
      }
      console.log(
        `[subtitle] cancionero modified — discarding ready cues item=${peekResolved.item.id}`,
      );
      forgetReadyAgent(sessionId, peekResolved.item.id);
    }
    const hit = recallReadyAgent(
      sessionId,
      peekResolved.item.id,
      peekResolved.assetId,
      peekAgent.targetLang,
    );
    if (hit && hit.cues.length > 0 && cuesSuspiciouslyEarly(hit.cues)) {
      console.warn(
        `[subtitle] session cache early first=${hit.cues[0]?.startMs ?? "n/a"} — ignoring`,
      );
      forgetReadyAgent(sessionId, peekResolved.item.id);
    } else if (hit && hit.cues.length > 0) {
      if (await agentLyricsStillCurrent(hit, peekResolved.mediaPath)) {
        bumpJob(sessionId);
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
        broadcastSession(
          sessionId,
          sessionStore.touchSubtitleAgent(peekSession),
        );
        console.log(
          `[subtitle] restored session cache on ${source} item=${peekResolved.item.id} cues=${hit.cues.length}`,
        );
        return;
      }
      console.log(
        `[subtitle] cancionero modified — ignoring session cache item=${peekResolved.item.id}`,
      );
      forgetReadyAgent(sessionId, peekResolved.item.id);
    }
    // Disk restore only for Go Live — preparation already purged/rebuilt once.
    if (source === "go_live") {
      const busyOther = inflightJobs.get(sessionId);
      if (
        await restorePersistedAgent(
          sessionId,
          peekResolved.item.id,
          peekResolved.assetId,
          peekResolved.mediaPath,
          peekAgent.targetLang,
          busyOther != null,
        )
      ) {
        return;
      }
    }
  }

  // Guion add: re-check cancionero before calculating. Unchanged lyrics →
  // restore disk cues; modified / missing → purge and recalculate.
  if (peekResolved?.ok && source === "guion_add" && peekAgent) {
    if (
      await restorePersistedAgent(
        sessionId,
        peekResolved.item.id,
        peekResolved.assetId,
        peekResolved.mediaPath,
        peekAgent.targetLang,
        true,
      )
    ) {
      console.log(
        `[subtitle] guion_add: cancionero unchanged — restored cues item=${peekResolved.item.id}`,
      );
      return;
    }
    console.log(
      `[subtitle] guion_add: cancionero missing or modified — calculating cues item=${peekResolved.item.id}`,
    );
    const mediaKey = cancioneroMediaKey({
      youtubeVideoId: peekResolved.youtube?.videoId,
      assetId: peekResolved.assetId,
    });
    forgetReadyAgent(sessionId, peekResolved.item.id);
    await forgetCancioneroTiming(mediaKey);
    await purgeKaraokeCacheForSong({
      assetId: peekResolved.assetId,
      mediaPath: peekResolved.mediaPath,
    });
  } else if (peekResolved?.ok && source !== "go_live") {
    // Toggle / focus: purge stale aligned clocks before a fresh run.
    const mediaKey = cancioneroMediaKey({
      youtubeVideoId: peekResolved.youtube?.videoId,
      assetId: peekResolved.assetId,
    });
    forgetReadyAgent(sessionId, peekResolved.item.id);
    await forgetCancioneroTiming(mediaKey);
    await purgeKaraokeCacheForSong({
      assetId: peekResolved.assetId,
      mediaPath: peekResolved.mediaPath,
    });
  } else if (peekResolved?.ok && source === "go_live") {
    // Go Live without ready cues (still preparing): do not purge mid-job —
    // that reset 100%→0%. Only force a fresh align if nothing is in flight.
    const runningSame =
      key &&
      inflightJobs.get(sessionId)?.key === key &&
      Date.now() - (inflightJobs.get(sessionId)?.at ?? 0) < INFLIGHT_MAX_AGE_MS;
    if (runningSame) {
      console.log(
        `[subtitle] go_live while preparing item=${peekResolved.item.id} — wait for current job`,
      );
      return;
    }
    const mediaKey = cancioneroMediaKey({
      youtubeVideoId: peekResolved.youtube?.videoId,
      assetId: peekResolved.assetId,
    });
    forgetReadyAgent(sessionId, peekResolved.item.id);
    await forgetCancioneroTiming(mediaKey);
    await purgeKaraokeCacheForSong({
      assetId: peekResolved.assetId,
      mediaPath: peekResolved.mediaPath,
    });
  }

  // This row is being (or about to be) prepared by the background queue: do
  // not start a second, cancellable foreground job. Show it as waiting; the
  // queue publishes the cues here when the row finishes. Go Live is explicit,
  // so it still runs its own job (the queue skips the row once it is ready).
  if (
    peekSession &&
    peekAgent &&
    peekResolved?.ok &&
    source !== "go_live" &&
    isRowQueued(sessionId, peekResolved.item.id)
  ) {
    if (peekAgent.itemId !== peekResolved.item.id) {
      patchAndBroadcast(peekSession, {
        enabled: true,
        itemId: peekResolved.item.id,
        assetId: peekResolved.assetId,
        status: "idle",
        cues: [],
        cueIndex: null,
        hint: "cancionero_align",
        translated: false,
        sourceLang: null,
      });
    }
    return;
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
    options?.force !== true
  ) {
    console.log(`[subtitle] job already running for this item — not restarting`);
    return;
  }

  const token = { key: key ?? "", at: Date.now() };
  if (key) inflightJobs.set(sessionId, token);
  try {
    // Per-song purge above requires a forced recompute (skip in-memory "ready").
    await runSubtitleJobInner(sessionId, preferredItemId, {
      ...options,
      force: true,
    });
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
  options?: { force?: boolean; source?: JobSource },
): Promise<void> {
  const force = options?.force === true;
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
  const bg = bgStore.getStore();
  const gen = bg ? (bgGeneration.get(sessionId) ?? 0) : bumpJob(sessionId);
  const session = sessionStore.get(sessionId);
  if (!session) return;

  if (!session.live.subtitleAgent?.enabled) return;
  // Background rows work on their own private agent state.
  const agent = bg ? bg.agent : session.live.subtitleAgent;

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

  // Same item+asset already ready for this target — keep cues.
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
        onProgress: ytDownloadProgress(sessionId, gen),
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

    const voiceEntrance = sungEntranceMs(
      asr.words ?? [],
      silenceAuto?.silences ?? [],
    );
    if (voiceEntrance != null) {
      console.log(
        `[subtitle] whisper voice scan words=${asr.words?.length ?? 0} entrance=${voiceEntrance}ms`,
      );
    }
    const asrAtVoice =
      voiceEntrance != null
        ? anchorFirstCueToVoiceOnset(shapedAsr, voiceEntrance)
        : shapedAsr;

    // Silence can only place a line per onset. With far fewer onsets than ASR
    // lines (e.g. 10 onsets / 28 lines) it would squash the lyric chart, so
    // keep Whisper's own clocks and use silence only to blank at the breath.
    const silenceCoversLines =
      silenceAuto != null &&
      silenceAuto.onsetsMs.length >= Math.ceil(asrLines.length * 0.7);

    // Prefer silence phrase placement when onsets cover the ASR lines; else
    // keep Fast Whisper / whisper.cpp segment clocks and blank on breaths.
    const asrClockCues: SubtitleCue[] = asrAtVoice;

    if (
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
      const voiced = anchorFirstCueToVoiceOnset(
        aligned.cues,
        voiceEntrance,
      );
      const packed = packKaraokeDisplayCues(voiced, 1, 1);
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
        nativeTrack: true,
        preserveLyricsSource: true,
        timingMode: "exact",
        hint: aligned.synced ? "asr_silence_aligned" : "asr_silence_partial",
      });
      if (okSilence) return;
    }

    if (shapedAsr.length > 0 && silenceAuto && !silenceCoversLines) {
      const blanked = packKaraokeDisplayCues(
        blankCuesAtPhraseSilence(
          asrClockCues,
          silenceAuto.silences,
          silenceAuto.durationMs,
          SILENCE_AIR_ANTICIPATION_MS,
        ),
        1,
        1,
      );
      console.log(
        `[subtitle] ASR clocks + silence blank lines=${shapedAsr.length} onsets=${silenceAuto.onsetsMs.length} silences=${silenceAuto.silences.length} airMs=${SILENCE_AIR_ANTICIPATION_MS}`,
      );
      const okClocks = await finishWithCues({
        sessionId,
        gen,
        itemId: resolved.item.id,
        assetId: silenceAuto.assetId || assetId,
        cues: blanked,
        sourceLang:
          asr.sourceLang ?? (asr.whisperTranslatedToEn ? "en" : targetLang),
        targetLang,
        alreadyEnglish: asr.whisperTranslatedToEn,
        nativeTrack: true,
        preserveLyricsSource: true,
        timingMode: "exact",
        hint: "asr_clocks_blank",
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
