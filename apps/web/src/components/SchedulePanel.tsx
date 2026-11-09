import { useRef, useState, type ReactNode } from "react";
import { useLocale } from "../locale/LocaleContext";
import type { PlaylistItem, SubtitleItemProgress } from "@promedia/shared";
import { itemLabel } from "@promedia/shared";
import {
  ScheduleTypeIcon,
  scheduleKindOf,
  type ScheduleKind,
} from "./ScheduleTypeIcon";
import {
  IconAddFiles,
  IconBible,
  IconFolderOpen,
  IconHeadphones,
  IconLibrary,
  IconMusicNote,
  IconSave,
  IconType,
  IconYoutube,
} from "./UiIcons";

export type SchedulePanelProps = {
  /** Karaoke readiness per item (percent → green at 100 = ready to project). */
  karaokeProgress?: Record<string, SubtitleItemProgress>;
  items: PlaylistItem[];
  selectedItemId: string | null;
  liveItemId: string | null;
  checkedIds: Set<string>;
  sessionReady: boolean;
  canMutate: boolean;
  uploading: boolean;
  onSelect: (id: string) => void;
  onToggleChecked: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onRemove: (id: string) => void;
  onRemoveChecked: () => void;
  onGoLive: (id: string) => void;
  onEditText: (id: string) => void;
  /** Edit bible passage (expand verse range). */
  onEditBible: (id: string) => void;
  /** Compact «+»: open native multi-file picker. */
  onAddFiles: () => void;
  /** Tab action: YouTube / generic link. */
  onAddLink: () => void;
  onAddBible: () => void;
  onAddTextBlank: () => void;
  /** Create song (library + projectable text). */
  onCreateSong: () => void;
  /** Tab action: upload music/audio files. */
  onAddAudio: () => void;
  /** Open local media library (Biblioteca). */
  onOpenLibrary: () => void;
  onOpenLoad: () => void;
  onOpenSave: () => void;
  /** External file drag onto Guion (not item reorder). */
  onFilesDropped: (files: File[]) => void;
  /** Saved playlist dialogs (icons open them). */
  saveLoadDialogs?: ReactNode;
  /** Inline text editor when creating/editing. */
  editor?: ReactNode;
};

/** Yellow rising percent; green at 100 (ready to project); red on failure. */
function KaraokePercent({
  progress,
  t,
}: {
  progress: SubtitleItemProgress;
  t: (key: string) => string;
}) {
  const state = progress.failed
    ? "failed"
    : progress.ready
      ? "ready"
      : progress.stale
        ? "stale"
        : "busy";
  const titleKey = {
    failed: "playlist.karaokeFailed",
    ready: "playlist.karaokeReady",
    stale: "playlist.karaokeStale",
    busy: "playlist.karaokeBusy",
  }[state];
  return (
    <span
      className={`schedule-karaoke-pct is-${state}`}
      title={t(titleKey)}
      data-testid="karaoke-progress"
    >
      {state === "failed" ? "!" : `${progress.percent}%`}
    </span>
  );
}

function kindLabelKey(kind: ScheduleKind): string {
  if (kind === "youtube") {
    return "itemTypes.youtube";
  }
  if (kind === "bible") {
    return "itemTypes.bible";
  }
  return `itemTypes.${kind}`;
}

/**
 * Left schedule column — denser list patterned after Quelea «Guion»
 * and EasyWorship Schedule (type icons, reorder, per-item go-live).
 * Toolbar: add solapas (action tabs) + files / load / save icons.
 */
