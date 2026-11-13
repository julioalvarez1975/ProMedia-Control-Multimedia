/**
 * Test: songs project one blank-line-separated phrase per slide.
 * Run: pnpm --filter @promedia/hub exec tsx scripts/test-phrases.mts
 */
import assert from "node:assert/strict";
import {
  editorBlockFromTextPayload,
  manualLyricLines,
  projectionTextSlides,
  resolveProjectionTextSlides,
  songToTextPayload,
  splitSlideOnBlankLines,
} from "@promedia/shared";

const song = ["a1", "a2", "a3", "", "b1", "b2", "b3", "", "c1", "c2", "c3"];
const slides = projectionTextSlides([{ id: "s", lines: song }]);
assert.equal(slides.length, 3, "one slide per phrase");
assert.deepEqual(slides.map((s) => s.lines), [["a1", "a2", "a3"], ["b1", "b2", "b3"], ["c1", "c2", "c3"]]);

// A phrase longer than 6 lines is chunked (6 + 2), blanks never leak into slides.
const long = Array.from({ length: 8 }, (_, i) => `l${i}`);
const chunked = projectionTextSlides([{ id: "x", lines: long }]);
assert.deepEqual(chunked.map((s) => s.lines.length), [6, 2]);
assert.ok(chunked.every((s) => s.lines.every((l) => l.trim() !== "")));

// Idempotent and unique ids.
const again = projectionTextSlides(slides);
assert.deepEqual(again.map((s) => s.lines), slides.map((s) => s.lines));
const ids = chunked.concat(slides).map((s) => s.id);
assert.equal(new Set(ids).size, ids.length, "slide ids are unique");

// Legacy payload (chunkLines:false, one big block) is re-split.
const legacy = resolveProjectionTextSlides({
  slides: [{ id: "lyrics", lines: song }],
  chunkLines: false,
} as never);
assert.equal(legacy.length, 3);

assert.equal(splitSlideOnBlankLines({ id: "z", lines: ["solo", "una"] }).length, 1);

const payload = songToTextPayload({
  title: "Prueba",
  artist: "Yo",
  stanzas: [{ id: "st", lines: song }],
});
assert.equal(payload.slides.length, 3);
assert.equal(payload.title, "Prueba — Yo");
assert.equal(payload.body, song.join("\n"));
assert.equal(editorBlockFromTextPayload(payload), song.join("\n"));

// A phrase longer than 6 lines is chunked for ←/→, but reopening the editor
// must not turn that chunk into a blank line between two rows.
const verse = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "", "l8"];
const versePayload = songToTextPayload({
  title: "Verso",
  stanzas: [{ id: "v", lines: verse }],
});
assert.equal(versePayload.body, verse.join("\n"));
assert.equal(editorBlockFromTextPayload(versePayload), verse.join("\n"));
assert.equal(
  editorBlockFromTextPayload({ slides: versePayload.slides }),
  verse.join("\n"),
  "legacy slides without body keep the operator blank line only",
);

const manual = manualLyricLines({
  id: "song",
  type: "text",
  order: 0,
  payload: versePayload,
});
assert.deepEqual(manual, verse.filter((line) => line.trim() !== ""));

console.log("TEST_OK test-phrases");
