import { useRef, useState } from "react";
import { useLocale } from "../locale/LocaleContext";
import type { TextAlign, TextPayload, TextSlide } from "@promedia/shared";
import {
  editorBlockFromTextPayload,
  projectionTextSlides,
} from "@promedia/shared";
import { cryptoRandomId } from "@promedia/item-types";
import {
  TEXT_IMPORT_MAX_BYTES,
  TEXT_IMPORT_MAX_SLIDES,
  importFileToTextSlides,
  isSupportedTextImport,
} from "../lib/textImport";

export type TextItemEditorProps = {
  initial: TextPayload;
  onSave: (payload: TextPayload) => void;
  onCancel: () => void;
};

function slidesToBlock(slides: readonly TextSlide[]): string {
  // Phrase breaks stay as blank lines. 6-line projection chunks do not.
  return editorBlockFromTextPayload({ slides });
}

function blockToLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * One text block for the whole song / text — the same shape the song is stored
 * in (lines, blank line between phrases). Each phrase still becomes one slide
 * on save — plus PDF/XML/text import.
 */
export function TextItemEditor({ initial, onSave, onCancel }: TextItemEditorProps) {
  const { t } = useLocale();

  const [title, setTitle] = useState(initial.title ?? "");
  const [align, setAlign] = useState<TextAlign>(initial.align ?? "center");
  const [block, setBlock] = useState<string>(() =>
    editorBlockFromTextPayload(initial),
  );
  const [blockId] = useState<string>(
    () => initial.slides[0]?.id || cryptoRandomId(),
  );
  const [importHint, setImportHint] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const onImportFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setImportHint(null);
    if (!isSupportedTextImport(file)) {
      setImportHint(t("text.importUnsupported"));
      return;
    }
    if (file.size > TEXT_IMPORT_MAX_BYTES) {
      setImportHint(t("text.importTooLarge"));
      return;
    }
    setImporting(true);
    try {
      const result = await importFileToTextSlides(file);
      setBlock(slidesToBlock(result.slides));
      if (result.title && !title.trim()) {
        setTitle(result.title);
      }
      setImportHint(
        result.truncated
          ? t("text.importTruncated").replace(
              "{n}",
              String(TEXT_IMPORT_MAX_SLIDES),
            )
          : t("text.importOk").replace(
              "{n}",
              String(result.slides.length),
            ),
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("file_too_large")) {
        setImportHint(t("text.importTooLarge"));
      } else if (msg.includes("unsupported_type")) {
        setImportHint(t("text.importUnsupported"));
      } else {
        setImportHint(t("text.importFailed"));
      }
    } finally {
      setImporting(false);
      if (importInputRef.current) {
        importInputRef.current.value = "";
      }
    }
  };

  const save = () => {
    const body = block.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    onSave({
      title: title.trim() || undefined,
      align,
      // Exact text, blank rows included. Slides are the projection of that
      // text (a blank line is still one phrase; long phrases chunk for ←/→).
      body,
      slides: projectionTextSlides([{ id: blockId, lines: blockToLines(body) }]),
    });
  };

  return (
    <div className="text-editor">
      <label className="text-editor-field">
        {t("text.editorTitle")}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("text.editorTitlePlaceholder")}
        />
      </label>
      <label className="text-editor-field">
        {t("text.editorAlign")}
        <select
          value={align}
          onChange={(e) => setAlign(e.target.value as TextAlign)}
        >
          <option value="left">{t("text.alignLeft")}</option>
          <option value="center">{t("text.alignCenter")}</option>
          <option value="right">{t("text.alignRight")}</option>
        </select>
      </label>

      <div className="text-editor-import">
        <input
          ref={importInputRef}
          type="file"
          accept=".pdf,.xml,.txt,.md,.text,.markdown,application/pdf,text/plain,text/markdown,application/xml,text/xml"
          className="sr-only"
          onChange={(e) => void onImportFile(e.target.files?.[0])}
        />
        <button
          type="button"
          className="btn"
          disabled={importing}
          onClick={() => importInputRef.current?.click()}
        >
          {importing
            ? t("text.importing")
            : t("text.importFile")}
        </button>
        <p className="text-editor-import-hint">{t("text.importLimits")}</p>
        {importHint ? (
          <p className="text-editor-import-status" role="status">
            {importHint}
          </p>
        ) : null}
      </div>

      <div className="text-editor-slides">
        <p className="text-editor-import-hint">{t("text.blockHint")}</p>
        <textarea
          className="text-editor-block"
          rows={18}
          value={block}
          onChange={(e) => setBlock(e.target.value)}
          placeholder={t("text.slidePlaceholder")}
          spellCheck={false}
        />
      </div>

      <div className="text-editor-actions">
        <div className="text-editor-actions-right">
          <button type="button" className="btn" onClick={onCancel}>
            {t("text.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            {t("text.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
