/**
 * Persistent karaoke “learning”: remember which Biblioteca song worked for a
 * YouTube id / audio asset / primary title so the next run skips bad aliases,
 * plus operator-taught cue start times from Preview ←/→ nudges.
 */
import { readJsonFile, writeJsonAtomic } from "./json-file.js";
import path from "node:path";
import { promediaRoot } from "./subtitle-paths.js";
import { normalizeMatchTitle, primaryTitleSegment } from "./subtitle-cancionero.js";

export type CancioneroMemoryEntry = {
  songId: string;
  songTitle: string;
  /** How we learned this mapping. */
  source: "exact" | "lyric" | "fuzzy" | "manual";
  updatedAt: string;
};

export type CancioneroTimingEntry = {
  /** Cue startMs taught by the operator (same order as packed karaoke cues). */
  cueStarts: number[];
  updatedAt: string;
};

type MemoryFile = {
  version: 1;
  /** yt:<videoId> | asset:<assetId> → song */
  byMedia: Record<string, CancioneroMemoryEntry>;
  /** normalized primary title → song */
  byTitle: Record<string, CancioneroMemoryEntry>;
  /** yt:<videoId> | asset:<assetId> → taught cue starts */
  timingByMedia?: Record<string, CancioneroTimingEntry>;
};

const EMPTY: MemoryFile = {
  version: 1,
  byMedia: {},
  byTitle: {},
  timingByMedia: {},
};

/**
 * Tracked in git (`apps/hub/seed/…`) so operator teach/nudge learning
 * can be committed and shared. Legacy `data/cancionero-memory.json` is
 * still read once to migrate older local sessions.
 */
function memoryPath(): string {
  return path.join(
    promediaRoot(),
    "apps",
    "hub",
    "seed",
    "cancionero-memory.json",
  );
}

function legacyMemoryPath(): string {
  return path.join(promediaRoot(), "data", "cancionero-memory.json");
}

let cache: MemoryFile | null = null;
let writeChain: Promise<void> = Promise.resolve();

function validMemory(parsed: MemoryFile | undefined): MemoryFile | null {
  if (parsed?.version === 1 && parsed.byMedia && parsed.byTitle) {
    return { ...parsed, timingByMedia: parsed.timingByMedia ?? {} };
  }
  return null;
}

async function loadMemory(): Promise<MemoryFile> {
  if (cache) return cache;
  // A corrupt seed is quarantined + logged by readJsonFile (never silently reset).
  const seeded = await readJsonFile<MemoryFile>(memoryPath(), "Memoria del cancionero");
  if (seeded.status === "ok") {
    const ok = validMemory(seeded.value);
    if (ok) {
      cache = ok;
      return cache;
    }
    console.warn("[hub] Memoria del cancionero: formato desconocido, se ignora.");
  }
  const legacy = await readJsonFile<MemoryFile>(legacyMemoryPath(), "Memoria del cancionero (data/)");
  if (legacy.status === "ok") {
    const ok = validMemory(legacy.value);
    if (ok) {
      cache = ok;
      // Persist into the tracked seed path so it can be committed.
      void saveMemory(ok).catch((err) =>
        console.warn(
          "[hub] no se pudo copiar la memoria legada al seed:",
          err instanceof Error ? err.message : err,
        ),
      );
      return cache;
    }
  }
  cache = { ...EMPTY, byMedia: {}, byTitle: {}, timingByMedia: {} };
  return cache;
}

async function saveMemory(next: MemoryFile): Promise<void> {
  cache = next;
  // A failed write must not wedge the chain: later saves still run.
  writeChain = writeChain
    .catch(() => undefined)
    .then(() => writeJsonAtomic(memoryPath(), next));
  await writeChain;
}

export function cancioneroMediaKey(options: {
  youtubeVideoId?: string | null;
  assetId?: string | null;
}): string | null {
  const yt = options.youtubeVideoId?.trim();
  if (yt) return `yt:${yt}`;
  const asset = options.assetId?.trim();
  if (asset) return `asset:${asset}`;
  return null;
}

export async function recallCancioneroByMedia(
  mediaKey: string | null | undefined,
): Promise<CancioneroMemoryEntry | null> {
  if (!mediaKey) return null;
  const mem = await loadMemory();
  return mem.byMedia[mediaKey] ?? null;
}

