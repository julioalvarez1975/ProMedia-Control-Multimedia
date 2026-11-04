/**
 * ProMedia shared protocol types (subtarea 2–8+).
 * No UI logic — hub and web import these shapes.
 */

export type SessionMode = "lan" | "cloud" | "portable";

export type ClientRole = "control" | "output";

export type TextAlign = "left" | "center" | "right";

export type TextSlide = {
  id: string;
  lines: string[];
};

export type TextPayload = {
  title?: string;
  slides: TextSlide[];
  align?: TextAlign;
  /**
   * @deprecated Ignored. Older songs stored one big block with `false`; every
   * text item now projects one blank-line-separated phrase per slide (long
   * phrases split every 6 lines), so those legacy items still navigate.
   */
  chunkLines?: boolean;
};

export type ImageFit = "contain" | "cover" | "fill";

export type ImagePayload = {
  assetId: string;
  fit: ImageFit;
  title?: string;
};

export type VideoFit = "contain" | "cover";

export type VideoFilePayload = {
  sourceKind: "file";
  assetId: string;
  title?: string;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  fit?: VideoFit;
};

export type VideoYoutubePayload = {
  sourceKind: "youtube";
  videoId: string;
  sourceUrl: string;
  title?: string;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  fit?: VideoFit;
};

export type VideoPayload = VideoFilePayload | VideoYoutubePayload;

/**
 * Bible passage as slides (one verse per slide). Renders like text on Output.
 * Version ids: rvr1909 | pdt | kjv | asv (see README licensing).
 */
export type BiblePayload = {
  versionId: string;
  versionLabel: string;
  bookId: string;
  bookName: string;
  chapter: number;
  verseStart: number;
  verseEnd: number;
  /** Display reference, e.g. "Juan 3:16-17". */
  reference: string;
  copyright?: string;
  /** True when served from embedded offline subset. */
  fromCache?: boolean;
  slides: TextSlide[];
  align?: TextAlign;
};

export type TextPlaylistItem = {
  id: string;
  type: "text";
  order: number;
  payload: TextPayload;
};

export type ImagePlaylistItem = {
  id: string;
  type: "image";
  order: number;
  payload: ImagePayload;
};

export type VideoPlaylistItem = {
  id: string;
  type: "video";
  order: number;
  payload: VideoPayload;
};

/** Local audio/music file (mp3, wav, m4a, …) — plays via mediaClock like file video. */
export type AudioPayload = {
  assetId: string;
  title?: string;
  autoplay?: boolean;
  loop?: boolean;
};

export type AudioPlaylistItem = {
  id: string;
  type: "audio";
  order: number;
  payload: AudioPayload;
};

export type BiblePlaylistItem = {
  id: string;
  type: "bible";
  order: number;
  payload: BiblePayload;
};

/** One projected page/slide of an imported presentation (image or SVG asset). */
export type PresentationSlide = {
  id: string;
  assetId: string;
};

/**
 * View-only presentation (PPTX/PDF/… import). No native edit — ←/→ navigates slides.
 */
export type PresentationPayload = {
  title?: string;
  fit: ImageFit;
  slides: PresentationSlide[];
  /** Original filename kept for operator reference / re-download from library. */
  originalName?: string;
  libraryItemId?: string;
};

export type PresentationPlaylistItem = {
  id: string;
  type: "presentation";
  order: number;
  payload: PresentationPayload;
};

export type PlaylistItemType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "bible"
  | "presentation";

export type PlaylistItem =
  | TextPlaylistItem
  | ImagePlaylistItem
  | VideoPlaylistItem
  | AudioPlaylistItem
  | BiblePlaylistItem
  | PresentationPlaylistItem;

/** Local media library categories (Phase 1 — on-disk, not cloud). */
export type LibraryCategory =
  | "canciones"
  | "biblias"
  | "textos"
  | "presentaciones"
  | "imagenes"
  | "videos"
  | "audios";

export const LIBRARY_CATEGORIES: readonly LibraryCategory[] = [
  "canciones",
  "biblias",
  "textos",
  "presentaciones",
  "imagenes",
  "videos",
  "audios",
] as const;

export type LibrarySongStanza = {
  id: string;
  lines: string[];
};

export type LibrarySongPayload = {
  title: string;
  artist?: string;
  stanzas: LibrarySongStanza[];
};

export type LibraryFileRef = {
  relativePath: string;
  mime: string;
  originalName: string;
  size: number;
};

export type LibrarySlideRef = {
  id: string;
  relativePath: string;
  mime: string;
};

