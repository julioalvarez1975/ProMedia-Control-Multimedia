/**
 * Test: songs project one blank-line-separated phrase per slide.
 * Run: pnpm --filter @promedia/hub exec tsx scripts/test-phrases.mts
 */
import assert from "node:assert/strict";
import {
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

console.log("TEST_OK test-phrases");
