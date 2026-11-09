import { useCallback, useEffect, useState } from "react";
import type { PlaylistItem } from "@promedia/shared";
import { useLocale } from "../locale/LocaleContext";
import {
  buildGuionFile,
  deleteSavedPlaylist,
  importGuionToSession,
  listSavedPlaylists,
  loadSavedPlaylist,
  pickGuionFromDisk,
  saveGuionToDisk,
  saveSessionPlaylist,
  type SavedPlaylistSummary,
} from "../lib/playlists";
import { DialogBrand } from "./DialogBrand";

export type SavedPlaylistPanelProps = {
  sessionId: string;
  wsTicket: string;
  /** Current Guion items — exported to the on-disk file. */
  items: readonly PlaylistItem[];
  disabled?: boolean;
  onHint?: (msg: string | null) => void;
  /** Compact layout for playlist column (legacy inline). */
  compact?: boolean;
  /** Dialog mode opened from Guion toolbar icons. */
  dialogMode?: boolean;
  saveOpen?: boolean;
  loadOpen?: boolean;
  onSaveOpenChange?: (open: boolean) => void;
  onLoadOpenChange?: (open: boolean) => void;
};

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export function SavedPlaylistPanel({
  sessionId,
  wsTicket,
  items,
  disabled,
  onHint,
  compact,
  dialogMode,
  saveOpen = false,
  loadOpen = false,
  onSaveOpenChange,
  onLoadOpenChange,
}: SavedPlaylistPanelProps) {
  const { t } = useLocale();

  const [name, setName] = useState("");
  const [list, setList] = useState<SavedPlaylistSummary[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setList(await listSavedPlaylists());
    } catch {
      // Hub list is optional; file save/load is the primary path.
      setList([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if ((saveOpen || loadOpen) && dialogMode) {
      void refresh();
    }
  }, [saveOpen, loadOpen, dialogMode, refresh]);

  const onSaveToFile = async () => {
    if (disabled) {
      return;
    }
    const label = name.trim() || t("playlist.defaultFileName");
    setBusy(true);
    try {
      const file = buildGuionFile(label, items);
      await saveGuionToDisk(file);
      // Also mirror into hub store when possible (same LAN / resume).
      try {
        await saveSessionPlaylist(sessionId, wsTicket, file.name);
        await refresh();
      } catch {
        // Disk save already succeeded.
      }
      setName("");
      onHint?.(t("playlist.savedFileOk"));
      onSaveOpenChange?.(false);
    } catch (err) {
      if (!isAbort(err)) {
        onHint?.(String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const onOpenFile = async () => {
    if (disabled) {
      return;
    }
    setBusy(true);
    try {
      const guion = await pickGuionFromDisk();
      const { skipped } = await importGuionToSession(
        sessionId,
        wsTicket,
        guion,
      );
      onHint?.(
        skipped > 0
          ? t("playlist.loadedSkipped").replace("{n}", String(skipped))
          : t("playlist.loadedOk"),
      );
      onLoadOpenChange?.(false);
    } catch (err) {
      if (!isAbort(err)) {
        onHint?.(String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const onLoadHub = async (id: string) => {
    setBusy(true);
    try {
      const { skipped } = await loadSavedPlaylist(sessionId, wsTicket, id);
      onHint?.(
        skipped > 0
          ? t("playlist.loadedSkipped").replace("{n}", String(skipped))
          : t("playlist.loadedOk"),
      );
      onLoadOpenChange?.(false);
    } catch (err) {
      onHint?.(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    setBusy(true);
    try {
      await deleteSavedPlaylist(id);
      await refresh();
    } catch (err) {
      onHint?.(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (dialogMode) {
    return (
      <>
        {saveOpen ? (
          <div
            className="promedia-dialog-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                onSaveOpenChange?.(false);
              }
            }}
          >
            <div
              className="promedia-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="playlist-save-title"
            >
              <DialogBrand id="playlist-save-title">
                {t("playlist.save")}
              </DialogBrand>
              <p className="promedia-dialog-hint">{t("playlist.saveFileHint")}</p>
              <label className="promedia-dialog-field">
                {t("playlist.saveName")}
                <input
                  value={name}
                  disabled={disabled || busy}
                  autoFocus
                  placeholder={t("playlist.saveName")}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void onSaveToFile();
                    } else if (e.key === "Escape") {
                      onSaveOpenChange?.(false);
                    }
                  }}
                />
              </label>
              <div className="promedia-dialog-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => onSaveOpenChange?.(false)}
                >
                  {t("text.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={disabled || busy || items.length === 0}
                  onClick={() => void onSaveToFile()}
                >
                  {t("playlist.saveToFile")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {loadOpen ? (
          <div
            className="promedia-dialog-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                onLoadOpenChange?.(false);
              }
            }}
          >
            <div
              className="promedia-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="playlist-load-title"
            >
              <DialogBrand id="playlist-load-title">
                {t("playlist.load")}
              </DialogBrand>
              <p className="promedia-dialog-hint">{t("playlist.loadFileHint")}</p>
              <div className="promedia-dialog-actions" style={{ justifyContent: "stretch" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={disabled || busy}
                  onClick={() => void onOpenFile()}
                  style={{ width: "100%" }}
                >
                  {t("playlist.openFile")}
                </button>
              </div>
              {list.length > 0 ? (
                <>
                  <p className="promedia-dialog-hint">
                    {t("playlist.hubCopies")}
                  </p>
                  <ul className="saved-playlist-list saved-playlist-list-dialog">
                    {list.map((p) => (
                      <li key={p.id}>
                        <span className="saved-playlist-name">
                          {p.name}{" "}
                          <span className="footer-muted">({p.itemCount})</span>
                        </span>
                        <div className="playlist-row-actions">
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={disabled || busy}
                            onClick={() => void onLoadHub(p.id)}
                          >
                            {t("playlist.load")}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={busy}
                            onClick={() => void onDelete(p.id)}
                          >
                            {t("playlist.remove")}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <div className="promedia-dialog-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => onLoadOpenChange?.(false)}
                >
                  {t("text.cancel")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div
      className={
        compact
          ? "saved-playlist-panel saved-playlist-panel-compact"
          : "saved-playlist-panel"
      }
    >
      <h3 className="theme-controls-title">
        {t(compact ? "playlist.saveLoadTitle" : "playlist.savedTitle")}
      </h3>
      <div className="saved-playlist-save">
        <input
          value={name}
          disabled={disabled || busy}
          placeholder={t("playlist.saveName")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void onSaveToFile();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || busy || items.length === 0}
          onClick={() => void onSaveToFile()}
        >
          {t("playlist.saveToFile")}
        </button>
        <button
          type="button"
          className="btn"
          disabled={disabled || busy}
          onClick={() => void onOpenFile()}
        >
          {t("playlist.openFile")}
        </button>
      </div>
      {list.length === 0 ? (
        <p className="zone-empty">{t("playlist.savedEmpty")}</p>
      ) : (
        <ul className="saved-playlist-list">
          {list.map((p) => (
            <li key={p.id}>
              <span className="saved-playlist-name">
                {p.name}{" "}
                <span className="footer-muted">({p.itemCount})</span>
              </span>
              <div className="playlist-row-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={disabled || busy}
                  onClick={() => void onLoadHub(p.id)}
                >
                  {t("playlist.load")}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => void onDelete(p.id)}
                >
                  {t("playlist.remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