/** Full local Bible translation imported into the hub library (not committed to git). */
export type LibraryBibleVersionMeta = {
  /** Stable slug used by Guion Biblia picker / lookup (e.g. rv1960, nvi, lbla). */
  versionId: string;
  label: string;
  shortLabel: string;
  language: "es" | "en" | string;
  copyright?: string;
  bookCount: number;
  verseCount: number;
  /** Source parse format. */
  format: "bible-bcv" | "bible-numbered" | "pdf-nt";
  /** Path under library root to canon JSON (book→chapter→verse). */
  canonRelativePath: string;
  /** Optional operator note (e.g. solo NT). */
  note?: string;
};

export type LibraryItem = {
  id: string;
  category: LibraryCategory;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Songs: lyrics by stanza (projectable as text). */
  song?: LibrarySongPayload;
  /** Free-form text saved in library. */
  text?: TextPayload;
  /** Bible passage snapshot. */
  bible?: BiblePayload;
  /** Full imported translation (lookup via Guion Biblia; not a playlist dump). */
  bibleVersion?: LibraryBibleVersionMeta;
  /** Original uploaded file (presentations, images, videos, optional for others). */
  original?: LibraryFileRef;
  /** Rendered pages/slides for projection (presentations). */
  slides?: LibrarySlideRef[];
};

export type SessionPlaylist = {
  items: PlaylistItem[];
};

/** Named playlist snapshot (subtarea 9). Asset bytes stay in media store. */
export type SavedPlaylist = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  items: PlaylistItem[];
};

export type MediaKind = "image" | "video" | "audio";

/** Media asset metadata (bytes live on disk via packages/media). */
export type MediaAsset = {
  id: string;
  kind: MediaKind;
  mime: string;
  storageKey: string;
  size?: number;
  durationMs?: number;
  originalName?: string;
  createdAt: string;
};

export type MediaClock = {
  itemId: string;
  playing: boolean;
  positionMs: number;
  rate?: number;
  updatedAt: string;
};

/** Target languages for the local subtitle agent (Phase 1). */
export type SubtitleTargetLang = "es" | "en" | "pt" | "fr" | "zh-CN";

export const SUBTITLE_TARGET_LANGS: readonly SubtitleTargetLang[] = [
  "es",
  "en",
  "pt",
  "fr",
  "zh-CN",
] as const;

export function isSubtitleTargetLang(
  value: unknown,
): value is SubtitleTargetLang {
  return (
    typeof value === "string" &&
    (SUBTITLE_TARGET_LANGS as readonly string[]).includes(value)
  );
}

/** One timed caption cue (ms relative to media start). */
export type SubtitleCue = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

/**
 * Local AI subtitle agent state (Phase 1 — offline ASR + optional local MT).
 * Broadcast on every session.updated so Preview and Output stay in sync.
 */
export type SubtitleAgentStatus =
  | "off"
  | "idle"
  | "downloading"
  | "extracting"
  | "transcribing"
  | "translating"
  | "ready"
  | "unsupported"
  | "error";

/** Caption size on Preview / Live / Output (SM–XL). Default MD. */
export type SubtitleFontSize = "sm" | "md" | "lg" | "xl";

export const SUBTITLE_FONT_SIZES: readonly SubtitleFontSize[] = [
  "sm",
  "md",
  "lg",
  "xl",
] as const;

export function isSubtitleFontSize(value: unknown): value is SubtitleFontSize {
  return value === "sm" || value === "md" || value === "lg" || value === "xl";
}

/**
 * Signed clock offset for timed cues vs mediaClock (ms).
 * Negative = adelante (show early); 0 = sync. Discrete steps Julio requested:
 * -3, -2.5, -2, -1.5, -1, -0.5, 0 seconds. Applies only to agent ASR cues —
 * Biblioteca songs advanced with ←/→ slides are manual and ignore lead.
 */
export type SubtitleLeadMs =
  | -3000
  | -2500
  | -2000
  | -1500
  | -1000
  | -500
  | 0;

export const SUBTITLE_LEAD_MS_OPTIONS: readonly SubtitleLeadMs[] = [
  -3000, -2500, -2000, -1500, -1000, -500, 0,
] as const;

/**
 * Native caption agent default: sync with cue clocks (YouTube/sidecar as-is).
 * Operators can still pick Adelante −3…−0.5 via the toolbar.
 */
export const DEFAULT_SUBTITLE_LEAD_MS: SubtitleLeadMs = 0;

/**
 * Cancionero / Biblioteca lyric path: sync with aligned onset (no default
 * adelante). Operators can still pick Adelante −3…−0.5 in the toolbar.
 */
