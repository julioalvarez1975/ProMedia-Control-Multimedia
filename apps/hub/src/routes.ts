import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  JoinSessionRequest,
  JoinSessionResponse,
  SessionMode,
} from "@promedia/shared";
import { assetStore } from "./asset-store.js";
import {
  authorizeHubOperator,
  authorizeSessionAccess,
} from "./auth.js";
import {
  BRANDING_LOGO_MAX_BYTES,
  getBrandingLogo,
  putBrandingLogo,
} from "./branding-store.js";
import { broadcastSession } from "./broadcast.js";
import { libraryStore } from "./library-store.js";
import { playlistStore } from "./playlist-store.js";
import { clientIpFromHeaders, rateLimitAllow } from "./rate-limit.js";
import { sessionStore } from "./session-store.js";

/** Session media upload cap (bytes) — prevents LAN DoS filling disk. */
const SESSION_ASSET_MAX_BYTES = 512 * 1024 * 1024;
import { BIBLE_BOOKS } from "./bible/books.js";
import { lookupPassage, passageToSlides } from "./bible/lookup.js";
import { parseBibleReference } from "./bible/parse.js";
import { BIBLE_VERSIONS, defaultVersionId } from "./bible/versions.js";
import {
  TEXT_IMPORT_MAX_BYTES,
  parsePdfBuffer,
} from "./text-import.js";
import type { LibrarySongPayload, TextPayload, BiblePayload } from "@promedia/shared";

function publicBase(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): { http: string; ws: string } {
  const url = new URL(c.req.url);
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
  const forwardedProto = c.req.header("x-forwarded-proto");
  const proto =
    forwardedProto === "https" || url.protocol === "https:" ? "https" : "http";
  const wsProto = proto === "https" ? "wss" : "ws";
  return {
    http: `${proto}://${host}`,
    ws: `${wsProto}://${host}`,
  };
}

function buildWsUrl(
  baseWs: string,
  sessionId: string,
  role: "control" | "output",
  ticket: string,
): string {
  const q = new URLSearchParams({
    sessionId,
    role,
    credential: ticket,
  });
  return `${baseWs}/api/v1/ws?${q.toString()}`;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

function hubOperatorFromRequest(c: {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  };
}) {
  return authorizeHubOperator({
    credential:
      bearerToken(c.req.header("authorization")) ?? c.req.query("credential"),
    accessToken:
      c.req.query("accessToken") ??
      c.req.query("token") ??
      c.req.header("x-promedia-access-token"),
  });
}

