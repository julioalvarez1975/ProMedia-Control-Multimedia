/**
 * downloadYoutubeVideoFile: uses fake yt-dlp / ffmpeg so no network is needed.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await mkdtemp(path.join(os.tmpdir(), "promedia-ytdl-"));
const fakeFfmpeg = path.join(tmp, "ffmpeg");
const fakeYtDlp = path.join(tmp, "yt-dlp");
await writeFile(fakeFfmpeg, "#!/bin/sh\nexit 0\n");
// Fake yt-dlp: --version → ok; otherwise write <id>.mp4 into the -P dir.
await writeFile(
  fakeYtDlp,
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo 2099.01.01; exit 0; fi
if [ "$FAKE_YTDLP_FAIL" = "1" ]; then echo "ERROR: Private video" >&2; exit 1; fi
dir=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-P" ]; then dir="$a"; fi
  prev="$a"
done
printf 'fake-mp4' > "$dir/IMJhRLI9_Sk.mp4"
exit 0
`,
);
await chmod(fakeFfmpeg, 0o755);
await chmod(fakeYtDlp, 0o755);
process.env.FFMPEG_PATH = fakeFfmpeg;
process.env.YT_DLP_PATH = fakeYtDlp;

const { downloadYoutubeVideoFile } = await import("../src/subtitle-youtube.ts");

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
}

try {
  // Unsafe id never reaches yt-dlp.
  await downloadYoutubeVideoFile("../etc/passwd").then(
    () => assert(false, "unsafe id must be rejected"),
    (err) => assert(String(err).includes("youtube_invalid_id"), "unsafe id rejected"),
  );

  const ok = await downloadYoutubeVideoFile("IMJhRLI9_Sk");
  assert(ok.filePath.endsWith("IMJhRLI9_Sk.mp4"), "returns the mp4 path");
  assert((await readFile(ok.filePath, "utf8")) === "fake-mp4", "file has the bytes");
  await rm(ok.dir, { recursive: true, force: true });

  process.env.FAKE_YTDLP_FAIL = "1";
  await downloadYoutubeVideoFile("IMJhRLI9_Sk").then(
    () => assert(false, "failure must reject"),
    (err) => assert(String(err).includes("youtube_private"), "yt-dlp error is classified"),
  );
  console.log("all passed");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
