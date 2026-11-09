/**
 * Boot-time environment check for the karaoke agent. Every tool it needs is
 * probed once; failures are printed as a ✓/⚠/✗ table with the fix, and exposed
 * on GET /health (`startup`) so Control can warn the operator.
 * Nothing here blocks the hub: a missing tool only disables the feature.
 */
import { spawn } from "node:child_process";
import { access, constants, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveFfmpegBin,
  resolveWhisperCliBin,
  resolveYtDlpBin,
} from "./subtitle-bins.js";
import { subtitleDataRoot } from "./subtitle-paths.js";
import { resolvePythonFor } from "./subtitle-python.js";
import { fileLooksComplete, whisperCppModelPath } from "./subtitle-whisper-cpp.js";

export type CheckStatus = "ok" | "warn" | "fail";

export type StartupCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What the operator should do (empty when ok). */
  fix: string;
};

const ALIGN_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../python/whisperx_align.py",
);

/** Run `bin ...args`, resolve the first output line (or null if it fails). */
export function probeCommand(
  bin: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? (out.split("\n")[0] ?? "").trim() || "ok" : null);
    });
  });
}

function result(
  id: string,
  label: string,
  ok: boolean,
  okDetail: string,
  failDetail: string,
  fix: string,
  level: Exclude<CheckStatus, "ok"> = "fail",
): StartupCheck {
  return ok
    ? { id, label, status: "ok", detail: okDetail, fix: "" }
    : { id, label, status: level, detail: failDetail, fix };
}

async function writable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function runStartupChecks(
  /** Test hook: force the binaries to probe instead of resolving them. */
  bins?: { ffmpeg?: string; ytDlp?: string; whisperCli?: string },
): Promise<StartupCheck[]> {
  const ffmpegBin = bins?.ffmpeg ?? resolveFfmpegBin();
  const ytBin = bins?.ytDlp ?? resolveYtDlpBin();
  const cliBin = bins?.whisperCli ?? resolveWhisperCliBin();
  const [ffmpeg, ytdlp, cli, modelOk, wxPython, fwPython, dataOk] =
    await Promise.all([
      probeCommand(ffmpegBin, ["-version"]),
      probeCommand(ytBin, ["--version"]),
      probeCommand(cliBin, ["--help"]),
      fileLooksComplete(whisperCppModelPath()),
      resolvePythonFor("whisperx"),
      resolvePythonFor("faster_whisper"),
      writable(subtitleDataRoot()),
    ]);
  let alignScript = true;
  try {
    await access(ALIGN_SCRIPT, constants.F_OK);
  } catch {
    alignScript = false;
  }

  return [
    result(
      "ffmpeg",
      "ffmpeg",
      ffmpeg !== null,
      ffmpeg ?? "",
      `no se ejecuta (${ffmpegBin})`,
      "Instalá ffmpeg: brew install ffmpeg (o definí FFMPEG_PATH). Sin él no hay audio para el karaoke.",
    ),
    result(
      "yt-dlp",
      "yt-dlp",
      ytdlp !== null,
      `versión ${ytdlp ?? ""}`,
      `no se ejecuta (${ytBin})`,
      "Instalá yt-dlp: brew install yt-dlp (o definí YT_DLP_PATH). Sin él no se puede bajar el audio de YouTube.",
    ),
    result(
      "whisper-cli",
      "whisper.cpp (whisper-cli)",
      cli !== null,
      cliBin,
      `no se ejecuta (${cliBin})`,
      "Instalá whisper.cpp: brew install whisper-cpp (o definí WHISPER_CPP_PATH). Sin él, solo captions de YouTube y pistas locales.",
      "warn",
    ),
    result(
      "whisper-model",
      "Modelo ggml de whisper.cpp",
      modelOk,
      whisperCppModelPath(),
      `falta o está incompleto (${whisperCppModelPath()})`,
      "Se descargará solo al primer uso con internet; o copiá el .bin a data/models/whisper/.",
      "warn",
    ),
    result(
      "whisperx",
      "WhisperX (alineación)",
      Boolean(wxPython) && alignScript,
      wxPython ?? "",
      alignScript
        ? "no se puede importar whisperx"
        : "falta apps/hub/python/whisperx_align.py",
      "Creá el venv: python3.12 -m venv data/models/whisperx-venv && data/models/whisperx-venv/bin/pip install -r apps/hub/python/requirements-whisperx.txt. Sin él los tiempos de la letra son menos precisos.",
      "warn",
    ),
    result(
      "faster-whisper",
      "faster-whisper",
      Boolean(fwPython),
      fwPython ?? "",
      "no se puede importar faster_whisper",
      "Transcribe las canciones que no están en el cancionero; viene con el venv de WhisperX. Sin él se usa whisper.cpp.",
      "warn",
    ),
    result(
      "data-dir",
      "Carpeta de datos",
      dataOk,
      subtitleDataRoot(),
      `no se puede escribir en ${subtitleDataRoot()}`,
      "Revisá permisos de la carpeta data/ (o SUBTITLE_DATA_ROOT). Sin ella no hay cachés.",
    ),
  ];
}

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };

export function formatStartupReport(checks: readonly StartupCheck[]): string {
  const lines = ["[hub] Chequeo del entorno (karaoke):"];
  for (const c of checks) {
    lines.push(
      `  ${ICON[c.status]} ${c.label}: ${c.status === "ok" ? c.detail : c.detail}`,
    );
    if (c.status !== "ok") lines.push(`      → ${c.fix}`);
  }
  const bad = checks.filter((c) => c.status !== "ok").length;
  lines.push(
    bad === 0
      ? "[hub] Entorno OK."
      : `[hub] ${bad} aviso(s): las funciones afectadas quedan desactivadas, el hub sigue funcionando.`,
  );
  return lines.join("\n");
}

let lastChecks: StartupCheck[] = [];

export function lastStartupChecks(): StartupCheck[] {
  return lastChecks;
}

/** Run, print and remember the report (called once at boot). */
export async function checkEnvironmentAtStartup(): Promise<StartupCheck[]> {
  lastChecks = await runStartupChecks();
  const report = formatStartupReport(lastChecks);
  if (lastChecks.some((c) => c.status === "fail")) console.error(report);
  else if (lastChecks.some((c) => c.status === "warn")) console.warn(report);
  else console.log(report);
  return lastChecks;
}
