/**
 * Loading a guion file ADDS to the current Guion: nothing is removed, the new
 * items go to the end, the live item is untouched, missing media is skipped.
 */
import assert from "node:assert/strict";
import { SessionStore } from "../src/session-store.ts";

const store = new SessionStore();
const { session } = store.create("lan");
const text = (id: string, line: string, order = 0) =>
  ({ id, type: "text", order, payload: { slides: [{ id: `s-${id}`, lines: [line] }] } }) as never;

assert.ok(!("error" in store.addItem(session, text("a", "uno", 0))));
assert.ok(!("error" in store.addItem(session, text("b", "dos", 1))));
store.goLive(session, "a");

const res = store.appendToPlaylist(session, [
  text("n1", "tres", 0),
  { id: "f1", type: "video", order: 1, payload: { sourceKind: "file", assetId: "gone" } } as never,
  text("n2", "cuatro", 2),
]);
assert.ok(!("error" in res), "append accepted");
if ("error" in res) throw new Error(res.error);
assert.equal(res.added, 2, "two items added");
assert.equal(res.skipped, 1, "the item whose file is gone is skipped");

const ids = session.playlist.items.map((i) => i.id);
assert.deepEqual(ids, ["a", "b", "n1", "n2"], "old items stay, new ones go to the end in order");
assert.deepEqual(session.playlist.items.map((i) => i.order), [0, 1, 2, 3], "orders are contiguous");
assert.equal(session.live.currentItemId, "a", "the live item is untouched");

// An id that already exists is refused instead of overwriting.
assert.deepEqual(store.appendToPlaylist(session, [text("a", "otra", 0)]), { error: "duplicate_id" });
assert.equal(session.playlist.items.length, 4, "nothing changed after the refusal");

// Appending to an empty Guion works too.
const { session: empty } = store.create("lan");
const r2 = store.appendToPlaylist(empty, [text("x", "uno", 0)]);
assert.ok(!("error" in r2) && r2.added === 1);
console.log("all passed");
process.exit(0);
