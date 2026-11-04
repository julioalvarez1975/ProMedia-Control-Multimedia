import { isSupportedTextImport } from "./textImport";

export type MediaFileKind =
  | "image"
  | "video"
  | "audio"
  | "text"
  | "presentation"
  | "unsupported";

const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".svg",
]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);
const AUDIO_EXTS = new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
]);
const PRESENTATION_EXTS = new Set([
  ".pptx",
  ".ppt",
  ".ppsx",
  ".potx",
  ".odp",
  ".pdf",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/** Detect playlist type for a dropped/picked file (same rules as legacy pickers). */
export function classifyMediaFile(file: File): MediaFileKind {
  const mime = (file.type || "").toLowerCase();
  const ext = extOf(file.name);

  if (mime.startsWith("image/") || IMAGE_EXTS.has(ext)) {
    return "image";
  }
  if (mime.startsWith("video/") || VIDEO_EXTS.has(ext)) {
    return "video";
  }
  if (mime.startsWith("audio/") || AUDIO_EXTS.has(ext)) {
    return "audio";
  }
  // PPTX/PDF → presentation slides (before plain-text PDF path).
  if (
    PRESENTATION_EXTS.has(ext) ||
    mime.includes("presentation") ||
    mime === "application/pdf" ||
    mime === "application/vnd.ms-powerpoint"
  ) {
    return "presentation";
  }
  if (isSupportedTextImport(file)) {
    return "text";
  }
  return "unsupported";
}

/**
 * Accept attribute for the unified multi-file picker / Guion drop.
 * Wildcard mime lets the OS picker show every file; ingest classifies each drop.
 */
export const UNIFIED_MEDIA_ACCEPT = "*/*";

/** Accept attribute for the Guion Audio solapa picker. */
export const AUDIO_MEDIA_ACCEPT = [
  "audio/*",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/flac",
  "audio/ogg",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
].join(",");
