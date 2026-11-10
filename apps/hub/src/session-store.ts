import { getWatermarkMeta } from "./watermark-store.js";
import { deriveItemProgress } from "./subtitle-item-progress.js";
import { persistReadyAgent } from "./subtitle-aligned-store.js";
import { rememberReadyAgent } from "./subtitle-ready-cache.js";
import type {
  AudioPayload,
  BiblePayload,
  ClientRole,
  HubMessage,
  ImagePayload,
  MediaClock,
  PlaylistItem,
  PresentationPayload,
  SceneMode,
  SessionLiveState,
  SessionMode,
  SessionPlaylist,
  SessionSnapshot,
  SessionUpdatedPayload,
  SubtitleAgentState,
  TextPayload,
  ThemeBackground,
  ThemeId,
  ThemeOverrides,
  TransitionEffect,
  VideoPayload,
} from "@promedia/shared";
import {
  emptyLiveState,
  emptyPlaylist,
  emptySubtitleAgentState,
  isSubtitleFontSize,
  isSubtitleTimingMode,
  normalizeSubtitleLeadMs,
  isSceneMode,
  isThemeId,
  isTransitionEffect,
  itemProjectionSlideCount,
  normalizeThemeBackground,
  normalizeThemeOverrides,
} from "@promedia/shared";
import { validatePlaylistItem } from "@promedia/item-types/validate";
import { assetStore } from "./asset-store.js";
import { getBrandingLogoUpdatedAt } from "./branding-store.js";
import {
  generateAccessToken,
  generateSessionId,
  generateShortCode,
  generateWsTicket,
} from "./ids.js";

const EVENT_BUFFER_SIZE = 100;

export type WsTicketRecord = {
  ticket: string;
  sessionId: string;
  role: ClientRole;
  createdAt: string;
  /** Last time the ticket authenticated a request or its socket was alive. */
  lastUsedAt: number;
};

/** A ticket nobody uses for this long (and with no open socket) is released. */
export const TICKET_IDLE_MS = 10 * 60_000;

