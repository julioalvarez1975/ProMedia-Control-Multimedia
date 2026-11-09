/**
 * Test: session lifecycle — close revokes code/token/tickets, idle tickets are
 * released, an empty session closes after the grace period (and a quick
 * reconnect cancels it), shutdown closes everything, assets are dropped.
 * Run: pnpm --filter @promedia/hub exec tsx scripts/test-sessions.mts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createLocalDiskAdapter } from "@promedia/media";
import { AssetStore } from "../src/asset-store.ts";
import { SessionStore } from "../src/session-store.ts";

process.env.PROMEDIA_SESSION_GRACE_MS = "150";
const { sessionStore } = await import("../src/session-store.ts");
const { WsHub, sessionGraceMs } = await import("../src/ws-hub.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
assert.equal(sessionGraceMs(), 150, "grace is configurable");

// ---- closeSession revokes everything --------------------------------------
{
  const store = new SessionStore();
  const closed: string[] = [];
  store.onSessionClosed((id) => closed.push(id));
  const { session, ticket } = store.create("lan");
  const out = store.issueTicket(session.id, "output");
  assert.ok(store.findByCode(session.code));
  assert.ok(store.findByAccessToken(session.accessToken));
  assert.ok(store.getTicket(out.ticket));

  assert.equal(store.closeSession(session.id), true);
  assert.equal(store.get(session.id), undefined);
  assert.equal(store.findByCode(session.code), undefined, "code revoked");
  assert.equal(store.findByAccessToken(session.accessToken), undefined, "token revoked");
  assert.equal(store.getTicket(ticket.ticket), undefined, "control ticket revoked");
  assert.equal(store.getTicket(out.ticket), undefined, "output ticket revoked");
  assert.deepEqual(closed, [session.id], "cleanup listener ran once");
  assert.equal(store.closeSession(session.id), false, "second close is a no-op");
}

// ---- idle tickets are released, live ones are not -------------------------
{
  const store = new SessionStore();
  const { session, ticket } = store.create("lan");
  const spare = store.issueTicket(session.id, "output");
  store.markTicketSocket(ticket.ticket, true); // control socket open
  const later = Date.now() + 60 * 60_000;
  assert.equal(store.releaseIdleTickets(later), 1, "only the idle ticket is released");
  assert.ok(store.getTicket(ticket.ticket), "ticket with an open socket is kept");
  assert.equal(store.getTicket(spare.ticket), undefined);
  store.markTicketSocket(ticket.ticket, false);
  assert.equal(store.releaseIdleTickets(later + 60 * 60_000), 1, "released once its socket closed");
}

// ---- assets of a closed session are deleted --------------------------------
{
  const dir = await mkdtemp(path.join(tmpdir(), "pm-assets-"));
  const assets = new AssetStore(createLocalDiskAdapter(dir));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const asset = await assets.putImage("s1", png, "image/png", "a.png");
  assert.ok(!("error" in asset));
  assert.equal((await readdir(path.join(dir, "s1"))).length, 1);
  assert.equal(await assets.dropSession("s1"), 1);
  assert.equal((await readdir(path.join(dir, "s1"))).length, 0, "file deleted");
  assert.equal(assets.list("s1").length, 0);
  await rm(dir, { recursive: true, force: true });
}

// ---- WsHub: grace close, reconnect cancels, shutdown ----------------------
{
  const server = createServer();
  const hub = new WsHub(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const url = (sid: string, role: string, cred: string) =>
    `ws://127.0.0.1:${port}/api/v1/ws?sessionId=${sid}&role=${role}&credential=${cred}`;
  const open = (u: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(u);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  const closedEvt = (ws: WebSocket) => new Promise<void>((r) => ws.once("close", () => r()));

  // 1) last client leaves → session closes after the grace period
  const a = sessionStore.create("lan");
  const wsA = await open(url(a.session.id, "control", a.ticket.ticket));
  wsA.close();
  await sleep(40);
  assert.ok(sessionStore.get(a.session.id), "still alive inside the grace period");
  await sleep(300);
  assert.equal(sessionStore.get(a.session.id), undefined, "closed after grace");
  assert.equal(sessionStore.getTicket(a.ticket.ticket), undefined, "ticket revoked");

  // 2) quick reload (reconnect inside grace) keeps the session
  const b = sessionStore.create("lan");
  const wsB1 = await open(url(b.session.id, "control", b.ticket.ticket));
  wsB1.close();
  await sleep(40);
  const wsB2 = await open(url(b.session.id, "control", b.ticket.ticket));
  await sleep(350);
  assert.ok(sessionStore.get(b.session.id), "reconnect cancelled the close");

  // 3) a second client (Output) keeps the session while Control is gone
  const outTicket = sessionStore.issueTicket(b.session.id, "output");
  const wsOut = await open(url(b.session.id, "output", outTicket.ticket));
  wsB2.close();
  await sleep(350);
  assert.ok(sessionStore.get(b.session.id), "Output still connected");

  // 4) hub shutdown closes sockets and sessions
  const gone = closedEvt(wsOut);
  hub.shutdown();
  await gone;
  assert.equal(sessionStore.get(b.session.id), undefined, "shutdown closed sessions");
  server.close();
}

console.log("TEST_OK test-sessions");
process.exit(0);