export function createApiRoutes(): Hono {
  const api = new Hono();

  api.post("/sessions", async (c) => {
    let body: CreateSessionRequest = {};
    try {
      body = (await c.req.json()) as CreateSessionRequest;
    } catch {
      body = {};
    }

    const envMode = (process.env.PROMEDIA_MODE ?? "").toLowerCase();
    const defaultMode: SessionMode =
      envMode === "cloud" || envMode === "portable" || envMode === "lan"
        ? envMode
        : "lan";
    const mode: SessionMode =
      body.mode === "cloud" || body.mode === "portable" || body.mode === "lan"
        ? body.mode
        : defaultMode;

    const { session, ticket } = sessionStore.create(mode);
    const bases = publicBase(c);
    const snapshot = sessionStore.toSnapshot(session);

    const response: CreateSessionResponse = {
      sessionId: session.id,
      code: session.code,
      accessToken: session.accessToken,
      role: "control",
      wsTicket: ticket.ticket,
      joinUrl: `${bases.http}/output?token=${encodeURIComponent(session.accessToken)}`,
      wsUrl: buildWsUrl(bases.ws, session.id, "control", ticket.ticket),
      snapshot,
    };

    return c.json(response, 201);
  });

  api.post("/sessions/join", async (c) => {
    let body: JoinSessionRequest;
    try {
      body = (await c.req.json()) as JoinSessionRequest;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const hasCode = typeof body.code === "string" && body.code.length > 0;
    const hasToken =
      typeof body.accessToken === "string" && body.accessToken.length > 0;

    if (hasCode === hasToken) {
      return c.json(
        { error: "provide exactly one of code or accessToken" },
        400,
      );
    }

    const role =
      body.role === "control" || body.role === "output" ? body.role : "output";

    // Cloud: short code stays Output-only. LAN/portable: phone Control may
    // join by the same 4-char code shown on the projector (rate-limited below).
    if (role === "control" && hasCode && !hasToken) {
      const mode = (process.env.PROMEDIA_MODE ?? "lan").toLowerCase();
      if (mode !== "lan" && mode !== "portable") {
        return c.json({ error: "control_requires_token" }, 403);
      }
    }

    const ip = clientIpFromHeaders((n) => c.req.header(n));
    if (hasCode) {
      const allowed = rateLimitAllow({
        key: `join-code:${ip}`,
        limit: 20,
        windowMs: 60_000,
      });
      if (!allowed) {
        return c.json({ error: "rate_limited" }, 429);
      }
    }

    const session = hasCode
      ? sessionStore.findByCode(body.code!)
      : sessionStore.findByAccessToken(body.accessToken!);

    if (!session) {
      return c.json({ error: "invalid_credentials" }, 401);
    }

    const ticket = sessionStore.issueTicket(session.id, role);
    const bases = publicBase(c);
    const snapshot = sessionStore.toSnapshot(session);

    const response: JoinSessionResponse = {
      sessionId: session.id,
      code: session.code,
      role,
      wsTicket: ticket.ticket,
      wsUrl: buildWsUrl(bases.ws, session.id, role, ticket.ticket),
      snapshot,
    };

    return c.json(response);
  });

  api.get("/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    const access = authorizeSessionAccess(sessionId, {
      credential:
        bearerToken(c.req.header("authorization")) ?? c.req.query("credential"),
      code: c.req.query("code"),
      accessToken: c.req.query("accessToken") ?? c.req.query("token"),
    });
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    const session = sessionStore.get(sessionId);
    if (!session) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ snapshot: sessionStore.toSnapshot(session) });
  });

  /**
   * Persistent venue logo for sceneMode "logo".
   * Auth: sessionId + credential (wsTicket) like session assets — Control + Output.
   */
  api.get("/branding/logo", async (c) => {
    const credential =
      bearerToken(c.req.header("authorization")) ?? c.req.query("credential");
    let sessionId = (c.req.query("sessionId") ?? "").trim();
    if (!sessionId && credential) {
      const ticket = sessionStore.getTicket(credential);
      if (ticket) {
        sessionId = ticket.sessionId;
      }
    }
    if (!sessionId) {
      return c.json({ error: "missing_session" }, 400);
    }
    const access = authorizeSessionAccess(sessionId, {
      credential,
      code: c.req.query("code"),
      accessToken: c.req.query("accessToken") ?? c.req.query("token"),
    });
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    const logo = await getBrandingLogo();
    if (!logo) {
      return c.json({ error: "not_found" }, 404);
    }
    return new Response(new Uint8Array(logo.bytes), {
      status: 200,
      headers: {
        "Content-Type": logo.meta.mime,
        "Cache-Control": "private, max-age=30",
        "X-Logo-Updated-At": logo.meta.updatedAt,
      },
    });
  });

  /**
   * Upload / replace the permanent branding logo (control only).
   * Multipart field `file`. Survives sessions under data/branding/.
   */
  api.post("/branding/logo", async (c) => {
    const sessionId = c.req.query("sessionId") ?? "";
    const credential =
      bearerToken(c.req.header("authorization")) ?? c.req.query("credential");
    if (!sessionId) {
      return c.json({ error: "missing_session" }, 400);
    }
    const access = authorizeSessionAccess(sessionId, {
      credential,
      accessToken: c.req.query("accessToken") ?? c.req.query("token"),
      requireRole: "control",
    });
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    let body: Record<string, string | File>;
    try {
      body = (await c.req.parseBody({ all: true })) as Record<
        string,
        string | File
      >;
    } catch {
      return c.json({ error: "invalid_multipart" }, 400);
    }

    const file = body.file;
    if (!file || typeof file === "string") {
      return c.json({ error: "missing_file" }, 400);
    }
    if (file.size > BRANDING_LOGO_MAX_BYTES) {
      return c.json({ error: "file_too_large" }, 400);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength > BRANDING_LOGO_MAX_BYTES) {
      return c.json({ error: "file_too_large" }, 400);
    }

    const result = await putBrandingLogo({
      bytes,
      mime: file.type || "application/octet-stream",
      originalName: file.name,
    });
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }

    const session = sessionStore.get(sessionId);
    if (session) {
      session.live.sceneMode = "logo";
    }
    for (const msg of sessionStore.applyBrandingLogoUpdatedAt(
      result.updatedAt,
    )) {
      broadcastSession(msg.sessionId, msg);
    }

    return c.json({ logo: result }, 201);
  });

  /**
   * Upload image or video asset (control only). Multipart field `file`.
   * Auth: Authorization Bearer <wsTicket> or query ?credential=
   * Video MIMEs: mp4/webm/quicktime (Q1). Cap {@link SESSION_ASSET_MAX_BYTES}.
   */
  api.post("/sessions/:sessionId/assets", async (c) => {
    const sessionId = c.req.param("sessionId");
    const credential =
      bearerToken(c.req.header("authorization")) ?? c.req.query("credential");
    const access = authorizeSessionAccess(sessionId, {
      credential,
      accessToken: c.req.query("accessToken") ?? c.req.query("token"),
      requireRole: "control",
    });
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    let body: Record<string, string | File>;
    try {
      body = (await c.req.parseBody({ all: true })) as Record<
        string,
        string | File
      >;
    } catch {
      return c.json({ error: "invalid_multipart" }, 400);
    }

    const file = body.file;
    if (!file || typeof file === "string") {
      return c.json({ error: "missing_file" }, 400);
    }

    if (file.size > SESSION_ASSET_MAX_BYTES) {
      return c.json({ error: "file_too_large" }, 400);
    }

    const mime = file.type || "application/octet-stream";
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength > SESSION_ASSET_MAX_BYTES) {
      return c.json({ error: "file_too_large" }, 400);
    }
    const result = await assetStore.putByMime(
      sessionId,
      bytes,
      mime,
      file.name,
    );
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ asset: result }, 201);
  });

  /**
   * Parse an uploaded document into page/paragraph text for Control text import.
   * PDF only on hub (pdf-parse). Auth not required — no session mutation.
   */
  api.post("/parse/document", async (c) => {
    const access = hubOperatorFromRequest(c);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ error: "missing_file" }, 400);
    }
    if (file.size > TEXT_IMPORT_MAX_BYTES) {
      return c.json({ error: "file_too_large" }, 400);
    }
    const name = file.name.toLowerCase();
    const isPdf =
      name.endsWith(".pdf") || file.type === "application/pdf";
    if (!isPdf) {
      return c.json({ error: "unsupported_type" }, 400);
    }
    try {
      const bytes = Buffer.from(await file.arrayBuffer());
      const result = await parsePdfBuffer(bytes);
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: "parse_failed", detail: String(err) },
        400,
      );
    }
  });

  /** List named SavedPlaylists (global to hub process / data file). */
  api.get("/playlists", async (c) => {
    const list = await playlistStore.list();
    return c.json({
      playlists: list.map(({ id, name, createdAt, updatedAt, items }) => ({
        id,
        name,
        createdAt,
        updatedAt,
        itemCount: items.length,
      })),
    });
  });

  api.get("/playlists/:id", async (c) => {
    const saved = await playlistStore.get(c.req.param("id"));
    if (!saved) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ playlist: saved });
  });

  /** Save current session playlist under a name (control). */
  api.post("/sessions/:sessionId/playlists", async (c) => {
    const sessionId = c.req.param("sessionId");
    const credential =
      bearerToken(c.req.header("authorization")) ?? c.req.query("credential");
    const access = authorizeSessionAccess(sessionId, {
      credential,
      requireRole: "control",
    });
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    const session = sessionStore.get(sessionId);
    if (!session) {
      return c.json({ error: "not_found" }, 404);
    }
    let body: { name?: string; id?: string } = {};
    try {
      body = (await c.req.json()) as { name?: string; id?: string };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (typeof body.name !== "string") {
      return c.json({ error: "missing_name" }, 400);
    }
    const result = await playlistStore.save({
      name: body.name,
      id: typeof body.id === "string" ? body.id : undefined,
      items: session.playlist.items,
    });
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ playlist: result }, 201);
  });

  /**
   * Import a guion file payload into the session playlist (control).
   * Used after the operator picks a `.promedia-guion.json` / `.json` on disk.
   */
  api.post("/sessions/:sessionId/playlists/import", async (c) => {
    const sessionId = c.req.param("sessionId");
    const credential =
      bearerToken(c.req.header("authorization")) ?? c.req.query("credential");
    const access = authorizeSessionAccess(sessionId, {
      credential,
      accessToken: c.req.query("accessToken") ?? c.req.query("token"),
      requireRole: "control",
    });
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    const session = sessionStore.get(sessionId);
    if (!session) {
      return c.json({ error: "not_found" }, 404);
    }
    let body: { name?: string; items?: unknown[] } = {};
    try {
      body = (await c.req.json()) as { name?: string; items?: unknown[] };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!Array.isArray(body.items)) {
      return c.json({ error: "missing_items" }, 400);
    }
    const cloned = body.items.map((raw, order) => {
      if (!raw || typeof raw !== "object") {
        return raw;
      }
      const item = raw as { id?: string };
      const baseId =
        typeof item.id === "string" && item.id.trim()
          ? item.id.trim().slice(0, 8)
          : "item";
      return {
        ...(raw as object),
        id: `${baseId}-${Date.now().toString(36)}-${order}`,
        order,
      };
    });
    const result = sessionStore.replacePlaylist(session, cloned);
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    broadcastSession(sessionId, result.message);
    return c.json({
      snapshot: sessionStore.toSnapshot(session),
      skipped: result.skipped,
      name: typeof body.name === "string" ? body.name : undefined,
      note: "File image/video assets are session-scoped; missing media were skipped.",
    });
  });

  /** Load a SavedPlaylist into the session playlist (control). */
  api.post("/sessions/:sessionId/playlists/:playlistId/load", async (c) => {
    const sessionId = c.req.param("sessionId");
    const playlistId = c.req.param("playlistId");
    const credential =
      bearerToken(c.req.header("authorization")) ?? c.req.query("credential");
    const access = authorizeSessionAccess(sessionId, {
      credential,
      requireRole: "control",
    });
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    const session = sessionStore.get(sessionId);
    if (!session) {
      return c.json({ error: "not_found" }, 404);
    }
    const saved = await playlistStore.get(playlistId);
    if (!saved) {
      return c.json({ error: "not_found" }, 404);
    }
    // Re-id items so load can be repeated without duplicate_id conflicts
    const cloned = saved.items.map((item, order) => ({
      ...item,
      id: `${item.id.slice(0, 8)}-${Date.now().toString(36)}-${order}`,
      order,
    }));
    const result = sessionStore.replacePlaylist(session, cloned);
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    broadcastSession(sessionId, result.message);
    return c.json({
      snapshot: sessionStore.toSnapshot(session),
      skipped: result.skipped,
      note: "File image/video assets are session-scoped; missing media were skipped.",
    });
  });

  api.delete("/playlists/:id", async (c) => {
    const ok = await playlistStore.remove(c.req.param("id"));
    if (!ok) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ ok: true });
  });

  /**
   * Bible versions: built-in public-domain remotes + local library imports.
   * Local translations with the same id override remotes (e.g. PDT offline).
   */
  api.get("/bible/versions", async (c) => {
    const local = await libraryStore.listLocalBibleVersions();
    const localIds = new Set(local.map((v) => v.versionId.toLowerCase()));
    const remote = BIBLE_VERSIONS.filter(
      (v) => !localIds.has(v.id.toLowerCase()),
    ).map((v) => ({
      id: v.id,
      label: v.label,
      shortLabel: v.shortLabel,
      language: v.language,
      license: v.license,
      default: Boolean(v.default),
      source: "remote" as const,
    }));
    const localMapped = local.map((v) => ({
      id: v.versionId,
      label: v.label,
      shortLabel: v.shortLabel,
      language: v.language,
      license: v.license,
      default: false,
      source: "local" as const,
      note: v.note,
      verseCount: v.verseCount,
      bookCount: v.bookCount,
    }));
    const defaultId = localIds.has(defaultVersionId())
      ? defaultVersionId()
      : defaultVersionId();
    return c.json({
      defaultVersionId: defaultId,
      versions: [...localMapped, ...remote],
      note:
        "Traducciones con copyright (RV1960, NVI, NTV, …) no van en el repo: importalas a data/library (Biblioteca → Biblias o carpeta bibles/import/). Remotas de dominio público: RV1909 / PDT / KJV / ASV.",
    });
  });

  api.get("/bible/books", (c) =>
    c.json({
      books: BIBLE_BOOKS.map((b) => ({
        id: b.id,
        nameEs: b.nameEs,
        nameEn: b.nameEn,
        chapters: b.chapters,
      })),
    }),
  );

  /**
   * Lookup a passage by structured fields or free-text reference.
   * Query: version, book, chapter, verseStart, verseEnd
   *    or: version, q=Juan+3:16-17
   */
  api.get("/bible/passage", async (c) => {
    const version =
      (c.req.query("version") ?? defaultVersionId()).trim() ||
      defaultVersionId();
    const q = (c.req.query("q") ?? "").trim();

    let bookId = (c.req.query("book") ?? "").trim().toLowerCase();
    let chapter = Number(c.req.query("chapter"));
    let verseStart = Number(c.req.query("verseStart") ?? c.req.query("from"));
    let verseEnd = Number(c.req.query("verseEnd") ?? c.req.query("to"));

    if (q) {
      const parsed = parseBibleReference(q);
      if (!parsed) {
        return c.json({ error: "invalid_reference", q }, 400);
      }
      bookId = parsed.book.id;
      chapter = parsed.chapter;
      verseStart = parsed.verseStart;
      verseEnd = parsed.verseEnd;
    }

    if (!bookId || !Number.isFinite(chapter) || !Number.isFinite(verseStart)) {
      return c.json(
        { error: "missing_params", need: "book+chapter+verseStart or q" },
        400,
      );
    }
    if (!Number.isFinite(verseEnd)) {
      verseEnd = verseStart;
    }

    const looked = await lookupPassage({
      versionId: version,
      bookId,
      chapter,
      verseStart,
      verseEnd,
    });
    if (!looked.ok) {
      const status = looked.error === "api_failed" ? 502 : 400;
      const message =
        "message" in looked && looked.message
          ? looked.message
          : looked.error === "api_failed"
            ? "No se pudo obtener el pasaje (API o red). Probá otra versión o más tarde."
            : looked.error === "passage_not_found"
              ? "Ese pasaje no está en la Biblia local."
              : undefined;
      return c.json(
        {
          error: looked.error,
          detail: looked.detail,
          message,
        },
        status,
      );
    }

    const slides = passageToSlides(looked.result);
    return c.json({
      ...looked.result,
      slides,
    });
  });

  // ── Local media library (Phase 1 — disk + JSON; not cloud) ──────────
  // All /library/* require a control operator (wsTicket or accessToken).
  api.use("/library/*", async (c, next) => {
    const access = hubOperatorFromRequest(c);
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }
    await next();
  });

  api.get("/library/items", async (c) => {
    const category = c.req.query("category") ?? undefined;
    const q = c.req.query("q") ?? undefined;
    const items = await libraryStore.list({ category, q });
    return c.json({ items });
  });

  api.get("/library/items/:id", async (c) => {
    const item = await libraryStore.get(c.req.param("id"));
    if (!item) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ item });
  });

  api.post("/library/songs", async (c) => {
    let body: LibrarySongPayload;
    try {
      body = (await c.req.json()) as LibrarySongPayload;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const result = await libraryStore.createSong(body);
    if ("error" in result) {
      return c.json(
        { error: result.error, message: result.message },
        400,
      );
    }
    return c.json({ item: result }, 201);
  });

  api.put("/library/songs/:id", async (c) => {
    let body: LibrarySongPayload;
    try {
      body = (await c.req.json()) as LibrarySongPayload;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const result = await libraryStore.updateSong(c.req.param("id"), body);
    if ("error" in result) {
      const status = result.error === "not_found" ? 404 : 400;
      return c.json(
        { error: result.error, message: result.message },
        status,
      );
    }
    return c.json({ item: result });
  });

  /**
   * Bulk-import Quelea song pack (.qsp) or a single Quelea song .xml.
   * Idempotent-ish: same title+author updates lyrics. Does not commit packs to git.
   */
  api.post("/library/songs/import", async (c) => {
    let body: Record<string, string | File>;
    try {
      body = (await c.req.parseBody({ all: true })) as Record<
        string,
        string | File
      >;
    } catch {
      return c.json({ error: "invalid_multipart" }, 400);
    }
    const file = body.file;
    if (!file || typeof file === "string") {
      return c.json({ error: "missing_file" }, 400);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await libraryStore.importQueleaUpload({
      bytes,
      originalName: file.name,
    });
    return c.json({
      imported: result.imported.map((i) => ({
        id: i.id,
        title: i.title,
        artist: i.song?.artist,
        stanzaCount: i.song?.stanzas.length,
      })),
      updated: result.updated.map((i) => ({
        id: i.id,
        title: i.title,
        artist: i.song?.artist,
        stanzaCount: i.song?.stanzas.length,
      })),
      skipped: result.skipped,
      importedCount: result.imported.length,
      updatedCount: result.updated.length,
      skippedCount: result.skipped.length,
    });
  });

  /**
   * Import Quelea .qsp / .xml from the operator folder
   * (default: data/library/songs/import/).
   */
  api.post("/library/songs/import-folder", async (c) => {
    // Ignore client-supplied paths — only the configured songs/import root.
    const result = await libraryStore.importSongsFromFolder({});
    return c.json({
      folder: result.folder,
      imported: result.imported.map((i) => ({
        id: i.id,
        title: i.title,
        artist: i.song?.artist,
        stanzaCount: i.song?.stanzas.length,
      })),
      updated: result.updated.map((i) => ({
        id: i.id,
        title: i.title,
        artist: i.song?.artist,
        stanzaCount: i.song?.stanzas.length,
      })),
      skipped: result.skipped,
      importedCount: result.imported.length,
      updatedCount: result.updated.length,
      skippedCount: result.skipped.length,
    });
  });

  api.post("/library/text", async (c) => {
    let body: { title?: string; text?: TextPayload };
    try {
      body = (await c.req.json()) as { title?: string; text?: TextPayload };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body.text) {
      return c.json({ error: "missing_text" }, 400);
    }
    const result = await libraryStore.saveText({
      title: body.title ?? body.text.title ?? "Texto",
      text: body.text,
    });
    if ("error" in result) {
      return c.json(
        { error: result.error, message: result.message },
        400,
      );
    }
    return c.json({ item: result }, 201);
  });

  api.post("/library/bible", async (c) => {
    let body: BiblePayload;
    try {
      body = (await c.req.json()) as BiblePayload;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const result = await libraryStore.saveBible(body);
    if ("error" in result) {
      return c.json(
        { error: result.error, message: result.message },
        400,
      );
    }
    return c.json({ item: result }, 201);
  });

  /** Upload image / video / presentation / text / Bible file into the local library. */
  api.post("/library/upload", async (c) => {
    let body: Record<string, string | File>;
    try {
      body = (await c.req.parseBody({ all: true })) as Record<
        string,
        string | File
      >;
    } catch {
      return c.json({ error: "invalid_multipart" }, 400);
    }
    const file = body.file;
    if (!file || typeof file === "string") {
      return c.json({ error: "missing_file" }, 400);
    }
    const title =
      typeof body.title === "string" ? body.title : undefined;
    const categoryHint =
      typeof body.category === "string" ? body.category.trim() : "";
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await libraryStore.uploadFile({
      bytes,
      originalName: file.name,
      mime: file.type || undefined,
      title,
      preferBiblias: categoryHint === "biblias",
    });
    if ("error" in result) {
      return c.json(
        { error: result.error, message: result.message },
        400,
      );
    }
    return c.json({ item: result }, 201);
  });

  /**
   * Import Bible XML/XMM/PDF from the operator folder
   * (default: data/library/bibles/import/). Does not commit texts to git.
   */
  api.post("/library/bibles/import-folder", async (c) => {
    // Ignore client-supplied paths — only the configured bibles/import root.
    const result = await libraryStore.importBiblesFromFolder({});
    return c.json({
      folder: result.folder,
      imported: result.imported.map((i) => ({
        id: i.id,
        title: i.title,
        versionId: i.bibleVersion?.versionId,
        shortLabel: i.bibleVersion?.shortLabel,
        verseCount: i.bibleVersion?.verseCount,
        bookCount: i.bibleVersion?.bookCount,
      })),
      skipped: result.skipped,
      importedCount: result.imported.length,
      skippedCount: result.skipped.length,
    });
  });

  api.delete("/library/items/:id", async (c) => {
    const result = await libraryStore.remove(c.req.param("id"));
    if (result === false) {
      return c.json({ error: "not_found" }, 404);
    }
    if (typeof result === "object" && "error" in result) {
      return c.json(
        { error: result.error, message: result.message },
        400,
      );
    }
    return c.json({ ok: true });
  });

  api.get("/library/items/:id/original", async (c) => {
    const opened = await libraryStore.openFile(c.req.param("id"), "original");
    if (!opened) {
      return c.json({ error: "not_found" }, 404);
    }
    try {
      await stat(opened.path);
      const nodeStream = createReadStream(opened.path);
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;
      return new Response(webStream, {
        status: 200,
        headers: {
          "Content-Type": opened.mime,
          "Content-Disposition": `attachment; filename="${opened.downloadName.replace(/"/g, "")}"`,
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch {
      return c.json({ error: "file_missing" }, 404);
    }
  });

  api.get("/library/items/:id/slides/:slideId", async (c) => {
    const opened = await libraryStore.openFile(c.req.param("id"), {
      slideId: c.req.param("slideId"),
    });
    if (!opened) {
      return c.json({ error: "not_found" }, 404);
    }
    try {
      await stat(opened.path);
      const nodeStream = createReadStream(opened.path);
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;
      return new Response(webStream, {
        status: 200,
        headers: {
          "Content-Type": opened.mime,
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch {
      return c.json({ error: "file_missing" }, 404);
    }
  });

  /**
   * Copy a library item into the live session playlist (control).
   * Presentation/image/video bytes are copied into session assets.
   */
  api.post(
    "/sessions/:sessionId/library/:libraryItemId/add",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const libraryItemId = c.req.param("libraryItemId");
      const credential =
        bearerToken(c.req.header("authorization")) ??
        c.req.query("credential");
      const access = authorizeSessionAccess(sessionId, {
        credential,
        requireRole: "control",
      });
      if (!access.ok) {
        return c.json({ error: access.error }, access.status);
      }
      const session = sessionStore.get(sessionId);
      if (!session) {
        return c.json({ error: "not_found" }, 404);
      }
      const materialized = await libraryStore.addToSession({
        sessionId,
        libraryItemId,
        order: session.playlist.items.length,
      });
      if ("error" in materialized) {
        return c.json(
          { error: materialized.error, message: materialized.message },
          400,
        );
      }
      const result = sessionStore.addItem(session, materialized.item);
      if ("error" in result) {
        return c.json({ error: result.error }, 400);
      }
      broadcastSession(sessionId, result);
      return c.json({
        item: materialized.item,
        snapshot: sessionStore.toSnapshot(session),
      }, 201);
    },
  );

  /**
   * Serve asset bytes. Auth via credential / code / accessToken query.
   */
  api.get("/sessions/:sessionId/assets/:assetId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const assetId = c.req.param("assetId");
    const access = authorizeSessionAccess(sessionId, {
      credential: c.req.query("credential"),
      code: c.req.query("code"),
      accessToken: c.req.query("accessToken") ?? c.req.query("token"),
    });
    if (!access.ok) {
      return c.json({ error: access.error }, access.status);
    }

    const asset = assetStore.get(sessionId, assetId);
    if (!asset) {
      return c.json({ error: "not_found" }, 404);
    }

    try {
      const { path: filePath } = await assetStore.getAdapter().open(asset.storageKey);
      await stat(filePath);
      const nodeStream = createReadStream(filePath);
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;
      return new Response(webStream, {
        status: 200,
        headers: {
          "Content-Type": asset.mime,
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch {
      return c.json({ error: "file_missing" }, 404);
    }
  });

  return api;
}
