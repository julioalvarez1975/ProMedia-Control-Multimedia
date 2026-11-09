import type { PlaylistItem } from "@promedia/shared";
import { hubHttpBase } from "./hub";

export type SavedPlaylistSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
};

/** On-disk guion export (operator file explorer save/open). */
export type GuionFile = {
  format: "promedia-guion";
  version: 1;
  name: string;
  exportedAt: string;
  items: PlaylistItem[];
};

export const GUION_FILE_ACCEPT =
  ".promedia-guion.json,.json,application/json";

function sanitizeFileBase(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return cleaned || "guion";
}

export function buildGuionFile(
  name: string,
  items: readonly PlaylistItem[],
): GuionFile {
  return {
    format: "promedia-guion",
    version: 1,
    name: name.trim() || "Guion",
    exportedAt: new Date().toISOString(),
    items: items.map((item, order) => ({ ...item, order })),
  };
}

export function parseGuionFile(raw: unknown): GuionFile {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid_guion_file");
  }
  const obj = raw as Record<string, unknown>;
  // Accept our format or a bare { name, items } / SavedPlaylist-shaped JSON.
  const items = obj.items;
  if (!Array.isArray(items)) {
    throw new Error("invalid_guion_file");
  }
  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : "Guion";
  return {
    format: "promedia-guion",
    version: 1,
    name,
    exportedAt:
      typeof obj.exportedAt === "string"
        ? obj.exportedAt
        : new Date().toISOString(),
    items: items as PlaylistItem[],
  };
}

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: string | Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<
    Array<{
      getFile: () => Promise<File>;
    }>
  >;
};

/** Write guion JSON via native save dialog, or download fallback. */
export async function saveGuionToDisk(file: GuionFile): Promise<void> {
  const suggested = `${sanitizeFileBase(file.name)}.promedia-guion.json`;
  const json = `${JSON.stringify(file, null, 2)}\n`;
  const w = window as SavePickerWindow;
  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: suggested,
        types: [
          {
            description: "ProMedia guion",
            accept: {
              "application/json": [".promedia-guion.json", ".json"],
            },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      return;
    } catch (err) {
      // User cancel — AbortError; rethrow others after fallback attempt skip.
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
      // Some browsers throw NotAllowedError — fall through to download.
    }
  }
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggested;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

/** Open native file picker (or hidden input) and parse a guion JSON. */
export async function pickGuionFromDisk(): Promise<GuionFile> {
  const w = window as SavePickerWindow;
  if (typeof w.showOpenFilePicker === "function") {
    try {
      const [handle] = await w.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "ProMedia guion",
            accept: {
              "application/json": [".promedia-guion.json", ".json"],
            },
          },
        ],
      });
      const file = await handle.getFile();
      const text = await file.text();
      return parseGuionFile(JSON.parse(text) as unknown);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
      // Fall through to <input type=file>.
    }
  }

  const file = await new Promise<File>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = GUION_FILE_ACCEPT;
    input.style.display = "none";
    const cleanup = () => {
      input.remove();
    };
    input.addEventListener("change", () => {
      const chosen = input.files?.[0];
      cleanup();
      if (!chosen) {
        reject(new DOMException("Cancelled", "AbortError"));
        return;
      }
      resolve(chosen);
    });
    input.addEventListener("cancel", () => {
      cleanup();
      reject(new DOMException("Cancelled", "AbortError"));
    });
    document.body.appendChild(input);
    input.click();
  });
  const text = await file.text();
  return parseGuionFile(JSON.parse(text) as unknown);
}

export async function listSavedPlaylists(): Promise<SavedPlaylistSummary[]> {
  const res = await fetch(`${hubHttpBase()}/api/v1/playlists`);
  if (!res.ok) {
    throw new Error(`list_playlists_${res.status}`);
  }
  const data = (await res.json()) as { playlists: SavedPlaylistSummary[] };
  return data.playlists;
}

export async function saveSessionPlaylist(
  sessionId: string,
  credential: string,
  name: string,
  id?: string,
): Promise<{ id: string; name: string }> {
  const res = await fetch(
    `${hubHttpBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/playlists`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, id }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `save_failed_${res.status}`);
  }
  const data = (await res.json()) as {
    playlist: { id: string; name: string };
  };
  return data.playlist;
}

export async function loadSavedPlaylist(
  sessionId: string,
  credential: string,
  playlistId: string,
): Promise<{ skipped: number }> {
  const res = await fetch(
    `${hubHttpBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/playlists/${encodeURIComponent(playlistId)}/load`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}` },
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `load_failed_${res.status}`);
  }
  const data = (await res.json()) as { skipped?: number };
  return { skipped: data.skipped ?? 0 };
}

export async function importGuionToSession(
  sessionId: string,
  credential: string,
  guion: GuionFile,
): Promise<{ skipped: number }> {
  const res = await fetch(
    `${hubHttpBase()}/api/v1/sessions/${encodeURIComponent(sessionId)}/playlists/import`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: guion.name, items: guion.items }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `import_failed_${res.status}`);
  }
  const data = (await res.json()) as { skipped?: number };
  return { skipped: data.skipped ?? 0 };
}

export async function deleteSavedPlaylist(id: string): Promise<void> {
  const res = await fetch(
    `${hubHttpBase()}/api/v1/playlists/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(`delete_failed_${res.status}`);
  }
}
