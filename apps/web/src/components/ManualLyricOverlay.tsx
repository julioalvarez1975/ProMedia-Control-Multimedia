import type { CSSProperties } from "react";
import { FittedTextStage } from "@promedia/item-types";
import type { SubtitleFontSize, TransitionEffect } from "@promedia/shared";
import {
  DEFAULT_TRANSITION_EFFECT,
  isSubtitleFontSize,
  LYRIC_OVERLAY_MAX_LINES,
  TRANSITION_DURATION_MS,
  transitionCssId,
} from "@promedia/shared";
import { lyricOverlayDisplayLines } from "./SubtitleOverlay";

const FIT_BY_SIZE: Record<
  SubtitleFontSize,
  { heightFrac: number; widthFrac: number; hardCapPx: number }
> = {
  sm: { heightFrac: 0.58, widthFrac: 0.34, hardCapPx: 320 },
  md: { heightFrac: 0.7, widthFrac: 0.37, hardCapPx: 400 },
  lg: { heightFrac: 0.8, widthFrac: 0.4, hardCapPx: 500 },
  xl: { heightFrac: 0.85, widthFrac: 0.44, hardCapPx: 580 },
};

export type ManualLyricOverlayProps = {
  /** The cancionero row to show. Empty hides the overlay. */
  line: string | null;
  fontSize?: SubtitleFontSize;
  transitionEffect?: TransitionEffect;
};

/**
 * One cancionero line, same stage look as karaoke, but the operator chooses
 * the moment. Sits over the live video or the stage background.
 */
export function ManualLyricOverlay({
  line,
  fontSize = "xl",
  transitionEffect = DEFAULT_TRANSITION_EFFECT,
}: ManualLyricOverlayProps) {
  const text = line?.trim() ?? "";
  if (!text) {
    return null;
  }
  const size = isSubtitleFontSize(fontSize) ? fontSize : "xl";
  const fit = FIT_BY_SIZE[size];
  const effect = transitionEffect || DEFAULT_TRANSITION_EFFECT;
  const displayLines = lyricOverlayDisplayLines(text);
  const txClass =
    effect !== "none"
      ? ` pm-tx pm-tx-${transitionCssId(effect)}`
      : " subtitle-overlay-cue--reel";
  const cueStyle =
    effect !== "none"
      ? ({ "--pm-tx-ms": `${TRANSITION_DURATION_MS}ms` } as CSSProperties)
      : undefined;

  return (
    <div
      className="subtitle-overlay subtitle-overlay--reel"
      data-size={size}
      data-motion="reel"
      data-tx={effect}
      data-cue={text}
      aria-live="polite"
    >
      <div key={text} className={`subtitle-overlay-cue${txClass}`} style={cueStyle}>
        <FittedTextStage
          lines={displayLines}
          lineKey={`${text}-${size}`}
          className="subtitle-overlay-fit text-output"
          lineClassName="text-output-line"
          heightFrac={fit.heightFrac}
          widthFrac={fit.widthFrac}
          hardCapPx={fit.hardCapPx}
          maxLines={LYRIC_OVERLAY_MAX_LINES}
        />
      </div>
    </div>
  );
}
