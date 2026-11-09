/**
 * Persistent church / venue logo for sceneMode "logo".
 * Survives sessions — stored under data/branding/ (gitignored).
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promediaRoot } from "./subtitle-paths.js";

/** Soft cap — projection logos should stay light for LAN Output. */
export const BRANDING_LOGO_MAX_BYTES = 8 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

export type BrandingLogoMeta = {
  mime: string;
  updatedAt: string;
  originalName?: string;
  size: number;
};

type MetaFile = {
  version: 1;
  mime: string;
  updatedAt: string;
  originalName?: string;
  size: number;
};

let cachedMeta: BrandingLogoMeta | null = null;
let cacheReady = false;

function brandingDir(): string {
  return path.join(promediaRoot(), "data", "branding");
}

function logoBinPath(): string {
  return path.join(brandingDir(), "logo.bin");
}

function logoMetaPath(): string {
  return path.join(brandingDir(), "logo.meta.json");
}

function normalizeMime(raw: string): string | null {
  const mime = String(raw || "")
    .trim()
    .toLowerCase();
  if (mime === "image/jpg") {
    return "image/jpeg";
  }
  return ALLOWED_MIME.has(mime) ? mime : null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureBrandingLayout(): Promise<string> {
  const dir = brandingDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function refreshBrandingLogoCache(): Promise<BrandingLogoMeta | null> {
  try {
    if (!(await pathExists(logoMetaPath())) || !(await pathExists(logoBinPath()))) {
      cachedMeta = null;
      cacheReady = true;
      return null;
    }
    const raw = await readFile(logoMetaPath(), "utf8");
    const parsed = JSON.parse(raw) as MetaFile;
    if (!parsed?.mime || !parsed?.updatedAt) {
      cachedMeta = null;
      cacheReady = true;
      return null;
    }
    cachedMeta = {
      mime: parsed.mime,
      updatedAt: parsed.updatedAt,
      originalName: parsed.originalName,
      size: parsed.size ?? 0,
    };
    cacheReady = true;
    return cachedMeta;
  } catch {
    cachedMeta = null;
    cacheReady = true;
    return null;
  }
}

/** In-memory stamp for new sessions (null until refresh/put). */
export function getBrandingLogoUpdatedAt(): string | null {
  return cachedMeta?.updatedAt ?? null;
}

export function getBrandingLogoMeta(): BrandingLogoMeta | null {
  return cachedMeta;
}

export async function getBrandingLogo(): Promise<{
  bytes: Buffer;
  meta: BrandingLogoMeta;
} | null> {
  if (!cacheReady) {
    await refreshBrandingLogoCache();
  }
  if (!cachedMeta) {
    return null;
  }
  try {
    const bytes = await readFile(logoBinPath());
    if (!bytes.byteLength) {
      return null;
    }
    return { bytes, meta: cachedMeta };
  } catch {
    return null;
  }
}

export async function putBrandingLogo(opts: {
  bytes: Buffer;
  mime: string;
  originalName?: string;
}): Promise<BrandingLogoMeta | { error: string }> {
  const mime = normalizeMime(opts.mime);
  if (!mime) {
    return { error: "unsupported_mime" };
  }
  if (!opts.bytes.byteLength) {
    return { error: "empty_file" };
  }
  if (opts.bytes.byteLength > BRANDING_LOGO_MAX_BYTES) {
    return { error: "file_too_large" };
  }

  await ensureBrandingLayout();
  const meta: BrandingLogoMeta = {
    mime,
    updatedAt: new Date().toISOString(),
    originalName: opts.originalName?.trim() || undefined,
    size: opts.bytes.byteLength,
  };
  const disk: MetaFile = {
    version: 1,
    mime: meta.mime,
    updatedAt: meta.updatedAt,
    originalName: meta.originalName,
    size: meta.size,
  };
  await writeFile(logoBinPath(), opts.bytes);
  await writeFile(logoMetaPath(), `${JSON.stringify(disk, null, 2)}\n`, "utf8");
  cachedMeta = meta;
  cacheReady = true;
  return meta;
}

/** Boot: create folder + load meta if present. */
export async function initBrandingStore(): Promise<BrandingLogoMeta | null> {
  await ensureBrandingLayout();
  return refreshBrandingLogoCache();
}
