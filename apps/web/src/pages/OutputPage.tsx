import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getItemType } from "@promedia/item-types";
import { DEFAULT_LOCALE, t } from "@promedia/i18n";
import type { SceneMode, ThemeId, TransitionEffect } from "@promedia/shared";
import {
  DEFAULT_THEME_BACKGROUND,
  DEFAULT_THEME_ID,
  DEFAULT_TRANSITION_EFFECT,
  emptySubtitleAgentState,
  normalizeThemeBackground,
} from "@promedia/shared";
import { LiveItemLayer } from "../components/LiveItemLayer";
import { SceneOverlay } from "../components/SceneOverlay";
import { WatermarkOverlay } from "../components/WatermarkOverlay";
import {
  StageBackground,
  StageDotsOverlay,
} from "../components/StageBackground";
import { SubtitleOverlay } from "../components/SubtitleOverlay";
import { useSessionConnection } from "../hooks/useSessionConnection";
import { buildAssetUrl, buildBrandingLogoUrl } from "../lib/assets";
import { OUTPUT_BROADCAST_CHANNEL } from "../lib/openOutputWindow";
import { loadPersistedControlSession } from "../lib/controlSessionPersist";
import {
  loadPersistedOutputSession,
  savePersistedOutputSession,
} from "../lib/outputSessionPersist";
import { themeSurfaceStyle } from "../lib/theme";

const locale = DEFAULT_LOCALE;

type FullscreenCapable = Element & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitRequestFullScreen?: () => Promise<void> | void;
};

function readFullscreenElement(): Element | null {
  const doc = document as Document & {
    webkitFullscreenElement?: Element | null;
  };
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Prefer the projection stage; fall back to documentElement (hides browser chrome). */
async function requestOutputFullscreen(stage: HTMLElement | null): Promise<boolean> {
  const candidates: FullscreenCapable[] = [];
  if (stage) {
    candidates.push(stage);
  }
  candidates.push(document.documentElement as FullscreenCapable);

  for (const el of candidates) {
    try {
      if (typeof el.requestFullscreen === "function") {
        await el.requestFullscreen();
        return true;
      }
      if (typeof el.webkitRequestFullscreen === "function") {
        await el.webkitRequestFullscreen();
        return true;
      }
      if (typeof el.webkitRequestFullScreen === "function") {
        await el.webkitRequestFullScreen();
        return true;
      }
    } catch {
      // try next candidate
    }
  }
  return false;
}

async function exitOutputFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void> | void;
      webkitCancelFullScreen?: () => Promise<void> | void;
    };
    if (typeof doc.webkitExitFullscreen === "function") {
      await doc.webkitExitFullscreen();
      return;
    }
    if (typeof doc.webkitCancelFullScreen === "function") {
      await doc.webkitCancelFullScreen();
    }
  } catch {
    // ignore
  }
}

