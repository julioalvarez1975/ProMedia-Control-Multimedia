/**
 * Independent watermark: own files (never the logo), image / animated image /
 * short video accepted, stamped on sessions, survives a restart.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "pm-watermark-"));
process.env.PROMEDIA_BRANDING_DIR = dir;
const store = await import("../src/watermark-store.ts");
const { SessionStore } = await import("../src/session-store.ts");

try {
  assert.equal(await store.initWatermarkStore(), null, "nothing uploaded yet");
  assert.equal(await store.getWatermark(), null);

  // validation
  assert.deepEqual(await store.putWatermark({ bytes: Buffer.from("x"), mime: "application/pdf" }), { error: "unsupported_mime" });
  assert.deepEqual(await store.putWatermark({ bytes: Buffer.alloc(0), mime: "image/png" }), { error: "empty_file" });
  assert.deepEqual(
    await store.putWatermark({ bytes: Buffer.alloc(store.WATERMARK_MAX_BYTES + 1), mime: "video/mp4" }),
    { error: "file_too_large" },
  );

  // image, animated image and video are all accepted
  for (const mime of ["image/png", "image/gif", "image/webp", "image/apng", "video/webm", "video/mp4"]) {
    const r = await store.putWatermark({ bytes: Buffer.from("data"), mime, originalName: "m" });
    assert.ok(!("error" in r), `${mime} accepted`);
  }

  // stored in its own files, not the logo's
  const put = await store.putWatermark({ bytes: Buffer.from("GIF89a-animated"), mime: "image/gif", originalName: "marca.gif" });
  assert.ok(!("error" in put));
  assert.deepEqual((await readdir(dir)).sort(), ["watermark.bin", "watermark.meta.json"], "own files only (no logo.*)");
  const got = await store.getWatermark();
  assert.equal(got?.bytes.toString(), "GIF89a-animated");
  assert.equal(got?.meta.mime, "image/gif");

  // survives a restart (fresh read from disk)
  const again = await store.refreshWatermarkCache();
  assert.equal(again?.mime, "image/gif", "reloaded from disk");

  // sessions: a new session carries it; an upload stamps + enables everywhere
  const sessions = new SessionStore();
  const { session } = sessions.create("lan");
  assert.equal(session.live.watermarkMime, "image/gif", "new sessions know the watermark");
  assert.equal(session.live.watermarkEnabled, false, "not forced on for new sessions");
  const next = await store.putWatermark({ bytes: Buffer.from("v"), mime: "video/mp4" });
  assert.ok(!("error" in next));
  const msgs = sessions.applyWatermarkUpdated(next as { updatedAt: string; mime: string });
  assert.equal(msgs.length, 1);
  assert.equal(session.live.watermarkMime, "video/mp4");
  assert.equal(session.live.watermarkEnabled, true, "uploading switches it on");
  assert.equal(session.live.watermarkUpdatedAt, (next as { updatedAt: string }).updatedAt);
  console.log("all passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
