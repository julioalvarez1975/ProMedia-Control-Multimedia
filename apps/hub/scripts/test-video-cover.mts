/**
 * Test: video cover state — only over live video/audio, toggle keeps the image,
 * never touches the media clock, cleared when the live item changes.
 * Run: pnpm --filter @promedia/hub exec tsx scripts/test-video-cover.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const media = await mkdtemp(path.join(tmpdir(), "pm-cover-"));
process.env.MEDIA_ROOT = media;
const { SessionStore } = await import("../src/session-store.ts");
const { assetStore } = await import("../src/asset-store.ts");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const store = new SessionStore();
const { session } = store.create("lan");
const img = await assetStore.putImage(session.id, png, "image/png", "c.png");
assert.ok(!("error" in img));
const imgId = (img as { id: string }).id;

store.addItem(session, { id: "t1", type: "text", order: 0, payload: { slides: [{ id: "s", lines: ["hola"] }] } } as never);
store.addItem(session, { id: "v1", type: "video", order: 1, payload: { sourceKind: "youtube", videoId: "abcdefghijk", sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk" } } as never);
const aud = await assetStore.putAudio(session.id, Buffer.from("ID3audio"), "audio/mpeg", "a.mp3");
assert.ok(!("error" in aud), "audio asset stored");
const added = store.addItem(session, { id: "a1", type: "audio", order: 2, payload: { assetId: (aud as { id: string }).id } } as never);
assert.ok(!("error" in added), `audio item added: ${JSON.stringify(added).slice(0, 80)}`);

// Nothing live / a text item live → refused.
assert.deepEqual(store.setVideoCover(session, { assetId: imgId }), { error: "no_av_live" });
store.goLive(session, "t1");
assert.deepEqual(store.setVideoCover(session, { assetId: imgId }), { error: "no_av_live" });

// Video live: choose image → active; the media clock is untouched.
const went = store.goLive(session, "v1");
assert.ok(!("error" in went), `goLive v1: ${JSON.stringify(went).slice(0, 120)}`);
session.live.mediaClock = { itemId: "v1", playing: true, positionMs: 5000, rate: 1, updatedAt: new Date().toISOString() } as never;
const clockBefore = JSON.stringify(session.live.mediaClock);
assert.ok(!("error" in store.setVideoCover(session, { assetId: imgId })));
assert.deepEqual(session.live.videoCover, { assetId: imgId, active: true });
assert.equal(JSON.stringify(session.live.mediaClock), clockBefore, "cover never touches the clock");
assert.equal(session.live.currentItemId, "v1", "video stays the live item");

// Toggle off keeps the image; toggle on shows it again.
store.setVideoCover(session, { active: false });
assert.deepEqual(session.live.videoCover, { assetId: imgId, active: false });
store.setVideoCover(session, { active: true });
assert.equal(session.live.videoCover?.active, true);

// Validation.
assert.deepEqual(store.setVideoCover(session, { assetId: "nope" }), { error: "cover_asset_not_found" });
assert.deepEqual(store.setVideoCover(session, {}), { error: "invalid_video_cover" });

// Re-going live on the SAME item keeps it; another item (audio too) clears it.
store.goLive(session, "v1");
assert.ok(session.live.videoCover, "same item keeps the cover");
store.goLive(session, "a1");
assert.equal(session.live.videoCover, null, "new live item starts clean");
assert.ok(!("error" in store.setVideoCover(session, { assetId: imgId })), "audio items accept a cover too");

// Forget / clear.
store.setVideoCover(session, { assetId: null });
assert.equal(session.live.videoCover, null);
store.setVideoCover(session, { assetId: imgId });
store.clearLive(session);
assert.equal(session.live.videoCover, null, "stopping the projection clears it");
assert.deepEqual(store.setVideoCover(session, { active: true }), { error: "no_av_live" });

await assetStore.dropSession(session.id);
await rm(media, { recursive: true, force: true });
console.log("TEST_OK test-video-cover");
process.exit(0);