export const CANCIONERO_DEFAULT_LEAD_MS: SubtitleLeadMs = 0;

/**
 * How the overlay maps mediaClock → cue.
 * - `exact`: cue windows as stored (official captions / no intro-hold).
 * - `assisted`: intro-hold first lyric through musical lead-in (ASR fallback).
 */
export type SubtitleTimingMode = "exact" | "assisted";

export const SUBTITLE_TIMING_MODES: readonly SubtitleTimingMode[] = [
  "exact",
  "assisted",
] as const;

export function isSubtitleTimingMode(
  value: unknown,
): value is SubtitleTimingMode {
  return (
    typeof value === "string" &&
    (SUBTITLE_TIMING_MODES as readonly string[]).includes(value)
  );
}

export function isSubtitleLeadMs(value: unknown): value is SubtitleLeadMs {
  return (
    typeof value === "number" &&
    (SUBTITLE_LEAD_MS_OPTIONS as readonly number[]).includes(value)
  );
}

/**
 * Coerce unknown / legacy values into a valid lead preset.
 * Legacy positive leadMs (how-early ms, e.g. 2000) maps to signed −2000.
 */
export function normalizeSubtitleLeadMs(value: unknown): SubtitleLeadMs {
  if (isSubtitleLeadMs(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Old sessions/clients stored positive “how early” ms (1500–3000).
    const signed = value > 0 ? -value : value;
    const clamped = Math.min(0, Math.max(-3000, signed));
    let best: SubtitleLeadMs = DEFAULT_SUBTITLE_LEAD_MS;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const opt of SUBTITLE_LEAD_MS_OPTIONS) {
      const dist = Math.abs(opt - clamped);
      if (dist < bestDist) {
        best = opt;
        bestDist = dist;
      }
    }
    return best;
  }
  return DEFAULT_SUBTITLE_LEAD_MS;
}

export type SubtitleAgentState = {
  enabled: boolean;
  targetLang: SubtitleTargetLang;
  status: SubtitleAgentStatus;
  /** Caption size (SM / MD / LG / XL). Persisted in session. */
  fontSize: SubtitleFontSize;
  /**
   * Signed offset vs mediaClock (ms): −3s…0 presets. Negative = adelante.
   * Only affects agent ASR/YouTube cues — not manual song slides.
   */
  leadMs: SubtitleLeadMs;
  /**
   * `exact` = native captions (YouTube/sidecar clocks as-is, no intro-hold).
   * `assisted` = ASR fallback (intro-hold through musical intro).
   */
  timingMode: SubtitleTimingMode;
  /** Playlist item the current cues belong to (if any). */
  itemId: string | null;
  /** Asset id used for ASR cache (`file` asset id, or `yt_<videoId>` for YouTube). */
  assetId: string | null;
  /** Detected / source language of ASR (BCP-47-ish: es, en, …). */
  sourceLang: string | null;
  /** True when cue text was machine-translated to targetLang. */
  translated: boolean;
  cues: SubtitleCue[];
  /**
   * Manual karaoke step:
   * - `null` — clock lookup (auto)
   * - `-1` — forced blank (before first line; ← from cue 0)
   * - `>= 0` — show `cues[cueIndex]` (operator ←/→ teach)
   */
  cueIndex: number | null;
  /** Operator-facing hint (downloading YouTube audio, text-only song, error, …). */
  hint: string | null;
  updatedAt: string | null;
};

export function emptySubtitleAgentState(
  targetLang: SubtitleTargetLang = "es",
): SubtitleAgentState {
  return {
    enabled: false,
    targetLang,
    status: "off",
    fontSize: "xl",
    leadMs: DEFAULT_SUBTITLE_LEAD_MS,
    timingMode: "exact",
    itemId: null,
    assetId: null,
    sourceLang: null,
    translated: false,
    cues: [],
    cueIndex: null,
    hint: null,
    updatedAt: null,
  };
}

/** Coerce legacy snapshots missing fontSize / leadMs / timingMode / cueIndex. */
export function normalizeSubtitleAgentState(
  raw: SubtitleAgentState | null | undefined,
): SubtitleAgentState {
  const base = raw ?? emptySubtitleAgentState();
  const cueIndexRaw = (base as { cueIndex?: unknown }).cueIndex;
  const cueIndex =
    typeof cueIndexRaw === "number" && Number.isFinite(cueIndexRaw)
      ? cueIndexRaw === -1
        ? -1
        : cueIndexRaw >= 0
          ? Math.floor(cueIndexRaw)
          : null
      : null;
  return {
    ...base,
    fontSize: isSubtitleFontSize(base.fontSize) ? base.fontSize : "md",
    leadMs: normalizeSubtitleLeadMs(
      (base as { leadMs?: unknown }).leadMs,
    ),
    timingMode: isSubtitleTimingMode(
      (base as { timingMode?: unknown }).timingMode,
    )
      ? (base as { timingMode: SubtitleTimingMode }).timingMode
      : "exact",
    cueIndex,
  };
}

