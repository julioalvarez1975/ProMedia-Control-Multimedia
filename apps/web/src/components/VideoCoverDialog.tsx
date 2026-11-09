import { useEffect, useRef, useState } from "react";
import type { LibraryItem } from "@promedia/shared";
import { libraryOriginalUrl, listLibraryItems } from "../lib/library";
import { useLocale } from "../locale/LocaleContext";
import { DialogBrand } from "./DialogBrand";

export type VideoCoverDialogProps = {
  open: boolean;
  onClose: () => void;
  busy?: boolean;
  error?: string | null;
  /** An image is currently set (offer "remove"). */
  hasCover?: boolean;
  onPickLibrary: (libraryItemId: string) => void;
  onPickFile: (file: File) => void;
  onRemove: () => void;
};

/**
 * Pick the cover image shown over the live video/audio: a Biblioteca image or
 * a new upload. The player keeps running underneath, so audio never stops.
 */
export function VideoCoverDialog({
  open,
  onClose,
  busy,
  error,
  hasCover,
  onPickLibrary,
  onPickFile,
  onRemove,
}: VideoCoverDialogProps) {
  const { t } = useLocale();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setListError(null);
    setLoading(true);
    void listLibraryItems({ category: "imagenes" })
      .then((list) => setItems(list.filter((i) => i.original)))
      .catch((err) => {
        setListError(String(err));
        setItems([]);
      })
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="promedia-dialog-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="promedia-dialog video-cover-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-cover-title"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogBrand id="video-cover-title">
          {t("control.videoCoverDialogTitle")}
        </DialogBrand>

        <div className="video-cover-actions">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onPickFile(file);
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {t("control.videoCoverUpload")}
          </button>
          {hasCover ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={onRemove}
            >
              {t("control.videoCoverRemove")}
            </button>
          ) : null}
          {busy ? <span>{t("control.videoCoverBusy")}</span> : null}
        </div>

        {error || listError ? (
          <p className="video-cover-error" role="alert">
            {error ?? listError}
          </p>
        ) : null}

        <h3 className="video-cover-subtitle">
          {t("control.videoCoverFromLibrary")}
        </h3>
        {!loading && items.length === 0 ? (
          <p className="video-cover-empty">{t("control.videoCoverEmpty")}</p>
        ) : (
          <ul className="video-cover-grid">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="video-cover-thumb"
                  disabled={busy}
                  title={item.title}
                  onClick={() => onPickLibrary(item.id)}
                >
                  <img src={libraryOriginalUrl(item.id)} alt="" loading="lazy" />
                  <span>{item.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="video-cover-footer">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t("control.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
