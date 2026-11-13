import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ClientRole,
  ClientToHubMessage,
  ErrorPayload,
  HubMessage,
  ImagePayload,
  PlaylistItem,
  TextPayload,
  VideoPayload,
} from "@promedia/shared";
import {
  isSceneMode,
  isSubtitleFontSize,
  isSubtitleTargetLang,
  isThemeId,
  isTransitionEffect,
  normalizeSubtitleLeadMs,
  normalizeThemeBackground,
  normalizeThemeOverrides,
} from "@promedia/shared";
import {
  maybeRefreshSubtitleAgent,
  maybeStartKaraokeOnGuionItem,
  nudgeSubtitleCancionero,
  saveLrclibLyricsToLibrary,
  setSubtitleAgent,
} from "./subtitle-agent.js";
import { sessionStore, type SessionRecord } from "./session-store.js";

/** Last player→hub clock report per session (diagnostics only). */
const clockReports = new Map<
  string,
  { lastAt: number; lastLogAt: number; goAt: number }
>();

function noteClockReport(
  sessionId: string,
  role: string,
  payload: { playing?: boolean; positionMs?: number } | undefined,
): void {
  const now = Date.now();
  const rec = clockReports.get(sessionId) ?? { lastAt: 0, lastLogAt: 0, goAt: 0 };
  rec.lastAt = now;
  if (now - rec.lastLogAt >= 5_000) {
    rec.lastLogAt = now;
    console.log(
      `[hub] mediaClock report from=${role} playing=${payload?.playing ?? "-"} pos=${
        typeof payload?.positionMs === "number"
          ? (payload.positionMs / 1000).toFixed(1) + "s"
          : "-"
      }`,
    );
  }
  clockReports.set(sessionId, rec);
}

/** Forget diagnostics of a closed session. */
export function forgetClockReports(sessionId: string): void {
  clockReports.delete(sessionId);
}

/** After Go Live on A/V: warn if the player never reports its playback time. */
function watchClockAfterGoLive(sessionId: string): void {
  const rec = clockReports.get(sessionId) ?? { lastAt: 0, lastLogAt: 0, goAt: 0 };
  rec.goAt = Date.now();
  clockReports.set(sessionId, rec);
  const goAt = rec.goAt;
  setTimeout(() => {
    const cur = clockReports.get(sessionId);
    if (cur && cur.goAt === goAt && cur.lastAt < goAt) {
      console.warn(
        "[hub] sin reloj del reproductor 10 s después de En vivo: Output cerrada o sin conexión, o YouTube bloqueó el autoplay (hacé clic en Output). Los subtítulos no avanzarán.",
      );
    }
  }, 10_000).unref?.();
}

type ClientConn = {
  ws: WebSocket;
  sessionId: string;
  role: ClientRole;
  lastSeq: number;
};

