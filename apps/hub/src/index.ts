import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Server } from "node:http";
import { SHARED_PACKAGE_VERSION } from "@promedia/shared";
import { initBrandingStore } from "./branding-store.js";
import { initWatermarkStore } from "./watermark-store.js";
import { setSessionBroadcaster } from "./broadcast.js";
import { listLanIPv4, resolveHubListenHost } from "./lan.js";
import { ensureLibraryLayout } from "./library-store.js";
import { createApiRoutes } from "./routes.js";
import { checkEnvironmentAtStartup, lastStartupChecks } from "./startup-check.js";
import { ensureSubtitleDirs } from "./subtitle-paths.js";
import { assetStore } from "./asset-store.js";
import { sessionStore } from "./session-store.js";
import { disposeSubtitleSession } from "./subtitle-agent.js";
import {
  flushPersistedAgents,
  purgeStaleAlignedCache,
} from "./subtitle-aligned-store.js";
import { purgeStaleAsrCache } from "./subtitle-asr.js";
import { forgetClockReports, WsHub } from "./ws-hub.js";

const app = new Hono();
const port = Number(process.env.PORT ?? 8787);
const deployMode = (process.env.PROMEDIA_MODE ?? "lan").toLowerCase();
const listenHost = resolveHubListenHost(deployMode);
const lanAddresses = listLanIPv4();

// Create data/library/{files,bibles/import,songs/import} on boot so Finder
// shows drop folders after first launch (no manual mkdir).
try {
  const layout = await ensureLibraryLayout();
  console.log(`[hub] library ready: ${layout.root}`);
  console.log(`[hub] Bible import folder: ${layout.bibleImport}`);
  console.log(`[hub] Song import folder: ${layout.songImport}`);
} catch (err) {
  console.error(
    "[hub] WARN: no se pudo crear la carpeta de biblioteca:",
    err instanceof Error ? err.message : err,
  );
}

try {
  const sub = await ensureSubtitleDirs();
  console.log(`[hub] subtitle models: ${sub.models}`);
  console.log(`[hub] youtube-cache: ${sub.youtubeCache}`);
  // Results calculated by an older procedure are dropped and made again.
  const [staleAligned, staleAsr] = await Promise.all([
    purgeStaleAlignedCache(),
    purgeStaleAsrCache(),
  ]);
  if (staleAligned + staleAsr > 0) {
    console.log(
      `[hub] removed old karaoke calculations (aligned=${staleAligned}, transcripts=${staleAsr}) — they will be recalculated`,
    );
  }
} catch (err) {
  console.error(
    "[hub] WARN: no se pudo crear data/models|youtube-cache (subtítulos):",
    err instanceof Error ? err.message : err,
  );
}

try {
  const logo = await initBrandingStore();
  console.log(
    logo
      ? `[hub] branding logo ready (${logo.mime}, ${logo.size} bytes)`
      : "[hub] branding logo folder ready (no custom logo yet)",
  );
} catch (err) {
  console.error(
    "[hub] WARN: no se pudo crear data/branding (logo):",
    err instanceof Error ? err.message : err,
  );
}

try {
  const wm = await initWatermarkStore();
  if (wm) console.log(`[hub] watermark ready (${wm.mime}, ${wm.size} bytes)`);
} catch (err) {
  console.error(
    "[hub] WARN: no se pudo preparar la marca de agua:",
    err instanceof Error ? err.message : err,
  );
}

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "promedia-hub",
    shared: SHARED_PACKAGE_VERSION,
    mode: deployMode,
    listenHost,
    lanAddresses,
    startup: lastStartupChecks(),
    mediaAdapter: process.env.MEDIA_ADAPTER ?? (deployMode === "cloud" ? "s3-compatible" : "local"),
  }),
);

app.get("/", (c) =>
  c.json({
    name: "ProMedia Hub",
    status: "hub-ws",
    health: "/health",
    api: "/api/v1",
    note: "Sessions are in-memory; hub restart clears them.",
  }),
);

app.route("/api/v1", createApiRoutes());

function exitPortInUse(): never {
  console.error(
    `[hub] ERROR: el puerto ${port} ya está en uso (EADDRINUSE).`,
  );
  console.error(
    `[hub] Hay otra instancia de ProMedia (o un hub viejo) escuchando en :${port}.`,
  );
  console.error(
    `[hub] Cerrá esa ventana / proceso, o liberá el puerto:\n` +
      `  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
      `  kill <PID>\n` +
      `En Mac, start-mac.command intenta cerrar procesos node/promedia en 8787 y 5173.`,
  );
  process.exit(1);
}

const server = serve(
  {
    fetch: app.fetch,
    port,
    hostname: listenHost,
  },
  (info) => {
    // Only log after a successful bind — never before serve() listens.
    console.log(
      `ProMedia hub listening on http://localhost:${info.port} (mode=${deployMode}, bind=${listenHost})`,
    );
    if (lanAddresses.length > 0) {
      for (const ip of lanAddresses) {
        console.log(
          `[hub] LAN API/WS → http://${ip}:${info.port}  (teléfono: Control en :5173, misma IP)`,
        );
      }
      console.log(
        `[hub] Control en el teléfono (misma Wi‑Fi): http://${lanAddresses[0]}:5173/control`,
      );
    } else {
      console.log(
        "[hub] Sin IPv4 LAN detectada — Control remoto necesita Wi‑Fi / Ethernet.",
      );
    }
  },
);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    exitPortInUse();
  }
  console.error("[hub] ERROR al escuchar:", err.message || err);
  process.exit(1);
});

// Attach WS upgrade handler (ticket auth on /api/v1/ws)
const hub = new WsHub(server as Server);
setSessionBroadcaster((sessionId, message) => hub.broadcast(sessionId, message));

// ── Session lifecycle: release everything a closed session owned ───────
sessionStore.onSessionClosed((sessionId) => {
  disposeSubtitleSession(sessionId);
  forgetClockReports(sessionId);
  void assetStore.dropSession(sessionId);
});

// Tickets nobody uses (no open socket) are released after TICKET_IDLE_MS.
setInterval(() => {
  const n = sessionStore.releaseIdleTickets();
  if (n > 0) console.log(`[hub] released ${n} idle ticket(s)`);
}, 60_000).unref();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[hub] ${signal}: closing sessions and sockets…`);
  hub.shutdown();
  // Save every finished karaoke still waiting on its write-behind timer.
  void flushPersistedAgents().finally(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Probe ffmpeg / yt-dlp / whisper / venv once and tell the operator what is missing.
void checkEnvironmentAtStartup().catch((err) => {
  console.error(
    "[hub] el chequeo del entorno falló:",
    err instanceof Error ? err.message : err,
  );
});
