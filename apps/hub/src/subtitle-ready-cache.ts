/**
 * Per-session cache of finished subtitle-agent results, keyed by Guion item.
 *
 * The agent state holds ONE item's cues at a time. Without this, every Go Live
 * on a different song re-ran the whole job (lookup → download → silence scan →
 * align: 8–20 s even with warm disk caches) and the karaoke started late.
 * With it, an item that was already aligned is restored instantly.
 */
import type { SubtitleAgentState, SubtitleTargetLang } from "@promedia/shared";

const MAX_ITEMS_PER_SESSION = 24;
const bySession = new Map<string, Map<string, SubtitleAgentState>>();

function clone(agent: SubtitleAgentState): SubtitleAgentState {
  return { ...agent, cues: agent.cues.map((c) => ({ ...c })) };
}

/** Store the agent when it holds finished, usable cues for an item. */
export function rememberReadyAgent(
  sessionId: string,
  agent: SubtitleAgentState | null | undefined,
): void {
  if (
    !agent ||
    agent.status !== "ready" ||
    !agent.itemId ||
    !agent.assetId ||
    agent.cues.length === 0
  ) {
    return;
  }
  let items = bySession.get(sessionId);
  if (!items) {
    items = new Map();
    bySession.set(sessionId, items);
  }
  items.delete(agent.itemId); // keep insertion order = recency
  items.set(agent.itemId, clone(agent));
  while (items.size > MAX_ITEMS_PER_SESSION) {
    const oldest = items.keys().next().value;
    if (oldest === undefined) break;
    items.delete(oldest);
  }
}

/** Cached result for this item, only if asset and target language still match. */
export function recallReadyAgent(
  sessionId: string,
  itemId: string,
  assetId: string,
  targetLang: SubtitleTargetLang,
): SubtitleAgentState | null {
  const hit = bySession.get(sessionId)?.get(itemId);
  if (!hit || hit.assetId !== assetId || hit.targetLang !== targetLang) {
    return null;
  }
  const healthy = hit.cues.every(
    (c) =>
      Number.isFinite(c.startMs) &&
      Number.isFinite(c.endMs) &&
      c.endMs > c.startMs &&
      Boolean(String(c.text ?? "").trim()),
  );
  return healthy ? clone(hit) : null;
}

/** Drop one item (or the whole session) — e.g. operator taught a new song. */
export function forgetReadyAgent(sessionId: string, itemId?: string): void {
  if (!itemId) {
    bySession.delete(sessionId);
    return;
  }
  bySession.get(sessionId)?.delete(itemId);
}
