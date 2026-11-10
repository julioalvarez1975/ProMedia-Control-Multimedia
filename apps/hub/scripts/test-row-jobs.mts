/**
 * Background row jobs: a row prepared in the background writes to its own
 * caches and progress, never to the agent the operator is looking at; the
 * finished result is flushed to its own file on disk.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptySubtitleAgentState } from "@promedia/shared";

const dataRoot = await mkdtemp(path.join(tmpdir(), "promedia-rowjobs-"));
process.env.SUBTITLE_DATA_ROOT = dataRoot;

const { sessionStore } = await import("../src/session-store.ts");
const { patchAgentForTest, runInBackgroundContextForTest } = await import("../src/subtitle-agent.ts");
const { recallReadyAgent } = await import("../src/subtitle-ready-cache.ts");
const {
  flushPersistedAgents,
  persistReadyAgent,
  setPersistMeta,
} = await import("../src/subtitle-aligned-store.ts");

const cue = (text: string) => ({ startMs: 0, endMs: 2000, text });
const { session } = sessionStore.create("lan");
for (const id of ["a", "b", "c"]) {
  session.playlist.items.push({
    id,
    type: "text",
    order: 0,
    payload: { title: id, align: "center", slides: [] },
  } as never);
}
const bgAgent = (itemId: string) => ({
  ...emptySubtitleAgentState("es"),
  enabled: true,
  itemId,
});

try {
  // Operator is on row "a" with finished cues.
  session.live.subtitleAgent = {
    ...emptySubtitleAgentState("es"),
    enabled: true,
    status: "ready",
    itemId: "a",
    assetId: "yt_AAAAAAAAAAA",
    cues: [cue("A line")],
  };

  // Row "b" progresses in the background.
  runInBackgroundContextForTest("b", bgAgent("b"), () => {
    patchAgentForTest(session, { status: "downloading", downloadPercent: 50 });
  });
  let live = session.live.subtitleAgent;
  assert.equal(live.itemId, "a", "background job does not change the focused row");
  assert.equal(live.cues[0]?.text, "A line", "focused cues are untouched");
  assert.equal(live.itemProgress?.b?.percent, 20, "row b shows its own download percent");
  assert.equal(live.itemProgress?.b?.bg, true, "row b is flagged as background");

  runInBackgroundContextForTest("b", bgAgent("b"), () => {
    patchAgentForTest(session, { status: "transcribing" });
  });
  assert.equal(session.live.subtitleAgent.itemProgress?.b?.percent, 70, "transcribing → 70");

  // Row "b" finishes: own memory cache + green, screen still on "a".
  runInBackgroundContextForTest("b", bgAgent("b"), () => {
    patchAgentForTest(session, {
      status: "ready",
      assetId: "yt_BBBBBBBBBBB",
      cues: [cue("B line")],
    });
  });
  live = session.live.subtitleAgent;
  assert.equal(live.itemProgress?.b?.ready, true, "row b is green");
  assert.equal(live.itemId, "a", "screen stays on row a");
  const cached = recallReadyAgent(session.id, "b", "yt_BBBBBBBBBBB", "es");
  assert.equal(cached?.cues[0]?.text, "B line", "row b has its own cache entry");
  assert.equal(recallReadyAgent(session.id, "a", "yt_AAAAAAAAAAA", "es")?.cues[0]?.text, "A line", "row a cache is independent");

  // The operator selects row "c" while it is being prepared: its progress
  // is mirrored, and its cues appear when it finishes.
  session.live.subtitleAgent = { ...session.live.subtitleAgent, itemId: "c", status: "idle", cues: [] };
  runInBackgroundContextForTest("c", bgAgent("c"), () => {
    patchAgentForTest(session, { status: "transcribing", hint: "cancionero_align" });
  });
  assert.equal(session.live.subtitleAgent.status, "transcribing", "focused row mirrors the job status");
  runInBackgroundContextForTest("c", bgAgent("c"), () => {
    patchAgentForTest(session, {
      status: "ready",
      assetId: "yt_CCCCCCCCCCC",
      cues: [cue("C line")],
    });
  });
  assert.equal(session.live.subtitleAgent.status, "ready", "focused row adopts the finished cues");
  assert.equal(session.live.subtitleAgent.cues[0]?.text, "C line");

  // Disk: each song is its own file, written on flush.
  for (const [id, text] of [["DDDDDDDDDDD", "D"], ["EEEEEEEEEEE", "E"]] as const) {
    setPersistMeta(`yt_${id}`, { songId: `song-${text}`, lyricsHash: `h${text}`, source: "cancionero" });
    persistReadyAgent({
      ...emptySubtitleAgentState("es"),
      enabled: true,
      status: "ready",
      itemId: text,
      assetId: `yt_${id}`,
      cues: [cue(`${text} line`)],
    });
  }
  await flushPersistedAgents();
  const files = (await readdir(path.join(dataRoot, "aligned"))).sort();
  assert.deepEqual(files, ["yt_DDDDDDDDDDD.es.json", "yt_EEEEEEEEEEE.es.json"], "one file per song");
  const d = JSON.parse(await readFile(path.join(dataRoot, "aligned", files[0]!), "utf8"));
  assert.equal(d.agent.cues[0].text, "D line", "file holds only its own song");
  console.log("all passed");
} finally {
  sessionStore.closeSession(session.id);
  await rm(dataRoot, { recursive: true, force: true });
}
