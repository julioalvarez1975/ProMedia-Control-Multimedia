/**
 * Disk persistence of finished karaoke results — one file per song.
 * YouTube videos are keyed by video id (`yt_<id>`); local audio/video by a
 * content hash (`fh_<sha1>`), so the same file re-uploaded in a later session
 * (asset ids are random per upload) is recognised and restored instantly.
 *
 * The in-memory per-item cache dies with the hub (every restart). Aligning a
 * song without official captions costs 60–90 s (WhisperX on CPU), so the
 * result is also saved under `data/subtitles/aligned/` and restored instantly
 * the next time the same video is added, even after a restart.
 *
 * Only results backed by a known lyric source (cancionero song or LRCLIB) are
 * persisted: a stale ASR transcript must never shadow a song added later.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubtitleAgentState, SubtitleTargetLang } from "@promedia/shared";
import { subtitleDataRoot } from "./subtitle-paths.js";

/**
 * Version of the PROCEDURE that produces a saved result. Bump it whenever the
 * alignment / timing logic changes in a way that makes old results wrong: every
 * file saved with another version is ignored and deleted at hub start
 * (`purgeStaleAlignedCache`), and the song is calculated again.
 *   1 → 2: results made before per-row background jobs, faster-whisper and the
 *          voice-anchor diagnostics (e.g. out-of-sync "El Gran Yo Soy").
 */
export const ALIGNED_CACHE_VERSION = 2;
const VERSION = ALIGNED_CACHE_VERSION;
/** `yt_<videoId>` or `fh_<sha1 of the local file>`. */
const SAFE_KEY = /^(?:yt_[A-Za-z0-9_-]{6,20}|fh_[0-9a-f]{40})$/;
const HASH_HEAD_BYTES = 4 * 1024 * 1024;
const WRITE_DEBOUNCE_MS = 400;

export type PersistSource = "cancionero" | "lrclib";

export type PersistMeta = {
  /** Biblioteca song id, or `lrclib:<id>` for LRCLIB lyrics. */
  songId: string;
  /** Hash of the exact lines the cues were built from. */
  lyricsHash: string;
  source: PersistSource;
  /** LRCLIB only: lets "Guardar letra" work after a restart. */
  lrclibSong?: { title: string; artist?: string; lines: string[] };
};

export type PersistedAgent = {
  version: number;
  /** Cache key of the song (`yt_…` / `fh_…`), see resolveCacheKey. */
  fileKey: string;
  targetLang: SubtitleTargetLang;
  songId: string;
  lyricsHash: string;
  source: PersistSource;
  lrclibSong?: PersistMeta["lrclibSong"];
  savedAt: string;
  agent: Pick<
    SubtitleAgentState,
    | "cues"
    | "hint"
    | "timingMode"
    | "sourceLang"
    | "translated"
    | "lyricsSource"
  >;
};

export function lyricsHash(lines: readonly string[]): string {
  return createHash("sha1")
    .update(lines.map((l) => String(l).trim()).filter(Boolean).join("\n"))
    .digest("hex");
}

const metaByAsset = new Map<string, PersistMeta>();
/** Session asset id → stable cache key (filled by resolveCacheKey). */
const keyByAsset = new Map<string, string>();
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Payloads waiting for the debounce; flushed on shutdown / session end. */
const pendingWrites = new Map<string, PersistedAgent>();

