import { useEffect } from "react";
import type { Locale } from "@promedia/i18n";
import { LOCALE_NAME, useLocale } from "../locale/LocaleContext";
import { DialogBrand } from "./DialogBrand";
import { IconAbout, IconLanguage } from "./UiIcons";

export type SettingsDialogProps = {
  open: boolean;
  onClose: () => void;
  onAbout: () => void;
};

/** General options. Language and About live here; more rows can be added later. */
export function SettingsDialog({ open, onClose, onAbout }: SettingsDialogProps) {
  const { t, locale, setLocale, locales } = useLocale();
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) {
    return null;
  }

  return (
    <div
      className="promedia-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="promedia-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
      >
        <DialogBrand id="settings-dialog-title">
          {t("control.settings")}
        </DialogBrand>
        <p className="promedia-dialog-hint">{t("control.settingsHint")}</p>

        <label className="promedia-dialog-field settings-option">
          <span className="settings-option-label">
            <IconLanguage />
            {t("control.language")}
          </span>
          <select
            value={locale}
            aria-label={t("control.language")}
            onChange={(e) => setLocale(e.target.value as Locale)}
          >
            {locales.map((code) => (
              <option key={code} value={code}>
                {LOCALE_NAME[code]}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="btn settings-about-btn"
          onClick={() => {
            onClose();
            onAbout();
          }}
        >
          <IconAbout />
          {t("control.about")}
        </button>

        <div className="promedia-dialog-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t("control.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
