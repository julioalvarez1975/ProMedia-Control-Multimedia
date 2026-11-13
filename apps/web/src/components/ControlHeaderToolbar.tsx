import { useState, type ReactNode } from "react";
import type {
  ThemeBackground,
  ThemeId,
  ThemeOverrides,
  TransitionEffect,
} from "@promedia/shared";
import { useLocale } from "../locale/LocaleContext";
import {
  ThemePanel,
  type ThemeBackgroundAssetOption,
} from "./ThemePanel";
import { SettingsDialog } from "./SettingsDialog";
import { StatusTip } from "./StatusTip";
import {
  IconGear,
  IconLibrary,
  IconProject,
  IconSaveLyrics,
  IconSubtitles,
} from "./UiIcons";

export type ControlHeaderToolbarProps = {
  projectionBusy: boolean;
  hubUnreachable: boolean;
  canMutate: boolean;
  hasSession: boolean;
  themeId: ThemeId;
  themeOverrides: ThemeOverrides | null;
  themeBackground: ThemeBackground;
  transitionEffect: TransitionEffect;
  uploadingBackground?: boolean;
  /** Session-uploaded stage backgrounds for the Theme dropdown. */
  backgroundAssets?: ThemeBackgroundAssetOption[];
  onProject: () => void;
  /** Open local Biblioteca (songs / bibles / texts / presentations / media). */
  onOpenLibrary: () => void;
  onThemeChange: (patch: {
    themeId?: ThemeId;
    themeOverrides?: ThemeOverrides | null;
    themeBackground?: ThemeBackground | null;
    transitionEffect?: TransitionEffect;
  }) => void;
  onUploadBackground?: (file: File) => void | Promise<void>;
  onAbout: () => void;
  /** Manual create/join when no session yet (rare after auto-session). */
  sessionFallback?: ReactNode;
  /** Local AI subtitle / karaoke agent. */
  subtitleAgentEnabled?: boolean;
  /** Tooltip: help text, download progress, or ASR errors (incl. yt-dlp). */
  subtitleAgentTitle?: string;
  /**
   * When set (missing yt-dlp/ffmpeg), show a StatusTip beside the
   * Agente subtítulos button — not only the button title attribute.
   */
  subtitleAgentErrorMessage?: string | null;
  onToggleSubtitleAgent?: () => void;
  /** Current lyrics came from LRCLIB (offer to save them). */
  showSaveLyrics?: boolean;
  onSaveLyrics?: () => void;
};

function ToolbarBtn({
  active,
  disabled,
  title,
  label,
  onClick,
  icon,
  className,
}: {
  active?: boolean;
  disabled?: boolean;
  title: string;
  label: string;
  onClick: () => void;
  icon: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`btn toolbar-icon-btn${active ? " active" : ""}${className ? ` ${className}` : ""}`}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="toolbar-icon-btn-glyph" aria-hidden>
        {icon}
      </span>
      <span className="toolbar-icon-btn-label">{label}</span>
    </button>
  );
}

/**
 * Flat Control tools strip: Project, subtitle agent, language, library,
 * about, transition + stage background. Scene / theme-preset / size / lead
 * UI removed for Guion width (keyboard shortcuts still work in Control).
 */
export function ControlHeaderToolbar({
  projectionBusy,
  hubUnreachable,
  canMutate,
  hasSession,
  themeId,
  themeOverrides,
  themeBackground,
  transitionEffect,
  uploadingBackground,
  backgroundAssets,
  onProject,
  onOpenLibrary,
  onThemeChange,
  onUploadBackground,
  onAbout,
  sessionFallback,
  subtitleAgentEnabled = false,
  subtitleAgentTitle,
  subtitleAgentErrorMessage,
  onToggleSubtitleAgent,
  showSaveLyrics = false,
  onSaveLyrics,
}: ControlHeaderToolbarProps) {
  const { t } = useLocale();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const subtitleTitle =
    subtitleAgentTitle?.trim() || t("control.subtitleAgentTitle");
  const depsError = subtitleAgentErrorMessage?.trim() || "";

  return (
    <div
      className="control-header-toolbar"
      role="toolbar"
      aria-label={t("control.toolbar")}
    >
      <ToolbarBtn
        className="toolbar-primary-action toolbar-settings"
        active={settingsOpen}
        title={t("control.settings")}
        label={t("control.settings")}
        icon={<IconGear />}
        onClick={() => setSettingsOpen(true)}
      />

      <ToolbarBtn
        className="toolbar-primary-action"
        disabled={projectionBusy || hubUnreachable}
        title={t("shortcuts.startProjection")}
        label={
          projectionBusy
            ? t("control.startProjectionBusy")
            : t("control.project")
        }
        icon={<IconProject />}
        onClick={onProject}
      />

      <span className="toolbar-subtitle-agent-wrap toolbar-primary-action">
        <ToolbarBtn
          className="toolbar-subtitle-agent"
          active={subtitleAgentEnabled}
          disabled={!canMutate || !onToggleSubtitleAgent}
          title={subtitleTitle}
          label={t("control.subtitleAgent")}
          icon={<IconSubtitles />}
          onClick={() => onToggleSubtitleAgent?.()}
        />
        {depsError ? (
          <StatusTip
            className="toolbar-subtitle-agent-error"
            tone="error"
            label={t("control.subtitleAgentError")}
            message={depsError}
          />
        ) : null}
        {subtitleAgentEnabled && showSaveLyrics && onSaveLyrics ? (
          <ToolbarBtn
            className="toolbar-subtitle-save-lyrics"
            disabled={!canMutate}
            title={t("control.subtitleSaveLyricsTitle")}
            label={t("control.subtitleSaveLyrics")}
            icon={<IconSaveLyrics />}
            onClick={onSaveLyrics}
          />
        ) : null}
      </span>

      <ToolbarBtn
        className="toolbar-primary-action"
        disabled={hubUnreachable}
        title={t("library.hint")}
        label={t("library.open")}
        icon={<IconLibrary />}
        onClick={onOpenLibrary}
      />

      {!hasSession && sessionFallback ? (
        <div className="toolbar-session-fallback">{sessionFallback}</div>
      ) : null}

      <ThemePanel
        themeId={themeId}
        themeOverrides={themeOverrides}
        themeBackground={themeBackground}
        transitionEffect={transitionEffect}
        disabled={!canMutate}
        uploadingBackground={uploadingBackground}
        backgroundAssets={backgroundAssets}
        onUploadBackground={onUploadBackground}
        onChange={onThemeChange}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onAbout={onAbout}
      />
    </div>
  );
}