/** Index of the cue active at position (or last started ≤ t; −1 if none). */
export function cueIndexAtPositionMs(
  cues: readonly SubtitleCue[],
  positionMs: number,
): number {
  if (!cues.length || !Number.isFinite(positionMs)) {
    return -1;
  }
  const t = Math.max(0, positionMs);
  let last = -1;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    if (t >= c.startMs && t < c.endMs) {
      return i;
    }
    if (c.startMs <= t) {
      last = i;
    }
  }
  return last;
}

/** Active cue at mediaClock position (inclusive start, exclusive end). */
export function cueAtPositionMs(
  cues: readonly SubtitleCue[],
  positionMs: number,
): SubtitleCue | null {
  if (!cues.length || !Number.isFinite(positionMs)) {
    return null;
  }
  const t = Math.max(0, positionMs);
  for (const cue of cues) {
    if (t >= cue.startMs && t < cue.endMs) {
      return cue;
    }
  }
  return null;
}

export type CueLeadLookupOptions = {
  /**
   * When true (assisted ASR), hold the first lyric from t=0 through its
   * startMs. When false (native captions), only show cues inside their
   * real windows — matches official YouTube lyric timing.
   */
  holdIntro?: boolean;
};

/**
 * Cue for display with signed offset: lookup at `positionMs - leadMs`.
 * Negative leadMs (adelante) advances the cue so the line is readable before
 * the sung words (timed agent cues only).
 *
 * Intro hold (assisted only): before the first timed cue (musical intro /
 * filtered [MÚSICA] labels), keep showing that first lyric from media start.
 * Native / exact mode skips this so clocks match uploaded captions.
 * Gaps after the first cue stay blank (no fill-forward).
 */
export function cueAtPositionWithLeadMs(
  cues: readonly SubtitleCue[],
  positionMs: number,
  leadMs: number,
  options?: CueLeadLookupOptions,
): SubtitleCue | null {
  const offset =
    typeof leadMs === "number" && Number.isFinite(leadMs)
      ? leadMs
      : DEFAULT_SUBTITLE_LEAD_MS;
  const lookup = positionMs - offset;
  const hit = cueAtPositionMs(cues, lookup);
  if (hit) {
    return hit;
  }
  if (!cues.length || !Number.isFinite(lookup)) {
    return null;
  }
  const holdIntro = options?.holdIntro !== false;
  if (!holdIntro) {
    return null;
  }
  const first = cues[0]!;
  // Hold opening line through the lead-in until its real startMs window.
  if (lookup < first.startMs && first.text) {
    return first;
  }
  return null;
}

/** Visual overlay on Output; does not clear live item (subtarea 7). */
export type SceneMode = "normal" | "logo" | "black" | "clear";

export const SCENE_MODES: readonly SceneMode[] = [
  "normal",
  "logo",
  "black",
  "clear",
] as const;

export function isSceneMode(value: unknown): value is SceneMode {
  return (
    typeof value === "string" &&
    (SCENE_MODES as readonly string[]).includes(value)
  );
}

export type {
  ResolvedTheme,
  ThemeBackground,
  ThemeBackgroundMediaKind,
  ThemeBackgroundMode,
  ThemeBackgroundPackId,
  ThemeFontFamily,
  ThemeFontSize,
  ThemeId,
  ThemeOverrides,
  ThemePreset,
  TransitionEffect,
} from "./themes.js";
export {
  DEFAULT_THEME_BACKGROUND,
  DEFAULT_THEME_ID,
  DEFAULT_TRANSITION_EFFECT,
  THEME_BACKGROUND_PACK_IDS,
  THEME_IDS,
  THEME_PRESETS,
  TRANSITION_DURATION_MS,
  TRANSITION_EFFECTS,
  fontFamilyCss,
  fontSizeCss,
  getThemePreset,
  isThemeBackgroundMediaKind,
  isThemeBackgroundPackId,
  isThemeFontFamily,
  isThemeFontSize,
  isThemeId,
  isTransitionEffect,
  normalizeThemeBackground,
  normalizeThemeOverrides,
  resolveTheme,
  themeBackgroundPackSrc,
  themeToCssVars,
  transitionCssId,
} from "./themes.js";

