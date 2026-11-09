/**
 * Shared Python sidecar plumbing for the karaoke agent: one place that finds
 * the WhisperX venv, checks that a module imports, and runs a JSON-in/JSON-out
 * script. Used by WhisperX alignment and the faster-whisper ASR backend.
 */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { ensureAugmentedPath } from "./subtitle-bins.js";
import { promediaRoot, subtitleModelsRoot } from "./subtitle-paths.js";

export type PythonRunResult = { code: number; stdout: string; stderr: string };

export function venvPythonCandidates(): string[] {
  const root = promediaRoot();
  const envOverride = process.env.SUBTITLE_WHISPERX_PYTHON?.trim();
  const out: string[] = [];
  if (envOverride) out.push(envOverride);
  out.push(
    path.join(root, "data/models/whisperx-venv/bin/python"),
    path.join(root, "data/models/whisperx-venv/bin/python3"),
    path.join(root, "apps/hub/.venv-whisperx/bin/python"),
    "/opt/homebrew/bin/python3.12",
    "/usr/local/bin/python3.12",
    "python3.12",
    "python3",
  );
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Does `python -c "import <module>"` succeed? */
export function probePythonImport(
  pythonBin: string,
  moduleName: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(pythonBin, ["-c", `import ${moduleName}; print('ok')`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0 && out.includes("ok")));
  });
}

const resolved = new Map<string, string | null>();

/** First Python (venv preferred) that can import `moduleName`; cached. */
export async function resolvePythonFor(
  moduleName: string,
): Promise<string | null> {
  if (resolved.has(moduleName)) return resolved.get(moduleName) ?? null;
  ensureAugmentedPath();
  for (const candidate of venvPythonCandidates()) {
    if (candidate.includes(path.sep) && !(await exists(candidate))) continue;
    if (await probePythonImport(candidate, moduleName)) {
      resolved.set(moduleName, candidate);
      return candidate;
    }
  }
  resolved.set(moduleName, null);
  return null;
}

/** Test hook / after installing the venv without restarting the hub. */
export function clearPythonCache(): void {
  resolved.clear();
}

/** Run `script` with `payload` as JSON on stdin; rejects on timeout/spawn error. */
export function runPythonScript(
  pythonBin: string,
  script: string,
  payload: unknown,
  opts: { timeoutMs: number; label: string },
): Promise<PythonRunResult> {
  return new Promise((resolve, reject) => {
    const models = subtitleModelsRoot();
    const child = spawn(pythonBin, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        HF_HOME: process.env.HF_HOME || models,
        HUGGINGFACE_HUB_CACHE: process.env.HUGGINGFACE_HUB_CACHE || models,
        TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE || models,
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${opts.label}_timeout`));
    }, opts.timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
}
