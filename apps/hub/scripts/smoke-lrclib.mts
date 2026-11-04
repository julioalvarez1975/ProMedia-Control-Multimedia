/**
 * Smoke: LRCLIB lyric lookup (mocked fetch — no network).
 * Run: pnpm --filter @promedia/hub exec tsx scripts/smoke-lrclib.mts
 */
import assert from "node:assert/strict";
import {
  clearLrclibCache,
  findLrclibSong,
  lrclibRecordToSong,
  parseLrc,
  plainLyricsToLines,
  type LrclibFetch,
  type LrclibRecord,
} from "../src/subtitle-lrclib.ts";

// ---- parseLrc ------------------------------------------------------------
const lrc = [
  "[ar:Artista de prueba]",
  "[00:05.50] Línea de prueba uno",
  "[00:09.00] Línea de prueba dos",
  "[00:12.25]",
  "[00:20.00][00:30.00] Coro de prueba",
].join("\n");
const entries = parseLrc(lrc);
assert.equal(entries.length, 5, "metadata ignored, multi-stamp expanded");
assert.equal(entries[0]!.startMs, 5_500);
assert.equal(entries[0]!.text, "Línea de prueba uno");
assert.equal(entries[2]!.text, "", "empty stamp kept as breath marker");
assert.equal(entries[3]!.startMs, 20_000);
assert.equal(entries[4]!.startMs, 30_000);

assert.deepEqual(plainLyricsToLines("uno\n\n dos \r\ntres"), [
  "uno",
  "dos",
  "tres",
]);

// ---- record → song -------------------------------------------------------
const synced: LrclibRecord = {
  id: 1,
  trackName: "Canción de prueba",
  artistName: "Artista de prueba",
  duration: 100,
  plainLyrics: "x",
  syncedLyrics: lrc,
};
const built = lrclibRecordToSong(synced)!;
assert.ok(built, "record converts");
assert.equal(built.song.title, "Canción de prueba");
assert.equal(built.syncedCues?.length, 4, "4 non-empty lines → 4 cues");
assert.equal(built.syncedCues![0]!.startMs, 5_500);
// Line ends where the empty breath marker starts (minus 40 ms).
assert.equal(built.syncedCues![1]!.endMs, 12_250 - 40);
assert.ok(
  built.syncedCues!.every((c, i, a) => i === 0 || c.startMs >= a[i - 1]!.startMs),
  "cues are ordered",
);

assert.equal(
  lrclibRecordToSong({ ...synced, instrumental: true }),
  null,
  "instrumental has no lyrics",
);
assert.equal(
  lrclibRecordToSong({ trackName: "Solo texto", plainLyrics: "" }),
  null,
  "empty lyrics rejected",
);
const plainOnly = lrclibRecordToSong({
  trackName: "Solo texto",
  plainLyrics: "uno\ndos",
})!;
assert.equal(plainOnly.syncedCues, null, "plain lyrics carry no clocks");

// ---- findLrclibSong (mock fetch) ----------------------------------------
type Call = { url: string };
function mockFetch(
  responder: (url: URL) => { status?: number; body: unknown } | "throw",
  calls: Call[],
): LrclibFetch {
  return async (url) => {
    calls.push({ url });
    const r = responder(new URL(url));
    if (r === "throw") throw new Error("offline");
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body };
  };
}

// 1) exact lookup hit
{
  clearLrclibCache();
  const calls: Call[] = [];
  const hit = await findLrclibSong({
    titles: ["Artista de prueba - Canción de prueba (Official Video)"],
    artists: ["Artista de prueba - Topic"],
    durationMs: 101_000,
    fetchImpl: mockFetch((u) => {
      assert.ok(u.pathname.endsWith("/get"), "exact lookup first");
      assert.equal(u.searchParams.get("artist_name"), "Artista de prueba");
      return { body: synced };
    }, calls),
  });
  assert.ok(hit, "exact hit");
  assert.equal(hit!.song.title, "Canción de prueba");
  assert.ok(hit!.syncedCues);
  assert.equal(calls.length, 1, "no search needed after exact hit");
}

// 2) no artist → free-text search, picks the right title + duration
{
  clearLrclibCache();
  const calls: Call[] = [];
  const wrongCut: LrclibRecord = { ...synced, id: 2, duration: 400 };
  const otherSong: LrclibRecord = {
    ...synced,
    id: 3,
    trackName: "Otra cosa distinta",
  };
  const hit = await findLrclibSong({
    titles: ["Canción de prueba"],
    durationMs: 100_000,
    fetchImpl: mockFetch(
      (u) => ({ body: u.pathname.endsWith("/search") ? [otherSong, wrongCut, synced] : null }),
      calls,
    ),
  });
  assert.ok(hit, "search hit");
  assert.equal(hit!.id, "lrclib:1", "wrong duration and wrong title rejected");
}

// 3) only a different cut / different song → miss
{
  clearLrclibCache();
  const hit = await findLrclibSong({
    titles: ["Canción de prueba"],
    durationMs: 100_000,
    fetchImpl: mockFetch(
      () => ({ body: [{ ...synced, duration: 400 }, { ...synced, trackName: "Nada que ver" }] }),
      [],
    ),
  });
  assert.equal(hit, null, "no acceptable record → null");
}

// 4) offline / HTTP error → null, never throws
{
  clearLrclibCache();
  assert.equal(
    await findLrclibSong({
      titles: ["Canción de prueba"],
      fetchImpl: mockFetch(() => "throw", []),
    }),
    null,
    "network error → null",
  );
  clearLrclibCache();
  assert.equal(
    await findLrclibSong({
      titles: ["Canción de prueba"],
      fetchImpl: mockFetch(() => ({ status: 503, body: {} }), []),
    }),
    null,
    "HTTP 503 → null",
  );
}

// 5) cache: second identical query does not hit the network
{
  clearLrclibCache();
  const calls: Call[] = [];
  const f = mockFetch(() => ({ body: [synced] }), calls);
  await findLrclibSong({ titles: ["Canción de prueba"], fetchImpl: f });
  const n = calls.length;
  await findLrclibSong({ titles: ["Canción de prueba"], fetchImpl: f });
  assert.equal(calls.length, n, "cached");
}

// 6) kill switch
{
  clearLrclibCache();
  process.env.PROMEDIA_LRCLIB = "0";
  const calls: Call[] = [];
  const hit = await findLrclibSong({
    titles: ["Canción de prueba"],
    fetchImpl: mockFetch(() => ({ body: [synced] }), calls),
  });
  delete process.env.PROMEDIA_LRCLIB;
  assert.equal(hit, null);
  assert.equal(calls.length, 0, "disabled → no requests");
}

console.log("SMOKE_OK smoke-lrclib");
