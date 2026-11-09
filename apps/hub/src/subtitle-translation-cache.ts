/**
 * Disk cache of machine translations of karaoke/caption lines.
 *
 * One file per language pair under `data/subtitles/translations/<src>-<tgt>.json`,
 * mapping sha1(source text) → translated text. Marian (ONNX) is slow and
 * deterministic, so a line translated once is never translated again — across
 * songs, sessions and hub restarts (choruses repeat inside and between songs).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json-file.js";
import { subtitleDataRoot } from "./subtitle-paths.js";

const VERSION = 1;
const MAX_ENTRIES = 20_000;
const WRITE_DEBOUNCE_MS = 500;
const SAFE_PAIR = /^[a-z]{2,3}-[a-z]{2,3}$/;

type PairFile = { version: number; entries: Record<string, string> };

const loaded = new Map<string, Promise<Map<string, string>>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function translationKey(text: string): string {
  return createHash("sha1").update(text.trim()).digest("hex");
}

function fileFor(pair: string): string {
  return path.join(subtitleDataRoot(), "translations", `${pair}.json`);
}

function load(pair: string): Promise<Map<string, string>> {
  let p = loaded.get(pair);
  if (!p) {
    p = (async () => {
      const res = await readJsonFile<PairFile>(fileFor(pair), `Caché de traducción ${pair}`);
      const map = new Map<string, string>();
      if (res.status === "ok" && res.value.version === VERSION) {
        for (const [k, v] of Object.entries(res.value.entries ?? {})) {
          if (typeof v === "string" && v.trim()) map.set(k, v);
        }
      }
      return map;
    })();
    loaded.set(pair, p);
  }
  return p;
}

function scheduleSave(pair: string, map: Map<string, string>): void {
  const prev = timers.get(pair);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(pair);
    // Map keeps insertion order: drop the oldest entries beyond the cap.
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    const payload: PairFile = { version: VERSION, entries: Object.fromEntries(map) };
    void writeJsonAtomic(fileFor(pair), payload, false).catch((err) =>
      console.warn(
        `[subtitle] translation cache save failed (${pair}):`,
        err instanceof Error ? err.message : err,
      ),
    );
  }, WRITE_DEBOUNCE_MS);
  t.unref?.();
  timers.set(pair, t);
}

/**
 * Translate `texts` using the cache; `translateMissing` receives only the
 * lines not cached yet and must return one translation per input (or null if
 * MT is unavailable, in which case nothing is cached and null is returned).
 */
export async function translateWithCache(
  src: string,
  tgt: string,
  texts: readonly string[],
  translateMissing: (missing: string[]) => Promise<string[] | null>,
): Promise<{ translations: string[]; cached: number } | null> {
  const pair = `${src}-${tgt}`;
  if (!SAFE_PAIR.test(pair)) {
    const direct = await translateMissing([...texts]);
    return direct ? { translations: direct, cached: 0 } : null;
  }
  const map = await load(pair);
  const out: Array<string | null> = texts.map((t) => map.get(translationKey(t)) ?? null);
  const missingIdx = out.flatMap((v, i) => (v === null ? [i] : []));
  if (missingIdx.length > 0) {
    // De-duplicate repeated lines (choruses) before translating.
    const uniqueTexts = [...new Set(missingIdx.map((i) => texts[i]!.trim()))];
    const translated = await translateMissing(uniqueTexts);
    if (!translated || translated.length !== uniqueTexts.length) return null;
    const byText = new Map(uniqueTexts.map((t, i) => [t, translated[i]!]));
    for (const i of missingIdx) {
      const tr = byText.get(texts[i]!.trim())!;
      out[i] = tr;
    }
    for (const [text, tr] of byText) {
      if (tr.trim()) map.set(translationKey(text), tr);
    }
    scheduleSave(pair, map);
  }
  return {
    translations: out.map((v, i) => v ?? texts[i]!),
    cached: texts.length - missingIdx.length,
  };
}

/** Test hook: forget in-memory state (files stay). */
export function resetTranslationCacheMemory(): void {
  loaded.clear();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
