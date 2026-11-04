import type {
  CreateSessionResponse,
  JoinSessionResponse,
  ClientRole,
} from "@promedia/shared";

/** Default hub HTTP port (dev). Keep in sync with apps/hub and README. */
export const HUB_DEV_PORT = 8787;

/**
 * REST base. Default: same-origin (Vite proxies `/api` → hub).
 * Set `VITE_HUB_URL` only when calling the hub without the proxy.
 */
export function hubHttpBase(): string {
  const env = import.meta.env.VITE_HUB_URL as string | undefined;
  if (env && env.length > 0) {
    return env.replace(/\/$/, "");
  }
  return "";
}

/**
 * Hub binds IPv4 (`0.0.0.0:8787`), not IPv6. Browsers that resolve
 * `localhost` to `::1` first fail WS/health unless we pin loopback to IPv4.
 */
export function hubDevHostname(pageHostname?: string): string {
  const host = (pageHostname ?? "").toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  ) {
    return "127.0.0.1";
  }
  return pageHostname ?? "127.0.0.1";
}

/**
 * WebSocket base URL.
 *
 * Prefer a direct hub WS in Vite dev — proxying `/api` WebSockets through Vite
 * is flaky on some Mac setups. REST stays same-origin via the proxy.
 *
 * Override with `VITE_HUB_WS_URL` (e.g. `ws://192.168.1.10:8787`) or
 * `VITE_HUB_URL` (http→ws rewrite) when needed.
 */
export function hubWsBase(): string {
  const wsEnv = import.meta.env.VITE_HUB_WS_URL as string | undefined;
  if (wsEnv && wsEnv.length > 0) {
    return wsEnv.replace(/\/$/, "");
  }
  const http = hubHttpBase();
  if (http) {
    return http.replace(/^http/, "ws");
  }
  if (import.meta.env.DEV) {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const host = hubDevHostname(window.location.hostname);
    return `${proto}://${host}:${HUB_DEV_PORT}`;
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
}

export function isHubUnreachableError(err: unknown): boolean {
  if (err instanceof TypeError) {
    return true;
  }
  const msg = String(err ?? "");
  return (
    /failed to fetch/i.test(msg) ||
    /networkerror/i.test(msg) ||
    /load failed/i.test(msg) ||
    /network request failed/i.test(msg) ||
    /econnrefused/i.test(msg)
  );
}

export type HubHealth = {
  ok: boolean;
  mode?: string;
  listenHost?: string;
  lanAddresses?: string[];
};

export async function probeHubHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${hubHttpBase()}/health`, {
      method: "GET",
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Hub /health — includes LAN IPs when mode=lan for phone Control URL. */
export async function fetchHubHealth(): Promise<HubHealth | null> {
  try {
    const res = await fetch(`${hubHttpBase()}/health`, {
      method: "GET",
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as HubHealth;
  } catch {
    return null;
  }
}

/** True when the page is opened via loopback (PC), not via LAN IP on a phone. */
export function isLoopbackPageHost(): boolean {
  const host = (window.location.hostname || "").toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

function lanPagePort(): string {
  return (
    window.location.port ||
    (window.location.protocol === "https:" ? "443" : "80")
  );
}

/**
 * Control URL(s) a phone should open on the same Wi‑Fi.
 * Prefer `?code=` (shared projection session). Token still works as fallback.
 */
export function buildLanControlUrls(
  lanAddresses: string[],
  opts?: { accessToken?: string | null; code?: string | null },
): string[] {
  const port = lanPagePort();
  const code = opts?.code?.trim().toUpperCase();
  const token = opts?.accessToken?.trim();
  let path = "/control";
  if (code) {
    path = `/control?code=${encodeURIComponent(code)}`;
  } else if (token) {
    path = `/control?token=${encodeURIComponent(token)}`;
  }
  return lanAddresses
    .filter((ip) => typeof ip === "string" && ip.length > 0)
    .map((ip) => `http://${ip}:${port}${path}`);
}

/** Output / projection URL(s) so a second device mirrors the same session. */
export function buildLanOutputUrls(
  lanAddresses: string[],
  code?: string | null,
): string[] {
  const port = lanPagePort();
  const c = code?.trim().toUpperCase();
  const path = c
    ? `/output?code=${encodeURIComponent(c)}&autofullscreen=1`
    : "/output";
  return lanAddresses
    .filter((ip) => typeof ip === "string" && ip.length > 0)
    .map((ip) => `http://${ip}:${port}${path}`);
}

/** Same-origin Output path for the current session (phone or PC). */
export function sharedOutputPath(code: string): string {
  const c = code.trim().toUpperCase();
  return `/output?code=${encodeURIComponent(c)}&autofullscreen=1`;
}

export async function createSession(
  mode: "lan" | "cloud" | "portable" = "lan",
): Promise<CreateSessionResponse> {
  let res: Response;
  try {
    res = await fetch(`${hubHttpBase()}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  } catch (err) {
    throw new Error("HUB_UNREACHABLE", { cause: err });
  }
  if (!res.ok) {
    throw new Error(`create failed: ${res.status}`);
  }
  return (await res.json()) as CreateSessionResponse;
}

export async function joinSession(opts: {
  code?: string;
  accessToken?: string;
  role: ClientRole;
}): Promise<JoinSessionResponse> {
  const body =
    opts.code !== undefined && opts.code.length > 0
      ? { code: opts.code, role: opts.role }
      : { accessToken: opts.accessToken, role: opts.role };

  let res: Response;
  try {
    res = await fetch(`${hubHttpBase()}/api/v1/sessions/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error("HUB_UNREACHABLE", { cause: err });
  }
  if (!res.ok) {
    throw new Error(`join failed: ${res.status}`);
  }
  return (await res.json()) as JoinSessionResponse;
}

export function buildWsUrl(
  sessionId: string,
  role: ClientRole,
  wsTicket: string,
): string {
  const q = new URLSearchParams({
    sessionId,
    role,
    credential: wsTicket,
  });
  return `${hubWsBase()}/api/v1/ws?${q.toString()}`;
}