import type {
  ThemeBackground,
  ThemeId,
  ThemeOverrides,
  TransitionEffect,
} from "./themes.js";
import {
  DEFAULT_THEME_BACKGROUND,
  DEFAULT_THEME_ID,
  DEFAULT_TRANSITION_EFFECT,
} from "./themes.js";

export type SessionLiveState = {
  currentItemId: string | null;
  currentSlideIndex: number;
  sceneMode: SceneMode;
  themeId: ThemeId;
  /** Deltas over preset; null = pure preset. */
  themeOverrides: ThemeOverrides | null;
  /** Stage background: solid color or media (pack / upload). */
  themeBackground: ThemeBackground;
  /** CSS transition on Output when live item changes. */
  transitionEffect: TransitionEffect;
  mediaClock: MediaClock | null;
  /** Local offline subtitle agent (Phase 1). */
  subtitleAgent: SubtitleAgentState;
  /**
   * ISO stamp of the hub-persisted branding logo (sceneMode "logo").
   * Null = no custom logo yet — Output falls back to the default SVG.
   */
  logoUpdatedAt: string | null;
  /**
   * Corner watermark: show branding logo top-right over live content.
   * Independent of sceneMode (works with "normal"; hidden under full logo/black).
   */
  watermarkEnabled: boolean;
};

export type SessionSnapshot = {
  id: string;
  code: string;
  mode: SessionMode;
  createdAt: string;
  seq: number;
  live: SessionLiveState;
  playlist: SessionPlaylist;
  lastTouchAt?: string;
  touchNote?: string;
};

export type HubMessage = {
  type: string;
  seq: number;
  sessionId: string;
  ts: string;
  payload: unknown;
};

export type SessionSnapshotPayload = SessionSnapshot;

export type SessionUpdatedPayload = {
  seq: number;
  live: SessionLiveState;
  playlist: SessionPlaylist;
  lastTouchAt?: string;
  touchNote?: string;
};

export type SessionEndedPayload = {
  reason: string;
};

export type ErrorPayload = {
  code: string;
  message: string;
};

export type ClientHelloMessage = {
  type: "client.hello";
  payload?: Record<string, unknown>;
};

export type ClientResyncMessage = {
  type: "client.resync";
  payload: { lastSeq: number };
};

export type SessionTouchMessage = {
  type: "session.touch";
  payload?: { note?: string };
};

export type PlaylistItemAddMessage = {
  type: "playlist.itemAdd";
  payload: { item: PlaylistItem };
};

export type PlaylistItemUpdateMessage = {
  type: "playlist.itemUpdate";
  payload: {
    id: string;
    patch: Partial<{
      payload:
        | TextPayload
        | ImagePayload
        | VideoPayload
        | BiblePayload
        | PresentationPayload;
      order: number;
    }>;
  };
};

export type PlaylistItemRemoveMessage = {
  type: "playlist.itemRemove";
  payload: { id: string };
};

export type PlaylistReorderMessage = {
  type: "playlist.reorder";
  payload: { orderedIds: string[] };
};

export type LiveGoMessage = {
  type: "live.go";
  payload: { itemId: string };
};

export type LiveClearMessage = {
  type: "live.clear";
  payload?: Record<string, never>;
};

export type LiveSetSlideMessage = {
  type: "live.setSlide";
  payload: { index: number };
};

export type LiveMediaClockSetMessage = {
  type: "live.mediaClock.set";
  payload: { playing: boolean; positionMs?: number };
};

export type LiveSubtitleAgentSetMessage = {
  type: "live.subtitleAgent.set";
  payload: {
    enabled?: boolean;
    targetLang?: SubtitleTargetLang;
    /** Caption size SM–XL (persisted on session). */
    fontSize?: SubtitleFontSize;
    /** Signed Adelante offset (−3s…0). Display-only; no ASR restart. */
    leadMs?: SubtitleLeadMs;
    /** Optional: process this playlist item (defaults to live, else ignored). */
    itemId?: string;
  };
};

/**
 * Operator teaches karaoke which Biblioteca song matches the current
 * Audio/YouTube item — saved to cancionero memory and forces a re-align.
 */
export type LiveSubtitleAgentTeachMessage = {
  type: "live.subtitleAgent.teach";
  payload: {
    /** Biblioteca → Canciones item id. */
    songId: string;
    /** Playlist item to bind (defaults to live / focused A/V). */
    itemId?: string;
  };
};

/**
 * Operator steps karaoke cues with ←/→ on Preview. Optional positionMs is the
 * wall-clock “this line starts now” sample used to teach timing.
 */
