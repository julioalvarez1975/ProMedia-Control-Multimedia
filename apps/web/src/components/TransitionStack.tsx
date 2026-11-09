import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  TRANSITION_DURATION_MS,
  transitionCssId,
  type TransitionEffect,
} from "@promedia/shared";

type Layer = {
  key: string;
  node: ReactNode;
  /** Playing the reversed effect before being removed. */
  leaving: boolean;
};

export type TransitionStackProps = {
  /** Effect chosen in "Efectos". `none` = instant. */
  effect: TransitionEffect;
  /** What is shown now (null = nothing). A new key plays the effect again. */
  layerKey: string | null;
  /** Content of the current layer. */
  node: ReactNode;
  /** Stacking order on the stage (default 5 = scene overlays; cover = 3). */
  zIndex?: number;
};

/**
 * Applies the stage transition effect to scene changes that are NOT a live
 * item swap (Logo / Vacío / Clear overlays, the video cover image):
 * - a layer entering plays the effect;
 * - changing from one layer to another plays the effect on the new one while
 *   the old stays underneath (no flash of the video in between);
 * - leaving plays the same effect in reverse, revealing what is below.
 * The player under the layers is never touched, so audio keeps playing.
 */
export function TransitionStack({
  effect,
  layerKey,
  node,
  zIndex = 5,
}: TransitionStackProps) {
  const [layers, setLayers] = useState<Layer[]>([]);
  const timers = useRef<number[]>([]);
  const latestKey = useRef<string | null>(layerKey);
  /** effect "none": no animation, drop old layers on the next tick. */
  const sweepSoon = (fn: () => void) => {
    timers.current.push(window.setTimeout(fn, 0));
  };
  const ms = effect === "none" ? 0 : TRANSITION_DURATION_MS;

  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
    },
    [],
  );

  useEffect(() => {
    // After the effect ends, keep ONLY the layer that is current at that
    // moment (an older timer must never remove a layer added later).
    const sweep = () => {
      setLayers((prev) =>
        prev.filter((l) => l.key === latestKey.current && !l.leaving),
      );
    };
    latestKey.current = layerKey;
    if (ms === 0) {
      sweepSoon(sweep);
    } else {
      const t = window.setTimeout(sweep, ms + 40);
      timers.current.push(t);
    }

    setLayers((prev) => {
      const top = prev.filter((l) => !l.leaving).at(-1);
      if (layerKey === null) {
        if (!top) return prev;
        return prev.map((l) => ({ ...l, leaving: true }));
      }
      if (top?.key === layerKey) {
        return prev.map((l) => (l === top ? { ...l, node } : l));
      }
      return [...prev, { key: layerKey, node, leaving: false }];
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerKey, effect]);

  // Keep the active layer's content fresh without replaying the effect.
  const live = layerKey === null ? null : layers.find((l) => l.key === layerKey && !l.leaving);
  const txClass =
    effect !== "none" ? ` pm-tx pm-tx-${transitionCssId(effect)}` : "";

  return (
    <>
      {layers.map((layer) => (
        <div
          key={layer.key + (layer.leaving ? ":out" : "")}
          className={`pm-tx-stack-layer${txClass}${layer.leaving ? " pm-tx-leave" : ""}`}
          style={{ "--pm-tx-ms": `${ms}ms`, zIndex } as CSSProperties}
        >
          {layer === live ? node : layer.node}
        </div>
      ))}
    </>
  );
}