export async function recallCancioneroByTitles(
  titles: string[],
): Promise<CancioneroMemoryEntry | null> {
  const mem = await loadMemory();
  for (const raw of titles) {
    const primary = normalizeMatchTitle(primaryTitleSegment(raw) || raw);
    if (!primary) continue;
    const hit = mem.byTitle[primary];
    if (hit) return hit;
  }
  return null;
}

export async function rememberCancioneroMatch(options: {
  mediaKey?: string | null;
  titles?: string[];
  songId: string;
  songTitle: string;
  source: CancioneroMemoryEntry["source"];
}): Promise<void> {
  const mem = await loadMemory();
  const entry: CancioneroMemoryEntry = {
    songId: options.songId,
    songTitle: options.songTitle,
    source: options.source,
    updatedAt: new Date().toISOString(),
  };
  const byMedia = { ...mem.byMedia };
  const byTitle = { ...mem.byTitle };
  if (options.mediaKey) {
    byMedia[options.mediaKey] = entry;
  }
  for (const raw of options.titles ?? []) {
    const primary = normalizeMatchTitle(primaryTitleSegment(raw) || raw);
    if (primary && primary.length >= 3) {
      byTitle[primary] = entry;
    }
  }
  await saveMemory({
    version: 1,
    byMedia,
    byTitle,
    timingByMedia: mem.timingByMedia ?? {},
  });
}

export async function recallCancioneroTiming(
  mediaKey: string | null | undefined,
): Promise<CancioneroTimingEntry | null> {
  if (!mediaKey) return null;
  const mem = await loadMemory();
  return mem.timingByMedia?.[mediaKey] ?? null;
}

/** Persist operator-taught cue start times for this media. */
export async function rememberCancioneroTiming(options: {
  mediaKey: string;
  cueStarts: number[];
}): Promise<void> {
  const key = options.mediaKey.trim();
  if (!key || options.cueStarts.length === 0) return;
  const mem = await loadMemory();
  const timingByMedia = { ...(mem.timingByMedia ?? {}) };
  timingByMedia[key] = {
    cueStarts: options.cueStarts.map((ms) => Math.max(0, Math.round(ms))),
    updatedAt: new Date().toISOString(),
  };
  await saveMemory({
    version: 1,
    byMedia: mem.byMedia,
    byTitle: mem.byTitle,
    timingByMedia,
  });
}

/** Drop taught cue clocks for this media (fresh align before each song). */
export async function forgetCancioneroTiming(
  mediaKey: string | null | undefined,
): Promise<void> {
  const key = mediaKey?.trim();
  if (!key) return;
  const mem = await loadMemory();
  if (!mem.timingByMedia?.[key]) return;
  const timingByMedia = { ...mem.timingByMedia };
  delete timingByMedia[key];
  await saveMemory({
    version: 1,
    byMedia: mem.byMedia,
    byTitle: mem.byTitle,
    timingByMedia,
  });
}

/**
 * Apply remembered starts onto aligned cues when counts match (or nearly).
 * Keeps cue text; only rewrites start/end clocks.
 */
export function applyRememberedCueStarts<
  T extends { startMs: number; endMs: number },
>(cues: T[], remembered: number[] | null | undefined): T[] {
  if (!remembered || remembered.length === 0 || cues.length === 0) {
    return cues;
  }
  // Same pack length, or within ±1 (pack regrouping edge).
  if (Math.abs(remembered.length - cues.length) > 1) {
    return cues;
  }
  const n = cues.length;
  const starts = cues.map((c, i) => {
    const taught = remembered[Math.min(i, remembered.length - 1)];
    return typeof taught === "number" && Number.isFinite(taught)
      ? Math.max(0, Math.round(taught))
      : c.startMs;
  });
  for (let i = 1; i < n; i++) {
    if (starts[i]! < starts[i - 1]! + 400) {
      starts[i] = starts[i - 1]! + 400;
    }
  }
  return cues.map((c, i) => {
    const startMs = starts[i]!;
    const nextStart = i + 1 < n ? starts[i + 1]! : startMs + Math.max(800, c.endMs - c.startMs);
    // Keep last-word end when present; else hold until just before next line.
    let endMs =
      Number.isFinite(c.endMs) && c.endMs > startMs + 400
        ? Math.round(c.endMs)
        : nextStart - 40;
    endMs = Math.max(startMs + 500, endMs);
    if (i + 1 < n) endMs = Math.min(endMs, Math.max(startMs + 500, nextStart - 40));
    return { ...c, startMs, endMs };
  });
}
