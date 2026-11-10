import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { PlaylistItem } from "@promedia/shared";
import { useLocale } from "../locale/LocaleContext";
import {
  buildGuionFile,
  importGuionToSession,
  pickGuionFromDisk,
  saveGuionToDisk,
} from "../lib/playlists";
import { DialogBrand } from "./DialogBrand";

export type SavedPlaylistPanelProps = {
  sessionId: string;
  wsTicket: string;
  /** Current Guion items — exported to the file. */
  items: readonly PlaylistItem[];
  disabled?: boolean;
  onHint?: (msg: string | null) => void;
};

/** Called from the Guion toolbar clicks (a real user gesture). */
export type SavedPlaylistPanelHandle = {
  /** Ask for the playlist name; the file is written only after confirming. */
  openSave: () => void;
  /** Open the device's file dialog and ADD the chosen file to the Guion. */
  openLoad: () => void;
};

const LAST_NAME_KEY = "promedia.guion.lastName";

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function readLastName(): string {
  try {
    return window.localStorage.getItem(LAST_NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberName(name: string): void {
  try {
    window.localStorage.setItem(LAST_NAME_KEY, name);
  } catch {
    // storage unavailable: the suggestion just falls back to the default
  }
}

/**
 * Guardar: first asks for the playlist name, and only then writes the local
 * file (device save dialog where the browser has one, else a download named
 * after it). Cargar: opens the device's file dialog and ADDS the file's items
 * to what is already in the Guion.
 */
export const SavedPlaylistPanel = forwardRef<
  SavedPlaylistPanelHandle,
  SavedPlaylistPanelProps
>(function SavedPlaylistPanel(
  { sessionId, wsTicket, items, disabled, onHint },
  ref,
) {
  const { t } = useLocale();
  const busy = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [nameOpen, setNameOpen] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (nameOpen) {
      window.setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [nameOpen]);

  const confirmSave = async () => {
    const label = name.trim();
    if (!label || busy.current) {
      return;
    }
    busy.current = true;
    setNameOpen(false);
    try {
      // Runs inside the confirm click: the browser allows its save dialog.
      const saved = await saveGuionToDisk(buildGuionFile(label, items));
      rememberName(saved);
      onHint?.(t("playlist.savedFileOk"));
    } catch (err) {
      if (!isAbort(err)) {
        onHint?.(String(err));
      }
    } finally {
      busy.current = false;
    }
  };

  const openLoad = async () => {
    if (disabled || busy.current) {
      return;
    }
    busy.current = true;
    try {
      // First thing in the click: the file dialog opens right away.
      const guion = await pickGuionFromDisk();
      const { added, skipped } = await importGuionToSession(sessionId, wsTicket, guion);
      onHint?.(
        (skipped > 0
          ? t("playlist.appendedSkipped").replace("{n}", String(added)).replace("{s}", String(skipped))
          : t("playlist.appendedOk").replace("{n}", String(added))),
      );
    } catch (err) {
      if (!isAbort(err)) {
        onHint?.(String(err));
      }
    } finally {
      busy.current = false;
    }
  };

  useImperativeHandle(ref, () => ({
    openSave: () => {
      if (disabled) {
        return;
      }
      setName(readLastName() || t("playlist.defaultFileName"));
      setNameOpen(true);
    },
    openLoad: () => {
      void openLoad();
    },
  }));

  if (!nameOpen) {
    return null;
  }
  return (
    <div
      className="promedia-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setNameOpen(false);
        }
      }}
    >
      <div
        className="promedia-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-name-title"
      >
        <DialogBrand id="playlist-name-title">
          {t("playlist.saveDialogTitle")}
        </DialogBrand>
        <label className="promedia-dialog-field">
          {t("playlist.saveNameLabel")}
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                e.preventDefault();
                void confirmSave();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setNameOpen(false);
              }
            }}
            autoComplete="off"
          />
        </label>
        <p className="promedia-dialog-hint">{t("playlist.saveNameHint")}</p>
        <div className="promedia-dialog-actions">
          <button type="button" className="btn" onClick={() => setNameOpen(false)}>
            {t("text.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!name.trim()}
            onClick={() => void confirmSave()}
          >
            {t("text.save")}
          </button>
        </div>
      </div>
    </div>
  );
});
