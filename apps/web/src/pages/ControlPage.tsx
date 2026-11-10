import { useEffect, useMemo, useRef, useState } from "react";
import {
  createEmptyTextPayload,
  cryptoRandomId,
  fetchYouTubeDisplayTitle,
  getItemType,
  parseYouTubeUrl,
} from "@promedia/item-types";
import type {
  AudioPayload,
  BiblePayload,
  ImageFit,
  SceneMode,
  ImagePayload,
  LibrarySongPayload,
  PlaylistItem,
  SubtitleTargetLang,
  TextPayload,
  ThemeId,
  TransitionEffect,
  VideoPayload,
} from "@promedia/shared";
import {
  DEFAULT_THEME_BACKGROUND,
  DEFAULT_THEME_ID,
  DEFAULT_TRANSITION_EFFECT,
  effectiveMediaClockPositionMs,
  emptySubtitleAgentState,
  isSubtitleTargetLang,
  itemHasSlides,
  itemProjectionSlideCount,
  normalizeThemeBackground,
  songToTextPayload,
} from "@promedia/shared";
import { AboutDialog } from "../components/AboutDialog";
import { BibliotecaDialog } from "../components/BibliotecaDialog";
import { BibleDialog } from "../components/BibleDialog";
import { ControlAdBanner } from "../components/ControlAdBanner";
import { ControlHeaderToolbar } from "../components/ControlHeaderToolbar";
import { LanRemoteHint } from "../components/LanRemoteHint";
import { LinkAddDialog } from "../components/LinkAddDialog";
import { SavedPlaylistPanel } from "../components/SavedPlaylistPanel";
import { SchedulePanel } from "../components/SchedulePanel";
import { SongEditor } from "../components/SongEditor";
import {
  StageBackground,
  StageDotsOverlay,
} from "../components/StageBackground";
import { StatusTip } from "../components/StatusTip";
import { SubtitleOverlay } from "../components/SubtitleOverlay";
import { TextItemEditor } from "../components/TextItemEditor";
import {
  IconDotsOverlay,
  IconGoLive,
  IconNext,
  IconPrev,
  IconSceneEmpty,
  IconVideoCover,
  IconSceneLogo,
  IconWatermark,
  IconUploadLogo,
} from "../components/UiIcons";
import { useLocale } from "../locale/LocaleContext";
import { useControlShortcuts } from "../hooks/useControlShortcuts";
import { useSessionConnection } from "../hooks/useSessionConnection";
import {
  LARGE_IMAGE_WARN_BYTES,
  LARGE_VIDEO_WARN_BYTES,
  buildAssetUrl,
  uploadBrandingLogo,
  downloadYoutubeAsAsset,
  uploadSessionAsset,
} from "../lib/assets";
import {
  AUDIO_MEDIA_ACCEPT,
  UNIFIED_MEDIA_ACCEPT,
  classifyMediaFile,
} from "../lib/classifyMediaFile";
import {
  loadPersistedControlSession,
  savePersistedControlSession,
} from "../lib/controlSessionPersist";
import {
  addLibraryItemToSession,
  createLibrarySong,
  uploadLibraryFile,
} from "../lib/library";
import { VideoCoverDialog } from "../components/VideoCoverDialog";
import { copyLibraryImageToSession } from "../lib/library";
import { fetchHubHealth, isLoopbackPageHost, type HubHealth } from "../lib/hub";
import {
  openOutputWindow,
  postOutputUnmute,
  startProjection,
} from "../lib/openOutputWindow";
import {
  TEXT_IMPORT_MAX_BYTES,
  TEXT_IMPORT_MAX_SLIDES,
  fileToGuionTextPayload,
  importFileToTextSlides,
} from "../lib/textImport";
import { themeSurfaceStyle } from "../lib/theme";

function assetSrcFor(
  sessionId: string,
  wsTicket: string,
  item: PlaylistItem | null,
  slideIndex = 0,
): string | undefined {
  if (!item || !sessionId || !wsTicket) {
    return undefined;
  }
  if (item.type === "image") {
    return buildAssetUrl(sessionId, item.payload.assetId, wsTicket);
  }
  if (item.type === "presentation") {
    const slide =
      item.payload.slides[slideIndex] ?? item.payload.slides[0] ?? null;
    if (!slide) {
      return undefined;
    }
    return buildAssetUrl(sessionId, slide.assetId, wsTicket);
  }
  if (item.type === "video" && item.payload.sourceKind === "file") {
    return buildAssetUrl(sessionId, item.payload.assetId, wsTicket);
  }
  if (item.type === "audio") {
    return buildAssetUrl(sessionId, item.payload.assetId, wsTicket);
  }
  return undefined;
}

