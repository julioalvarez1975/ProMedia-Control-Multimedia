#!/usr/bin/env node
/**
 * Runs every hub smoke/test script (scripts/smoke-*.mts, scripts/test-*.mts)
 * with tsx, one process each, and prints a summary. Exit code 1 on any failure.
 *
 *   pnpm test           all scripts
 *   pnpm test -- --ci   skip the ones that need whisper-cli, a downloaded model
 *                       or a long model load (not available on a clean runner)
 *   pnpm test -- <text> only scripts whose name contains <text>
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hubDir = path.resolve(here, "..");
const args = process.argv.slice(2);
const ci = args.includes("--ci");
const filter = args.find((a) => !a.startsWith("--"));

/** Need whisper-cli / a ggml or HF model on disk. */
const NEEDS_LOCAL_ASR = new Set(["smoke-whisper-cpp.mts", "smoke-whisper-load.mts"]);

const names = (await readdir(here))
  .filter((n) => /^(smoke|test)-.*\.mts$/.test(n))
  .filter((n) => !filter || n.includes(filter))
  .filter((n) => !(ci && NEEDS_LOCAL_ASR.has(n)))
  .sort();

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("pnpm", ["exec", "tsx", path.join("scripts", name)], {
      cwd: hubDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) =>
      resolve({ name, code: code ?? 1, ms: Date.now() - started, out }),
    );
  });
}

console.log(`Running ${names.length} script(s)${ci ? " (--ci)" : ""}…\n`);
const results = [];
for (const name of names) {
  const r = await run(name);
  results.push(r);
  console.log(`${r.code === 0 ? "✓" : "✗"} ${name} (${(r.ms / 1000).toFixed(1)}s)`);
  if (r.code !== 0) console.log(r.out.split("\n").map((l) => `    ${l}`).join("\n"));
}
const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