export type LiveSubtitleAgentNudgeMessage = {
  type: "live.subtitleAgent.nudge";
  payload: {
    /** −1 previous line · +1 next line (teach start at positionMs). */
    delta: -1 | 1;
    /** Media position (ms) when the operator pressed the key. */
    positionMs?: number;
    itemId?: string;
  };
};

export type LiveSetSceneModeMessage = {
  type: "live.setSceneMode";
  payload: { sceneMode: SceneMode };
};

export type LiveSetWatermarkMessage = {
  type: "live.setWatermark";
  payload: { enabled: boolean };
};

export type LiveSetThemeMessage = {
  type: "live.setTheme";
  payload: {
    themeId?: ThemeId;
    themeOverrides?: ThemeOverrides | null;
    themeBackground?: ThemeBackground | null;
    transitionEffect?: TransitionEffect;
  };
};

export type ClientToHubMessage =
  | ClientHelloMessage
  | ClientResyncMessage
  | SessionTouchMessage
  | PlaylistItemAddMessage
  | PlaylistItemUpdateMessage
  | PlaylistItemRemoveMessage
  | PlaylistReorderMessage
  | LiveGoMessage
  | LiveClearMessage
  | LiveSetSlideMessage
  | LiveMediaClockSetMessage
  | LiveSubtitleAgentSetMessage
  | LiveSubtitleAgentTeachMessage
  | LiveSubtitleAgentNudgeMessage
  | LiveSetSceneModeMessage
  | LiveSetWatermarkMessage
  | LiveSetThemeMessage;

export type CreateSessionRequest = {
  mode?: SessionMode;
};

export type CreateSessionResponse = {
  sessionId: string;
  code: string;
  accessToken: string;
  role: "control";
  wsTicket: string;
  joinUrl: string;
  wsUrl: string;
  snapshot: SessionSnapshot;
};

export type JoinSessionRequest = {
  code?: string;
  accessToken?: string;
  role?: ClientRole;
};

export type JoinSessionResponse = {
  sessionId: string;
  code: string;
  role: ClientRole;
  wsTicket: string;
  wsUrl: string;
  snapshot: SessionSnapshot;
};

export const SHARED_PACKAGE_VERSION = "0.0.15-mvp" as const;

export function emptyLiveState(): SessionLiveState {
  return {
    currentItemId: null,
    currentSlideIndex: 0,
    sceneMode: "normal",
    themeId: DEFAULT_THEME_ID,
    themeOverrides: null,
    themeBackground: { ...DEFAULT_THEME_BACKGROUND },
    transitionEffect: DEFAULT_TRANSITION_EFFECT,
    mediaClock: null,
    subtitleAgent: emptySubtitleAgentState(),
    logoUpdatedAt: null,
    watermarkEnabled: false,
  };
}

export function emptyPlaylist(): SessionPlaylist {
  return { items: [] };
}

/**
 * Stop wall-clock extrapolation when the hub has not heard from the player.
 * Otherwise Go Live races karaoke cues ahead while YouTube is still mounting —
 * sync only looks right after the operator rewinds.
 */
export const MEDIA_CLOCK_EXTRAPOLATION_MAX_AGE_MS = 500;

export function effectiveMediaClockPositionMs(
  clock: MediaClock,
  nowMs: number = Date.now(),
): number {
  if (!clock.playing) {
    return clock.positionMs;
  }
  const updated = Date.parse(clock.updatedAt);
  if (!Number.isFinite(updated)) {
    return clock.positionMs;
  }
  const age = nowMs - updated;
  // Freeze at last reported player time until the next heartbeat.
  if (age > MEDIA_CLOCK_EXTRAPOLATION_MAX_AGE_MS) {
    return clock.positionMs;
  }
  const rate = clock.rate ?? 1;
  return Math.max(0, clock.positionMs + age * rate);
}

export function itemLabel(item: PlaylistItem): string {
  if (item.type === "text") {
    const title = item.payload.title?.trim();
    if (title) {
      return title;
    }
    const first = item.payload.slides[0]?.lines.find((l) => l.trim().length > 0);
    return first?.trim() || "Texto";
  }
  if (item.type === "bible") {
    const ref = item.payload.reference?.trim();
    const ver = item.payload.versionLabel?.trim() || item.payload.versionId;
    if (ref) {
      return ver ? `${ref} · ${ver}` : ref;
    }
    return ver || "Biblia";
  }
  if (item.type === "image") {
    return item.payload.title?.trim() || "Imagen";
  }
  if (item.type === "audio") {
    return item.payload.title?.trim() || "Audio";
  }
  if (item.type === "presentation") {
    return (
      item.payload.title?.trim() ||
      item.payload.originalName?.trim() ||
      "Presentación"
    );
  }
  if (item.payload.sourceKind === "youtube") {
    return item.payload.title?.trim() || `YouTube ${item.payload.videoId}`;
  }
  return item.payload.title?.trim() || "Vídeo";
}

