import { useCallback, useEffect, useState } from "react";
import {
  buildLanControlUrls,
  fetchHubHealth,
  isLoopbackPageHost,
} from "../lib/hub";
import { useLocale } from "../locale/LocaleContext";

export type ShareProjectionBarProps = {
  code: string;
  accessToken?: string | null;
  /** True when Output/projection window was opened from this PC. */
  projectionReady?: boolean;
};

/**
 * PC projects; phone joins the same session as remote Control.
 * En vivo on the phone updates the PC Output — not a second phone stage.
 */
export function ShareProjectionBar({
  code,
  accessToken,
  projectionReady = false,
}: ShareProjectionBarProps) {
  const { t } = useLocale();
  const onPhone = !isLoopbackPageHost();
  const [controlUrl, setControlUrl] = useState("");
  const [copied, setCopied] = useState<"control" | "code" | null>(null);

  useEffect(() => {
    if (onPhone) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const health = await fetchHubHealth();
      if (cancelled || !health?.ok) {
        return;
      }
      const addrs = health.lanAddresses ?? [];
      const controls = buildLanControlUrls(addrs, { code, accessToken });
      setControlUrl(controls[0] ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, [code, accessToken, onPhone]);

  const flash = useCallback((kind: "control" | "code") => {
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1600);
  }, []);

  const copyText = useCallback(
    async (text: string, kind: "control" | "code") => {
      if (!text) {
        return;
      }
      try {
        await navigator.clipboard?.writeText(text);
        flash(kind);
      } catch {
        // ignore
      }
    },
    [flash],
  );

  if (onPhone) {
    return (
      <div
        className="share-projection-bar share-projection-bar--phone"
        role="status"
        aria-label={t("control.shareProjectionTitle")}
      >
        <div className="share-projection-main">
          <p className="share-projection-title">
            {t("control.remoteControlActive")}
          </p>
          <p className="share-projection-code">
            <span className="share-projection-code-label">
              {t("control.sessionCode")}
            </span>{" "}
            <strong>{code}</strong>
          </p>
          <p className="share-projection-hint">
            {t("control.shareProjectionHintPhone")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="share-projection-bar"
      role="region"
      aria-label={t("control.shareProjectionTitle")}
    >
      <div className="share-projection-main">
        <p className="share-projection-title">
          {t("control.shareProjectionTitle")}
        </p>
        <p className="share-projection-code" title={t("control.sessionCodeHint")}>
          <span className="share-projection-code-label">
            {t("control.sessionCode")}
          </span>{" "}
          <strong>{code}</strong>
          <button
            type="button"
            className="btn btn-ghost share-projection-copy"
            onClick={() => void copyText(code, "code")}
          >
            {copied === "code"
              ? t("control.lanRemoteCopied")
              : t("control.lanRemoteCopy")}
          </button>
        </p>
        <p className="share-projection-hint">
          {projectionReady
            ? t("control.shareProjectionHintPcReady")
            : t("control.shareProjectionHintPc")}
        </p>
      </div>

      <div className="share-projection-actions">
        {controlUrl ? (
          <div className="share-projection-link-row">
            <span className="share-projection-link-label">
              {t("control.shareControlLink")}
            </span>
            <a className="share-projection-link" href={controlUrl}>
              {controlUrl}
            </a>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void copyText(controlUrl, "control")}
            >
              {copied === "control"
                ? t("control.lanRemoteCopied")
                : t("control.lanRemoteCopy")}
            </button>
          </div>
        ) : (
          <p className="share-projection-hint">{t("control.shareWaitingLan")}</p>
        )}
      </div>
    </div>
  );
}
