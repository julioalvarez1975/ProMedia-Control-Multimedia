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
  buildKaraokeAlignPrompt,
  findCancioneroSongCandidates,
  packKaraokeDisplayCues,
  probeMediaDurationMs,
  resolveCancioneroSongById,
  scoreSongLyricOverlap,
  scoreSongMatch,
  snapAlignedCuesToSilenceOnsets,
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
  const speech = filterSpeechCues(options.cues);
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
        `[subtitle] cancionero miss (${listed.reason ?? "no_match"}) — auto-generate lyrics via captions/Whisper tried=${JSON.stringify(listed.tried)}`,
      );
      // Continue runSubtitleJob → YouTube captions or Whisper ASR as lyric text.
      return false;
    }
    match = strong[0]!;
    learnSource = match.score >= 100 ? "exact" : "fuzzy";
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

  // Karaoke: download → WhisperX forced align (cancionero text → audio) →
  // one line per phrase, 500 ms before the voice. Silence/ASR only as fallback.
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

  // Ensure local audio exists (YouTube download) before WhisperX / silence.
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

  let lineCues = songToSubtitleCues(match.song, durationMs);
  let synced = false;
  let timingModeHint = "cancionero_match";
  let published = false;

  const publishKaraokeCues = async (
    nextLineCues: SubtitleCue[],
    hint: string,
  ): Promise<boolean> => {
    let nextCues = packKaraokeDisplayCues(nextLineCues, 1, 1);
    const taughtTiming = await recallCancioneroTiming(mediaKey);
    if (taughtTiming?.cueStarts?.length) {
      nextCues = applyRememberedCueStarts(nextCues, taughtTiming.cueStarts);
    }
    if (!nextCues.length) return false;
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
    if (okPub) return true;
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
    });
    return true;
  };

  // 1) Silence map first (fast) — publish ASAP so Output is not blank.
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

  if (silence && silence.onsetsMs.length > 0) {
    const aligned = alignCancioneroLinesToSilence(
      lines,
      silence.onsetsMs,
      durationMs || silence.durationMs,
      SILENCE_AIR_ANTICIPATION_MS,
      silence.silences,
    );
    lineCues = aligned.cues;
    synced = aligned.synced;
    assetId = silence.assetId || assetId;
    timingModeHint = synced
      ? "cancionero_match_silence"
      : "cancionero_match_silence_partial";
    console.log(
      `[subtitle] karaoke silence-align synced=${synced} aligned=${aligned.alignedCount}/${lines.length} airMs=${SILENCE_AIR_ANTICIPATION_MS}`,
    );
  }

  // Publish baseline (silence or equal-time) before WhisperX / ASR.
  published = await publishKaraokeCues(lineCues, timingModeHint);
  if (!isCurrent(sessionId, gen)) return true;

  // 2) WhisperX forced align — refine clocks; cues already on screen.
  const canWhisperx = mediaPath ? await whisperxAvailable() : false;
  if (canWhisperx && mediaPath) {
    const wx = await alignLyricsWithWhisperx({
      mediaPath,
      assetId,
      lines,
      language: targetLang === "en" ? "en" : "es",
      durationMs,
      airMs: SILENCE_AIR_ANTICIPATION_MS,
      onsetHintsMs: silence?.onsetsMs ?? [],
      onStatus: (st) => statusPatch(st, "whisperx_align"),
    });
    if (!isCurrent(sessionId, gen)) return true;
    if (wx && wx.cues.length > 0) {
      lineCues = wx.cues;
      synced = wx.cues.length >= Math.max(1, Math.ceil(lines.length * 0.5));
      if (wx.durationMs > 0) durationMs = Math.max(durationMs, wx.durationMs);
      timingModeHint = synced
        ? "cancionero_match_whisperx"
        : "cancionero_match_whisperx_partial";
      console.log(
        `[subtitle] karaoke whisperx synced=${synced} lines=${wx.cues.length}/${lines.length} model=${wx.alignModel} airMs=${SILENCE_AIR_ANTICIPATION_MS}`,
      );
      published =
        (await publishKaraokeCues(lineCues, timingModeHint)) || published;
    }
  } else if (!canWhisperx) {
    console.warn(
      "[subtitle] whisperx not installed — using silence/equal karaoke align",
    );
  }

  // 3) Only if still weak: captions/ASR clocks (slow) + lyric disambiguation.
  if (!synced || (ambiguous && learnSource !== "manual")) {
    const alignPrompt = buildKaraokeAlignPrompt(lines);
    const timing = await fetchCancioneroTimingCues({
      sessionId,
      gen,
      targetLang,
      resolved: { ...resolved, mediaPath, assetId },
      alignPrompt,
      onStatus: statusPatch,
    });
    if (!isCurrent(sessionId, gen)) return true;

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
        lineCues = songToSubtitleCues(match.song, durationMs);
        if (silence && silence.onsetsMs.length > 0) {
          const realigned = alignCancioneroLinesToSilence(
            lines,
            silence.onsetsMs,
            durationMs || silence.durationMs,
            SILENCE_AIR_ANTICIPATION_MS,
            silence.silences,
          );
          lineCues = realigned.cues;
          synced = realigned.synced;
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

    if (!synced && timing && timing.cues.length > 0) {
      if (silence && silence.onsetsMs.length > 0) {
        const textAligned = alignCancioneroLinesToTiming(
          lines,
          timing.cues,
          durationMs,
        );
        const snapped = snapAlignedCuesToSilenceOnsets(
          textAligned.cues,
          silence.onsetsMs,
          durationMs || silence.durationMs,
          SILENCE_AIR_ANTICIPATION_MS,
          silence.silences,
        );
        lineCues = snapped.cues;
        synced = snapped.synced || textAligned.synced;
        timingModeHint = synced
          ? "cancionero_match_silence_snap"
          : "cancionero_match_silence_snap_partial";
      } else {
        const aligned = alignCancioneroLinesToTiming(
          lines,
          timing.cues,
          durationMs,
        );
        const airOnly = snapAlignedCuesToSilenceOnsets(
          aligned.cues,
          [],
          durationMs,
          SILENCE_AIR_ANTICIPATION_MS,
          [],
        );
        lineCues = airOnly.cues;
        synced = aligned.synced;
        assetId = timing.assetId || assetId;
        timingModeHint = synced
          ? "cancionero_match_audio_air"
          : "cancionero_match_audio_air_partial";
      }
    }
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
  if (rememberOk) {
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
  void runSubtitleJob(session.id, itemId ?? session.live.currentItemId ?? undefined, {
    force: true,
    teachSongId: songId,
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
  void runSubtitleJob(session.id, patch.itemId, { force: wasOff });

  return message;
}

/** Re-run when Go Live changes the A/V item under an active agent. */
export function maybeRefreshSubtitleAgent(session: SessionRecord): void {
  const agent = session.live.subtitleAgent;
  if (!agent?.enabled) return;
  // Missing yt-dlp/ffmpeg: do not tight-loop; quiet re-check inside the job.
  void runSubtitleJob(session.id, session.live.currentItemId ?? undefined, {
    force: false,
  });
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
  void runSubtitleJob(session.id, item.id, { force: true });
}

async function runSubtitleJob(
  sessionId: string,
  preferredItemId?: string,
  options?: { force?: boolean; teachSongId?: string },
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

  // Same asset already ready for this target — keep cues
  // (unless operator is teaching a different cancionero song).
  if (
    !teachSongId &&
    agent.status === "ready" &&
    agent.assetId === resolved.assetId &&
    agent.targetLang === targetLang &&
    agent.cues.length > 0
  ) {
    if (agent.itemId !== resolved.item.id) {
      patchAndBroadcast(session, { itemId: resolved.item.id });
    }
    return;
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
    // pick where each sentence starts (−200 ms air) — same clock as karaoke.
    const shapedAsr = shapeLyricLikeCues(filterSpeechCues(asr.cues));
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

    if (silenceAuto && silenceAuto.onsetsMs.length > 0 && asrLines.length > 0) {
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
