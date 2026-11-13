import type { ClientRole } from "@promedia/shared";
import { sessionStore } from "./session-store.js";

export type SessionAccess =
  | { ok: true; role?: ClientRole }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Validate session membership via wsTicket, short code, or opaque token.
 * Short code never grants `control` (LAN guess → Output only).
 * Access token may grant control when `requireRole: "control"` (owner secret).
 */
export function authorizeSessionAccess(
  sessionId: string,
  opts: {
    credential?: string | null;
    code?: string | null;
    accessToken?: string | null;
    requireRole?: ClientRole;
  },
): SessionAccess {
  const session = sessionStore.get(sessionId);
  if (!session) {
    return { ok: false, status: 401, error: "session_not_found" };
  }

  const credential = opts.credential?.trim();
  if (credential) {
    const ticket = sessionStore.getTicket(credential);
    if (!ticket || ticket.sessionId !== sessionId) {
      return { ok: false, status: 403, error: "invalid_ticket" };
    }
    if (opts.requireRole && ticket.role !== opts.requireRole) {
      return { ok: false, status: 403, error: "forbidden_role" };
    }
    return { ok: true, role: ticket.role };
  }

  const code = opts.code?.trim();
  if (code) {
    const byCode = sessionStore.findByCode(code);
    if (!byCode || byCode.id !== sessionId) {
      return { ok: false, status: 403, error: "invalid_code" };
    }
    if (opts.requireRole === "control") {
      return { ok: false, status: 403, error: "forbidden_role" };
    }
    return { ok: true };
  }

  const accessToken = opts.accessToken?.trim();
  if (accessToken) {
    const byToken = sessionStore.findByAccessToken(accessToken);
    if (!byToken || byToken.id !== sessionId) {
      return { ok: false, status: 403, error: "invalid_token" };
    }
    // Access token is the session owner secret — may act as control.
    return {
      ok: true,
      role: opts.requireRole === "control" ? "control" : undefined,
    };
  }

  return { ok: false, status: 401, error: "missing_credentials" };
}

/**
 * Hub-global operator gate for Biblioteca mutations (not session-scoped).
 * Accepts a live control wsTicket or any session accessToken.
 * Tries the ticket first; if it is stale (hub restart), falls back to the
 * access token so Control does not get a false 403 while both are sent.
 */
export function authorizeHubOperator(opts: {
  credential?: string | null;
  accessToken?: string | null;
}): SessionAccess {
  const credential = opts.credential?.trim();
  if (credential) {
    const ticket = sessionStore.getTicket(credential);
    if (ticket?.role === "control" && sessionStore.get(ticket.sessionId)) {
      return { ok: true, role: "control" };
    }
    // Stale ticket after hub restart — try accessToken below before failing.
  }
  const accessToken = opts.accessToken?.trim();
  if (accessToken) {
    const session = sessionStore.findByAccessToken(accessToken);
    if (!session) {
      return { ok: false, status: 403, error: "invalid_token" };
    }
    return { ok: true, role: "control" };
  }
  if (credential) {
    return { ok: false, status: 403, error: "invalid_ticket" };
  }
  return { ok: false, status: 401, error: "missing_credentials" };
}