/** Text, bible and presentation items share ←/→ slide navigation. */
export function itemHasSlides(item: PlaylistItem): boolean {
  return (
    item.type === "text" ||
    item.type === "bible" ||
    item.type === "presentation"
  );
}

/**
 * Max lines shown at once on Output / Preview / Live text stages.
 * Longer slides are split into chunks so ←/→ advances by 6 lines.
 */
export const TEXT_PROJECTION_LINES = 6;

/**
 * Absolute max visual rows for karaoke projection (pack + soft-wrap).
 * Stage shows 2 large lyric lines at a time.
 */
export const LYRIC_OVERLAY_MAX_LINES = 2;

/** Pack 2 cancionero phrases per cue for large 2-line projection. */
export const LYRIC_OVERLAY_PREFERRED_LINES = 2;

/**
 * Soft-wrap budget (characters) before a source line becomes multiple
 * projection rows. Keeps stage typography large for long bible/prose lines.
 */
export const TEXT_PROJECTION_SOFT_WRAP_CHARS = 52;

/**
 * Soft-wrap budget for karaoke / cancionero overlay phrases.
 * Keeps each of the 2 projected lines short enough for large type.
 * Cancionero exact newlines still win when present.
 */
export const LYRIC_PHRASE_SOFT_WRAP_CHARS = 36;

/**
 * Flatten embedded newlines, drop blanks, and soft-wrap long lines so each
 * entry is one visual projection row (before 6-line chunking).
 */
export function normalizeProjectionLines(
  lines: string[],
  softWrapChars: number = TEXT_PROJECTION_SOFT_WRAP_CHARS,
): string[] {
  const wrapAt = Math.max(12, Math.trunc(softWrapChars));
  const out: string[] = [];
  for (const raw of lines ?? []) {
    const parts = String(raw)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }
      for (const row of softWrapProjectionLine(trimmed, wrapAt)) {
        out.push(row);
      }
    }
  }
  return out.length > 0 ? out : [""];
}

/**
 * If a row is a single orphan word, pull the last word from the previous row
 * so no projected line stands alone as one short word.
 */
export function collapseOrphanWordRows(rows: string[]): string[] {
  if (rows.length < 2) {
    return rows;
  }
  const out = rows.map((r) => String(r).trim()).filter(Boolean);
  for (let i = out.length - 1; i >= 1; i -= 1) {
    const curWords = out[i]!.split(/\s+/).filter(Boolean);
    if (curWords.length !== 1) {
      continue;
    }
    const prevWords = out[i - 1]!.split(/\s+/).filter(Boolean);
    if (prevWords.length < 2) {
      continue;
    }
    const moved = prevWords.pop()!;
    out[i - 1] = prevWords.join(" ");
    out[i] = `${moved} ${curWords[0]}`.trim();
  }
  return out.length > 0 ? out : rows;
}

/** Split one long line on word boundaries (hard-split only if a word is longer). */
export function softWrapProjectionLine(
  line: string,
  maxChars: number = TEXT_PROJECTION_SOFT_WRAP_CHARS,
): string[] {
  const text = line.trim();
  const limit = Math.max(12, Math.trunc(maxChars));
  if (text.length <= limit) {
    return text ? [text] : [];
  }
  const words = text.split(/\s+/).filter(Boolean);
  const rows: string[] = [];
  let current = "";
  const pushCurrent = () => {
    if (current) {
      rows.push(current);
      current = "";
    }
  };
  for (let wi = 0; wi < words.length; wi += 1) {
    const word = words[wi]!;
    const remaining = words.length - wi - 1;
    if (word.length > limit) {
      pushCurrent();
      for (let i = 0; i < word.length; i += limit) {
        rows.push(word.slice(i, i + limit));
      }
      continue;
    }
    if (!current) {
      current = word;
      continue;
    }
    const next = `${current} ${word}`;
    if (next.length <= limit) {
      current = next;
      continue;
    }
    // Avoid leaving a single orphan word on the next line: keep it here with
    // a soft overflow (~15%) when it is the last remaining word.
    if (remaining === 0 && next.length <= Math.ceil(limit * 1.15)) {
      current = next;
      continue;
    }
    rows.push(current);
    current = word;
  }
  pushCurrent();
  const wrapped = rows.length > 0 ? rows : [text];
  return collapseOrphanWordRows(wrapped);
}

