/**
 * Disk persistence of finished karaoke results (YouTube videos only).
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
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubtitleAgentState, SubtitleTargetLang } from "@promedia/shared";
import { subtitleDataRoot } from "./subtitle-paths.js";

const VERSION = 1;
const SAFE_ASSET = /^yt_[A-Za-z0-9_-]{6,20}$/;
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
  assetId: string;
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
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function alignedDir(): string {
  return path.join(subtitleDataRoot(), "aligned");
}

function fileFor(assetId: string, targetLang: string): string | null {
  if (!SAFE_ASSET.test(assetId) || !/^[A-Za-z-]{2,10}$/.test(targetLang)) {
    return null;
  }
  return path.join(alignedDir(), `${assetId}.${targetLang}.json`);
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
  const file = fileFor(agent.assetId, agent.targetLang);
  if (!meta || !file) return;

  const payload: PersistedAgent = {
    version: VERSION,
    assetId: agent.assetId,
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
  writeTimers.set(
    file,
    setTimeout(() => {
      writeTimers.delete(file);
      void (async () => {
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
      })();
    }, WRITE_DEBOUNCE_MS),
  );
}

export async function loadPersistedAgent(
  assetId: string,
  targetLang: SubtitleTargetLang,
): Promise<PersistedAgent | null> {
  const file = fileFor(assetId, targetLang);
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as PersistedAgent;
    if (
      parsed?.version !== VERSION ||
      parsed.assetId !== assetId ||
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

/** Forget a video (operator taught another song, lyrics changed…). */
export async function forgetPersistedAgent(assetId: string): Promise<void> {
  metaByAsset.delete(assetId);
  if (!SAFE_ASSET.test(assetId)) return;
  try {
    const names = await readdir(alignedDir());
    await Promise.all(
      names
        .filter((n) => n.startsWith(`${assetId}.`))
        .map((n) => rm(path.join(alignedDir(), n), { force: true })),
    );
  } catch {
    // nothing saved yet
  }
}
