import type {
  TextAlign,
  TextPayload,
  TextPlaylistItem,
  TextSlide,
} from "@promedia/shared";
import {
  resolveLinesPerSlide,
  resolveProjectionTextSlides,
} from "@promedia/shared";

const ALIGNS: ReadonlySet<TextAlign> = new Set(["left", "center", "right"]);

export function isTextSlide(value: unknown): value is TextSlide {
  if (!value || typeof value !== "object") {
    return false;
  }
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    s.id.length > 0 &&
    Array.isArray(s.lines) &&
    s.lines.every((line) => typeof line === "string")
  );
}

export function isTextPayload(value: unknown): value is TextPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const p = value as Record<string, unknown>;
  if (!Array.isArray(p.slides) || p.slides.length < 1) {
    return false;
  }
  if (!p.slides.every(isTextSlide)) {
    return false;
  }
  if (p.title !== undefined && typeof p.title !== "string") {
    return false;
  }
  if (p.align !== undefined && !ALIGNS.has(p.align as TextAlign)) {
    return false;
  }
  if (p.chunkLines !== undefined && typeof p.chunkLines !== "boolean") {
    return false;
  }
  if (
    p.linesPerSlide !== undefined &&
    (typeof p.linesPerSlide !== "number" || !Number.isFinite(p.linesPerSlide))
  ) {
    return false;
  }
  return true;
}

export function isTextPlaylistItem(value: unknown): value is TextPlaylistItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    item.type === "text" &&
    typeof item.order === "number" &&
    Number.isFinite(item.order) &&
    isTextPayload(item.payload)
  );
}

export function normalizeTextPayload(payload: TextPayload): TextPayload {
  const mapped = payload.slides.map((slide) => ({
    id: slide.id,
    lines: slide.lines.map((line) => String(line)),
  }));
  const title = payload.title?.trim() ? payload.title.trim() : undefined;
  const align = payload.align ?? "center";
  // Songs keep ONE lyric block (blank lines = phrase ends) and are paged at
  // projection time by `linesPerSlide`.
  if (payload.linesPerSlide !== undefined) {
    return {
      title,
      align,
      slides: mapped.length > 0 ? mapped : [{ id: "lyrics", lines: [""] }],
      linesPerSlide: resolveLinesPerSlide(payload.linesPerSlide),
    };
  }
  // `chunkLines: false` (legacy songs) is dropped: slides are re-split into
  // one blank-line-separated phrase each.
  const slides = resolveProjectionTextSlides({ slides: mapped });
  return { title, align, slides };
}

export function createEmptyTextPayload(title = ""): TextPayload {
  return {
    title: title || undefined,
    align: "center",
    slides: [{ id: cryptoRandomId(), lines: [""] }],
  };
}

export function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