export type SessionRecord = {
  id: string;
  code: string;
  accessToken: string;
  mode: SessionMode;
  createdAt: string;
  seq: number;
  live: SessionLiveState;
  playlist: SessionPlaylist;
  lastTouchAt?: string;
  touchNote?: string;
  eventBuffer: HubMessage[];
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Re-index `order` in the given array order (do not re-sort). */
function withSequentialOrder(items: PlaylistItem[]): PlaylistItem[] {
  return items.map((item, index) => ({ ...item, order: index }));
}

/** Sort by existing `order`, then re-index 0…n-1. */
function sortItems(items: PlaylistItem[]): PlaylistItem[] {
  return withSequentialOrder(
    [...items].sort((a, b) => a.order - b.order),
  );
}

export class SessionStore {
  private readonly byId = new Map<string, SessionRecord>();
  private readonly byCode = new Map<string, string>();
  private readonly byAccessToken = new Map<string, string>();
  private readonly tickets = new Map<string, WsTicketRecord>();
  private readonly closeListeners: Array<(sessionId: string) => void> = [];
  /** Tickets whose WebSocket is currently open (never idle-released). */
  private readonly liveTickets = new Map<string, number>();

  create(mode: SessionMode = "lan"): {
    session: SessionRecord;
    ticket: WsTicketRecord;
  } {
    let code = generateShortCode(4);
    while (this.byCode.has(code)) {
      code = generateShortCode(4);
    }

    const id = generateSessionId();
    const accessToken = generateAccessToken();
    const createdAt = nowIso();

    const live = emptyLiveState();
    live.logoUpdatedAt = getBrandingLogoUpdatedAt();
    live.watermarkUpdatedAt = getWatermarkMeta()?.updatedAt ?? null;
    live.watermarkMime = getWatermarkMeta()?.mime ?? null;
    const session: SessionRecord = {
      id,
      code,
      accessToken,
      mode,
      createdAt,
      seq: 0,
      live,
      playlist: emptyPlaylist(),
      eventBuffer: [],
    };

    this.byId.set(id, session);
    this.byCode.set(code, id);
    this.byAccessToken.set(accessToken, id);

    const ticket = this.issueTicket(id, "control");
    return { session, ticket };
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.byId.get(sessionId);
  }

  findByCode(code: string): SessionRecord | undefined {
    const id = this.byCode.get(code.trim().toUpperCase());
    return id ? this.byId.get(id) : undefined;
  }

  findByAccessToken(accessToken: string): SessionRecord | undefined {
    const id = this.byAccessToken.get(accessToken);
    return id ? this.byId.get(id) : undefined;
  }

  issueTicket(sessionId: string, role: ClientRole): WsTicketRecord {
    const record: WsTicketRecord = {
      ticket: generateWsTicket(),
      sessionId,
      role,
      createdAt: nowIso(),
      lastUsedAt: Date.now(),
    };
    this.tickets.set(record.ticket, record);
    return record;
  }

  getTicket(ticket: string): WsTicketRecord | undefined {
    const rec = this.tickets.get(ticket);
    if (rec) rec.lastUsedAt = Date.now();
    return rec;
  }

  /** A socket authenticated with this ticket opened (+1) or closed (-1). */
  markTicketSocket(ticket: string, open: boolean): void {
    const n = (this.liveTickets.get(ticket) ?? 0) + (open ? 1 : -1);
    if (n > 0) this.liveTickets.set(ticket, n);
    else this.liveTickets.delete(ticket);
    const rec = this.tickets.get(ticket);
    if (rec) rec.lastUsedAt = Date.now();
  }

  /** Release tickets that are idle and have no open socket. Returns count. */
  releaseIdleTickets(now = Date.now(), idleMs = TICKET_IDLE_MS): number {
    let released = 0;
    for (const [ticket, rec] of this.tickets) {
      if (this.liveTickets.has(ticket)) continue;
      if (now - rec.lastUsedAt >= idleMs) {
        this.tickets.delete(ticket);
        released += 1;
      }
    }
    return released;
  }

  ticketCount(): number {
    return this.tickets.size;
  }

  /** Subscribe to session teardown (caches, jobs, files owned by the session). */
  onSessionClosed(listener: (sessionId: string) => void): void {
    this.closeListeners.push(listener);
  }

  /**
   * Close a session and revoke everything that grants access to it: join code,
   * access token and every WebSocket ticket. Returns false if it was unknown.
   */
  closeSession(sessionId: string): boolean {
    const session = this.byId.get(sessionId);
    if (!session) return false;
    this.byId.delete(sessionId);
    this.byCode.delete(session.code);
    this.byAccessToken.delete(session.accessToken);
    for (const [ticket, rec] of this.tickets) {
      if (rec.sessionId === sessionId) {
        this.tickets.delete(ticket);
        this.liveTickets.delete(ticket);
      }
    }
    for (const listener of this.closeListeners) {
      try {
        listener(sessionId);
      } catch (err) {
        console.warn(
          `[hub] session cleanup failed for ${sessionId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return true;
  }

  toSnapshot(session: SessionRecord): SessionSnapshot {
    // Keep live.logoUpdatedAt aligned with hub branding (new uploads / boot).
    const brandingAt = getBrandingLogoUpdatedAt();
    if (brandingAt && session.live.logoUpdatedAt !== brandingAt) {
      session.live.logoUpdatedAt = brandingAt;
    }
    const wm = getWatermarkMeta();
    if (wm && session.live.watermarkUpdatedAt !== wm.updatedAt) {
      session.live.watermarkUpdatedAt = wm.updatedAt;
      session.live.watermarkMime = wm.mime;
    }
    if (typeof session.live.watermarkEnabled !== "boolean") {
      session.live.watermarkEnabled = false;
    }
    return {
      id: session.id,
      code: session.code,
      mode: session.mode,
      createdAt: session.createdAt,
      seq: session.seq,
      live: { ...session.live },
      playlist: { items: session.playlist.items.map((item) => ({ ...item })) },
      lastTouchAt: session.lastTouchAt,
      touchNote: session.touchNote,
    };
  }

  /** Active sessions (for branding logo fan-out). */
  listSessions(): SessionRecord[] {
    return [...this.byId.values()];
  }

  /**
   * Stamp every live session with a new branding logo time and bump seq
   * so Control/Output refresh the logo image URL.
   */
  /** New watermark file: stamp every session, show it, bump seq. */
  applyWatermarkUpdated(meta: { updatedAt: string; mime: string }): HubMessage[] {
    const messages: HubMessage[] = [];
    for (const session of this.byId.values()) {
      session.live.watermarkUpdatedAt = meta.updatedAt;
      session.live.watermarkMime = meta.mime;
      session.live.watermarkEnabled = true;
      messages.push(this.bumpUpdated(session));
    }
    return messages;
  }

  applyBrandingLogoUpdatedAt(updatedAt: string): HubMessage[] {
    const messages: HubMessage[] = [];
    for (const session of this.byId.values()) {
      session.live.logoUpdatedAt = updatedAt;
      messages.push(this.bumpUpdated(session));
    }
    return messages;
  }

  makeMessage(
    session: SessionRecord,
    type: string,
    payload: unknown,
  ): HubMessage {
    return {
      type,
      seq: session.seq,
      sessionId: session.id,
      ts: nowIso(),
      payload,
    };
  }

  pushEvent(session: SessionRecord, message: HubMessage): void {
    session.eventBuffer.push(message);
    if (session.eventBuffer.length > EVENT_BUFFER_SIZE) {
      session.eventBuffer.splice(0, session.eventBuffer.length - EVENT_BUFFER_SIZE);
    }
  }

  private ensureSubtitleAgent(session: SessionRecord): SubtitleAgentState {
    if (!session.live.subtitleAgent) {
      session.live.subtitleAgent = emptySubtitleAgentState();
    } else {
      const agent = session.live.subtitleAgent;
      const fontOk = isSubtitleFontSize(agent.fontSize);
      const leadOk =
        typeof agent.leadMs === "number" &&
        Number.isFinite(agent.leadMs) &&
        agent.leadMs === normalizeSubtitleLeadMs(agent.leadMs);
      const timingOk = isSubtitleTimingMode(
        (agent as { timingMode?: unknown }).timingMode,
      );
      if (!fontOk || !leadOk || !timingOk) {
        session.live.subtitleAgent = {
          ...agent,
          fontSize: fontOk ? agent.fontSize : "md",
          leadMs: normalizeSubtitleLeadMs(agent.leadMs),
          timingMode: timingOk ? agent.timingMode : "exact",
        };
      }
    }
    return session.live.subtitleAgent;
  }

  private bumpUpdated(session: SessionRecord): HubMessage {
    this.ensureSubtitleAgent(session);
    session.seq += 1;
    const payload: SessionUpdatedPayload = {
      seq: session.seq,
      live: {
        ...session.live,
        subtitleAgent: { ...session.live.subtitleAgent },
      },
      playlist: { items: session.playlist.items.map((item) => ({ ...item })) },
      lastTouchAt: session.lastTouchAt,
      touchNote: session.touchNote,
    };
    const message = this.makeMessage(session, "session.updated", payload);
    this.pushEvent(session, message);
    return message;
  }

  /** Persist subtitleAgent field already mutated on session.live. */
  touchSubtitleAgent(session: SessionRecord): HubMessage {
    this.ensureSubtitleAgent(session);
    // Finished cues (incl. operator ←/→ retiming) are kept per item so a later
    // Go Live on that item restores them instantly instead of re-running the job.
    rememberReadyAgent(session.id, session.live.subtitleAgent);
    // …and on disk for YouTube videos, so a hub restart does not lose them.
    persistReadyAgent(session.live.subtitleAgent);
    session.live.subtitleAgent = {
      ...session.live.subtitleAgent,
      itemProgress: deriveItemProgress(
        session.id,
        session.live.subtitleAgent,
        session.playlist.items.map((i) => i.id),
      ),
    };
    return this.bumpUpdated(session);
  }

  touch(session: SessionRecord, note?: string): HubMessage {
    session.lastTouchAt = nowIso();
    if (note !== undefined) {
      session.touchNote = note;
    }
    return this.bumpUpdated(session);
  }

  /**
   * Replace session playlist with a validated snapshot (SavedPlaylist load).
   * Skips file items whose MediaAsset is missing in this session (text/YouTube OK).
   */
  replacePlaylist(
    session: SessionRecord,
    rawItems: unknown[],
  ):
    | { message: HubMessage; skipped: number }
    | { error: string } {
    const next: PlaylistItem[] = [];
    let skipped = 0;
    for (const raw of rawItems) {
      const item = validatePlaylistItem(raw);
      if (!item) {
        return { error: "invalid_item" };
      }
      const assetErr = this.requireAsset(session, item);
      if (assetErr) {
        if (assetErr.error === "unknown_asset") {
          skipped += 1;
          continue;
        }
        return assetErr;
      }
      next.push(item);
    }
    session.playlist.items = sortItems(next);
    if (
      session.live.currentItemId &&
      !session.playlist.items.some((i) => i.id === session.live.currentItemId)
    ) {
      session.live.currentItemId = null;
      session.live.currentSlideIndex = 0;
      session.live.mediaClock = null;
      session.live.sceneMode = "normal";
      session.live.videoCover = null;
    }
    return { message: this.bumpUpdated(session), skipped };
  }

  /**
   * ADD items from a guion file to the END of the current playlist (nothing is
   * removed, the live item and its clock are untouched). Items are re-id'd by
   * the caller; ones whose session asset no longer exists are skipped.
   */
  appendToPlaylist(
    session: SessionRecord,
    rawItems: unknown[],
  ):
    | { message: HubMessage; added: number; skipped: number }
    | { error: string } {
    const toAdd: PlaylistItem[] = [];
    let skipped = 0;
    const base = session.playlist.items.reduce(
      (max, i) => Math.max(max, i.order),
      -1,
    );
    for (const raw of rawItems) {
      const item = validatePlaylistItem(raw);
      if (!item) {
        return { error: "invalid_item" };
      }
      if (session.playlist.items.some((i) => i.id === item.id)) {
        return { error: "duplicate_id" };
      }
      const assetErr = this.requireAsset(session, item);
      if (assetErr) {
        if (assetErr.error === "unknown_asset") {
          skipped += 1;
          continue;
        }
        return assetErr;
      }
      toAdd.push({ ...item, order: base + 1 + toAdd.length });
    }
    session.playlist.items = sortItems([...session.playlist.items, ...toAdd]);
    return { message: this.bumpUpdated(session), added: toAdd.length, skipped };
  }

  addItem(session: SessionRecord, rawItem: unknown): HubMessage | { error: string } {
    const item = validatePlaylistItem(rawItem);
    if (!item) {
      return { error: "invalid_item" };
    }
    if (session.playlist.items.some((existing) => existing.id === item.id)) {
      return { error: "duplicate_id" };
    }
    const assetErr = this.requireAsset(session, item);
    if (assetErr) {
      return assetErr;
    }
    const order =
      session.playlist.items.length === 0
        ? 0
        : Math.max(...session.playlist.items.map((i) => i.order)) + 1;
    session.playlist.items = sortItems([
      ...session.playlist.items,
      { ...item, order },
    ]);
    return this.bumpUpdated(session);
  }

  updateItem(
    session: SessionRecord,
    id: string,
    patch: {
      payload?:
        | TextPayload
        | ImagePayload
        | VideoPayload
        | PresentationPayload
        | BiblePayload
        | AudioPayload;
      order?: number;
    },
  ): HubMessage | { error: string } {
    const idx = session.playlist.items.findIndex((i) => i.id === id);
    if (idx < 0) {
      return { error: "not_found" };
    }
    const current = session.playlist.items[idx]!;
    const nextRaw = {
      id: current.id,
      type: current.type,
      order: patch.order ?? current.order,
      payload: patch.payload ?? current.payload,
    };
    const validated = validatePlaylistItem(nextRaw);
    if (!validated) {
      return { error: "invalid_item" };
    }
    const assetErr = this.requireAsset(session, validated);
    if (assetErr) {
      return assetErr;
    }
    const items = [...session.playlist.items];
    items[idx] = validated;
    session.playlist.items = sortItems(items);
    return this.bumpUpdated(session);
  }

  removeItem(session: SessionRecord, id: string): HubMessage | { error: string } {
    const before = session.playlist.items.length;
    session.playlist.items = sortItems(
      session.playlist.items.filter((item) => item.id !== id),
    );
    if (session.playlist.items.length === before) {
      return { error: "not_found" };
    }
    if (session.live.currentItemId === id) {
      session.live.currentItemId = null;
      session.live.currentSlideIndex = 0;
      session.live.mediaClock = null;
      session.live.videoCover = null;
    }
    return this.bumpUpdated(session);
  }

  reorder(session: SessionRecord, orderedIds: string[]): HubMessage | { error: string } {
    if (orderedIds.length !== session.playlist.items.length) {
      return { error: "invalid_reorder" };
    }
    const byId = new Map(session.playlist.items.map((i) => [i.id, i]));
    const next: PlaylistItem[] = [];
    for (const id of orderedIds) {
      const item = byId.get(id);
      if (!item) {
        return { error: "invalid_reorder" };
      }
      next.push(item);
      byId.delete(id);
    }
    if (byId.size > 0) {
      return { error: "invalid_reorder" };
    }
    // Keep client order — sortItems() would undo the drag by old `order` values.
    session.playlist.items = withSequentialOrder(next);
    return this.bumpUpdated(session);
  }

  goLive(session: SessionRecord, itemId: string): HubMessage | { error: string } {
    const item = session.playlist.items.find((i) => i.id === itemId);
    if (!item) {
      return { error: "not_found" };
    }
    if (
      item.type !== "text" &&
      item.type !== "image" &&
      item.type !== "video" &&
      item.type !== "audio" &&
      item.type !== "bible" &&
      item.type !== "presentation"
    ) {
      return { error: "unsupported_type" };
    }
    // The cover belongs to the item it was set on: another item starts clean.
    if (session.live.currentItemId !== itemId) {
      session.live.videoCover = null;
    }
    session.live.currentItemId = itemId;
    session.live.currentSlideIndex = 0;
    // Julio lock: Go Live resets sceneMode to normal
    session.live.sceneMode = "normal";
    // En vivo → audio on: clear muted / force autoplay so Output starts with sound.
    if (item.type === "video") {
      const idx = session.playlist.items.findIndex((i) => i.id === itemId);
      if (
        idx >= 0 &&
        (item.payload.muted === true || item.payload.autoplay === false)
      ) {
        const current = session.playlist.items[idx]!;
        if (current.type === "video") {
          session.playlist.items[idx] = {
            ...current,
            payload: {
              ...current.payload,
              muted: false,
              autoplay: true,
            },
          };
        }
      }
      session.live.mediaClock = {
        itemId,
        playing: true,
        positionMs: 0,
        rate: 1,
        updatedAt: nowIso(),
      };
    } else if (item.type === "audio") {
      const idx = session.playlist.items.findIndex((i) => i.id === itemId);
      if (idx >= 0 && item.payload.autoplay === false) {
        const current = session.playlist.items[idx]!;
        if (current.type === "audio") {
          session.playlist.items[idx] = {
            ...current,
            payload: {
              ...current.payload,
              autoplay: true,
            },
          };
        }
      }
      session.live.mediaClock = {
        itemId,
        playing: true,
        positionMs: 0,
        rate: 1,
        updatedAt: nowIso(),
      };
    } else {
      session.live.mediaClock = null;
    }
    return this.bumpUpdated(session);
  }

  clearLive(session: SessionRecord): HubMessage {
    session.live.currentItemId = null;
    session.live.currentSlideIndex = 0;
    session.live.mediaClock = null;
    session.live.videoCover = null;
    session.live.sceneMode = "normal";
    // Keep the subtitle agent state: stopping the projection (black) must not
    // wipe the aligned cues. Wiping made Control re-target the agent and re-run
    // the whole download / scan / align job, which then raced the next Go Live.
    // SubtitleOverlay only renders for the live item, so stale cues are never shown.
    this.ensureSubtitleAgent(session);
    return this.bumpUpdated(session);
  }


  setSceneMode(
    session: SessionRecord,
    sceneMode: SceneMode | unknown,
  ): HubMessage | { error: string } {
    if (!isSceneMode(sceneMode)) {
      return { error: "invalid_scene_mode" };
    }
    // Overlay only — does not touch currentItemId or mediaClock (Q1/Q2)
    session.live.sceneMode = sceneMode;
    return this.bumpUpdated(session);
  }

  /**
   * Image cover over the live video/audio (under the subtitle). Overlay only:
   * does not touch currentItemId or mediaClock, so playback never stops.
   * - `assetId` string: choose that session image (active unless active:false)
   * - `assetId` null: forget the cover
   * - only `active`: toggle the current image
   */
  setVideoCover(
    session: SessionRecord,
    patch: { assetId?: string | null; active?: boolean; background?: boolean },
  ): HubMessage | { error: string } {
    const live = session.live;
    const current = live.currentItemId
      ? session.playlist.items.find((i) => i.id === live.currentItemId)
      : null;
    if (!current || (current.type !== "video" && current.type !== "audio")) {
      return { error: "no_av_live" };
    }
    // The animated stage background itself (no image): above the video, under
    // the subtitle.
    if (patch.background === true) {
      live.videoCover = { assetId: null, active: patch.active !== false };
      return this.bumpUpdated(session);
    }
    if (patch.assetId === null) {
      live.videoCover = null;
      return this.bumpUpdated(session);
    }
    if (typeof patch.assetId === "string") {
      const asset = assetStore.get(session.id, patch.assetId);
      if (!asset || asset.kind !== "image") {
        return { error: "cover_asset_not_found" };
      }
      live.videoCover = {
        assetId: asset.id,
        active: patch.active !== false,
      };
      return this.bumpUpdated(session);
    }
    if (typeof patch.active === "boolean") {
      if (!live.videoCover) {
        return { error: "no_cover_image" };
      }
      live.videoCover = { ...live.videoCover, active: patch.active };
      return this.bumpUpdated(session);
    }
    return { error: "invalid_video_cover" };
  }

  setWatermark(
    session: SessionRecord,
    enabled: unknown,
  ): HubMessage | { error: string } {
    if (typeof enabled !== "boolean") {
      return { error: "invalid_watermark" };
    }
    session.live.watermarkEnabled = enabled;
    return this.bumpUpdated(session);
  }

  setTheme(
    session: SessionRecord,
    patch: {
      themeId?: ThemeId;
      themeOverrides?: ThemeOverrides | null;
      themeBackground?: ThemeBackground | null;
      transitionEffect?: TransitionEffect;
    },
  ): HubMessage | { error: string } {
    if (patch.themeId !== undefined) {
      if (!isThemeId(patch.themeId)) {
        return { error: "invalid_theme_id" };
      }
      session.live.themeId = patch.themeId;
      // Switching preset clears overrides unless caller also sends overrides
      if (patch.themeOverrides === undefined) {
        session.live.themeOverrides = null;
      }
    }
    if (patch.themeOverrides !== undefined) {
      if (patch.themeOverrides === null) {
        session.live.themeOverrides = null;
      } else {
        const normalized = normalizeThemeOverrides(patch.themeOverrides);
        if (normalized === null && Object.keys(patch.themeOverrides).length > 0) {
          return { error: "invalid_theme_overrides" };
        }
        session.live.themeOverrides = normalized;
      }
    }
    if (patch.themeBackground !== undefined) {
      session.live.themeBackground = normalizeThemeBackground(
        patch.themeBackground,
      );
    }
    if (patch.transitionEffect !== undefined) {
      if (!isTransitionEffect(patch.transitionEffect)) {
        return { error: "invalid_transition_effect" };
      }
      session.live.transitionEffect = patch.transitionEffect;
    }
    if (
      patch.themeId === undefined &&
      patch.themeOverrides === undefined &&
      patch.themeBackground === undefined &&
      patch.transitionEffect === undefined
    ) {
      return { error: "empty_theme_patch" };
    }
    return this.bumpUpdated(session);
  }

  setSlide(session: SessionRecord, index: number): HubMessage | { error: string } {
    const itemId = session.live.currentItemId;
    if (!itemId) {
      return { error: "no_live_item" };
    }
    const item = session.playlist.items.find((i) => i.id === itemId);
    if (
      !item ||
      (item.type !== "text" &&
        item.type !== "bible" &&
        item.type !== "presentation")
    ) {
      return { error: "no_live_item" };
    }
    const max = Math.max(itemProjectionSlideCount(item) - 1, 0);
    const clamped = Math.min(Math.max(Math.trunc(index), 0), max);
    session.live.currentSlideIndex = clamped;
    return this.bumpUpdated(session);
  }

  setMediaClock(
    session: SessionRecord,
    patch: { playing: boolean; positionMs?: number },
  ): HubMessage | { error: string } {
    const itemId = session.live.currentItemId;
    if (!itemId) {
      return { error: "no_live_item" };
    }
    const item = session.playlist.items.find((i) => i.id === itemId);
    if (!item || (item.type !== "video" && item.type !== "audio")) {
      return { error: "no_video_live" };
    }
    const prev = session.live.mediaClock;
    const positionMs =
      typeof patch.positionMs === "number" && Number.isFinite(patch.positionMs)
        ? Math.max(0, patch.positionMs)
        : (prev?.positionMs ?? 0);
    const clock: MediaClock = {
      itemId,
      playing: patch.playing,
      positionMs,
      rate: prev?.rate ?? 1,
      updatedAt: nowIso(),
    };
    session.live.mediaClock = clock;
    return this.bumpUpdated(session);
  }

  private requireAsset(
    session: SessionRecord,
    item: PlaylistItem,
  ): { error: string } | null {
    if (item.type === "image") {
      const asset = assetStore.get(session.id, item.payload.assetId);
      if (!asset || asset.kind !== "image") {
        return { error: "unknown_asset" };
      }
    }
    if (item.type === "video" && item.payload.sourceKind === "file") {
      const asset = assetStore.get(session.id, item.payload.assetId);
      if (!asset || asset.kind !== "video") {
        return { error: "unknown_asset" };
      }
    }
    if (item.type === "audio") {
      const asset = assetStore.get(session.id, item.payload.assetId);
      if (!asset || asset.kind !== "audio") {
        return { error: "unknown_asset" };
      }
    }
    if (item.type === "presentation") {
      for (const slide of item.payload.slides) {
        const asset = assetStore.get(session.id, slide.assetId);
        if (!asset || asset.kind !== "image") {
          return { error: "unknown_asset" };
        }
      }
    }
    return null;
  }

  eventsAfter(session: SessionRecord, lastSeq: number): HubMessage[] | null {
    if (session.eventBuffer.length === 0) {
      return null;
    }
    const oldest = session.eventBuffer[0]?.seq ?? 0;
    if (lastSeq + 1 < oldest) {
      return null;
    }
    return session.eventBuffer.filter((m) => m.seq > lastSeq);
  }
}

export const sessionStore = new SessionStore();
