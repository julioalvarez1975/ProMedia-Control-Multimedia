import { useEffect, useState } from "react";
import type { PlaylistItem, TextPayload } from "@promedia/shared";
import { resolveProjectionTextSlides } from "@promedia/shared";
import { FittedTextStage } from "./FittedTextStage.js";

export type TextPreviewProps = {
  item: PlaylistItem;
  slideIndex: number;
  onSlideIndexChange?: (index: number) => void;
};

function ChevronLeftIcon() {
  return (
    <svg
      className="text-preview-nav-icon"
      width="22"
      height="22"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      className="text-preview-nav-icon"
      width="22"
      height="22"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708"
      />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg
      className="text-preview-nav-icon"
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5"
      />
    </svg>
  );
}

/** Preview uses the same theme CSS vars + fit path as Output. */
export function TextPreview({
  item,
  slideIndex,
  onSlideIndexChange,
}: TextPreviewProps) {
  const payload = item.payload as TextPayload;
  const slides = resolveProjectionTextSlides(payload);
  const total = slides.length;
  const index = Math.min(Math.max(slideIndex, 0), Math.max(total - 1, 0));
  const slide = slides[index];
  const lines = slide?.lines ?? [""];
  const showNav = Boolean(onSlideIndexChange) && total > 1;
  const canPrev = showNav && index > 0;
  const canNext = showNav && index < total - 1;
  // Full lyrics: scrollable list of every phrase (stage only fits one slide).
  const [showAll, setShowAll] = useState(false);
  const canShowAll = total > 1;
  useEffect(() => {
    setShowAll(false);
  }, [item.id]);

  return (
    <div className="text-preview" data-has-slide-nav={showNav ? "1" : undefined}>
      {canShowAll ? (
        <button
          type="button"
          className="text-preview-lyrics-toggle"
          aria-pressed={showAll}
          aria-label="Lyrics"
          title="Lyrics / Letra"
          onClick={() => setShowAll((v) => !v)}
        >
          <ListIcon />
        </button>
      ) : null}
      {canShowAll && showAll ? (
        <div className="text-preview-lyrics" role="list">
          {slides.map((s, i) => (
            <button
              type="button"
              key={s.id}
              role="listitem"
              className="text-preview-lyrics-slide"
              data-current={i === index ? "1" : undefined}
              onClick={() => {
                onSlideIndexChange?.(i);
                setShowAll(false);
              }}
            >
              <span className="text-preview-lyrics-num">{i + 1}</span>
              <span className="text-preview-lyrics-lines">
                {s.lines.join("\n")}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {showNav ? (
        <button
          type="button"
          className="text-preview-nav text-preview-nav-prev"
          disabled={!canPrev}
          aria-label="Previous"
          title="Previous"
          onClick={() => onSlideIndexChange?.(index - 1)}
        >
          <ChevronLeftIcon />
        </button>
      ) : null}
      <FittedTextStage
        lines={lines}
        lineKey={slide?.id ?? `prev-${index}`}
        className="text-stage"
        lineClassName="text-line"
      />
      {showNav ? (
        <button
          type="button"
          className="text-preview-nav text-preview-nav-next"
          disabled={!canNext}
          aria-label="Next"
          title="Next"
          onClick={() => onSlideIndexChange?.(index + 1)}
        >
          <ChevronRightIcon />
        </button>
      ) : null}
    </div>
  );
}
