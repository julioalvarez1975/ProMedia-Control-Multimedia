/**
 * Test: startup environment check reports missing tools with a fix message.
 * Run: pnpm --filter @promedia/hub exec tsx scripts/test-startup-check.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "pm-start-"));
process.env.SUBTITLE_DATA_ROOT = path.join(dir, "data");
process.env.SUBTITLE_WHISPERX_PYTHON = "/nonexistent/python";
process.env.SUBTITLE_WHISPER_CPP_MODEL = "ggml-missing.bin";

const { formatStartupReport, probeCommand, runStartupChecks } = await import("../src/startup-check.ts");

assert.ok((await probeCommand(process.execPath, ["--version"]))?.startsWith("v"), "probe works");
assert.equal(await probeCommand("/nonexistent/tool", ["-v"]), null, "missing tool → null");

const checks = await runStartupChecks({
  ffmpeg: "/nonexistent/ffmpeg",
  ytDlp: "/nonexistent/yt-dlp",
  whisperCli: "/nonexistent/whisper-cli",
});
const by = Object.fromEntries(checks.map((c) => [c.id, c]));
assert.equal(by["ffmpeg"]!.status, "fail", "ffmpeg is required");
assert.equal(by["yt-dlp"]!.status, "fail", "yt-dlp is required");
assert.equal(by["whisper-cli"]!.status, "warn");
assert.equal(by["whisper-model"]!.status, "warn");
assert.equal(by["data-dir"]!.status, "ok", "writable temp data dir");
for (const c of checks.filter((x) => x.status !== "ok")) {
  assert.ok(c.fix.length > 10, `${c.id} explains how to fix it`);
}
const report = formatStartupReport(checks);
assert.match(report, /✗ ffmpeg/);
assert.match(report, /→ Instal/);
assert.match(report, /aviso\(s\)/);

await rm(dir, { recursive: true, force: true });
console.log("TEST_OK test-startup-check");