async function writePersisted(file: string, payload: PersistedAgent): Promise<void> {
  try {
    await mkdir(alignedDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), "utf8");
    await rename(tmp, file);
  } catch (err) {
    console.warn(
      "[subtitle] aligned cache save failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Write every pending result now (hub shutdown / session closed). */
export async function flushPersistedAgents(): Promise<void> {
  const entries = [...pendingWrites.entries()];
  pendingWrites.clear();
  for (const t of writeTimers.values()) clearTimeout(t);
  writeTimers.clear();
  await Promise.all(entries.map(([file, payload]) => writePersisted(file, payload)));
}

function alignedDir(): string {
  return path.join(subtitleDataRoot(), "aligned");
}

function fileFor(assetId: string, targetLang: string): string | null {
  if (!SAFE_KEY.test(assetId) || !/^[A-Za-z-]{2,10}$/.test(targetLang)) {
    return null;
  }
  return path.join(alignedDir(), `${assetId}.${targetLang}.json`);
}

/**
 * Stable per-song key: `yt_<id>` as-is; a local file is hashed (first 4 MB +
 * size — fast, and unique enough for media files). Remembered per asset id so
 * the synchronous persist path can find it.
 */
export async function resolveCacheKey(
  assetId: string,
  mediaPath: string | null,
): Promise<string | null> {
  const known = keyByAsset.get(assetId);
  if (known) return known;
  if (SAFE_KEY.test(assetId)) {
    keyByAsset.set(assetId, assetId);
    return assetId;
  }
  if (!mediaPath) return null;
  try {
    const size = (await stat(mediaPath)).size;
    const fh = await open(mediaPath, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, HASH_HEAD_BYTES));
      await fh.read(buf, 0, buf.length, 0);
      const key = `fh_${createHash("sha1").update(buf).update(String(size)).digest("hex")}`;
      keyByAsset.set(assetId, key);
      return key;
    } finally {
      await fh.close();
    }
  } catch (err) {
    console.warn(
      "[subtitle] could not hash media for the aligned cache:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Test hook. */
export function cacheKeyOf(assetId: string): string | null {
  return keyByAsset.get(assetId) ?? (SAFE_KEY.test(assetId) ? assetId : null);
}

/** The job declares what the cues are built from, right before publishing. */
export function setPersistMeta(assetId: string, meta: PersistMeta): void {
  metaByAsset.set(assetId, meta);
}

export function clearPersistMeta(assetId: string): void {
  metaByAsset.delete(assetId);
}

export function getPersistMeta(assetId: string): PersistMeta | undefined {
  return metaByAsset.get(assetId);
}

/** Write-behind save when the agent holds finished, source-backed cues. */
export function persistReadyAgent(
  agent: SubtitleAgentState | null | undefined,
): void {
  if (
    !agent ||
    agent.status !== "ready" ||
    !agent.assetId ||
    agent.cues.length === 0
  ) {
    return;
  }
  const meta = metaByAsset.get(agent.assetId);
  const key = cacheKeyOf(agent.assetId);
  const file = key ? fileFor(key, agent.targetLang) : null;
  if (!meta || !key || !file) return;

  const payload: PersistedAgent = {
    version: VERSION,
    fileKey: key,
    targetLang: agent.targetLang,
    songId: meta.songId,
    lyricsHash: meta.lyricsHash,
    source: meta.source,
    lrclibSong: meta.lrclibSong,
    savedAt: new Date().toISOString(),
    agent: {
      cues: agent.cues.map((c) => ({ ...c })),
      hint: agent.hint,
      timingMode: agent.timingMode,
      sourceLang: agent.sourceLang,
      translated: agent.translated,
      lyricsSource: agent.lyricsSource ?? meta.source,
    },
  };

  const prev = writeTimers.get(file);
  if (prev) clearTimeout(prev);
  pendingWrites.set(file, payload);
  writeTimers.set(
    file,
    setTimeout(() => {
      writeTimers.delete(file);
      const pending = pendingWrites.get(file);
      pendingWrites.delete(file);
      if (pending) void writePersisted(file, pending);
    }, WRITE_DEBOUNCE_MS),
  );
}

export async function loadPersistedAgent(
  fileKey: string,
  targetLang: SubtitleTargetLang,
): Promise<PersistedAgent | null> {
  const file = fileFor(fileKey, targetLang);
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as PersistedAgent;
    if (
      parsed?.version !== VERSION ||
      parsed.fileKey !== fileKey ||
      parsed.targetLang !== targetLang ||
      !Array.isArray(parsed.agent?.cues) ||
      parsed.agent.cues.length === 0
    ) {
      return null;
    }
    const healthy = parsed.agent.cues.every(
      (c) =>
        Number.isFinite(c.startMs) &&
        Number.isFinite(c.endMs) &&
        c.endMs > c.startMs &&
        Boolean(String(c.text ?? "").trim()),
    );
    return healthy ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Delete saved results from an older procedure (or unreadable ones) so they are
 * recalculated. Returns how many files were removed.
 */
export async function purgeStaleAlignedCache(): Promise<number> {
  let names: string[];
  try {
    names = await readdir(alignedDir());
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(alignedDir(), name);
    let stale = false;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { version?: unknown };
      stale = parsed?.version !== VERSION;
    } catch {
      stale = true;
    }
    if (stale) {
      await rm(file, { force: true }).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}

/** Forget a video (operator taught another song, lyrics changed…). */
export async function forgetPersistedAgent(assetId: string): Promise<void> {
  const key = cacheKeyOf(assetId) ?? assetId;
  metaByAsset.delete(assetId);
  if (!SAFE_KEY.test(key)) return;
  try {
    const names = await readdir(alignedDir());
    await Promise.all(
      names
        .filter((n) => n.startsWith(`${key}.`))
        .map((n) => rm(path.join(alignedDir(), n), { force: true })),
    );
  } catch {
    // nothing saved yet
  }
}
