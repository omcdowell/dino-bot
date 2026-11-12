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
) {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: "cid_ru1_phone",
    clientType: "mobile",
    ...(password ? { password } : {}),
    sessionTokens,
    capabilities: { session_tokens: true },
    reconnect: { enabled: false },
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
