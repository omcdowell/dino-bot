/**
 * RU1: an update or restart must keep an already-paired device signed in. A paired phone (direct
 * E2EE, password pairing, session tokens) had to pair again after the v0.1.4 update: the restart
 * dropped every session token (they lived in memory), the phone's token was refused and its
 * password fallback did not get it back in.
 *
 * Here a phone-like client pairs with the password, gets a token, forgets the password, and the
 * daemon is stopped and started again on the same PASEO_HOME and port (what `dinobot update` and
 * a manual port do). The daemon must come back with the same identity (key, server id) and admit
 * the device with its token alone.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createMemorySessionTokenStore,
  type DaemonSessionTokenStore,
} from "@getpaseo/client/internal/daemon-client";
import { DaemonClient } from "../test-utils/index.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DAEMON_PASSWORD_HASH_FILE, stableDaemonPasswordHash } from "../auth.js";
import { loadOrCreateDaemonKeyPair } from "../daemon-keypair.js";
import { mintPairingTicket } from "../pairing-tickets.js";
import { listPairedDevices, revokePairedDevices } from "../session-tokens.js";

const PASSWORD = "dinobot-restart-test-password-0123456789";
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

/** As the daemon resolves PASEO_PASSWORD (config.ts): the kept hash while the password is unchanged. */
async function envPasswordHash(paseoHomeRoot: string): Promise<string> {
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  return stableDaemonPasswordHash(PASSWORD, path.join(paseoHome, DAEMON_PASSWORD_HASH_FILE));
}

async function start(paseoHomeRoot: string, passwordHash: string, listenPort = 0) {
  return createTestPaseoDaemon({
    paseoHomeRoot,
    staticDir: path.join(paseoHomeRoot, "static"),
    cleanup: false,
    listenPort,
    auth: { password: passwordHash },
  });
}

function phone(
  daemon: TestPaseoDaemon,
  publicKeyB64: string,
  sessionTokens: DaemonSessionTokenStore,
  password?: string,
  options: {
    clientId?: string;
    pairingTicket?: string;
    deviceTokens?: boolean;
    reconnect?: boolean;
  } = {},
) {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: options.clientId ?? "cid_ru1_phone",
    clientType: "mobile",
    ...(password ? { password } : {}),
    ...(options.pairingTicket ? { pairingTicket: options.pairingTicket } : {}),
    sessionTokens,
    // An app from before QR2 does not ask for device tokens.
    capabilities: { session_tokens: true, device_tokens: options.deviceTokens === true },
    reconnect: options.reconnect
      ? { enabled: true, baseDelayMs: 50, maxDelayMs: 200 }
      : { enabled: false },
    e2ee: { enabled: true, daemonPublicKeyB64: publicKeyB64 },
  });
  cleanups.push(() => client.close());
  return client;
}

async function identity(paseoHome: string) {
  return {
    publicKeyB64: (await loadOrCreateDaemonKeyPair(paseoHome)).publicKeyB64,
    serverId: (await readFile(path.join(paseoHome, "server-id"), "utf8")).trim(),
  };
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("a restart keeps the pairing (RU1)", () => {
  test("same identity, and a paired device gets back in with its token, no password", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ru1-restart-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const first = await start(root, await envPasswordHash(root));
    const before = await identity(first.paseoHome);
    const tokens = createMemorySessionTokenStore();
    const paired = phone(first, before.publicKeyB64, tokens, PASSWORD);
    await paired.connect();
    await waitFor(() => tokens.get() !== null);
    const token = tokens.get();
    await paired.close();
    const port = first.port;
    await first.close();

    // The update: same PASEO_HOME, same port, a fresh process that resolves PASEO_PASSWORD again.
    const second = await start(root, await envPasswordHash(root), port);
    cleanups.push(() => second.close());
    expect(second.port).toBe(port);
    expect(await identity(second.paseoHome)).toEqual(before);

    // The phone has only its token now (its stored password is gone or stale).
    const back = phone(second, before.publicKeyB64, tokens);
    await back.connect();
    expect(back.authFailureReason).toBeNull();
    expect((await back.fetchAgents()).entries).toEqual([]);
    expect(tokens.get()).toBe(token);
  });

  test("control: a device without token or password is still refused after the restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ru1-restart-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const daemon = await start(root, await envPasswordHash(root));
    cleanups.push(() => daemon.close());
    const { publicKeyB64 } = await identity(daemon.paseoHome);
    const stranger = phone(daemon, publicKeyB64, createMemorySessionTokenStore());
    await expect(stranger.connect()).rejects.toThrow();
  });
});

/** Remembers whether the last token the daemon sent was a device token. */
function deviceAwareStore() {
  let token: string | null = null;
  let device = false;
  return {
    get: () => token,
    set: (next: string | null, info?: { device?: boolean }) => {
      token = next;
      device = info?.device === true;
    },
    isDevice: () => device,
  };
}

