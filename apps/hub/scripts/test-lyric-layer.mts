/**
 * Test: manual lyric layer — only over live video/audio with karaoke off, steps
 * clamped, cleared when the live item changes.
 * Run: pnpm --filter @promedia/hub exec tsx scripts/test-lyric-layer.mts
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MEDIA_ROOT = await mkdtemp(path.join(tmpdir(), "pm-lyric-"));
const { SessionStore } = await import("../src/session-store.ts");

const store = new SessionStore();
const { session } = store.create("lan");
store.addItem(session, { id: "song", type: "text", order: 0, payload: { slides: [{ id: "a", lines: ["uno"] }, { id: "b", lines: ["dos"] }, { id: "c", lines: ["tres"] }] } } as never);
store.addItem(session, { id: "v1", type: "video", order: 1, payload: { sourceKind: "youtube", videoId: "abcdefghijk", sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk" } } as never);

assert.deepEqual(store.setLyricLayer(session, { itemId: "song" }), { error: "no_av_live" });
store.goLive(session, "v1");
assert.ok(!("error" in store.setLyricLayer(session, { itemId: "song" })));
assert.deepEqual(session.live.lyricLayer, { itemId: "song", index: 0 });
store.setLyricLayer(session, { delta: 1 });
store.setLyricLayer(session, { delta: 1 });
store.setLyricLayer(session, { delta: 1 });
assert.equal(session.live.lyricLayer?.index, 2, "clamped at last phrase");
store.setLyricLayer(session, { delta: -1 });
assert.equal(session.live.lyricLayer?.index, 1);
// Does not touch the media clock / live item.
assert.equal(session.live.currentItemId, "v1");
// Karaoke on → refused.
session.live.subtitleAgent = { ...session.live.subtitleAgent, enabled: true };
assert.deepEqual(store.setLyricLayer(session, { delta: 1 }), { error: "karaoke_active" });
session.live.subtitleAgent = { ...session.live.subtitleAgent, enabled: false };
assert.ok(!("error" in store.setLyricLayer(session, { itemId: null })));
assert.equal(session.live.lyricLayer, null);
store.setLyricLayer(session, { itemId: "song" });
store.clearLive(session);
assert.equal(session.live.lyricLayer, null, "cleared with live item");
console.log("ok test-lyric-layer");