function send(ws: WebSocket, message: HubMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(
  ws: WebSocket,
  sessionId: string,
  seq: number,
  code: string,
  message: string,
): void {
  const payload: ErrorPayload = { code, message };
  send(ws, {
    type: "error",
    seq,
    sessionId,
    ts: new Date().toISOString(),
    payload,
  });
}

function parseClientMessage(raw: string): ClientToHubMessage | null {
  try {
    const data = JSON.parse(raw) as { type?: string; payload?: unknown };
    if (!data || typeof data.type !== "string") {
      return null;
    }
    const type = data.type;
    const payload = data.payload;

    if (type === "client.hello") {
      return { type: "client.hello", payload: payload as Record<string, unknown> };
    }
    if (type === "client.resync") {
      const lastSeq = (payload as { lastSeq?: unknown } | undefined)?.lastSeq;
      if (typeof lastSeq !== "number" || !Number.isFinite(lastSeq)) {
        return null;
      }
      return { type: "client.resync", payload: { lastSeq } };
    }
    if (type === "session.touch") {
      const note = (payload as { note?: unknown } | undefined)?.note;
      return {
        type: "session.touch",
        payload: typeof note === "string" ? { note } : {},
      };
    }
    if (type === "playlist.itemAdd") {
      const item = (payload as { item?: unknown } | undefined)?.item;
      if (!item) {
        return null;
      }
      return { type: "playlist.itemAdd", payload: { item: item as PlaylistItem } };
    }
    if (type === "playlist.itemUpdate") {
      const p = payload as { id?: unknown; patch?: unknown } | undefined;
      if (!p || typeof p.id !== "string" || !p.patch || typeof p.patch !== "object") {
        return null;
      }
      return {
        type: "playlist.itemUpdate",
        payload: {
          id: p.id,
          patch: p.patch as {
            payload?: TextPayload | ImagePayload | VideoPayload;
            order?: number;
          },
        },
      };
    }
    if (type === "playlist.itemRemove") {
      const id = (payload as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string") {
        return null;
      }
      return { type: "playlist.itemRemove", payload: { id } };
    }
    if (type === "playlist.reorder") {
      const orderedIds = (payload as { orderedIds?: unknown } | undefined)?.orderedIds;
      if (
        !Array.isArray(orderedIds) ||
        !orderedIds.every((id) => typeof id === "string")
      ) {
        return null;
      }
      return { type: "playlist.reorder", payload: { orderedIds } };
    }
    if (type === "live.go") {
      const itemId = (payload as { itemId?: unknown } | undefined)?.itemId;
      if (typeof itemId !== "string") {
        return null;
      }
      return { type: "live.go", payload: { itemId } };
    }
    if (type === "live.clear") {
      return { type: "live.clear", payload: {} };
    }
    if (type === "live.setSlide") {
      const index = (payload as { index?: unknown } | undefined)?.index;
      if (typeof index !== "number" || !Number.isFinite(index)) {
        return null;
      }
      return { type: "live.setSlide", payload: { index } };
    }
    if (type === "live.mediaClock.set") {
      const p = payload as { playing?: unknown; positionMs?: unknown } | undefined;
      if (!p || typeof p.playing !== "boolean") {
        return null;
      }
      const positionMs =
        typeof p.positionMs === "number" && Number.isFinite(p.positionMs)
          ? p.positionMs
          : undefined;
      return {
        type: "live.mediaClock.set",
        payload: { playing: p.playing, positionMs },
      };
    }
    if (type === "live.subtitleAgent.set") {
      const p = payload as {
        enabled?: unknown;
        targetLang?: unknown;
        fontSize?: unknown;
        leadMs?: unknown;
        itemId?: unknown;
      } | undefined;
      if (!p) {
        return null;
      }
      const out: {
        enabled?: boolean;
        targetLang?: import("@promedia/shared").SubtitleTargetLang;
        fontSize?: import("@promedia/shared").SubtitleFontSize;
        leadMs?: import("@promedia/shared").SubtitleLeadMs;
        itemId?: string;
      } = {};
      if (p.enabled !== undefined) {
        if (typeof p.enabled !== "boolean") {
          return null;
        }
        out.enabled = p.enabled;
      }
      if (p.targetLang !== undefined) {
        if (!isSubtitleTargetLang(p.targetLang)) {
          return null;
        }
        out.targetLang = p.targetLang;
      }
      if (p.fontSize !== undefined) {
        if (!isSubtitleFontSize(p.fontSize)) {
          return null;
        }
        out.fontSize = p.fontSize;
      }
      if (p.leadMs !== undefined) {
        if (typeof p.leadMs !== "number" || !Number.isFinite(p.leadMs)) {
          return null;
        }
        // Accept signed presets and legacy positive “how early” ms.
        out.leadMs = normalizeSubtitleLeadMs(p.leadMs);
      }
      if (p.itemId !== undefined) {
        if (typeof p.itemId !== "string") {
          return null;
        }
        out.itemId = p.itemId;
      }
      if (
        out.enabled === undefined &&
        out.targetLang === undefined &&
        out.fontSize === undefined &&
        out.leadMs === undefined &&
        out.itemId === undefined
      ) {
        return null;
      }
      return { type: "live.subtitleAgent.set", payload: out };
    }
    if (type === "live.subtitleAgent.saveLyrics") {
      return { type: "live.subtitleAgent.saveLyrics", payload: {} };
    }
    if (type === "live.subtitleAgent.nudge") {
      const p = payload as {
        delta?: unknown;
        positionMs?: unknown;
        itemId?: unknown;
      } | undefined;
      if (!p || (p.delta !== -1 && p.delta !== 1)) {
        return null;
      }
      const out: {
        delta: -1 | 1;
        positionMs?: number;
        itemId?: string;
      } = { delta: p.delta };
      if (p.positionMs !== undefined) {
        if (typeof p.positionMs !== "number" || !Number.isFinite(p.positionMs)) {
          return null;
        }
        out.positionMs = Math.max(0, p.positionMs);
      }
      if (p.itemId !== undefined) {
        if (typeof p.itemId !== "string") {
          return null;
        }
        out.itemId = p.itemId;
      }
      return { type: "live.subtitleAgent.nudge", payload: out };
    }
    if (type === "live.setLyricOverlay") {
      const p = payload as { itemId?: unknown; lineIndex?: unknown } | undefined;
      if (!p) {
        return null;
      }
      if (p.itemId !== null && typeof p.itemId !== "string") {
        return null;
      }
      const out: { itemId: string | null; lineIndex?: number } = {
        itemId: p.itemId === null ? null : p.itemId,
      };
      if (p.lineIndex !== undefined) {
        if (typeof p.lineIndex !== "number" || !Number.isFinite(p.lineIndex)) {
          return null;
        }
        out.lineIndex = Math.max(0, Math.trunc(p.lineIndex));
      }
      return { type: "live.setLyricOverlay", payload: out };
    }
    if (type === "live.setSceneMode") {
      const sceneMode = (payload as { sceneMode?: unknown } | undefined)?.sceneMode;
      if (!isSceneMode(sceneMode)) {
        return null;
      }
      return { type: "live.setSceneMode", payload: { sceneMode } };
    }
    if (type === "live.setVideoCover") {
      const p = payload as
        | { assetId?: unknown; active?: unknown; background?: unknown }
        | undefined;
      const out: { assetId?: string | null; active?: boolean; background?: boolean } = {};
      if (p?.background === true) out.background = true;
      else if (p?.background !== undefined) return null;
      if (p?.assetId === null) out.assetId = null;
      else if (typeof p?.assetId === "string" && p.assetId.length > 0 && p.assetId.length <= 64) {
        out.assetId = p.assetId;
      } else if (p?.assetId !== undefined) {
        return null;
      }
      if (typeof p?.active === "boolean") out.active = p.active;
      else if (p?.active !== undefined) return null;
      if (out.assetId === undefined && out.active === undefined && !out.background) return null;
      return { type: "live.setVideoCover", payload: out };
    }
    if (type === "live.setWatermark") {
      const enabled = (payload as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== "boolean") {
        return null;
      }
      return { type: "live.setWatermark", payload: { enabled } };
    }
    if (type === "live.setTheme") {
      const p = payload as {
        themeId?: unknown;
        themeOverrides?: unknown;
        themeBackground?: unknown;
        transitionEffect?: unknown;
      } | undefined;
      if (!p) {
        return null;
      }
      const out: {
        themeId?: import("@promedia/shared").ThemeId;
        themeOverrides?: import("@promedia/shared").ThemeOverrides | null;
        themeBackground?: import("@promedia/shared").ThemeBackground | null;
        transitionEffect?: import("@promedia/shared").TransitionEffect;
      } = {};
      if (p.themeId !== undefined) {
        if (!isThemeId(p.themeId)) {
          return null;
        }
        out.themeId = p.themeId;
      }
      if (p.themeOverrides !== undefined) {
        if (p.themeOverrides === null) {
          out.themeOverrides = null;
        } else {
          const n = normalizeThemeOverrides(p.themeOverrides);
          if (n === null) {
            // allow empty object as clear
            out.themeOverrides = null;
          } else {
            out.themeOverrides = n;
          }
        }
      }
      if (p.themeBackground !== undefined) {
        if (p.themeBackground === null) {
          out.themeBackground = { mode: "solid" };
        } else {
          out.themeBackground = normalizeThemeBackground(p.themeBackground);
        }
      }
      if (p.transitionEffect !== undefined) {
        if (!isTransitionEffect(p.transitionEffect)) {
          return null;
        }
        out.transitionEffect = p.transitionEffect;
      }
      if (
        out.themeId === undefined &&
        out.themeOverrides === undefined &&
        out.themeBackground === undefined &&
        out.transitionEffect === undefined
      ) {
        return null;
      }
      return { type: "live.setTheme", payload: out };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Grace before an empty session is closed (page reload / brief reconnect).
 * PROMEDIA_SESSION_GRACE_MS=0 closes the moment the last client leaves.
 */
export function sessionGraceMs(): number {
  const raw = process.env.PROMEDIA_SESSION_GRACE_MS;
  if (raw === undefined || raw.trim() === "") return 20_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 20_000;
}

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ClientConn>();
  private readonly closeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(server: HttpServer) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.endsWith("/api/v1/ws") && url.pathname !== "/api/v1/ws") {
        socket.destroy();
        return;
      }

      const sessionId = url.searchParams.get("sessionId") ?? "";
      const role = url.searchParams.get("role") as ClientRole | null;
      const credential = url.searchParams.get("credential") ?? "";

      const rejected = this.validateUpgrade(sessionId, role, credential);
      if (rejected) {
        socket.write(
          `HTTP/1.1 ${rejected.status} ${rejected.statusText}\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, req, sessionId, role as ClientRole, credential);
      });
    });
  }

  private validateUpgrade(
    sessionId: string,
    role: ClientRole | null,
    credential: string,
  ): { status: number; statusText: string } | null {
    if (!sessionId || !credential || (role !== "control" && role !== "output")) {
      return { status: 401, statusText: "Unauthorized" };
    }
    const session = sessionStore.get(sessionId);
    if (!session) {
      return { status: 401, statusText: "Unauthorized" };
    }
    const ticket = sessionStore.getTicket(credential);
    if (!ticket || ticket.sessionId !== sessionId || ticket.role !== role) {
      return { status: 403, statusText: "Forbidden" };
    }
    return null;
  }

  private onConnection(
    ws: WebSocket,
    _req: IncomingMessage,
    sessionId: string,
    role: ClientRole,
    credential: string,
  ): void {
    const session = sessionStore.get(sessionId);
    if (!session) {
      ws.close(4401, "session not found");
      return;
    }
    // Someone is here again: cancel a pending "empty session" close.
    this.cancelSessionClose(sessionId);
    sessionStore.markTicketSocket(credential, true);

    const conn: ClientConn = {
      ws,
      sessionId,
      role,
      lastSeq: session.seq,
    };
    this.clients.add(conn);

    const snapshotMsg = sessionStore.makeMessage(
      session,
      "session.snapshot",
      sessionStore.toSnapshot(session),
    );
    send(ws, snapshotMsg);

    ws.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      this.handleClientMessage(conn, text);
    });

    let released = false;
    const onGone = () => {
      this.clients.delete(conn);
      if (released) return;
      released = true;
      sessionStore.markTicketSocket(credential, false);
      this.scheduleSessionCloseIfEmpty(sessionId);
    };
    ws.on("close", onGone);
    ws.on("error", onGone);
  }

  private connectionCount(sessionId: string): number {
    let n = 0;
    for (const c of this.clients) if (c.sessionId === sessionId) n += 1;
    return n;
  }

  private cancelSessionClose(sessionId: string): void {
    const t = this.closeTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.closeTimers.delete(sessionId);
    }
  }

  /** Last client gone → close the session after the grace period. */
  private scheduleSessionCloseIfEmpty(sessionId: string): void {
    if (this.connectionCount(sessionId) > 0) return;
    this.cancelSessionClose(sessionId);
    const timer = setTimeout(() => {
      this.closeTimers.delete(sessionId);
      if (this.connectionCount(sessionId) > 0) return;
      if (sessionStore.closeSession(sessionId)) {
        console.log(`[hub] session ${sessionId} closed (no clients)`);
      }
    }, sessionGraceMs());
    timer.unref?.();
    this.closeTimers.set(sessionId, timer);
  }

  /** Hub shutdown: close every socket and session. */
  shutdown(): void {
    for (const t of this.closeTimers.values()) clearTimeout(t);
    this.closeTimers.clear();
    for (const conn of [...this.clients]) {
      try {
        conn.ws.close(1001, "hub shutting down");
      } catch {
        // socket already gone — nothing to close
      }
    }
    this.clients.clear();
    for (const session of sessionStore.listSessions()) {
      sessionStore.closeSession(session.id);
    }
    this.wss.close();
  }

  private requireControl(conn: ClientConn, session: SessionRecord): boolean {
    if (conn.role !== "control") {
      sendError(
        conn.ws,
        session.id,
        session.seq,
        "forbidden",
        "output cannot mutate session",
      );
      return false;
    }
    return true;
  }

  private applyResult(
    conn: ClientConn,
    session: SessionRecord,
    result: HubMessage | { error: string },
  ): void {
    if ("error" in result) {
      sendError(conn.ws, session.id, session.seq, result.error, result.error);
      return;
    }
    this.broadcast(session.id, result);
  }

  private handleClientMessage(conn: ClientConn, raw: string): void {
    const session = sessionStore.get(conn.sessionId);
    if (!session) {
      sendError(conn.ws, conn.sessionId, 0, "not_found", "Session gone");
      return;
    }

    const msg = parseClientMessage(raw);
    if (!msg) {
      sendError(conn.ws, session.id, session.seq, "bad_request", "Invalid message");
      return;
    }

    if (msg.type === "client.hello") {
      const snapshotMsg = sessionStore.makeMessage(
        session,
        "session.snapshot",
        sessionStore.toSnapshot(session),
      );
      send(conn.ws, snapshotMsg);
      conn.lastSeq = session.seq;
      return;
    }

    if (msg.type === "client.resync") {
      this.handleResync(conn, session, msg.payload.lastSeq);
      return;
    }

    // The Output window owns the real player (YouTube iframe / <video>). It must
    // be able to report its playback time, otherwise the hub clock stays at the
    // Go Live anchor and karaoke cues never advance (or stay stuck on cue 0).
    if (msg.type === "live.mediaClock.set" && conn.role === "output") {
      noteClockReport(session.id, conn.role, msg.payload);
      this.applyResult(
        conn,
        session,
        sessionStore.setMediaClock(session, msg.payload),
      );
      return;
    }

    if (!this.requireControl(conn, session)) {
      console.warn(`[hub] rejected ${msg.type} from role=${conn.role}`);
      return;
    }

    switch (msg.type) {
      case "session.touch":
        this.applyResult(conn, session, sessionStore.touch(session, msg.payload?.note));
        return;
      case "playlist.itemAdd": {
        const addResult = sessionStore.addItem(session, msg.payload.item);
        this.applyResult(conn, session, addResult);
        if (!("error" in addResult)) {
          // YouTube / audio in Guion → download, silence scan, cancionero cues.
          maybeStartKaraokeOnGuionItem(session, msg.payload.item);
        }
        return;
      }
      case "playlist.itemUpdate":
        this.applyResult(
          conn,
          session,
          sessionStore.updateItem(session, msg.payload.id, msg.payload.patch),
        );
        return;
      case "playlist.itemRemove":
        this.applyResult(
          conn,
          session,
          sessionStore.removeItem(session, msg.payload.id),
        );
        return;
      case "playlist.reorder":
        this.applyResult(
          conn,
          session,
          sessionStore.reorder(session, msg.payload.orderedIds),
        );
        return;
      case "live.go": {
        console.log(
          `[hub] live.go item=${msg.payload.itemId} from=${conn.role} was=${session.live.currentItemId ?? "-"}`,
        );
        const goResult = sessionStore.goLive(session, msg.payload.itemId);
        this.applyResult(conn, session, goResult);
        if (!("error" in goResult)) {
          maybeRefreshSubtitleAgent(session);
          const goItem = session.playlist.items.find(
            (i) => i.id === msg.payload.itemId,
          );
          if (goItem && (goItem.type === "video" || goItem.type === "audio")) {
            watchClockAfterGoLive(session.id);
          }
        }
        return;
      }
      case "live.clear":
        console.log(
          `[hub] live.clear from=${conn.role} was=${session.live.currentItemId ?? "-"}`,
        );
        this.applyResult(conn, session, sessionStore.clearLive(session));
        return;
      case "live.setSlide":
        this.applyResult(
          conn,
          session,
          sessionStore.setSlide(session, msg.payload.index),
        );
        return;
      case "live.mediaClock.set":
        noteClockReport(session.id, conn.role, msg.payload);
        this.applyResult(
          conn,
          session,
          sessionStore.setMediaClock(session, msg.payload),
        );
        return;
      case "live.subtitleAgent.set":
        this.applyResult(
          conn,
          session,
          setSubtitleAgent(session, msg.payload),
        );
        return;
      case "live.subtitleAgent.saveLyrics":
        this.applyResult(conn, session, saveLrclibLyricsToLibrary(session));
        return;
      case "live.subtitleAgent.nudge":
        this.applyResult(
          conn,
          session,
          nudgeSubtitleCancionero(session, msg.payload),
        );
        return;
      case "live.setLyricOverlay":
        this.applyResult(
          conn,
          session,
          sessionStore.setLyricOverlay(session, msg.payload),
        );
        return;
      case "live.setSceneMode":
        this.applyResult(
          conn,
          session,
          sessionStore.setSceneMode(session, msg.payload.sceneMode),
        );
        return;
      case "live.setVideoCover":
        this.applyResult(
          conn,
          session,
          sessionStore.setVideoCover(session, msg.payload),
        );
        return;
      case "live.setWatermark":
        this.applyResult(
          conn,
          session,
          sessionStore.setWatermark(session, msg.payload.enabled),
        );
        return;
      case "live.setTheme":
        this.applyResult(
          conn,
          session,
          sessionStore.setTheme(session, msg.payload),
        );
        return;
      default:
        sendError(conn.ws, session.id, session.seq, "bad_request", "Unknown type");
    }
  }

  private handleResync(
    conn: ClientConn,
    session: SessionRecord,
    lastSeq: number,
  ): void {
    const live = sessionStore.get(session.id);
    if (!live) {
      sendError(conn.ws, session.id, 0, "not_found", "Session gone");
      return;
    }

    if (lastSeq >= live.seq) {
      conn.lastSeq = live.seq;
      return;
    }

    const events = sessionStore.eventsAfter(live, lastSeq);
    if (events === null) {
      const snapshotMsg = sessionStore.makeMessage(
        live,
        "session.snapshot",
        sessionStore.toSnapshot(live),
      );
      send(conn.ws, snapshotMsg);
      conn.lastSeq = live.seq;
      return;
    }

    for (const event of events) {
      send(conn.ws, event);
      conn.lastSeq = event.seq;
    }
  }

  broadcast(sessionId: string, message: HubMessage): void {
    for (const conn of this.clients) {
      if (conn.sessionId !== sessionId) {
        continue;
      }
      if (message.seq <= conn.lastSeq) {
        continue;
      }
      send(conn.ws, message);
      conn.lastSeq = message.seq;
    }
  }
}