/** Product Control — text + image + video playlist (subtarea 6). */
export function ControlPage() {
  const { t, locale } = useLocale();

  /** Subtitle target follows Control UI language (ES/EN/PT/FR/ZH). */
  const subtitleTargetFromLocale = (
    isSubtitleTargetLang(locale) ? locale : "es"
  ) as SubtitleTargetLang;
  const session = useSessionConnection("control");
  const [joinCode, setJoinCode] = useState("");
  const [popupBlockedUrl, setPopupBlockedUrl] = useState<string | null>(null);
  const [projectionBusy, setProjectionBusy] = useState(false);
  const autoSessionStarted = useRef(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  /** Multi-select for bulk remove (checkboxes); separate from preview selection. */
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [previewSlideIndex, setPreviewSlideIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [bibleDialogOpen, setBibleDialogOpen] = useState(false);
  const [editingBibleId, setEditingBibleId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [songEditorOpen, setSongEditorOpen] = useState(false);
  const [songBusy, setSongBusy] = useState(false);
  const [songError, setSongError] = useState<string | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  /** Soft action hints (pair / upload / remote Control). */
  const [uploadHint, setUploadHint] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadingBackground, setUploadingBackground] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoFileInputRef = useRef<HTMLInputElement>(null);
  /** Phone/LAN opened /control without token — wait for code/token pair. */
  const [needsRemotePair, setNeedsRemotePair] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const onPhoneLan = !isLoopbackPageHost();
  /** Uploaded stage backgrounds listed in the Theme dropdown (this session). */
  const [themeBackgroundAssets, setThemeBackgroundAssets] = useState<
    Array<{
      assetId: string;
      label: string;
      mediaKind: "image" | "video";
    }>
  >([]);
  const [aboutOpen, setAboutOpen] = useState(false);
  /** Local Preview playhead (ms) before Go Live — karaoke overlay + ←/→ teach. */
  const [previewLocalPositionMs, setPreviewLocalPositionMs] = useState(0);
  /** YouTube items already probed for oEmbed title (avoid repeat fetches). */
  const youtubeTitleTried = useRef<Set<string>>(new Set());
  /** Remember video durations (preview metadata) for remaining-time / scrub max. */
  const [durationByItemId, setDurationByItemId] = useState<
    Record<string, number>
  >({});
  const unifiedInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  /** Track item count for sequential multi-file order without stale closure. */
  const itemsLenRef = useRef(0);

  const rememberDuration = (itemId: string | null, ms: number) => {
    if (!itemId || !(ms > 0)) {
      return;
    }
    setDurationByItemId((prev) =>
      prev[itemId] === ms ? prev : { ...prev, [itemId]: ms },
    );
  };

  const items = session.snapshot?.playlist.items ?? [];
  itemsLenRef.current = items.length;

  // Backfill Guion labels: YouTube items stored as "YouTube {id}" get real titles.
  // Hub boot check (ffmpeg / yt-dlp / whisper / venv): warn once per connection.
  const [envIssues, setEnvIssues] = useState<NonNullable<HubHealth["startup"]>>([]);
  const [envIssuesDismissed, setEnvIssuesDismissed] = useState(false);
  const hubReachable = !session.hubUnreachable && session.hasSession;
  useEffect(() => {
    if (!hubReachable) {
      return;
    }
    let cancelled = false;
    void fetchHubHealth().then((health) => {
      if (!cancelled) {
        setEnvIssues((health?.startup ?? []).filter((c) => c.status !== "ok"));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hubReachable]);

  useEffect(() => {
    if (!session.hasSession || session.wsStatus !== "open") return;
    for (const it of items) {
      if (it.type !== "video" || it.payload.sourceKind !== "youtube") continue;
      if (it.payload.title?.trim()) continue;
      if (youtubeTitleTried.current.has(it.id)) continue;
      youtubeTitleTried.current.add(it.id);
      const sourceUrl =
        it.payload.sourceUrl?.trim() ||
        `https://www.youtube.com/watch?v=${it.payload.videoId}`;
      const itemId = it.id;
      const basePayload = it.payload;
      void fetchYouTubeDisplayTitle(sourceUrl).then((title) => {
        if (!title) return;
        session.updateItem(itemId, {
          payload: { ...basePayload, title },
        });
      });
    }
  }, [items, session.hasSession, session.wsStatus, session.updateItem]);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? null,
    [items, selectedItemId],
  );
  const selectedIndex = useMemo(
    () => items.findIndex((i) => i.id === selectedItemId),
    [items, selectedItemId],
  );
  const liveItemId = session.snapshot?.live.currentItemId ?? null;
  const liveItem = useMemo(
    () => items.find((i) => i.id === liveItemId) ?? null,
    [items, liveItemId],
  );
  const liveSlideIndex = session.snapshot?.live.currentSlideIndex ?? 0;
  const sceneMode = session.snapshot?.live.sceneMode ?? "normal";
  const mediaClock = session.snapshot?.live.mediaClock ?? null;
  const themeId: ThemeId =
    session.snapshot?.live.themeId ?? DEFAULT_THEME_ID;
  const themeOverrides = session.snapshot?.live.themeOverrides ?? null;
  const themeBackground = normalizeThemeBackground(
    session.snapshot?.live.themeBackground ?? DEFAULT_THEME_BACKGROUND,
  );
  const dotsOverlay = themeBackground.dotsOverlay === true;
  /** Dots on the video plane so Preview captions stay above the tile. */
  const previewVideoPlaneDots =
    dotsOverlay && selectedItem?.type === "video";
  const transitionEffect: TransitionEffect =
    session.snapshot?.live.transitionEffect ?? DEFAULT_TRANSITION_EFFECT;
  const subtitleAgent =
    session.snapshot?.live.subtitleAgent ?? emptySubtitleAgentState();
  const themeStyle = themeSurfaceStyle(themeId, themeOverrides);

  const subtitleFocusItem = liveItem ?? selectedItem;
  /** "Preparar Guion": some A/V item exists and none is projecting. */
  const canPrepareGuion = useMemo(() => {
    const items = session.snapshot?.playlist.items ?? [];
    const hasTarget = items.some(
      (i) =>
        i.type === "audio" ||
        (i.type === "video" && i.payload.sourceKind === "youtube"),
    );
    // The hub prepares rows in the background: allowed while something plays.
    return hasTarget;
  }, [session.snapshot?.playlist.items]);
  const subtitleAgentTitle = useMemo(() => {
    if (subtitleAgent.enabled) {
      const st = subtitleAgent.status;
      const hint = subtitleAgent.hint ?? "";
      if (st === "downloading" && hint === "youtube_audio") {
        return t("control.subtitleAgentDownloadingAudio");
      }
      if (
        (st === "downloading" || st === "extracting") &&
        (hint === "silence_scan" || hint === "cancionero_sync")
      ) {
        return t("control.subtitleAgentSilenceScan");
      }
      if (
        st === "downloading" ||
        st === "extracting" ||
        st === "transcribing" ||
        st === "translating" ||
        st === "idle"
      ) {
        return t("control.subtitleAgentWorking");
      }
      if (st === "ready") {
        if (hint === "lyrics_saved") {
          return t("control.subtitleLyricsSaved");
        }
        if (hint === "lyrics_exists") {
          return t("control.subtitleLyricsExists");
        }
        if (hint === "lyrics_save_failed") {
          return t("control.subtitleLyricsSaveFailed");
        }
        if (hint === "mt_source_only") {
          return t("control.subtitleAgentSourceOnly");
        }
        if (
          hint === "cancionero_match_synced" ||
          hint === "cancionero_match_silence"
        ) {
          return t("control.subtitleAgentCancioneroSynced");
        }
        if (
          hint === "cancionero_match" ||
          hint === "cancionero_match_silence_partial"
        ) {
          return t("control.subtitleAgentCancioneroReady");
        }
        if (
          hint === "native_captions" ||
          hint === "native_captions_auto"
        ) {
          return t("control.subtitleAgentNativeReady");
        }
        if (hint === "local_sidecar" || hint === "local_embedded") {
          return t("control.subtitleAgentLocalTracksReady");
        }
        if (hint === "asr_fallback" || hint === "asr_auto_lyrics") {
          return t("control.subtitleAgentAsrAutoLyrics");
        }
        return t("control.subtitleAgentReady");
      }
      if (st === "error") {
        if (
          hint === "cancionero_no_match" ||
          hint === "cancionero_no_songs" ||
          hint === "cancionero_empty"
        ) {
          // Should be rare now (auto-ASR); keep a short status if it appears.
          return t("control.subtitleAgentAsrAutoLyrics");
        }
        if (hint === "no_speech") {
          return t("control.subtitleAgentNoSpeech");
        }
        if (hint === "yt_dlp_missing") {
          return t("control.subtitleAgentYtDlpMissing");
        }
        if (hint === "ffmpeg_missing") {
          return t("control.subtitleAgentFfmpegMissing");
        }
        if (hint === "ffmpeg_extract_failed") {
          return t("control.subtitleAgentExtractFailed");
        }
        if (hint === "model_download_failed") {
          return t("control.subtitleAgentModelDownload");
        }
        if (hint === "model_path_error") {
          return t("control.subtitleAgentModelPath");
        }
        if (hint === "whisper_cpp_missing") {
          return t("control.subtitleAgentWhisperCppMissing");
        }
        if (
          hint === "whisper_cpp_failed" ||
          hint.startsWith("whisper_cpp_failed")
        ) {
          return t("control.subtitleAgentWhisperCppFailed");
        }
        if (hint === "youtube_age_restricted") {
          return t("control.subtitleAgentYoutubeAge");
        }
        if (hint === "youtube_private") {
          return t("control.subtitleAgentYoutubePrivate");
        }
        if (hint === "youtube_blocked" || hint === "youtube_unavailable") {
          return t("control.subtitleAgentYoutubeFailed");
        }
        if (hint.startsWith("youtube_")) {
          return t("control.subtitleAgentYoutubeFailed");
        }
        return hint
          ? `${t("control.subtitleAgentError")}: ${hint}`
          : t("control.subtitleAgentError");
      }
      if (st === "unsupported") {
        if (hint === "text_only_no_audio") {
          return t("control.subtitleAgentTextOnly");
        }
        if (hint === "no_item") {
          return t("control.subtitleAgentNoItem");
        }
        if (hint === "not_local_av") {
          return t("control.subtitleAgentTextOnly");
        }
      }
    }
    if (!subtitleFocusItem) {
      return t("control.subtitleAgentNoItem");
    }
    if (subtitleFocusItem.type === "video") {
      if (subtitleFocusItem.payload.sourceKind === "youtube") {
        return t("control.subtitleAgentYoutube");
      }
      return t("control.subtitleAgentTitle");
    }
    if (subtitleFocusItem.type === "audio") {
      return t("control.subtitleAgentTitle");
    }
    if (
      subtitleFocusItem.type === "text" ||
      subtitleFocusItem.type === "bible"
    ) {
      return t("control.subtitleAgentTextOnly");
    }
    return t("control.subtitleAgentTitle");
  }, [
    subtitleFocusItem,
    subtitleAgent.enabled,
    subtitleAgent.status,
    subtitleAgent.hint,
    t,
  ]);

  const themeBgAssetSrc =
    themeBackground.mode === "media" &&
    themeBackground.assetId &&
    session.sessionId &&
    session.wsTicket
      ? buildAssetUrl(
          session.sessionId,
          themeBackground.assetId,
          session.wsTicket,
        )
      : undefined;

  const onUploadThemeBackground = async (file: File) => {
    if (!session.sessionId || !session.wsTicket) {
      return;
    }
    setUploadingBackground(true);
    try {
      const asset = await uploadSessionAsset(
        session.sessionId,
        session.wsTicket,
        file,
      );
      const mediaKind = asset.mime.startsWith("image/")
        ? ("image" as const)
        : ("video" as const);
      const label =
        (asset.originalName && asset.originalName.trim()) ||
        t("theme.bgUploadActive");
      setThemeBackgroundAssets((prev) => {
        if (prev.some((a) => a.assetId === asset.id)) {
          return prev;
        }
        return [...prev, { assetId: asset.id, label, mediaKind }];
      });
      session.setTheme({
        themeBackground: normalizeThemeBackground({
          mode: "media",
          packId: null,
          assetId: asset.id,
          mediaKind,
          dotsOverlay: themeBackground.dotsOverlay,
        }),
      });
    } catch (err) {
      setUploadHint(
        err instanceof Error ? err.message : t("theme.bgUploadFailed"),
      );
    } finally {
      setUploadingBackground(false);
    }
  };

  const wsReady = session.wsStatus === "open";
  const sessionReady = session.hasSession;
  /** Playlist chrome needs a session; mutations need WS (auto-reconnects if down). */
  const canMutate = sessionReady && wsReady;

  // Cancionero miss does not open a modal — Whisper/captions auto-generate
  // the subtitle text.

  // When agent is on, re-target ASR if focus item changed (live preferred).
  useEffect(() => {
    if (!subtitleAgent.enabled || !canMutate) {
      return;
    }
    // The hub is preparing the Guion in order: re-targeting here would
    // supersede the running item and restart the queue.
    if (subtitleAgent.prepare?.running && !liveItemId) {
      return;
    }
    const focusId = liveItemId || selectedItemId;
    if (!focusId) {
      return;
    }
    if (subtitleAgent.itemId === focusId) {
      return;
    }
    session.setSubtitleAgent({
      enabled: true,
      targetLang: subtitleTargetFromLocale,
      itemId: focusId,
    });
    // Intentionally depend on focus ids / enabled — not full agent object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    subtitleAgent.enabled,
    subtitleAgent.itemId,
    subtitleAgent.prepare?.running,
    liveItemId,
    selectedItemId,
    canMutate,
    subtitleTargetFromLocale,
  ]);

  // Keep subtitle targetLang in sync with Control language selector.
  useEffect(() => {
    if (!subtitleAgent.enabled || !canMutate) {
      return;
    }
    if (subtitleAgent.targetLang === subtitleTargetFromLocale) {
      return;
    }
    session.setSubtitleAgent({
      enabled: true,
      targetLang: subtitleTargetFromLocale,
      itemId: (liveItemId || selectedItemId || undefined) ?? undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    subtitleAgent.enabled,
    subtitleAgent.targetLang,
    subtitleTargetFromLocale,
    canMutate,
  ]);

  const canGoLive = Boolean(
    selectedItem &&
      (selectedItem.type === "text" ||
        selectedItem.type === "image" ||
        selectedItem.type === "video" ||
        selectedItem.type === "audio" ||
        selectedItem.type === "bible" ||
        selectedItem.type === "presentation") &&
      canMutate,
  );

  const persistSession = (code: string, accessToken?: string) => {
    savePersistedControlSession({ code, accessToken });
  };

  const createRef = useRef(session.create);
  const joinRef = useRef(session.join);
  createRef.current = session.create;
  joinRef.current = session.join;

  // After hub is healthy: create or resume session so Control WS is ready.
  // Opening Output still needs a click ("Iniciar proyección") — browsers block popups.
  // Phone/LAN without token must NOT auto-create — that orphaned a 2nd session
  // and En vivo never reached the projector Output.
  useEffect(() => {
    if (autoSessionStarted.current) {
      return;
    }
    if (session.hubChecking || session.hubUnreachable) {
      return;
    }
    if (session.hasSession) {
      autoSessionStarted.current = true;
      setNeedsRemotePair(false);
      if (session.code) {
        persistSession(session.code, session.accessToken || undefined);
      }
      return;
    }
    autoSessionStarted.current = true;
    void (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const urlToken = (
          params.get("token") ??
          params.get("accessToken") ??
          ""
        ).trim();
        const urlCode = (params.get("code") ?? "").trim().toUpperCase();
        const saved = loadPersistedControlSession();
        const token = urlToken || saved?.accessToken?.trim() || "";
        if (token) {
          try {
            const res = await joinRef.current({ accessToken: token });
            persistSession(res.code, token);
            setNeedsRemotePair(false);
            return;
          } catch {
            // Stale token after hub restart.
          }
        }
        if (urlCode) {
          try {
            const res = await joinRef.current({ code: urlCode });
            persistSession(res.code, saved?.accessToken);
            setNeedsRemotePair(false);
            return;
          } catch {
            // invalid code
          }
        }
        // Resume last session by code on phone (same Wi‑Fi as projector).
        if (onPhoneLan && saved?.code) {
          try {
            const res = await joinRef.current({ code: saved.code });
            persistSession(res.code, saved.accessToken);
            setNeedsRemotePair(false);
            return;
          } catch {
            // stale
          }
        }
        if (onPhoneLan) {
          // Wait for operator to enter the projector session code.
          setNeedsRemotePair(true);
          return;
        }
        const res = await createRef.current();
        persistSession(res.code, res.accessToken);
        setNeedsRemotePair(false);
      } catch {
        // Allow manual CTA / retry after failure (hub flap).
        autoSessionStarted.current = false;
      }
    })();
  }, [
    session.hubChecking,
    session.hubUnreachable,
    session.hasSession,
    session.code,
    session.accessToken,
    onPhoneLan,
  ]);

  const pairWithProjector = () => {
    const code = pairCode.trim().toUpperCase();
    if (!code || pairBusy) {
      return;
    }
    setPairBusy(true);
    setPairError(null);
    void (async () => {
      try {
        const res = await session.join({ code });
        persistSession(res.code);
        setNeedsRemotePair(false);
        setPairCode("");
        // Keep ?code= in URL so refresh re-joins the same projector session.
        try {
          const u = new URL(window.location.href);
          u.searchParams.set("code", res.code);
          u.searchParams.delete("token");
          u.searchParams.delete("accessToken");
          window.history.replaceState({}, "", u.toString());
        } catch {
          // ignore
        }
      } catch {
        setPairError(t("control.pairFailed"));
      } finally {
        setPairBusy(false);
      }
    })();
  };

  /** Existing "Abrir salida" — open/focus Output for current session (no create). */
  const openOutput = () => {
    if (!session.code) {
      return;
    }
    void (async () => {
      const result = await openOutputWindow(session.code, {
        autofullscreen: false,
        preferSecondary: true,
      });
      if (result.popupBlocked) {
        setPopupBlockedUrl(result.url);
        return;
      }
      setPopupBlockedUrl(null);
    })();
  };

  /**
   * PC only: open Output on the projector screen.
   * Phone never opens Output — it joins this session and En vivo drives the PC.
   */
  const onStartProjection = () => {
    if (session.hubUnreachable) {
      void session.checkHubHealth();
      return;
    }
    if (onPhoneLan) {
      // Phone is remote Control only — projection lives on the PC Output.
      setUploadHint(t("control.phoneControlsPcHint"));
      return;
    }
    setProjectionBusy(true);
    void (async () => {
      try {
        const result = await startProjection({
          existingCode: session.code || null,
          ensureSession: async () => {
            if (session.code) {
              return session.code;
            }
            const saved = loadPersistedControlSession();
            if (saved?.accessToken) {
              try {
                const joined = await session.join({
                  accessToken: saved.accessToken,
                });
                persistSession(joined.code, saved.accessToken);
                return joined.code;
              } catch {
                // stale — create fresh
              }
            }
            const created = await session.create();
            persistSession(created.code, created.accessToken);
            return created.code;
          },
        });
        if (result.popupBlocked) {
          setPopupBlockedUrl(result.url);
          return;
        }
        setPopupBlockedUrl(null);
      } catch {
        // Footer / banner cover hub errors; no message panel.
      } finally {
        setProjectionBusy(false);
      }
    })();
  };

  const karaokeManualReady = Boolean(
    subtitleAgent.enabled &&
      subtitleAgent.status === "ready" &&
      subtitleAgent.cues.length > 0 &&
      selectedItem &&
      (selectedItem.type === "video" || selectedItem.type === "audio") &&
      (!subtitleAgent.itemId || subtitleAgent.itemId === selectedItem.id),
  );

  const karaokePositionMs = (): number => {
    if (
      selectedItem &&
      selectedItem.id === liveItemId &&
      mediaClock &&
      mediaClock.itemId === selectedItem.id
    ) {
      return effectiveMediaClockPositionMs(mediaClock);
    }
    return Math.max(0, previewLocalPositionMs);
  };

  const nudgeKaraoke = (delta: -1 | 1) => {
    if (!karaokeManualReady || !selectedItem) {
      return false;
    }
    return session.nudgeSubtitleCancionero({
      delta,
      positionMs: karaokePositionMs(),
      itemId: selectedItem.id,
    });
  };

  // ── Cover image over the live video/audio (under the subtitle) ───────
  const videoCover = session.snapshot?.live.videoCover ?? null;
  const liveIsAv = Boolean(
    liveItem && (liveItem.type === "video" || liveItem.type === "audio"),
  );
  const [coverDialogOpen, setCoverDialogOpen] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);

  /** Tap: toggle the current image, or open the picker when none is set. */
  const toggleVideoCover = () => {
    if (!liveIsAv || !ensureWsOrHint()) {
      return;
    }
    if (!videoCover) {
      setCoverError(null);
      setCoverDialogOpen(true);
      return;
    }
    session.setVideoCover({ active: !videoCover.active });
  };

  const applyCoverAsset = (assetId: string) => {
    if (session.setVideoCover({ assetId, active: true })) {
      setCoverDialogOpen(false);
    } else {
      setCoverError(t("control.videoCoverFailed"));
    }
  };

  const pickCoverFromLibrary = async (libraryItemId: string) => {
    if (!session.sessionId || !session.wsTicket) {
      return;
    }
    setCoverBusy(true);
    setCoverError(null);
    try {
      const { assetId } = await copyLibraryImageToSession({
        sessionId: session.sessionId,
        credential: session.wsTicket,
        libraryItemId,
      });
      applyCoverAsset(assetId);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : t("control.videoCoverFailed"));
    } finally {
      setCoverBusy(false);
    }
  };

  const pickCoverFromFile = async (file: File) => {
    if (!session.sessionId || !session.wsTicket) {
      return;
    }
    setCoverBusy(true);
    setCoverError(null);
    try {
      const asset = await uploadSessionAsset(session.sessionId, session.wsTicket, file);
      applyCoverAsset(asset.id);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : t("control.videoCoverFailed"));
    } finally {
      setCoverBusy(false);
    }
  };

  /**
   * Scene buttons / shortcuts are toggles: pressing the active overlay again
   * (Logo, Vacío, Clear) returns to the live content ("normal").
   */
  const toggleSceneMode = (mode: SceneMode) => {
    session.setSceneMode(mode !== "normal" && mode === sceneMode ? "normal" : mode);
  };

  useControlShortcuts({
    enabled: canMutate,
    goLive: () => {
      if (liveItemId) {
        session.clearLive();
        session.setSceneMode("black");
        return;
      }
      if (selectedItemId && canGoLive) {
        session.goLive(selectedItemId);
        postOutputUnmute();
      }
    },
    openOutput,
    setSceneMode: toggleSceneMode,
    toggleVideoCover,
    setTheme: (id) => session.setTheme({ themeId: id }),
    prevSlide: () => {
      if (nudgeKaraoke(-1)) {
        return;
      }
      if (liveItem && itemHasSlides(liveItem)) {
        const next = Math.max(0, liveSlideIndex - 1);
        session.setSlide(next);
        if (selectedItemId === liveItem.id) {
          setPreviewSlideIndex(next);
        }
      }
    },
    nextSlide: () => {
      if (nudgeKaraoke(1)) {
        return;
      }
      if (liveItem && itemHasSlides(liveItem)) {
        const max = Math.max(itemProjectionSlideCount(liveItem) - 1, 0);
        const next = Math.min(max, liveSlideIndex + 1);
        session.setSlide(next);
        if (selectedItemId === liveItem.id) {
          setPreviewSlideIndex(next);
        }
      }
    },
  });

  const selectItem = (id: string) => {
    setSelectedItemId(id);
    setPreviewSlideIndex(
      id === liveItemId ? liveSlideIndex : 0,
    );
    setPreviewLocalPositionMs(0);
    setCreating(false);
    setEditingId(null);
    setEditingBibleId(null);
    setLinkDialogOpen(false);
    setBibleDialogOpen(false);
  };

  const toggleChecked = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const clearChecked = () => setCheckedIds(new Set());

  const startCreateTextBlank = () => {
    setCreating(true);
    setEditingId(null);
    setLinkDialogOpen(false);
    setBibleDialogOpen(false);
  };

  const ensureWsOrHint = (): boolean => {
    if (session.wsStatus === "open" && session.isWsOpen()) {
      return true;
    }
    if (session.hubUnreachable) {
      setUploadHint(t("control.hubUnreachable"));
      void session.checkHubHealth();
      return false;
    }
    session.reconnect();
    setUploadHint(t("control.wsDisconnectedHint"));
    return false;
  };

  const saveNewText = (payload: TextPayload) => {
    if (!ensureWsOrHint()) {
      return;
    }
    const item: PlaylistItem = {
      id: cryptoRandomId(),
      type: "text",
      order: items.length,
      payload,
    };
    if (!session.addItem(item)) {
      setUploadHint(t("control.wsDisconnectedHint"));
      session.reconnect();
      return;
    }
    setCreating(false);
    setSelectedItemId(item.id);
    setPreviewSlideIndex(0);
  };

  const saveEditText = (payload: TextPayload) => {
    if (!editingId) {
      return;
    }
    if (!ensureWsOrHint()) {
      return;
    }
    session.updateItem(editingId, { payload });
    setEditingId(null);
  };

  const openLinkDialog = () => {
    setUploadHint(null);
    setCreating(false);
    setEditingId(null);
    setBibleDialogOpen(false);
    setLinkDialogOpen(true);
  };

  const closeLinkDialog = () => setLinkDialogOpen(false);

  const openBibleDialog = () => {
    setUploadHint(null);
    setCreating(false);
    setEditingId(null);
    setEditingBibleId(null);
    setLinkDialogOpen(false);
    setBibleDialogOpen(true);
  };

  const openEditBible = (id: string) => {
    setUploadHint(null);
    setCreating(false);
    setEditingId(null);
    setEditingBibleId(id);
    setSelectedItemId(id);
    setLinkDialogOpen(false);
    setBibleDialogOpen(true);
  };

  const closeBibleDialog = () => {
    setBibleDialogOpen(false);
    setEditingBibleId(null);
  };

  const openLibrary = () => {
    setUploadHint(null);
    setCreating(false);
    setEditingId(null);
    setLinkDialogOpen(false);
    setBibleDialogOpen(false);
    setSongEditorOpen(false);
    setLibraryOpen(true);
  };

  const openCreateSong = () => {
    setUploadHint(null);
    setCreating(false);
    setEditingId(null);
    setLinkDialogOpen(false);
    setBibleDialogOpen(false);
    setLibraryOpen(false);
    setSongError(null);
    setSongEditorOpen(true);
  };

  const saveSongFromGuion = async (song: LibrarySongPayload) => {
    if (!ensureWsOrHint()) {
      return;
    }
    setSongBusy(true);
    setSongError(null);
    try {
      await createLibrarySong(song);
      const payload = songToTextPayload(song);
      const item: PlaylistItem = {
        id: cryptoRandomId(),
        type: "text",
        order: itemsLenRef.current,
        payload,
      };
      if (!session.addItem(item)) {
        setUploadHint(t("control.wsDisconnectedHint"));
        session.reconnect();
        return;
      }
      setSelectedItemId(item.id);
      setPreviewSlideIndex(0);
      setSongEditorOpen(false);
    } catch (err) {
      setSongError(String(err));
    } finally {
      setSongBusy(false);
    }
  };

  const addBiblePassage = (payload: BiblePayload) => {
    if (!ensureWsOrHint()) {
      return;
    }
    const item: PlaylistItem = {
      id: cryptoRandomId(),
      type: "bible",
      order: itemsLenRef.current,
      payload,
    };
    if (!session.addItem(item)) {
      setUploadHint(t("control.wsDisconnectedHint"));
      session.reconnect();
      return;
    }
    setSelectedItemId(item.id);
    setPreviewSlideIndex(0);
    closeBibleDialog();
    if (payload.fromCache) {
      setUploadHint(t("bible.addedFromCache"));
    } else {
      setUploadHint(null);
    }
  };

  const saveBiblePassage = (payload: BiblePayload) => {
    if (!editingBibleId || !ensureWsOrHint()) {
      return;
    }
    if (!session.updateItem(editingBibleId, { payload })) {
      setUploadHint(t("control.wsDisconnectedHint"));
      session.reconnect();
      return;
    }
    setSelectedItemId(editingBibleId);
    setPreviewSlideIndex(0);
    if (editingBibleId === liveItemId) {
      session.setSlide(0);
    }
    closeBibleDialog();
    if (payload.fromCache) {
      setUploadHint(t("bible.addedFromCache"));
    } else {
      setUploadHint(null);
    }
  };

  /**
   * YouTube blocked embed (101/150): download the video through the hub and
   * swap the Guion item for a local file (same id/position/title) so Preview,
   * Output and the karaoke agent use the file path.
   */
  const youtubeToLocal = async (item: PlaylistItem): Promise<void> => {
    if (
      item.type !== "video" ||
      item.payload.sourceKind !== "youtube" ||
      !session.sessionId ||
      !session.wsTicket
    ) {
      throw new Error("not_ready");
    }
    const asset = await downloadYoutubeAsAsset(
      session.sessionId,
      session.wsTicket,
      item.payload.videoId,
    );
    const payload: VideoPayload = {
      sourceKind: "file",
      assetId: asset.id,
      title: item.payload.title,
      autoplay: item.payload.autoplay,
      loop: item.payload.loop,
      muted: item.payload.muted,
      fit: item.payload.fit,
    };
    if (!session.updateItem(item.id, { payload })) {
      throw new Error("ws_disconnected");
    }
  };

  const addYoutubeFromUrl = (url: string) => {
    if (!ensureWsOrHint()) {
      return;
    }
    const parsed = parseYouTubeUrl(url);
    if (!parsed) {
      setUploadHint(t("video.youtubeInvalid"));
      return;
    }
    const payload: VideoPayload = {
      sourceKind: "youtube",
      videoId: parsed.videoId,
      sourceUrl: parsed.sourceUrl,
      autoplay: true,
      muted: false,
      fit: "contain",
    };
    const item: PlaylistItem = {
      id: cryptoRandomId(),
      type: "video",
      order: itemsLenRef.current,
      payload,
    };
    if (!session.addItem(item)) {
      setUploadHint(t("control.wsDisconnectedHint"));
      session.reconnect();
      return;
    }
    setSelectedItemId(item.id);
    closeLinkDialog();
    setUploadHint(t("video.youtubeCaveat"));
    // Resolve real title for Guion label (async; list updates when ready).
    void fetchYouTubeDisplayTitle(parsed.sourceUrl).then((title) => {
      if (!title) return;
      session.updateItem(item.id, {
        payload: { ...payload, title },
      });
    });
  };

  const addGenericLink = (url: string) => {
    if (!ensureWsOrHint()) {
      return;
    }
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      // keep raw
    }
    const payload: TextPayload = {
      title: host || t("link.itemTitle"),
      align: "center",
      slides: [
        {
          id: cryptoRandomId(),
          lines: [url],
        },
      ],
    };
    const item: PlaylistItem = {
      id: cryptoRandomId(),
      type: "text",
      order: itemsLenRef.current,
      payload,
    };
    if (!session.addItem(item)) {
      setUploadHint(t("control.wsDisconnectedHint"));
      session.reconnect();
      return;
    }
    setSelectedItemId(item.id);
    setPreviewSlideIndex(0);
    closeLinkDialog();
    setUploadHint(t("link.added"));
  };

  const ingestOneFile = async (
    file: File,
    order: number,
  ): Promise<{ ok: boolean; itemId?: string; hint?: string }> => {
    const kind = classifyMediaFile(file);

    // Presentations (PPTX/PDF/…) → Biblioteca import → Guion slides.
    if (kind === "presentation") {
      if (!session.sessionId || !session.wsTicket) {
        return { ok: false, hint: t("control.wsDisconnectedHint") };
      }
      try {
        const libItem = await uploadLibraryFile(file);
        const playlistItem = await addLibraryItemToSession({
          sessionId: session.sessionId,
          credential: session.wsTicket,
          libraryItemId: libItem.id,
        });
        return {
          ok: true,
          itemId: playlistItem.id,
          hint: t("playlist.presentationAdded"),
        };
      } catch (err) {
        return {
          ok: false,
          hint: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Unknown / other types: still add to Guion (text if readable, else stub).
    if (kind === "unsupported") {
      try {
        const payload = await fileToGuionTextPayload(file);
        const item: PlaylistItem = {
          id: cryptoRandomId(),
          type: "text",
          order,
          payload: {
            title: payload.title,
            align: payload.align,
            slides: payload.slides,
          },
        };
        if (!session.addItem(item)) {
          return { ok: false, hint: t("control.wsDisconnectedHint") };
        }
        return {
          ok: true,
          itemId: item.id,
          hint: payload.usedBinaryStub
            ? t("playlist.genericFileAdded")
            : t("text.importAdded").replace(
                "{n}",
                String(payload.slides.length),
              ),
        };
      } catch (err) {
        return {
          ok: false,
          hint: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (kind === "text") {
      if (file.size > TEXT_IMPORT_MAX_BYTES) {
        return { ok: false, hint: t("text.importTooLarge") };
      }
      try {
        const result = await importFileToTextSlides(file);
        const payload: TextPayload = {
          title: result.title || file.name.replace(/\.[^.]+$/, ""),
          align: "center",
          slides: result.slides,
        };
        const item: PlaylistItem = {
          id: cryptoRandomId(),
          type: "text",
          order,
          payload,
        };
        if (!session.addItem(item)) {
          return { ok: false, hint: t("control.wsDisconnectedHint") };
        }
        return {
          ok: true,
          itemId: item.id,
          hint: result.truncated
            ? t("text.importTruncated").replace(
                "{n}",
                String(TEXT_IMPORT_MAX_SLIDES),
              )
            : t("text.importAdded").replace(
                "{n}",
                String(result.slides.length),
              ),
        };
      } catch (err) {
        const msg = String(err);
        if (msg.includes("file_too_large")) {
          return { ok: false, hint: t("text.importTooLarge") };
        }
        if (msg.includes("unsupported_type")) {
          return { ok: false, hint: t("text.importUnsupported") };
        }
        return { ok: false, hint: t("text.importFailed") };
      }
    }

    if (!session.sessionId || !session.wsTicket) {
      return { ok: false, hint: t("control.wsDisconnectedHint") };
    }

    const hints: string[] = [];
    if (kind === "image" && file.size > LARGE_IMAGE_WARN_BYTES) {
      hints.push(t("image.largeWarning"));
    }
    if (kind === "video") {
      if (file.type === "video/quicktime") {
        hints.push(t("video.quicktimeWarning"));
      }
      if (file.size > LARGE_VIDEO_WARN_BYTES) {
        hints.push(t("video.largeWarning"));
      }
    }

    try {
      const asset = await uploadSessionAsset(
        session.sessionId,
        session.wsTicket,
        file,
      );
      if (kind === "image") {
        const payload: ImagePayload = {
          assetId: asset.id,
          fit: "contain",
          title: asset.originalName || file.name,
        };
        const item: PlaylistItem = {
          id: cryptoRandomId(),
          type: "image",
          order,
          payload,
        };
        session.addItem(item);
        return {
          ok: true,
          itemId: item.id,
          hint: hints.length ? hints.join(" ") : undefined,
        };
      }
      if (kind === "audio") {
        const payload: AudioPayload = {
          assetId: asset.id,
          title: asset.originalName || file.name,
          autoplay: true,
          loop: false,
        };
        const item: PlaylistItem = {
          id: cryptoRandomId(),
          type: "audio",
          order,
          payload,
        };
        session.addItem(item);
        return {
          ok: true,
          itemId: item.id,
          hint: hints.length ? hints.join(" ") : undefined,
        };
      }
      const payload: VideoPayload = {
        sourceKind: "file",
        assetId: asset.id,
        title: asset.originalName || file.name,
        autoplay: true,
        muted: false,
        fit: "contain",
      };
      const item: PlaylistItem = {
        id: cryptoRandomId(),
        type: "video",
        order,
        payload,
      };
      session.addItem(item);
      return {
        ok: true,
        itemId: item.id,
        hint: hints.length ? hints.join(" ") : undefined,
      };
    } catch (err) {
      return { ok: false, hint: String(err) };
    }
  };

  const ingestFiles = async (fileList: File[]) => {
    if (!fileList.length) {
      return;
    }
    if (!ensureWsOrHint()) {
      return;
    }
    setCreating(false);
    setEditingId(null);
    setLinkDialogOpen(false);
    setBibleDialogOpen(false);
    setUploading(true);
    setUploadHint(null);
    let order = itemsLenRef.current;
    let lastId: string | null = null;
    const hints: string[] = [];
    let added = 0;
    try {
      for (const file of fileList) {
        const result = await ingestOneFile(file, order);
        if (result.ok) {
          added += 1;
          order += 1;
          itemsLenRef.current = order;
          if (result.itemId) {
            lastId = result.itemId;
          }
        }
        if (result.hint) {
          hints.push(result.hint);
        }
      }
      if (lastId) {
        setSelectedItemId(lastId);
        setPreviewSlideIndex(0);
      }
      if (hints.length) {
        setUploadHint(hints.slice(-3).join(" · "));
      } else if (added > 1) {
        setUploadHint(
          t("playlist.filesAdded").replace("{n}", String(added)),
        );
      }
    } finally {
      setUploading(false);
      if (unifiedInputRef.current) {
        unifiedInputRef.current.value = "";
      }
      if (audioInputRef.current) {
        audioInputRef.current.value = "";
      }
    }
  };

  const onPickUnifiedFiles = () => {
    setUploadHint(null);
    setCreating(false);
    setEditingId(null);
    setLinkDialogOpen(false);
    setBibleDialogOpen(false);
    unifiedInputRef.current?.click();
  };

  const onPickAudioFiles = () => {
    setUploadHint(null);
    setCreating(false);
    setEditingId(null);
    setLinkDialogOpen(false);
    setBibleDialogOpen(false);
    audioInputRef.current?.click();
  };

  const onFitChange = (fit: ImageFit) => {
    if (
      !selectedItem ||
      (selectedItem.type !== "image" && selectedItem.type !== "presentation")
    ) {
      return;
    }
    session.updateItem(selectedItem.id, {
      payload: { ...selectedItem.payload, fit },
    });
  };

  const reorderItems = (orderedIds: string[]) => {
    if (!ensureWsOrHint()) {
      return;
    }
    session.reorder(orderedIds);
  };

  const goLiveItem = (id: string) => {
    if (!ensureWsOrHint()) {
      return;
    }
    const keepSlide =
      id === selectedItemId &&
      selectedItem &&
      itemHasSlides(selectedItem)
        ? previewSlideIndex
        : 0;
    setSelectedItemId(id);
    setPreviewSlideIndex(keepSlide);
    setCreating(false);
    setEditingId(null);
    setEditingBibleId(null);
    setLinkDialogOpen(false);
    setBibleDialogOpen(false);
    session.goLive(id);
    if (keepSlide > 0) {
      session.setSlide(keepSlide);
    }
    // En vivo from Control gesture → ask Output to play with audio.
    postOutputUnmute();
  };

  /** Stop projecting → full black Output. */
  const stopLiveToBlack = () => {
    if (!ensureWsOrHint()) {
      return;
    }
    session.clearLive();
    session.setSceneMode("black");
  };

  const hasCustomLogo = Boolean(session.snapshot?.live.logoUpdatedAt);

  const showLogoScene = () => {
    if (!ensureWsOrHint()) {
      return;
    }
    // No saved image yet → ask for one instead of projecting the default mark.
    if (!hasCustomLogo) {
      openLogoFilePicker();
      return;
    }
    toggleSceneMode("logo");
  };

  const watermarkEnabled =
    session.snapshot?.live.watermarkEnabled === true;

  const toggleWatermark = () => {
    if (!ensureWsOrHint()) {
      return;
    }
    session.setWatermark(!watermarkEnabled);
  };

  const toggleDotsOverlay = () => {
    if (!ensureWsOrHint()) {
      return;
    }
    session.setTheme({
      themeBackground: normalizeThemeBackground({
        ...themeBackground,
        dotsOverlay: !dotsOverlay,
      }),
    });
  };

  const openLogoFilePicker = () => {
    if (!canMutate || uploadingLogo) {
      return;
    }
    logoFileInputRef.current?.click();
  };

  const onLogoFileChosen = async (file: File | null) => {
    if (!file || !session.sessionId || !session.wsTicket) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      setUploadHint(t("control.sceneLogoBadType"));
      return;
    }
    if (file.size > LARGE_IMAGE_WARN_BYTES) {
      setUploadHint(t("control.sceneLogoLarge"));
    }
    setUploadingLogo(true);
    try {
      await uploadBrandingLogo(session.sessionId, session.wsTicket, file);
      // Hub broadcasts logoUpdatedAt + sceneMode logo — Output refreshes.
      session.setSceneMode("logo");
      setUploadHint(t("control.sceneLogoSaved"));
    } catch (err) {
      setUploadHint(
        err instanceof Error
          ? `${t("control.sceneLogoUploadFailed")}: ${err.message}`
          : t("control.sceneLogoUploadFailed"),
      );
    } finally {
      setUploadingLogo(false);
      if (logoFileInputRef.current) {
        logoFileInputRef.current.value = "";
      }
    }
  };

  const showEmptyScene = () => {
    if (!ensureWsOrHint()) {
      return;
    }
    toggleSceneMode("black");
  };

  const slideCount =
    selectedItem && itemHasSlides(selectedItem)
      ? itemProjectionSlideCount(selectedItem)
      : 0;

  /** Preview ←/→ also drives Output when this item is live. */
  const setPreviewSlideSynced = (index: number) => {
    const max = Math.max(slideCount - 1, 0);
    const next = Math.min(Math.max(index, 0), max);
    setPreviewSlideIndex(next);
    if (
      selectedItem &&
      selectedItem.id === liveItemId &&
      itemHasSlides(selectedItem)
    ) {
      session.setSlide(next);
    }
  };

  const previewGoPrev = () => {
    if (nudgeKaraoke(-1)) {
      return;
    }
    if (
      selectedItem &&
      itemHasSlides(selectedItem) &&
      previewSlideIndex > 0
    ) {
      setPreviewSlideSynced(previewSlideIndex - 1);
      return;
    }
    if (selectedIndex > 0) {
      const prev = items[selectedIndex - 1];
      if (prev) {
        selectItem(prev.id);
      }
    }
  };

  const previewGoNext = () => {
    if (nudgeKaraoke(1)) {
      return;
    }
    if (
      selectedItem &&
      itemHasSlides(selectedItem) &&
      previewSlideIndex < slideCount - 1
    ) {
      setPreviewSlideSynced(previewSlideIndex + 1);
      return;
    }
    if (selectedIndex >= 0 && selectedIndex < items.length - 1) {
      const next = items[selectedIndex + 1];
      if (next) {
        selectItem(next.id);
      }
    }
  };

  const canPreviewPrev =
    Boolean(selectedItem) &&
    (karaokeManualReady ||
      previewSlideIndex > 0 ||
      selectedIndex > 0);
  const canPreviewNext =
    Boolean(selectedItem) &&
    (karaokeManualReady ||
      (itemHasSlides(selectedItem!) &&
        previewSlideIndex < slideCount - 1) ||
      (selectedIndex >= 0 && selectedIndex < items.length - 1));

  const removeOne = (id: string) => {
    if (!ensureWsOrHint()) {
      return;
    }
    session.removeItem(id);
    if (selectedItemId === id) {
      setSelectedItemId(null);
    }
    if (editingId === id) {
      setEditingId(null);
    }
    setCheckedIds((prev) => {
      if (!prev.has(id)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const removeChecked = () => {
    if (checkedIds.size === 0) {
      return;
    }
    if (!ensureWsOrHint()) {
      return;
    }
    const ids = [...checkedIds];
    for (const id of ids) {
      session.removeItem(id);
    }
    if (selectedItemId && checkedIds.has(selectedItemId)) {
      setSelectedItemId(null);
    }
    if (editingId && checkedIds.has(editingId)) {
      setEditingId(null);
    }
    clearChecked();
  };

  const previewModule = selectedItem
    ? getItemType(selectedItem.type)
    : undefined;
  const Preview = previewModule?.Preview;
  const previewSrc = assetSrcFor(
    session.sessionId,
    session.wsTicket,
    selectedItem,
    previewSlideIndex,
  );

  return (
    <div className="control-shell">
      <div className="control-chrome">
        {/* Row 1: brand + title only — tools never share this bar. */}
        <header className="control-header">
          <div className="control-brand">
            <img
              className="control-brand-logo"
              src="/logo-mark.svg"
              alt=""
              width={40}
              height={40}
              decoding="async"
            />
            <h1 className="control-brand-title">
              {t("control.headerTitle")}
            </h1>
          </div>
        </header>

        {/* Row 2: flat tools (peers + flex-wrap) / GAM */}
        <div className="control-toolbar-strip">
          <div className="control-header-cluster">
            <ControlHeaderToolbar
              projectionBusy={projectionBusy}
              hubUnreachable={session.hubUnreachable}
              canMutate={canMutate}
              hasSession={session.hasSession}
              themeId={themeId}
              themeOverrides={themeOverrides}
              themeBackground={themeBackground}
              transitionEffect={transitionEffect}
              uploadingBackground={uploadingBackground}
              backgroundAssets={themeBackgroundAssets}
              onProject={onStartProjection}
              onOpenLibrary={openLibrary}
              onThemeChange={(patch) => session.setTheme(patch)}
              onUploadBackground={onUploadThemeBackground}
              onAbout={() => setAboutOpen(true)}
              subtitleAgentEnabled={subtitleAgent.enabled}
              subtitleAgentTitle={subtitleAgentTitle}
              subtitleAgentErrorMessage={
                subtitleAgent.enabled &&
                subtitleAgent.status === "error" &&
                (subtitleAgent.hint === "yt_dlp_missing" ||
                  subtitleAgent.hint === "ffmpeg_missing" ||
                  subtitleAgent.hint === "ffmpeg_extract_failed")
                  ? subtitleAgent.hint === "ffmpeg_missing"
                    ? t("control.subtitleAgentFfmpegMissing")
                    : subtitleAgent.hint === "ffmpeg_extract_failed"
                      ? t("control.subtitleAgentExtractFailed")
                      : t("control.subtitleAgentYtDlpMissing")
                  : null
              }
              onToggleSubtitleAgent={() => {
                const next = !subtitleAgent.enabled;
                session.setSubtitleAgent({
                  enabled: next,
                  targetLang: subtitleTargetFromLocale,
                  itemId:
                    (liveItemId || selectedItemId || undefined) ?? undefined,
                });
                if (next) {
                  session.setTheme({
                    themeBackground: normalizeThemeBackground({
                      ...themeBackground,
                      dotsOverlay: true,
                    }),
                  });
                }
              }}
              subtitlePrepare={subtitleAgent.prepare ?? null}
              canPrepareGuion={canPrepareGuion}
              onPrepareGuion={() =>
                session.prepareSubtitleAgent(
                  Boolean(subtitleAgent.prepare?.running),
                )
              }
              showSaveLyrics={subtitleAgent.lyricsSource === "lrclib"}
              onSaveLyrics={() => session.saveSubtitleLyrics()}
              sessionFallback={
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      void session
                        .create()
                        .then((res) => {
                          persistSession(res.code, res.accessToken);
                        })
                        .catch(() => undefined);
                    }}
                  >
                    {t("control.createSession")}
                  </button>
                  <label className="field-inline">
                    <span className="sr-only">{t("control.code")}</span>
                    <input
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value.trim())}
                      placeholder={t("control.joinPlaceholder")}
                      maxLength={64}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn"
                    disabled={!joinCode.trim()}
                    onClick={() => {
                      const token = joinCode.trim();
                      // Control join requires accessToken (short codes = Output only).
                      void session
                        .join({ accessToken: token })
                        .then((res) => {
                          persistSession(res.code, token);
                        })
                        .catch(() => undefined);
                    }}
                  >
                    {t("control.joinSession")}
                  </button>
                </>
              }
            />
          </div>

          <div className="control-header-end">
            <div
              className="control-header-sep"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("control.headerSeparator")}
            />
            <ControlAdBanner />
          </div>
        </div>
      </div>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {popupBlockedUrl ? (
        <div className="control-banner control-banner-compact" role="status">
          <StatusTip
            tone="warn"
            label={t("control.statusTipWarn")}
            message={t("control.popupBlocked")}
          />
          <a
            className="control-banner-link"
            href={popupBlockedUrl}
            target="_blank"
            rel="noopener"
          >
            {t("control.openOutput")}
          </a>
        </div>
      ) : null}

      {uploadHint ? (
        <div className="control-banner control-banner-compact" role="status">
          <StatusTip
            tone="info"
            label={t("control.statusTipInfo")}
            message={uploadHint}
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setUploadHint(null)}
          >
            {t("control.dismissHint")}
          </button>
        </div>
      ) : null}

      {needsRemotePair && !session.hasSession && !session.hubUnreachable ? (
        <div
          className="control-banner control-banner-pair"
          role="dialog"
          aria-label={t("control.pairTitle")}
        >
          <StatusTip
            tone="info"
            label={t("control.statusTipInfo")}
            message={t("control.pairBody")}
          />
          <form
            className="control-pair-form"
            onSubmit={(e) => {
              e.preventDefault();
              pairWithProjector();
            }}
          >
            <label className="control-pair-label">
              {t("control.pairCodeLabel")}
              <input
                value={pairCode}
                onChange={(e) =>
                  setPairCode(e.target.value.toUpperCase().slice(0, 8))
                }
                placeholder="AB12"
                maxLength={8}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pairBusy || pairCode.trim().length < 3}
            >
              {pairBusy ? t("control.pairBusy") : t("control.pairSubmit")}
            </button>
          </form>
          {pairError ? (
            <p className="control-banner-error-text">{pairError}</p>
          ) : null}
        </div>
      ) : null}

      <VideoCoverDialog
        open={coverDialogOpen}
        onClose={() => setCoverDialogOpen(false)}
        busy={coverBusy}
        error={coverError}
        hasCover={Boolean(videoCover)}
        onPickLibrary={(id) => void pickCoverFromLibrary(id)}
        onPickFile={(file) => void pickCoverFromFile(file)}
        onRemove={() => {
          session.setVideoCover({ assetId: null });
          setCoverDialogOpen(false);
        }}
      />

      {!session.hubUnreachable && !envIssuesDismissed && envIssues.length > 0 ? (
        <div
          className="control-banner control-banner-env control-banner-compact"
          role={envIssues.some((c) => c.status === "fail") ? "alert" : "status"}
        >
          <strong>{t("control.envIssuesTitle")}</strong>
          <ul className="control-banner-env-list">
            {envIssues.map((c) => (
              <li key={c.id}>
                <b>{c.status === "fail" ? "✗" : "⚠"} {c.label}:</b> {c.detail}
                <br />
                <small>{c.fix}</small>
              </li>
            ))}
          </ul>
          <p>
            <small>{t("control.envIssuesHint")}</small>
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setEnvIssuesDismissed(true)}
          >
            {t("control.close")}
          </button>
        </div>
      ) : null}

      {session.hubUnreachable ? (
        <div
          className="control-banner control-banner-hub-down control-banner-compact"
          role="alert"
        >
          <StatusTip
            tone="error"
            label={t("control.statusTipWarn")}
            message={t("control.hubUnreachable")}
          />
          <p className="control-banner-hub-cmd">
            <code>pnpm dev</code>
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={session.hubChecking}
            onClick={() => {
              void session.checkHubHealth().then((ok) => {
                if (ok && session.hasSession) {
                  session.reconnect();
                }
              });
            }}
          >
            {session.hubChecking
              ? t("control.hubChecking")
              : t("control.retryHealth")}
          </button>
        </div>
      ) : null}

      {session.error &&
      !session.hubUnreachable &&
      !session.error.startsWith("HUB_UNREACHABLE") ? (
        <div
          className="control-banner control-banner-error control-banner-compact"
          role="alert"
        >
          <StatusTip
            tone="error"
            label={t("control.statusTipWarn")}
            message={session.error}
          />
        </div>
      ) : null}

      {sessionReady && !wsReady && !session.hubUnreachable ? (
        <div
          className="control-banner control-banner-error control-banner-compact"
          role="status"
        >
          <StatusTip
            tone="error"
            label={t("control.statusTipWarn")}
            message={
              session.wsStatus === "connecting"
                ? t("control.wsConnectingHint")
                : t("control.wsDisconnectedHint")
            }
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => session.reconnect()}
          >
            {t("control.reconnect")}
          </button>
        </div>
      ) : null}

      <input
        ref={unifiedInputRef}
        type="file"
        multiple
        accept={UNIFIED_MEDIA_ACCEPT}
        className="sr-only"
        onChange={(e) => {
          const list = e.target.files ? Array.from(e.target.files) : [];
          void ingestFiles(list);
        }}
      />
      <input
        ref={audioInputRef}
        type="file"
        multiple
        accept={AUDIO_MEDIA_ACCEPT}
        className="sr-only"
        onChange={(e) => {
          const list = e.target.files ? Array.from(e.target.files) : [];
          void ingestFiles(list);
        }}
      />

      <LinkAddDialog
        open={linkDialogOpen}
        onClose={closeLinkDialog}
        onAddYoutube={addYoutubeFromUrl}
        onAddGenericLink={addGenericLink}
      />

      <BibleDialog
        key={editingBibleId ?? "bible-new"}
        open={bibleDialogOpen}
        onClose={closeBibleDialog}
        onAdd={addBiblePassage}
        initial={(() => {
          if (!editingBibleId) {
            return null;
          }
          const hit = items.find((i) => i.id === editingBibleId);
          return hit?.type === "bible" ? hit.payload : null;
        })()}
        onSave={editingBibleId ? saveBiblePassage : undefined}
      />

      <BibliotecaDialog
        open={libraryOpen}
        sessionId={session.sessionId}
        wsTicket={session.wsTicket}
        canMutate={canMutate}
        onClose={() => setLibraryOpen(false)}
        onAddedToGuion={(itemId) => {
          setSelectedItemId(itemId);
          setPreviewSlideIndex(0);
          setLibraryOpen(false);
        }}
        onOpenCreateSong={() => {
          /* Song editor opens inside BibliotecaDialog */
        }}
      />

      <SongEditor
        open={songEditorOpen}
        busy={songBusy}
        error={songError}
        onClose={() => setSongEditorOpen(false)}
        onSave={(song) => void saveSongFromGuion(song)}
      />

      <div className="control-zones control-zones-stacked">
        {/* Left column: Guion list (full height). Live goes via Output / En vivo. */}
        <div className="control-guion-column">
          <SchedulePanel
            karaokeProgress={
              subtitleAgent.enabled ? subtitleAgent.itemProgress : undefined
            }
            items={items}
            selectedItemId={selectedItemId}
            liveItemId={liveItemId}
            checkedIds={checkedIds}
            sessionReady={sessionReady}
            canMutate={canMutate}
            uploading={uploading}
            onSelect={selectItem}
            onToggleChecked={toggleChecked}
            onReorder={reorderItems}
            onRemove={removeOne}
            onRemoveChecked={removeChecked}
            onGoLive={goLiveItem}
            onEditText={(id) => {
              selectItem(id);
              setEditingId(id);
            }}
            onEditBible={(id) => {
              openEditBible(id);
            }}
            onAddFiles={() => {
              if (!sessionReady) {
                return;
              }
              if (!wsReady) {
                session.reconnect();
                setUploadHint(t("control.wsDisconnectedHint"));
              }
              onPickUnifiedFiles();
            }}
            onAddLink={() => {
              if (!sessionReady) {
                return;
              }
              if (!wsReady) {
                session.reconnect();
                setUploadHint(t("control.wsDisconnectedHint"));
              }
              openLinkDialog();
            }}
            onAddBible={() => {
              if (!sessionReady) {
                return;
              }
              if (!wsReady) {
                session.reconnect();
                setUploadHint(t("control.wsDisconnectedHint"));
              }
              openBibleDialog();
            }}
            onAddTextBlank={() => {
              if (!sessionReady) {
                return;
              }
              startCreateTextBlank();
            }}
            onCreateSong={() => {
              if (!sessionReady) {
                return;
              }
              openCreateSong();
            }}
            onAddAudio={() => {
              if (!sessionReady) {
                return;
              }
              if (!wsReady) {
                session.reconnect();
                setUploadHint(t("control.wsDisconnectedHint"));
              }
              onPickAudioFiles();
            }}
            onOpenLibrary={() => {
              if (!sessionReady) {
                return;
              }
              openLibrary();
            }}
            onOpenLoad={() => {
              if (!session.hasSession) {
                return;
              }
              setLoadDialogOpen(true);
            }}
            onOpenSave={() => {
              if (!canMutate) {
                return;
              }
              setSaveDialogOpen(true);
            }}
            onFilesDropped={(files) => {
              if (!sessionReady) {
                return;
              }
              if (!wsReady) {
                session.reconnect();
                setUploadHint(t("control.wsDisconnectedHint"));
                return;
              }
              void ingestFiles(files);
            }}
            saveLoadDialogs={
              session.hasSession && session.sessionId && session.wsTicket ? (
                <SavedPlaylistPanel
                  sessionId={session.sessionId}
                  wsTicket={session.wsTicket}
                  items={items}
                  disabled={!canMutate}
                  onHint={setUploadHint}
                  saveOpen={saveDialogOpen}
                  loadOpen={loadDialogOpen}
                  onSaveOpenChange={setSaveDialogOpen}
                  onLoadOpenChange={setLoadDialogOpen}
                />
              ) : null
            }
            editor={
              creating ? (
                <TextItemEditor
                  initial={createEmptyTextPayload()}
                  onSave={saveNewText}
                  onCancel={() => setCreating(false)}
                />
              ) : editingId && selectedItem?.type === "text" ? (
                <TextItemEditor
                  initial={selectedItem.payload}
                  onSave={saveEditText}
                  onCancel={() => setEditingId(null)}
                />
              ) : null
            }
          />
        </div>

        {/* Right column: maximized Vista previa. */}
        <div className="control-stages control-stages-preview-only">
          <section
            className="zone zone-preview"
            aria-label={t("control.preview")}
          >
            {/*
              Always-visible Preview toolbar: prev/next, send-to-live, and
              shortcuts tip. No floating 1/N pager — count removed per Julio.
              Video/YouTube also render play/scrub/mute under the media.
            */}
            <div
              className="preview-toolbar preview-toolbar-lite preview-toolbar-persistent"
              role="toolbar"
              aria-label={t("preview.nav")}
            >
              <button
                type="button"
                className="btn preview-tb-btn"
                disabled={!selectedItem || !canPreviewPrev}
                title={t("shortcuts.prev")}
                aria-label={t("shortcuts.prev")}
                onClick={previewGoPrev}
              >
                <IconPrev />
              </button>
              <button
                type="button"
                className="btn preview-tb-btn"
                disabled={!selectedItem || !canPreviewNext}
                title={t("shortcuts.next")}
                aria-label={t("shortcuts.next")}
                onClick={previewGoNext}
              >
                <IconNext />
              </button>
              <span className="preview-tb-sep" aria-hidden="true" />
              <button
                type="button"
                className={[
                  "btn btn-primary preview-tb-golive",
                  liveItemId ? "is-on-air" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={!liveItemId && !canGoLive}
                title={
                  liveItemId
                    ? t("control.stopLive")
                    : t("shortcuts.goLive")
                }
                aria-label={
                  liveItemId
                    ? t("control.stopLive")
                    : t("shortcuts.goLive")
                }
                aria-pressed={Boolean(liveItemId)}
                onClick={() => {
                  if (liveItemId) {
                    stopLiveToBlack();
                    return;
                  }
                  if (selectedItemId) {
                    goLiveItem(selectedItemId);
                  }
                }}
              >
                <IconGoLive />
                <span className="preview-tb-golive-label">
                  {t("playlist.goLiveShort")}
                </span>
              </button>
              <input
                ref={logoFileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                hidden
                onChange={(e) => {
                  void onLogoFileChosen(e.target.files?.[0] ?? null);
                }}
              />
              <button
                type="button"
                className={[
                  "btn preview-tb-btn preview-tb-scene",
                  sceneMode === "logo" ? "is-active" : "",
                  uploadingLogo ? "is-busy" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={!canMutate || uploadingLogo}
                title={t("control.sceneLogoHint")}
                aria-label={t("control.sceneLogo")}
                aria-pressed={sceneMode === "logo"}
                onClick={(e) => {
                  // Alt/Meta/Ctrl+click → replace permanent logo file.
                  if (e.altKey || e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    openLogoFilePicker();
                    return;
                  }
                  showLogoScene();
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openLogoFilePicker();
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  openLogoFilePicker();
                }}
              >
                <span className="preview-tb-scene-glyph" aria-hidden>
                  <IconSceneLogo />
                </span>
                <span className="preview-tb-scene-label">
                  {uploadingLogo
                    ? t("control.sceneLogoUploading")
                    : t("control.sceneLogo")}
                </span>
              </button>
              <button
                type="button"
                className="btn preview-tb-btn preview-tb-logo-upload"
                disabled={!canMutate || uploadingLogo}
                title={t("control.sceneLogoUpload")}
                aria-label={t("control.sceneLogoUpload")}
                onClick={openLogoFilePicker}
              >
                <IconUploadLogo />
              </button>
              <button
                type="button"
                className={[
                  "btn preview-tb-btn preview-tb-scene",
                  watermarkEnabled ? "is-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={!canMutate}
                title={t("control.sceneWatermarkHint")}
                aria-label={t("control.sceneWatermark")}
                aria-pressed={watermarkEnabled}
                onClick={toggleWatermark}
              >
                <span className="preview-tb-scene-glyph" aria-hidden>
                  <IconWatermark />
                </span>
                <span className="preview-tb-scene-label">
                  {t("control.sceneWatermark")}
                </span>
              </button>
              <button
                type="button"
                className={[
                  "btn preview-tb-btn preview-tb-scene",
                  dotsOverlay ? "is-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={!canMutate}
                title={t("control.dotsOverlayHint")}
                aria-label={t("control.dotsOverlay")}
                aria-pressed={dotsOverlay}
                onClick={toggleDotsOverlay}
              >
                <span className="preview-tb-scene-glyph" aria-hidden>
                  <IconDotsOverlay />
                </span>
                <span className="preview-tb-scene-label">
                  {t("control.dotsOverlay")}
                </span>
              </button>
              <button
                type="button"
                className={[
                  "btn preview-tb-btn preview-tb-scene",
                  sceneMode === "black" ? "is-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={!canMutate}
                title={t("shortcuts.sceneBlack")}
                aria-label={t("control.sceneEmpty")}
                aria-pressed={sceneMode === "black"}
                onClick={showEmptyScene}
              >
                <span className="preview-tb-scene-glyph" aria-hidden>
                  <IconSceneEmpty />
                </span>
                <span className="preview-tb-scene-label">
                  {t("control.sceneEmpty")}
                </span>
              </button>
              <button
                type="button"
                className={[
                  "btn preview-tb-btn preview-tb-scene",
                  videoCover?.active ? "is-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={!canMutate || !liveIsAv}
                title={
                  liveIsAv
                    ? t("control.videoCoverHint")
                    : t("control.videoCoverNeedsAv")
                }
                aria-label={t("control.videoCover")}
                aria-pressed={Boolean(videoCover?.active)}
                onClick={(e) => {
                  // Alt/Meta/Ctrl+click → choose another image.
                  if (e.altKey || e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    setCoverError(null);
                    setCoverDialogOpen(true);
                    return;
                  }
                  toggleVideoCover();
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (liveIsAv) {
                    setCoverError(null);
                    setCoverDialogOpen(true);
                  }
                }}
              >
                <span className="preview-tb-scene-glyph" aria-hidden>
                  <IconVideoCover />
                </span>
                <span className="preview-tb-scene-label">
                  {t("control.videoCover")}
                </span>
              </button>
              <span className="preview-tb-spacer" />
              <StatusTip
                tone="info"
                className="preview-tb-shortcuts"
                label={t("shortcuts.help")}
                message={t("shortcuts.hint")}
              />
            </div>
            <div className="zone-body zone-stage pm-theme" style={themeStyle}>
              <StageBackground
                background={themeBackground}
                assetSrc={themeBgAssetSrc}
                showDots={!previewVideoPlaneDots}
              />
              <span className="stage-overlay-label" aria-hidden="true">
                {t("control.preview")}
              </span>
              {selectedItem && Preview ? (
                <div
                  className={
                    previewVideoPlaneDots
                      ? "pm-stage-video-plane"
                      : "pm-stage-item-plane"
                  }
                >
                  <Preview
                    item={selectedItem}
                    slideIndex={previewSlideIndex}
                    onSlideIndexChange={setPreviewSlideSynced}
                    assetSrc={previewSrc}
                    onFitChange={
                      selectedItem.type === "image" ||
                      selectedItem.type === "presentation"
                        ? onFitChange
                        : undefined
                    }
                    projecting={
                      (selectedItem.type === "video" ||
                        selectedItem.type === "audio") &&
                      selectedItem.id === liveItemId
                    }
                    mediaClock={
                      (selectedItem.type === "video" ||
                        selectedItem.type === "audio") &&
                      selectedItem.id === liveItemId
                        ? mediaClock
                        : undefined
                    }
                    onMediaClockSet={
                      (selectedItem.type === "video" ||
                        selectedItem.type === "audio") &&
                      selectedItem.id === liveItemId
                        ? (patch) => session.setMediaClock(patch)
                        : undefined
                    }
                    onDurationMs={(ms) =>
                      rememberDuration(selectedItem.id, ms)
                    }
                    durationMsHint={
                      durationByItemId[selectedItem.id] ?? 0
                    }
                    onLocalPositionMs={
                      selectedItem.type === "video" ||
                      selectedItem.type === "audio"
                        ? setPreviewLocalPositionMs
                        : undefined
                    }
                    onYoutubeToLocal={
                      selectedItem.type === "video" &&
                      selectedItem.payload.sourceKind === "youtube"
                        ? () => youtubeToLocal(selectedItem)
                        : undefined
                    }
                    youtubeToLocalLabels={{
                      button: t("video.ytLocalButton"),
                      busy: t("video.ytLocalBusy"),
                      note: t("video.ytLocalNote"),
                      failed: t("video.ytLocalFailed"),
                    }}
                  />
                  {previewVideoPlaneDots ? <StageDotsOverlay /> : null}
                </div>
              ) : (
                <p>{t("control.previewEmpty")}</p>
              )}
              <SubtitleOverlay
                agent={subtitleAgent}
                mediaClock={
                  selectedItem && selectedItem.id === liveItemId
                    ? mediaClock
                    : null
                }
                localPositionMs={
                  selectedItem &&
                  (selectedItem.type === "video" ||
                    selectedItem.type === "audio") &&
                  selectedItem.id !== liveItemId
                    ? previewLocalPositionMs
                    : null
                }
                itemId={selectedItem?.id ?? null}
                transitionEffect={transitionEffect}
              />
            </div>
          </section>
        </div>
      </div>

      <footer className="control-footer">
        <span
          className={
            session.wsStatus === "open" && !session.hubUnreachable
              ? "status-dot on"
              : "status-dot"
          }
        />
        <span>
          {session.hubUnreachable
            ? t("control.hubDownFooter")
            : session.wsStatus === "open"
              ? t("control.wsConnected")
              : session.wsStatus === "connecting"
                ? t("control.wsConnecting")
                : t("control.wsDisconnected")}
        </span>
        <span className="footer-sep">·</span>
        <span>seq {session.lastSeq >= 0 ? session.lastSeq : "—"}</span>
        {session.code ? (
          <>
            <span className="footer-sep">·</span>
            <span
              className="footer-session-code"
              title={t("control.sessionCodeHint")}
            >
              {t("control.sessionCode")}: <strong>{session.code}</strong>
            </span>
          </>
        ) : null}
        <LanRemoteHint
          code={session.code || null}
          accessToken={session.accessToken || null}
        />
        {uploading ? (
          <>
            <span className="footer-sep">·</span>
            <span className="footer-muted">{t("video.uploading")}</span>
          </>
        ) : null}
      </footer>
    </div>
  );
}
