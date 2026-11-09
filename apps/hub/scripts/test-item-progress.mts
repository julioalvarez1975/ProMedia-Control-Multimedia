/**
 * Per-item karaoke readiness (Guion rows) + yt-dlp percent parsing.
 */
import {
  emptySubtitleAgentState,
  subtitleOverallPercent,
  type SubtitleAgentState,
} from "@promedia/shared";
import { deriveItemProgress, forgetItemProgress } from "../src/subtitle-item-progress.ts";
import { parseYtDlpPercent } from "../src/subtitle-youtube.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
}

const SID = "s1";
const ids = ["a", "b"];
const agent = (p: Partial<SubtitleAgentState>): SubtitleAgentState => ({
  ...emptySubtitleAgentState(),
  enabled: true,
  ...p,
});
const cue = { startMs: 0, endMs: 1000, text: "x" };

// percent bands
assert(subtitleOverallPercent("downloading", 50) === 20, "download 50% → 20 overall");
assert(subtitleOverallPercent("downloading", 100) === 40, "download 100% → 40 overall");
assert(subtitleOverallPercent("transcribing") === 70, "transcribing → 70");
assert(subtitleOverallPercent("ready") === 100, "ready → 100");

// yt-dlp output parsing
assert(parseYtDlpPercent("[download]   7.5% of 3.2MiB at 1MiB/s\n[download]  42.3% of 3.2MiB") === 42.3, "parses last percent");
assert(parseYtDlpPercent("[download] Destination: x.m4a") === null, "no percent → null");

// rising, never down while busy
let m = deriveItemProgress(SID, agent({ itemId: "a", status: "downloading", downloadPercent: 50 }), ids);
assert(m.a?.percent === 20 && !m.a.ready, "downloading 50% → 20, not ready");
m = deriveItemProgress(SID, agent({ itemId: "a", status: "downloading", downloadPercent: 10 }), ids);
assert(m.a?.percent === 20, "percent never goes down");
m = deriveItemProgress(SID, agent({ itemId: "a", status: "transcribing" }), ids);
assert(m.a?.percent === 70, "transcribing → 70");

// ready only with cues → 100 + ready
m = deriveItemProgress(SID, agent({ itemId: "a", status: "ready", cues: [cue] }), ids);
assert(m.a?.percent === 100 && m.a.ready === true, "ready with cues → 100 ready");

// another item takes over: unfinished previous one becomes stale, finished stays
m = deriveItemProgress(SID, agent({ itemId: "b", status: "downloading", downloadPercent: 20 }), ids);
assert(m.a?.ready === true && !m.a.stale, "finished item stays ready");
m = deriveItemProgress(SID, agent({ itemId: "a", status: "ready", cues: [cue] }), ids);
m = deriveItemProgress(SID, agent({ itemId: "b", status: "transcribing" }), ids);
m = deriveItemProgress(SID, agent({ itemId: "a", status: "ready", cues: [cue] }), ids);
assert(m.b?.stale === true && m.b.percent === 70, "unfinished item goes stale keeping its percent");

// failure
m = deriveItemProgress(SID, agent({ itemId: "b", status: "error" }), ids);
assert(m.b?.failed === true && !m.b.ready, "error → failed");

// removed items disappear; agent off clears
m = deriveItemProgress(SID, agent({ itemId: "a", status: "ready", cues: [cue] }), ["a"]);
assert(!("b" in m), "item removed from the Guion is dropped");
m = deriveItemProgress(SID, agent({ enabled: false, status: "off" }), ids);
assert(Object.keys(m).length === 0, "agent off clears progress");

forgetItemProgress(SID);
console.log("all passed");
