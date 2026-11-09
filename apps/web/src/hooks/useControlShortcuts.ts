import { useEffect } from "react";
import type { SceneMode, ThemeId } from "@promedia/shared";

export type ControlShortcutHandlers = {
  goLive?: () => void;
  setSceneMode?: (mode: SceneMode) => void;
  setTheme?: (themeId: ThemeId) => void;
  prevSlide?: () => void;
  nextSlide?: () => void;
  openOutput?: () => void;
  enabled?: boolean;
};

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) {
    return false;
  }
  if (el.isContentEditable) {
    return true;
  }
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (tag !== "INPUT") {
    return false;
  }
  // Range / checkbox / buttons must NOT swallow ←/→ (karaoke + slides).
  const type = ((el as HTMLInputElement).type || "text").toLowerCase();
  return (
    type === "text" ||
    type === "search" ||
    type === "email" ||
    type === "password" ||
    type === "url" ||
    type === "tel" ||
    type === "number"
  );
}

/**
 * MVP keyboard map (subtarea 11). Ignored while typing in inputs.
 *
 * G — Go Live · O — Abrir salida
 * 1/2/3 — tema Oscuro/Claro/Acento
 * L / B / C / N — logo / black / clear / normal
 * ← / → — slide prev/next (texto live)
 */
export function useControlShortcuts(handlers: ControlShortcutHandlers): void {
  const {
    goLive,
    setSceneMode,
    setTheme,
    prevSlide,
    nextSlide,
    openOutput,
    enabled = true,
  } = handlers;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      if (isTypingTarget(e.target)) {
        return;
      }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      switch (key) {
        case "g":
          e.preventDefault();
          goLive?.();
          break;
        case "o":
          e.preventDefault();
          openOutput?.();
          break;
        case "l":
          e.preventDefault();
          setSceneMode?.("logo");
          break;
        case "b":
          e.preventDefault();
          setSceneMode?.("black");
          break;
        case "c":
          e.preventDefault();
          setSceneMode?.("clear");
          break;
        case "n":
        case "Escape":
          e.preventDefault();
          setSceneMode?.("normal");
          break;
        case "1":
          e.preventDefault();
          setTheme?.("oscuro");
          break;
        case "2":
          e.preventDefault();
          setTheme?.("claro");
          break;
        case "3":
          e.preventDefault();
          setTheme?.("acento");
          break;
        case "ArrowLeft":
          e.preventDefault();
          prevSlide?.();
          break;
        case "ArrowRight":
          e.preventDefault();
          nextSlide?.();
          break;
        default:
          break;
      }
    };
    // Capture phase so ←/→ still reach karaoke when a range/scrubber has focus.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    enabled,
    goLive,
    setSceneMode,
    setTheme,
    prevSlide,
    nextSlide,
    openOutput,
  ]);
}
