/**
 * Persistent watermark file (image, animated image or short video), independent
 * of the venue logo. Survives sessions — stored under data/branding/ next to the
 * logo but in its own files.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promediaRoot } from "./subtitle-paths.js";

/** Watermarks are small corner marks; keep them light for LAN Output. */
export const WATERMARK_MAX_BYTES = 16 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/apng",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
]);

export type WatermarkMeta = {
  mime: string;
  updatedAt: string;
  originalName?: string;
  size: number;
};

let cachedMeta: WatermarkMeta | null = null;
let cacheReady = false;

function dir(): string {
  return process.env.PROMEDIA_BRANDING_DIR?.trim()
    ? process.env.PROMEDIA_BRANDING_DIR.trim()
    : path.join(promediaRoot(), "data", "branding");
}
const binPath = () => path.join(dir(), "watermark.bin");
const metaPath = () => path.join(dir(), "watermark.meta.json");

function normalizeMime(raw: string): string | null {
  const mime = String(raw || "").trim().toLowerCase();
  const fixed = mime === "image/jpg" ? "image/jpeg" : mime;
  return ALLOWED_MIME.has(fixed) ? fixed : null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function refreshWatermarkCache(): Promise<WatermarkMeta | null> {
  cacheReady = true;
  try {
    if (!(await exists(metaPath())) || !(await exists(binPath()))) {
      cachedMeta = null;
      return null;
    }
    const parsed = JSON.parse(await readFile(metaPath(), "utf8")) as Partial<WatermarkMeta>;
    if (!parsed?.mime || !parsed?.updatedAt) {
      cachedMeta = null;
      return null;
    }
    cachedMeta = {
      mime: parsed.mime,
      updatedAt: parsed.updatedAt,
      originalName: parsed.originalName,
      size: parsed.size ?? 0,
    };
    return cachedMeta;
  } catch {
    cachedMeta = null;
    return null;
  }
}

/** In-memory stamps for new sessions (null until refresh / put). */
export function getWatermarkMeta(): WatermarkMeta | null {
  return cachedMeta;
}

export async function getWatermark(): Promise<{ bytes: Buffer; meta: WatermarkMeta } | null> {
  if (!cacheReady) await refreshWatermarkCache();
  if (!cachedMeta) return null;
  try {
    const bytes = await readFile(binPath());
    return bytes.byteLength ? { bytes, meta: cachedMeta } : null;
  } catch {
    return null;
  }
}

export async function putWatermark(opts: {
  bytes: Buffer;
  mime: string;
  originalName?: string;
}): Promise<WatermarkMeta | { error: string }> {
  const mime = normalizeMime(opts.mime);
  if (!mime) return { error: "unsupported_mime" };
  if (!opts.bytes.byteLength) return { error: "empty_file" };
  if (opts.bytes.byteLength > WATERMARK_MAX_BYTES) return { error: "file_too_large" };
  await mkdir(dir(), { recursive: true });
  const meta: WatermarkMeta = {
    mime,
    updatedAt: new Date().toISOString(),
    originalName: opts.originalName?.trim() || undefined,
    size: opts.bytes.byteLength,
  };
  await writeFile(binPath(), opts.bytes);
  await writeFile(metaPath(), `${JSON.stringify({ version: 1, ...meta }, null, 2)}\n`, "utf8");
  cachedMeta = meta;
  cacheReady = true;
  return meta;
}

/** Boot: create folder + load meta if present. */
export async function initWatermarkStore(): Promise<WatermarkMeta | null> {
  await mkdir(dir(), { recursive: true });
  return refreshWatermarkCache();
}
