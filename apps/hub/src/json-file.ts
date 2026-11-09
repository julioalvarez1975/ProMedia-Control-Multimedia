/**
 * Safe JSON persistence for the hub's on-disk stores (library index, saved
 * playlists, cancionero memory, caches).
 *
 * - `readJsonFile` never silently turns a corrupt file into "empty": the
 *   corrupt file is moved aside (`.corrupt-<time>`) and the error is logged
 *   loudly, so the next write cannot destroy the only copy of the data.
 * - `writeJsonAtomic` writes a temp file and renames it, so a crash mid-write
 *   cannot leave a truncated file.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type JsonReadResult<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "corrupt"; movedTo: string | null; error: string };

export async function readJsonFile<T>(
  file: string,
  label: string,
): Promise<JsonReadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    // Unreadable (permissions…) is not "empty" — surface it.
    console.error(
      `[hub] ${label}: no se puede leer ${file}:`,
      err instanceof Error ? err.message : err,
    );
    return {
      status: "corrupt",
      movedTo: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    return { status: "ok", value: JSON.parse(raw) as T };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const movedTo = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let moved: string | null = movedTo;
    try {
      await rename(file, movedTo);
    } catch {
      moved = null; // could not even move it; the error below still tells the operator
    }
    console.error(
      `[hub] ${label}: ${file} está corrupto (${error}). ` +
        (moved
          ? `Se guardó una copia en ${moved} y se empieza vacío.`
          : "No se pudo apartar el archivo."),
    );
    return { status: "corrupt", movedTo: moved, error };
  }
}

export async function writeJsonAtomic(
  file: string,
  data: unknown,
  pretty = true,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(
    tmp,
    pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data),
    "utf8",
  );
  await rename(tmp, file);
}
