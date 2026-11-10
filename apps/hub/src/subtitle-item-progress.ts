/**
 * Per-item karaoke readiness for the Guion rows. Derived from the agent state
 * on every broadcast (`SessionStore.touchSubtitleAgent`), so every path —
 * live job, restore from cache/disk, error — feeds it without extra wiring.
 *
 * The map lives here (not on the agent object) because restores replace the
 * whole agent state with an older snapshot; the map must survive that.
 */
import {
  subtitleOverallPercent,
  type SubtitleAgentState,
  type SubtitleItemProgress,
} from "@promedia/shared";

const bySession = new Map<string, Map<string, SubtitleItemProgress>>();
const lastItemBySession = new Map<string, string | null>();

export function forgetItemProgress(sessionId: string): void {
  bySession.delete(sessionId);
  lastItemBySession.delete(sessionId);
}

/**
 * Update the map from the agent state and return the object to expose.
 * `playlistItemIds` drops rows that no longer exist in the Guion.
 */
export function deriveItemProgress(
  sessionId: string,
  agent: SubtitleAgentState,
  playlistItemIds: readonly string[],
): Record<string, SubtitleItemProgress> {
  if (!agent.enabled || agent.status === "off") {
    bySession.delete(sessionId);
    lastItemBySession.delete(sessionId);
    return {};
  }
  let map = bySession.get(sessionId);
  if (!map) {
    map = new Map();
    bySession.set(sessionId, map);
  }
  const live = new Set(playlistItemIds);
  for (const id of [...map.keys()]) {
    if (!live.has(id)) map.delete(id);
  }

  const itemId = agent.itemId;
  const prevItem = lastItemBySession.get(sessionId) ?? null;
  // The agent moved to another item: the previous one, if unfinished, keeps
  // its last percent but is flagged stale (its job may have been replaced).
  if (prevItem && prevItem !== itemId) {
    const prev = map.get(prevItem);
    if (prev && !prev.ready && !prev.failed && !prev.bg) {
      map.set(prevItem, { ...prev, stale: true });
    }
  }
  lastItemBySession.set(sessionId, itemId);

  if (itemId && live.has(itemId) && agent.status !== "idle") {
    const before = map.get(itemId);
    if (agent.status === "ready" && agent.cues.length > 0) {
      map.set(itemId, { percent: 100, ready: true });
    } else if (agent.status === "error" || agent.status === "unsupported") {
      map.set(itemId, { percent: before?.percent ?? 0, ready: false, failed: true });
    } else {
      const computed = subtitleOverallPercent(agent.status, agent.downloadPercent);
      // Rising only; a finished item that is re-run restarts from its phase.
      const base = before && !before.ready && !before.failed ? before.percent : 0;
      map.set(itemId, {
        percent: Math.max(computed, base),
        ready: false,
        ...(before?.bg ? { bg: true } : {}),
      });
    }
  } else if (itemId && live.has(itemId) && agent.status === "idle" && !map.has(itemId)) {
    map.set(itemId, { percent: 0, ready: false });
  }
  return Object.fromEntries(map);
}

/**
 * Mark rows as ready (green 100 %) without touching the agent: songs whose
 * aligned karaoke is already cached (memory or disk). Never downgrades.
 */
export function markItemsReady(sessionId: string, itemIds: readonly string[]): boolean {
  let map = bySession.get(sessionId);
  if (!map) {
    map = new Map();
    bySession.set(sessionId, map);
  }
  let changed = false;
  for (const id of itemIds) {
    if (map.get(id)?.ready) continue;
    map.set(id, { percent: 100, ready: true });
    changed = true;
  }
  return changed;
}

export function isItemReady(sessionId: string, itemId: string): boolean {
  return bySession.get(sessionId)?.get(itemId)?.ready === true;
}

/**
 * Progress reported by a background row job (hub queue). Rising only; ready and
 * failed are final for that run. Returns true when the stored value changed.
 */
export function setBgProgress(
  sessionId: string,
  itemId: string,
  next: { percent: number; ready: boolean; failed?: boolean },
): boolean {
  let map = bySession.get(sessionId);
  if (!map) {
    map = new Map();
    bySession.set(sessionId, map);
  }
  const before = map.get(itemId);
  let rec: SubtitleItemProgress;
  if (next.ready) rec = { percent: 100, ready: true, bg: true };
  else if (next.failed) rec = { percent: before?.percent ?? 0, ready: false, failed: true, bg: true };
  else {
    const base = before && !before.ready && !before.failed ? before.percent : 0;
    rec = { percent: Math.max(next.percent, base), ready: false, bg: true };
  }
  if (
    before &&
    before.percent === rec.percent &&
    before.ready === rec.ready &&
    before.failed === rec.failed
  ) {
    return false;
  }
  map.set(itemId, rec);
  return true;
}