export function SchedulePanel({
  karaokeProgress,
  items,
  selectedItemId,
  liveItemId,
  checkedIds,
  sessionReady,
  canMutate,
  uploading,
  onSelect,
  onToggleChecked,
  onReorder,
  onRemove,
  onRemoveChecked,
  onGoLive,
  onEditText,
  onEditBible,
  onAddFiles,
  onAddLink,
  onAddBible,
  onAddTextBlank,
  onCreateSong,
  onAddAudio,
  onOpenLibrary,
  onOpenLoad,
  onOpenSave,
  onFilesDropped,
  saveLoadDialogs,
  editor,
}: SchedulePanelProps) {
  const { t } = useLocale();

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const dragIdRef = useRef<string | null>(null);

  const addDisabled = !sessionReady || uploading;
  const sorted = [...items].sort((a, b) => a.order - b.order);

  const applyReorder = (fromId: string, toId: string) => {
    if (fromId === toId || !canMutate) {
      return;
    }
    const ids = sorted.map((i) => i.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) {
      return;
    }
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    if (!moved) {
      return;
    }
    next.splice(to, 0, moved);
    onReorder(next);
  };

  const hasExternalFiles = (dt: DataTransfer | null): boolean => {
    if (!dt) {
      return false;
    }
    if (dt.types.includes("Files")) {
      return true;
    }
    return Array.from(dt.items ?? []).some((it) => it.kind === "file");
  };

  return (
    <section
      className={[
        "zone zone-playlist zone-schedule",
        fileDragOver ? "is-file-drop" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={t("control.playlist")}
      onDragEnter={(e) => {
        if (!hasExternalFiles(e.dataTransfer) || dragIdRef.current) {
          return;
        }
        e.preventDefault();
        setFileDragOver(true);
      }}
      onDragOver={(e) => {
        if (!hasExternalFiles(e.dataTransfer) || dragIdRef.current) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setFileDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) {
          return;
        }
        setFileDragOver(false);
      }}
      onDrop={(e) => {
        if (dragIdRef.current) {
          return;
        }
        if (!hasExternalFiles(e.dataTransfer)) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setFileDragOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) {
          onFilesDropped(files);
        }
      }}
    >
      <header className="schedule-header">
        <h2>{t("control.playlist")}</h2>
        <span className="schedule-count" title={t("playlist.itemCount")}>
          {sorted.length}
        </span>
      </header>

      <div
        className="schedule-toolbar schedule-toolbar-unified"
        role="toolbar"
        aria-label={t("playlist.addMenu")}
      >
        <div className="schedule-toolbar-row">
          <div
            className="schedule-add-tabs"
            role="group"
            aria-label={t("playlist.addTabs")}
          >
            <button
              type="button"
              className="schedule-add-tab"
              disabled={addDisabled}
              title={t("playlist.addLink")}
              aria-label={t("playlist.addLink")}
              onClick={onAddLink}
            >
              <IconYoutube className="schedule-icon-svg" size={16} />
              <span>{t("playlist.addLink")}</span>
            </button>
            <button
              type="button"
              className="schedule-add-tab"
              disabled={addDisabled}
              title={t("itemTypes.bible")}
              aria-label={t("itemTypes.bible")}
              onClick={onAddBible}
            >
              <IconBible className="schedule-icon-svg" size={16} />
              <span>{t("itemTypes.bible")}</span>
            </button>
            <button
              type="button"
              className="schedule-add-tab"
              disabled={addDisabled}
              title={t("text.blankManual")}
              aria-label={t("text.blankManual")}
              onClick={onAddTextBlank}
            >
              <IconType className="schedule-icon-svg" size={16} />
              <span>{t("text.blankManual")}</span>
            </button>
            <button
              type="button"
              className="schedule-add-tab"
              disabled={addDisabled}
              title={t("library.createSong")}
              aria-label={t("library.createSong")}
              onClick={onCreateSong}
            >
              <IconMusicNote className="schedule-icon-svg" size={16} />
              <span>{t("library.createSong")}</span>
            </button>
            <button
              type="button"
              className="schedule-add-tab"
              disabled={addDisabled}
              title={t("playlist.addAudioTip")}
              aria-label={t("playlist.addAudio")}
              onClick={onAddAudio}
            >
              <IconHeadphones className="schedule-icon-svg" size={16} />
              <span>{t("playlist.addAudio")}</span>
            </button>
            <button
              type="button"
              className="schedule-add-tab"
              disabled={addDisabled}
              title={t("library.open")}
              aria-label={t("library.open")}
              onClick={onOpenLibrary}
            >
              <IconLibrary className="schedule-icon-svg" size={16} />
              <span>{t("library.open")}</span>
            </button>
          </div>

          <button
            type="button"
            className="schedule-icon-btn"
            disabled={addDisabled}
            title={t("playlist.addFilesTip")}
            aria-label={t("playlist.addFilesTip")}
            onClick={onAddFiles}
          >
            <IconAddFiles className="schedule-icon-svg" size={16} />
          </button>
          <button
            type="button"
            className="schedule-icon-btn"
            disabled={!sessionReady || uploading}
            title={t("playlist.load")}
            aria-label={t("playlist.load")}
            onClick={onOpenLoad}
          >
            <IconFolderOpen className="schedule-icon-svg" size={16} />
          </button>
          <button
            type="button"
            className="schedule-icon-btn"
            disabled={!canMutate}
            title={t("playlist.save")}
            aria-label={t("playlist.save")}
            onClick={onOpenSave}
          >
            <IconSave className="schedule-icon-svg" size={16} />
          </button>
        </div>

        {checkedIds.size > 0 ? (
          <button
            type="button"
            className="schedule-add-btn schedule-add-btn-danger schedule-remove-checked"
            disabled={!canMutate}
            title={t("playlist.removeSelected")}
            onClick={onRemoveChecked}
          >
            {t("playlist.removeSelected")} ({checkedIds.size})
          </button>
        ) : null}
      </div>

      {fileDragOver ? (
        <div className="schedule-drop-overlay" aria-hidden>
          {t("playlist.dropFiles")}
        </div>
      ) : null}

      {saveLoadDialogs}

      {editor ? (
        <div className="zone-body playlist-editor">{editor}</div>
      ) : (
        <div className="zone-body schedule-list">
          {sorted.length === 0 ? (
            <p className="zone-empty">
              {t("control.playlistEmpty")}
              <span className="schedule-drop-hint">
                {t("playlist.dropHint")}
              </span>
            </p>
          ) : (
            <ul
              className="schedule-ul"
              onDragOver={(e) => {
                if (dragIdRef.current) {
                  e.preventDefault();
                }
              }}
            >
              {sorted.map((item) => {
                const kind = scheduleKindOf(item);
                const isLive = item.id === liveItemId;
                const isSelected = item.id === selectedItemId;
                const isDropTarget =
                  dropTargetId === item.id && dragId !== item.id;
                return (
                  <li
                    key={item.id}
                    className={[
                      "schedule-item",
                      isSelected ? "is-selected" : "",
                      isLive ? "is-live" : "",
                      dragId === item.id ? "is-dragging" : "",
                      isDropTarget ? "is-drop-target" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onDragOver={(e) => {
                      if (!dragIdRef.current || dragIdRef.current === item.id) {
                        return;
                      }
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = "move";
                      setDropTargetId(item.id);
                    }}
                    onDragLeave={(e) => {
                      if (e.currentTarget.contains(e.relatedTarget as Node)) {
                        return;
                      }
                      setDropTargetId((cur) =>
                        cur === item.id ? null : cur,
                      );
                    }}
                    onDrop={(e) => {
                      if (hasExternalFiles(e.dataTransfer)) {
                        return;
                      }
                      e.preventDefault();
                      e.stopPropagation();
                      const from =
                        e.dataTransfer.getData("text/plain") ||
                        dragIdRef.current;
                      if (from) {
                        applyReorder(from, item.id);
                      }
                      dragIdRef.current = null;
                      setDragId(null);
                      setDropTargetId(null);
                    }}
                  >
                    <label className="schedule-check">
                      <input
                        type="checkbox"
                        checked={checkedIds.has(item.id)}
                        onChange={() => onToggleChecked(item.id)}
                        aria-label={t("playlist.selectItem")}
                      />
                    </label>
                    <span
                      className="schedule-drag-handle"
                      title={t("playlist.dragReorder")}
                      draggable={canMutate}
                      onDragStart={(e) => {
                        if (!canMutate) {
                          e.preventDefault();
                          return;
                        }
                        dragIdRef.current = item.id;
                        setDragId(item.id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", item.id);
                      }}
                      onDragEnd={() => {
                        dragIdRef.current = null;
                        setDragId(null);
                        setDropTargetId(null);
                      }}
                    >
                      ⋮⋮
                    </span>
                    <button
                      type="button"
                      className="schedule-row-main"
                      onClick={() => onSelect(item.id)}
                      onDoubleClick={() => {
                        if (canMutate) {
                          onGoLive(item.id);
                        }
                      }}
                      title={t("playlist.doubleClickLive")}
                    >
                      <span
                        className={`schedule-type schedule-type-${kind}`}
                        title={t(kindLabelKey(kind))}
                      >
                        <ScheduleTypeIcon kind={kind} />
                      </span>
                      <span className="schedule-row-label">
                        {itemLabel(item)}
                      </span>
                      {karaokeProgress?.[item.id] ? (
                        <KaraokePercent
                          progress={karaokeProgress[item.id]!}
                          t={t}
                        />
                      ) : null}
                      {isLive ? (
                        <span className="schedule-live-badge">
                          {t("playlist.liveBadge")}
                        </span>
                      ) : null}
                    </button>
                    <div className="schedule-row-actions">
                      <button
                        type="button"
                        className={[
                          "btn btn-ghost schedule-go-btn",
                          isLive ? "is-on-air" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        disabled={!canMutate || isLive}
                        title={t("control.goLive")}
                        aria-pressed={isLive}
                        onClick={() => onGoLive(item.id)}
                      >
                        {t("playlist.goLiveShort")}
                      </button>
                      {item.type === "text" || item.type === "bible" ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={!canMutate}
                          onClick={() => {
                            onSelect(item.id);
                            if (item.type === "bible") {
                              onEditBible(item.id);
                            } else {
                              onEditText(item.id);
                            }
                          }}
                          title={t("playlist.edit")}
                        >
                          {t("playlist.edit")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-ghost schedule-remove-btn"
                        disabled={!canMutate}
                        onClick={() => onRemove(item.id)}
                        title={t("playlist.remove")}
                      >
                        ×
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
