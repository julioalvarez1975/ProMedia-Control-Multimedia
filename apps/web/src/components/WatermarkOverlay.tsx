import { useEffect, useState } from "react";
import { useLocale } from "../locale/LocaleContext";

const DEFAULT_MARK_SRC = "/logo-default.svg";

export type WatermarkOverlayProps = {
  enabled: boolean;
  /**
   * The operator's own watermark file (independent of the venue logo). Null =
   * none uploaded: the built-in default mark is shown.
   */
  src?: string | null;
  /** MIME of `src` — `video/*` plays as a looping muted video. */
  mime?: string | null;
  /**
   * Hide under full-stage scenes (logo / black / clear) — watermark is for
   * live content, not takeover modes.
   */
  sceneBlocksWatermark?: boolean;
};

/**
 * Corner mark — fixed top-right over the Output stage, faint so it never
 * competes with the content. Image, animated image (gif / webp / apng) or a
 * short looping video.
 */
export function WatermarkOverlay({
  enabled,
  src,
  mime,
  sceneBlocksWatermark = false,
}: WatermarkOverlayProps) {
  const { t } = useLocale();
  const [failed, setFailed] = useState(false);
  const resolvedSrc = src?.trim() || DEFAULT_MARK_SRC;
  const isVideo = Boolean(src?.trim()) && (mime ?? "").startsWith("video/");

  useEffect(() => {
    setFailed(false);
  }, [resolvedSrc]);

  if (!enabled || sceneBlocksWatermark) {
    return null;
  }

  return (
    <div className="scene-watermark" aria-label={t("scene.watermark")}>
      {failed ? (
        <span className="scene-watermark-fallback">{t("scene.logoFallback")}</span>
      ) : isVideo ? (
        <video
          className="scene-watermark-img"
          src={resolvedSrc}
          autoPlay
          loop
          muted
          playsInline
          onError={() => setFailed(true)}
        />
      ) : (
        <img
          className="scene-watermark-img"
          src={resolvedSrc}
          alt=""
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