describe("one-use pairing code (QR2)", () => {
  test("a phone paired by a ticket, with no password, stays paired across a restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qr2-ticket-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const first = await start(root, await envPasswordHash(root));
    const { publicKeyB64 } = await identity(first.paseoHome);
    const { ticket } = mintPairingTicket(first.paseoHome);

    const tokens = deviceAwareStore();
    const paired = phone(first, publicKeyB64, tokens, undefined, {
      clientId: "cid_qr2_phone",
      pairingTicket: ticket,
      deviceTokens: true,
    });
    await paired.connect();
    await waitFor(() => tokens.get() !== null);
    expect(tokens.isDevice()).toBe(true);
    await paired.close();

    // The same code on another device: refused, even though the phone may still retry with it.
    const other = phone(first, publicKeyB64, createMemorySessionTokenStore(), undefined, {
      clientId: "cid_qr2_other",
      pairingTicket: ticket,
      deviceTokens: true,
    });
    await expect(other.connect()).rejects.toThrow(/Pairing code expired or already used/);
    expect(other.authFailureReason).toBe("pairing_ticket_invalid");

    const port = first.port;
    await first.close();
    const second = await start(root, await envPasswordHash(root), port);
    cleanups.push(() => second.close());

    // After the restart (an update): back in with the device token alone.
    const back = phone(second, publicKeyB64, tokens, undefined, {
      clientId: "cid_qr2_phone",
      deviceTokens: true,
    });
    await back.connect();
    expect(back.authFailureReason).toBeNull();
    expect((await back.fetchAgents()).entries).toEqual([]);
    await back.close();

    // The used ticket stays used after the restart.
    const late = phone(second, publicKeyB64, createMemorySessionTokenStore(), undefined, {
      clientId: "cid_qr2_late",
      pairingTicket: ticket,
      deviceTokens: true,
    });
    await expect(late.connect()).rejects.toThrow();

    // `dinobot devices` sees it; revoking it ends the pairing.
    expect(listPairedDevices(second.paseoHome).map((d) => d.clientId)).toEqual(["cid_qr2_phone"]);
    revokePairedDevices(second.paseoHome, ["cid_qr2_phone"]);
    const revoked = phone(second, publicKeyB64, tokens, undefined, {
      clientId: "cid_qr2_phone",
      deviceTokens: true,
    });
    await expect(revoked.connect()).rejects.toThrow();
  });

  test("an already-paired phone (password) keeps working and moves to a device token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qr2-migrate-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const daemon = await start(root, await envPasswordHash(root));
    cleanups.push(() => daemon.close());
    const { publicKeyB64 } = await identity(daemon.paseoHome);
    // An old app: password and a 24-hour token.
    const tokens = deviceAwareStore();
    const old = phone(daemon, publicKeyB64, tokens, PASSWORD);
    await old.connect();
    await waitFor(() => tokens.get() !== null);
    expect(tokens.isDevice()).toBe(false);
    const sessionToken = tokens.get();
    await old.close();
    // The updated app (device_tokens) connects with that token and gets a device token.
    const updated = phone(daemon, publicKeyB64, tokens, PASSWORD, { deviceTokens: true });
    await updated.connect();
    await waitFor(() => tokens.get() !== sessionToken);
    expect(tokens.isDevice()).toBe(true);
    await updated.close();
    // ...which then admits it without the password.
    const migrated = phone(daemon, publicKeyB64, tokens, undefined, { deviceTokens: true });
    await migrated.connect();
    expect(migrated.authFailureReason).toBeNull();
  });

  test("an expired code is refused; a transition code with the password still pairs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qr2-expired-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const daemon = await start(root, await envPasswordHash(root));
    cleanups.push(() => daemon.close());
    const { publicKeyB64 } = await identity(daemon.paseoHome);
    const { ticket } = mintPairingTicket(daemon.paseoHome, { now: Date.now() - 11 * 60 * 1000 });
    const expired = phone(daemon, publicKeyB64, createMemorySessionTokenStore(), undefined, {
      clientId: "cid_qr2_expired",
      pairingTicket: ticket,
      deviceTokens: true,
    });
    await expect(expired.connect()).rejects.toThrow(/Pairing code expired or already used/);

    const tokens = deviceAwareStore();
    const withPassword = phone(daemon, publicKeyB64, tokens, PASSWORD, {
      clientId: "cid_qr2_transition",
      pairingTicket: ticket,
      deviceTokens: true,
      reconnect: true,
    });
    await withPassword.connect().catch(() => undefined);
    await waitFor(() => tokens.get() !== null);
    expect(tokens.isDevice()).toBe(true);
    expect(withPassword.authFailureReason).toBeNull();
  });
});