/** Product Output — live + sceneMode overlays (subtarea 7). */
export function OutputPage() {
  const [params] = useSearchParams();
  const {
    hasSession,
    wsStatus,
    error,
    join,
    snapshot,
    sessionId,
    wsTicket,
    code: sessionCode,
    setMediaClock,
  } = useSessionConnection("output");
  const stageRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const autoJoinStarted = useRef(false);
  const autofullscreenTried = useRef(false);
  const joinRef = useRef(join);
  joinRef.current = join;

  const queryCode = (params.get("code") ?? "").trim().toUpperCase();
  const queryToken =
    (params.get("token") ?? params.get("accessToken") ?? "").trim();
  const wantAutofullscreen =
    params.get("autofullscreen") === "1" ||
    params.get("autofullscreen") === "true";

  const liveItem = useMemo(() => {
    const id = snapshot?.live.currentItemId;
    if (!id || !snapshot) {
      return null;
    }
    return snapshot.playlist.items.find((i) => i.id === id) ?? null;
  }, [snapshot]);

  const liveSlideIndex = snapshot?.live.currentSlideIndex ?? 0;
  const mediaClock = snapshot?.live.mediaClock ?? null;
  const sceneMode: SceneMode = snapshot?.live.sceneMode ?? "normal";
  const watermarkEnabled = snapshot?.live.watermarkEnabled === true;
  const logoUpdatedAt = snapshot?.live.logoUpdatedAt ?? null;
  const themeId: ThemeId = snapshot?.live.themeId ?? DEFAULT_THEME_ID;
  const themeOverrides = snapshot?.live.themeOverrides ?? null;
  const themeBackground = normalizeThemeBackground(
    snapshot?.live.themeBackground ?? DEFAULT_THEME_BACKGROUND,
  );
  const dotsOverlay = themeBackground.dotsOverlay === true;
  /** Dots on the video plane (inside item layer) so captions stay above. */
  const videoPlaneDots = dotsOverlay && liveItem?.type === "video";
  const transitionEffect: TransitionEffect =
    snapshot?.live.transitionEffect ?? DEFAULT_TRANSITION_EFFECT;
  const subtitleAgent =
    snapshot?.live.subtitleAgent ?? emptySubtitleAgentState();
  const themeStyle = themeSurfaceStyle(themeId, themeOverrides);
  const liveItemKey = liveItem?.id ?? "__empty__";
  const OutputRenderer = liveItem
    ? getItemType(liveItem.type)?.OutputRenderer
    : undefined;
  const themeBgAssetSrc =
    themeBackground.mode === "media" &&
    themeBackground.assetId &&
    sessionId &&
    wsTicket
      ? buildAssetUrl(sessionId, themeBackground.assetId, wsTicket)
      : undefined;

  const assetSrc = (() => {
    if (!liveItem || !sessionId || !wsTicket) {
      return undefined;
    }
    if (liveItem.type === "image") {
      return buildAssetUrl(sessionId, liveItem.payload.assetId, wsTicket);
    }
    if (liveItem.type === "presentation") {
      const slide =
        liveItem.payload.slides[liveSlideIndex] ?? liveItem.payload.slides[0];
      if (!slide) {
        return undefined;
      }
      return buildAssetUrl(sessionId, slide.assetId, wsTicket);
    }
    if (liveItem.type === "video" && liveItem.payload.sourceKind === "file") {
      return buildAssetUrl(sessionId, liveItem.payload.assetId, wsTicket);
    }
    if (liveItem.type === "audio") {
      return buildAssetUrl(sessionId, liveItem.payload.assetId, wsTicket);
    }
    return undefined;
  })();

  // Output route: force black page chrome (no light browser gutters).
  useEffect(() => {
    document.documentElement.classList.add("output-route");
    document.body.classList.add("output-route");
    return () => {
      document.documentElement.classList.remove("output-route");
      document.body.classList.remove("output-route");
    };
  }, []);

  useEffect(() => {
    const syncFs = () => {
      setIsFullscreen(Boolean(readFullscreenElement()));
    };
    syncFs();
    document.addEventListener("fullscreenchange", syncFs);
    document.addEventListener("webkitfullscreenchange", syncFs);
    return () => {
      document.removeEventListener("fullscreenchange", syncFs);
      document.removeEventListener("webkitfullscreenchange", syncFs);
    };
  }, []);

  /**
   * Projection only joins the Control session — never asks for a code and
   * never creates a parallel session. Phone pairing lives on /control.
   */
  useEffect(() => {
    if (autoJoinStarted.current || hasSession) {
      return;
    }
    autoJoinStarted.current = true;
    void (async () => {
      const tryJoin = async (opts: {
        code?: string;
        accessToken?: string;
      }): Promise<boolean> => {
        try {
          await joinRef.current(opts);
          return true;
        } catch {
          return false;
        }
      };

      if (queryCode && (await tryJoin({ code: queryCode }))) {
        return;
      }
      if (queryToken && (await tryJoin({ accessToken: queryToken }))) {
        return;
      }

      const savedOut = loadPersistedOutputSession();
      if (savedOut?.code && (await tryJoin({ code: savedOut.code }))) {
        return;
      }
      if (
        savedOut?.accessToken &&
        (await tryJoin({ accessToken: savedOut.accessToken }))
      ) {
        return;
      }

      // Same PC browser: reuse the Control panel session (code stays on Control).
      const savedControl = loadPersistedControlSession();
      if (
        savedControl?.code &&
        (await tryJoin({ code: savedControl.code }))
      ) {
        return;
      }
      if (
        savedControl?.accessToken &&
        (await tryJoin({ accessToken: savedControl.accessToken }))
      ) {
        return;
      }

      // Nothing to join yet — wait until Control opens proyección with ?code=.
      autoJoinStarted.current = false;
    })();
  }, [queryCode, queryToken, hasSession]);

  // Remember Output join for projector refresh (pairing UI stays on Control).
  useEffect(() => {
    if (!hasSession) {
      return;
    }
    savePersistedOutputSession({
      code: sessionCode || queryCode || undefined,
      accessToken: queryToken || undefined,
    });
  }, [hasSession, sessionCode, queryCode, queryToken]);

  const enterFullscreen = async () => {
    await requestOutputFullscreen(stageRef.current);
  };

  const exitFullscreen = async () => {
    await exitOutputFullscreen();
  };

  // Control → Output: postMessage (desktop popup) + BroadcastChannel (mobile-safe).
  useEffect(() => {
    const handleControlMessage = (data: { type?: string } | null) => {
      if (data?.type === "promedia.requestFullscreen") {
        if (!readFullscreenElement()) {
          void requestOutputFullscreen(stageRef.current);
        }
        return;
      }
      if (data?.type === "promedia.requestUnmute") {
        window.dispatchEvent(new CustomEvent("promedia:unmute"));
      }
    };
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) {
        return;
      }
      handleControlMessage(ev.data as { type?: string } | null);
    };
    window.addEventListener("message", onMessage);

    let bus: BroadcastChannel | null = null;
    try {
      bus = new BroadcastChannel(OUTPUT_BROADCAST_CHANNEL);
      bus.onmessage = (ev: MessageEvent) => {
        handleControlMessage(ev.data as { type?: string } | null);
      };
    } catch {
      bus = null;
    }

    return () => {
      window.removeEventListener("message", onMessage);
      bus?.close();
    };
  }, []);

  // ?autofullscreen=1 — try after load / join (may be blocked without gesture).
  useEffect(() => {
    if (!wantAutofullscreen || autofullscreenTried.current) {
      return;
    }
    if (!hasSession && wsStatus === "connecting") {
      return;
    }
    autofullscreenTried.current = true;
    const timers = [200, 600, 1500].map((ms) =>
      window.setTimeout(() => {
        if (readFullscreenElement()) {
          return;
        }
        void requestOutputFullscreen(stageRef.current);
      }, ms),
    );
    return () => {
      for (const id of timers) {
        window.clearTimeout(id);
      }
    };
  }, [wantAutofullscreen, hasSession, wsStatus]);

  // First real user gesture on Output → enter fullscreen (hides browser bar).
  useEffect(() => {
    if (!wantAutofullscreen || isFullscreen) {
      return;
    }
    const onGesture = () => {
      if (readFullscreenElement()) {
        return;
      }
      void requestOutputFullscreen(stageRef.current);
    };
    window.addEventListener("pointerdown", onGesture, { capture: true });
    window.addEventListener("keydown", onGesture, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", onGesture, { capture: true });
      window.removeEventListener("keydown", onGesture, { capture: true });
    };
  }, [wantAutofullscreen, isFullscreen]);

  const showFsPrompt = wantAutofullscreen && !isFullscreen && hasSession;

  const retryProjectionSession = () => {
    if (autoJoinStarted.current && (wsStatus === "connecting" || hasSession)) {
      return;
    }
    autoJoinStarted.current = false;
    // Re-run the join effect by flipping the guard after a tick.
    window.setTimeout(() => {
      if (hasSession) {
        return;
      }
      autoJoinStarted.current = true;
      void (async () => {
        const tryJoin = async (opts: {
          code?: string;
          accessToken?: string;
        }): Promise<boolean> => {
          try {
            await joinRef.current(opts);
            return true;
          } catch {
            return false;
          }
        };
        if (queryCode && (await tryJoin({ code: queryCode }))) return;
        if (queryToken && (await tryJoin({ accessToken: queryToken }))) return;
        const savedOut = loadPersistedOutputSession();
        if (savedOut?.code && (await tryJoin({ code: savedOut.code }))) return;
        if (
          savedOut?.accessToken &&
          (await tryJoin({ accessToken: savedOut.accessToken }))
        ) {
          return;
        }
        const savedControl = loadPersistedControlSession();
        if (
          savedControl?.code &&
          (await tryJoin({ code: savedControl.code }))
        ) {
          return;
        }
        if (
          savedControl?.accessToken &&
          (await tryJoin({ accessToken: savedControl.accessToken }))
        ) {
          return;
        }
        autoJoinStarted.current = false;
      })();
    }, 0);
  };

  return (
    <div className="output-shell">
      <div
        ref={stageRef}
        className={
          isFullscreen
            ? "output-stage output-stage-fs pm-theme"
            : "output-stage pm-theme"
        }
        style={themeStyle}
        data-theme={themeId}
      >
        <StageBackground
          background={themeBackground}
          assetSrc={themeBgAssetSrc}
          showDots={!videoPlaneDots}
        />
        {wsStatus === "connecting" && !hasSession ? (
          <p className="output-waiting">{t(locale, "output.joining")}</p>
        ) : error && !hasSession ? (
          <div className="output-waiting-block">
            <p className="output-waiting output-error">
              {t(locale, "output.joinFailed")}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={retryProjectionSession}
            >
              {t(locale, "output.retry")}
            </button>
          </div>
        ) : (
          <>
            {/* Keep item mounted under overlays so video clock/audio continue (Q1). */}
            {liveItem && OutputRenderer ? (
              <LiveItemLayer
                key={liveItemKey}
                effect={transitionEffect}
                dataContent={liveItem.type}
                ariaHidden={sceneMode !== "normal"}
                planeOverlay={
                  videoPlaneDots ? <StageDotsOverlay /> : null
                }
              >
                <OutputRenderer
                  item={liveItem}
                  slideIndex={liveSlideIndex}
                  assetSrc={assetSrc}
                  mediaClock={mediaClock}
                  onMediaClockSet={
                    liveItem.type === "video" || liveItem.type === "audio"
                      ? (patch) => setMediaClock(patch)
                      : undefined
                  }
                />
              </LiveItemLayer>
            ) : sceneMode === "normal" ? (
              <LiveItemLayer key={liveItemKey} effect={transitionEffect}>
                <div className="output-waiting-block">
                  <p className="output-waiting">
                    {t(locale, "output.waiting")}
                  </p>
                </div>
              </LiveItemLayer>
            ) : null}
            <SubtitleOverlay
              agent={subtitleAgent}
              mediaClock={mediaClock}
              itemId={liveItem?.id ?? null}
              transitionEffect={transitionEffect}
            />
            <SceneOverlay
              mode={sceneMode}
              logoSrc={
                logoUpdatedAt && sessionId && wsTicket
                  ? buildBrandingLogoUrl(
                      sessionId,
                      wsTicket,
                      logoUpdatedAt,
                    )
                  : null
              }
            />
            <WatermarkOverlay
              enabled={watermarkEnabled}
              sceneBlocksWatermark={sceneMode !== "normal"}
              logoSrc={
                logoUpdatedAt && sessionId && wsTicket
                  ? buildBrandingLogoUrl(
                      sessionId,
                      wsTicket,
                      logoUpdatedAt,
                    )
                  : null
              }
            />
          </>
        )}

        {!isFullscreen && !hasSession ? (
          <div className="output-chrome">
            <p className="output-hint">{t(locale, "output.fullscreenHint")}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void enterFullscreen()}
            >
              {t(locale, "output.enterFullscreen")}
            </button>
          </div>
        ) : showFsPrompt ? (
          <button
            type="button"
            className="output-fs-prompt"
            onClick={() => void enterFullscreen()}
            title={t(locale, "output.clickFullscreen")}
            aria-label={t(locale, "output.clickFullscreen")}
          >
            <span className="output-fs-prompt-label">
              {t(locale, "output.clickFullscreen")}
            </span>
          </button>
        ) : !isFullscreen && hasSession ? (
          <button
            type="button"
            className="output-exit-fs"
            onClick={() => void enterFullscreen()}
            title={t(locale, "output.enterFullscreen")}
            aria-label={t(locale, "output.enterFullscreen")}
          />
        ) : (
          <button
            type="button"
            className="output-exit-fs"
            onClick={() => void exitFullscreen()}
            aria-label="Exit fullscreen"
          />
        )}
      </div>
    </div>
  );
}
