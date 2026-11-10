import { useEffect, useRef } from "react";
import type { PlaylistItem } from "@promedia/shared";
import { useLocale } from "../locale/LocaleContext";
import {
  buildGuionFile,
  importGuionToSession,
  pickGuionFromDisk,
  saveGuionToDisk,
} from "../lib/playlists";

export type SavedPlaylistPanelProps = {
  sessionId: string;
  wsTicket: string;
  /** Current Guion items — exported to the file. */
  items: readonly PlaylistItem[];
  disabled?: boolean;
  onHint?: (msg: string | null) => void;
  /** Set to true by the Guion toolbar: runs the action and resets itself. */
  saveOpen?: boolean;
  loadOpen?: boolean;
  onSaveOpenChange?: (open: boolean) => void;
  onLoadOpenChange?: (open: boolean) => void;
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
 * Headless: Guardar / Cargar open the DEVICE's own file dialog straight away
 * (no list of saved guiones). The guion lives in a local file; saving with the
 * same name replaces that file, and the last name is suggested next time.
 */
export function SavedPlaylistPanel({
  sessionId,
  wsTicket,
  items,
  disabled,
  onHint,
  saveOpen = false,
  loadOpen = false,
  onSaveOpenChange,
  onLoadOpenChange,
}: SavedPlaylistPanelProps) {
  const { t } = useLocale();
  const running = useRef(false);

  useEffect(() => {
    if (!saveOpen) {
      return;
    }
    // Always reset the flag so the toolbar button works again next click.
    onSaveOpenChange?.(false);
    if (disabled || running.current) {
      return;
    }
    running.current = true;
    void (async () => {
      try {
        const label = readLastName() || t("playlist.defaultFileName");
        const saved = await saveGuionToDisk(buildGuionFile(label, items));
        rememberName(saved);
        onHint?.(t("playlist.savedFileOk"));
      } catch (err) {
        if (!isAbort(err)) {
          onHint?.(String(err));
        }
      } finally {
        running.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveOpen]);

  useEffect(() => {
    if (!loadOpen) {
      return;
    }
    onLoadOpenChange?.(false);
    if (disabled || running.current) {
      return;
    }
    running.current = true;
    void (async () => {
      try {
        const guion = await pickGuionFromDisk();
        const { skipped } = await importGuionToSession(sessionId, wsTicket, guion);
        rememberName(guion.name);
        onHint?.(
          skipped > 0
            ? t("playlist.loadedSkipped").replace("{n}", String(skipped))
            : t("playlist.loadedOk"),
        );
      } catch (err) {
        if (!isAbort(err)) {
          onHint?.(String(err));
        }
      } finally {
        running.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadOpen]);

  return null;
}
