import { useEffect, useState } from "react";
import { useLocale } from "../locale/LocaleContext";

const DEFAULT_LOGO_SRC = "/logo-default.svg";

export type WatermarkOverlayProps = {
  enabled: boolean;
  /** Hub branding logo URL when a custom image was saved; else default SVG. */
  logoSrc?: string | null;
  /**
   * Hide under full-stage scenes (logo / black / clear) — watermark is for
   * live content, not takeover modes.
   */
  sceneBlocksWatermark?: boolean;
};

/**
 * Corner branding mark — logo fixed top-right over the Output stage.
 */
export function WatermarkOverlay({
  enabled,
  logoSrc,
  sceneBlocksWatermark = false,
}: WatermarkOverlayProps) {
  const { t } = useLocale();
  const [logoFailed, setLogoFailed] = useState(false);
  const resolvedLogoSrc = logoSrc?.trim() || DEFAULT_LOGO_SRC;

  useEffect(() => {
    setLogoFailed(false);
  }, [resolvedLogoSrc]);

  if (!enabled || sceneBlocksWatermark) {
    return null;
  }

  return (
    <div
      className="scene-watermark"
      aria-label={t("scene.watermark")}
    >
      {logoFailed ? (
        <span className="scene-watermark-fallback">{t("scene.logoFallback")}</span>
      ) : (
        <img
          className="scene-watermark-img"
          src={resolvedLogoSrc}
          alt=""
          onError={() => setLogoFailed(true)}
        />
      )}
    </div>
  );
}