/** Split a line list into chunks of at most `linesPerChunk` (default 6). */
export function chunkTextLines(
  lines: string[],
  linesPerChunk: number = TEXT_PROJECTION_LINES,
): string[][] {
  const limit = Math.max(1, Math.trunc(linesPerChunk));
  const source = normalizeProjectionLines(lines);
  const chunks: string[][] = [];
  for (let i = 0; i < source.length; i += limit) {
    chunks.push(source.slice(i, i + limit));
  }
  return chunks;
}

/**
 * Expand text/bible slides so each has ≤6 lines for projection navigation.
 * Preserves intentional slide boundaries; splits only when a slide is longer.
 * Multi-line blobs / blanks are normalized first so one entry = one visual row.
 */
export function projectionTextSlides(
  slides: TextSlide[],
  linesPerChunk: number = TEXT_PROJECTION_LINES,
): TextSlide[] {
  if (!Array.isArray(slides) || slides.length < 1) {
    return [{ id: "empty", lines: [""] }];
  }
  const out: TextSlide[] = [];
  for (const phrase of splitSlidesOnBlankLines(slides)) {
    const parts = chunkTextLines(phrase.lines ?? [], linesPerChunk);
    parts.forEach((lines, partIndex) => {
      out.push({
        id: partIndex === 0 ? phrase.id : `${phrase.id}__${partIndex}`,
        lines,
      });
    });
  }
  return out.length > 0 ? out : [{ id: "empty", lines: [""] }];
}

/**
 * A blank line inside a slide separates phrases: each phrase becomes its own
 * slide (so ←/→ and Vista previa step phrase by phrase). A slide without
 * blank-line breaks is returned untouched.
 */
export function splitSlideOnBlankLines(slide: TextSlide): TextSlide[] {
  const groups: string[][] = [];
  let current: string[] = [];
  for (const raw of slide.lines ?? []) {
    for (const part of String(raw)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")) {
      if (part.trim()) {
        current.push(part);
      } else if (current.length > 0) {
        groups.push(current);
        current = [];
      }
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  if (groups.length <= 1) {
    return [slide];
  }
  return groups.map((lines, i) => ({
    id: i === 0 ? slide.id : `${slide.id}~${i}`,
    lines,
  }));
}

export function splitSlidesOnBlankLines(slides: TextSlide[]): TextSlide[] {
  return slides.flatMap((slide) => splitSlideOnBlankLines(slide));
}

/** Resolve slides for projection: one phrase per slide, ≤6 lines each. */
export function resolveProjectionTextSlides(payload: {
  slides: TextSlide[];
  chunkLines?: boolean;
}): TextSlide[] {
  return projectionTextSlides(payload.slides);
}

/** Slide count used by ←/→ (text/bible after 6-line chunking; presentation = pages). */
export function itemProjectionSlideCount(item: PlaylistItem): number {
  if (item.type === "presentation") {
    return Math.max(item.payload.slides.length, 0);
  }
  if (item.type !== "text" && item.type !== "bible") {
    return 0;
  }
  return resolveProjectionTextSlides(item.payload).length;
}

/** Flatten song stanzas into one lyric block (agent + karaoke sync). */
export function flattenSongLyrics(song: LibrarySongPayload): LibrarySongPayload {
  const lines: string[] = [];
  for (const stanza of song.stanzas ?? []) {
    for (const line of stanza.lines ?? []) {
      lines.push(String(line));
    }
  }
  const id =
    (song.stanzas?.[0]?.id && String(song.stanzas[0].id)) || "lyrics";
  return {
    title: song.title,
    artist: song.artist,
    stanzas: [{ id, lines: lines.length > 0 ? lines : [""] }],
  };
}

/**
 * Convert library song → text slides, one per phrase (blank lines in the
 * lyrics separate phrases). ←/→ steps phrase by phrase; a phrase longer than
 * 6 lines is split on projection.
 */
export function songToTextPayload(song: LibrarySongPayload): TextPayload {
  const flat = flattenSongLyrics(song);
  const stanza = flat.stanzas[0]!;
  const lines =
    stanza.lines.length > 0 ? stanza.lines.map((l) => String(l)) : [""];
  const title = flat.title.trim();
  const artist = flat.artist?.trim();
  return {
    title: artist ? `${title} — ${artist}` : title || undefined,
    align: "center",
    slides,
  };
}
  const slides = projectionTextSlides([
    { id: stanza.id || "lyrics", lines },
  ]);
