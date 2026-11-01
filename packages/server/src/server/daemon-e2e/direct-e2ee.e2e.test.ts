/**
 * Direct (non-relay) sockets with end-to-end encryption: the client offers
 * DIRECT_E2EE_SUBPROTOCOL, runs the relay's secure channel keyed to the daemon key from
 * pairing, and sends the password only inside it. A recording TCP proxy between client and
 * daemon stands in for someone on the network path.
 */
import { createServer, connect, type Server, type Socket } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { networkInterfaces, tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { DIRECT_E2EE_SUBPROTOCOL } from "@getpaseo/protocol/daemon-endpoints";
import {
  DaemonClient as SharedDaemonClient,
  DIRECT_E2EE_FAILED_MESSAGE,
  type WebSocketLike,
} from "@getpaseo/client/internal/daemon-client";
import { DaemonClient } from "../test-utils/index.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { hashDaemonPassword } from "../auth.js";
import { loadOrCreateDaemonKeyPair } from "../daemon-keypair.js";
import { generateKeyPair, exportPublicKey } from "@getpaseo/relay/e2ee";

const PASSWORD = "dinobot-e2ee-test-password-0123456789";

interface Recorder {
  port: number;
  /** Everything the client sent toward the daemon, as raw bytes. */
  upstream: () => Buffer;
  /** Everything the daemon sent back. */
  downstream: () => Buffer;
  close: () => Promise<void>;
}

async function startRecordingProxy(targetHost: string, targetPort: number): Promise<Recorder> {
  const up: Buffer[] = [];
  const down: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const target = connect(targetPort, targetHost);
    sockets.add(client);
    sockets.add(target);
    client.on("data", (chunk) => {
      up.push(Buffer.from(chunk));
      target.write(chunk);
    });
    target.on("data", (chunk) => {
      down.push(Buffer.from(chunk));
      client.write(chunk);
    });
    const end = () => {
      client.destroy();
      target.destroy();
    };
    client.on("close", end);
    target.on("close", end);
    client.on("error", end);
    target.on("error", end);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind");
  return {
    port: address.port,
    upstream: () => Buffer.concat(up),
    downstream: () => Buffer.concat(down),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function nonLoopbackIpv4s(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

/**
 * Stands in for a daemon that predates direct E2EE: it ignores the subprotocol and reads the
 * first frame as the application hello, closing 4002 "Invalid hello".
 */
async function startOldDaemonStub(): Promise<{ old: WebSocketServer; received: string[] }> {
  const received: string[] = [];
  const old = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/ws" });
  const onFrame = (ws: WebSocket, data: unknown) => {
    received.push(String(data));
    ws.close(4002, "Invalid hello");
  };
  old.on("connection", (ws) => ws.on("message", (data) => onFrame(ws, data)));
  await once(old, "listening");
  return { old, received };
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/** GET /api/files/download from a chosen local address (another "machine" or this one). */
function httpDownload(
  target: { host: string; port: number; token: string },
  localAddress: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: target.host,
        port: target.port,
        path: `/api/files/download?token=${encodeURIComponent(target.token)}`,
        localAddress,
        headers: { Authorization: `Bearer ${PASSWORD}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
  delete process.env.PASEO_DIRECT_E2EE;
});

async function startDaemon(options: { listen?: string } = {}): Promise<{
  daemon: TestPaseoDaemon;
  publicKeyB64: string;
}> {
  const daemon = await createTestPaseoDaemon({
    auth: { password: hashDaemonPassword(PASSWORD) },
    ...(options.listen ? { listen: options.listen } : {}),
  });
  cleanups.push(() => daemon.close());
  const keyPair = await loadOrCreateDaemonKeyPair(daemon.paseoHome);
  return { daemon, publicKeyB64: keyPair.publicKeyB64 };
}

function track<T extends SharedDaemonClient>(client: T): T {
  cleanups.push(() => client.close());
  return client;
}

describe("direct E2EE", () => {
  test("admits the right key and password; the password never crosses the wire in clear", async () => {
    const { daemon, publicKeyB64 } = await startDaemon();
    const proxy = await startRecordingProxy("127.0.0.1", daemon.port);
    cleanups.push(() => proxy.close());

    const client = track(
      new DaemonClient({
        url: `ws://127.0.0.1:${proxy.port}/ws`,
        clientId: "clsk_direct_e2ee",
        password: PASSWORD,
        reconnect: { enabled: false },
        e2ee: { enabled: true, daemonPublicKeyB64: publicKeyB64 },
      }),
    );
    const started = performance.now();
    await client.connect();
    const connectMs = performance.now() - started;
    const agents = await client.fetchAgents();
    expect(agents.entries).toEqual([]);

    const upstream = proxy.upstream().toString("latin1");
    expect(upstream).toContain(`Sec-WebSocket-Protocol: ${DIRECT_E2EE_SUBPROTOCOL}`);
    expect(upstream).not.toContain(PASSWORD);
    expect(upstream).not.toMatch(/authorization:/i);
    expect(upstream).not.toContain("paseo.bearer.");
    expect(upstream).not.toContain('"type":"hello"');
    expect(proxy.downstream().toString("latin1")).not.toContain("server_info");
    console.info(`[direct-e2ee] connect incl. handshake: ${connectMs.toFixed(1)} ms`);
  });

  test("control: a plaintext client on the same path shows the password in clear", async () => {
    const { daemon } = await startDaemon();
    const proxy = await startRecordingProxy("127.0.0.1", daemon.port);
    cleanups.push(() => proxy.close());
    const client = track(
      new DaemonClient({
        url: `ws://127.0.0.1:${proxy.port}/ws`,
        clientId: "clsk_direct_plain",
        password: PASSWORD,
        reconnect: { enabled: false },
      }),
    );
    await client.connect();
    expect(proxy.upstream().toString("latin1")).toContain(PASSWORD);
  });

  test("a daemon without the paired key never gets the password", async () => {
    const { daemon } = await startDaemon();
    const proxy = await startRecordingProxy("127.0.0.1", daemon.port);
    cleanups.push(() => proxy.close());
    const impostorKey = exportPublicKey(generateKeyPair().publicKey);
    const client = track(
      new DaemonClient({
        url: `ws://127.0.0.1:${proxy.port}/ws`,
        clientId: "clsk_direct_wrong_key",
        password: PASSWORD,
        reconnect: { enabled: false },
        e2ee: { enabled: true, daemonPublicKeyB64: impostorKey },
      }),
    );
    await expect(client.connect()).rejects.toThrow();
    expect(client.lastError).toBe(DIRECT_E2EE_FAILED_MESSAGE);
    expect(proxy.upstream().toString("latin1")).not.toContain(PASSWORD);
  });

  test("an old daemon (no direct E2EE) fails clearly, never falls back to plaintext", async () => {
    const { old, received } = await startOldDaemonStub();
    cleanups.push(() => closeServer(old));
    const port = (old.address() as { port: number }).port;
    const client = track(
      new DaemonClient({
        url: `ws://127.0.0.1:${port}/ws`,
        clientId: "clsk_old_daemon",
        password: PASSWORD,
        reconnect: { enabled: true, baseDelayMs: 10, maxDelayMs: 10 },
        e2ee: {
          enabled: true,
          daemonPublicKeyB64: exportPublicKey(generateKeyPair().publicKey),
        },
      }),
    );
    await expect(client.connect()).rejects.toThrow();
    expect(client.lastError).toBe(DIRECT_E2EE_FAILED_MESSAGE);
    expect(received.join("\n")).not.toContain(PASSWORD);
    expect(received.every((frame) => frame.includes('"e2ee_hello"'))).toBe(true);
  });

  test("PASEO_DIRECT_E2EE=required: a plaintext client from another address is refused clearly", async () => {
    const [daemonIp, otherIp] = nonLoopbackIpv4s();
    if (!daemonIp || !otherIp) return; // needs two local addresses to stand in for two machines
    process.env.PASEO_DIRECT_E2EE = "required";
    const { daemon, publicKeyB64 } = await startDaemon({ listen: daemonIp });
    // Source the connection from a different local address: the daemon sees a peer that is not
    // its own address, which is what another machine looks like.
    const fromOtherAddress = (
      url: string,
      options?: { protocols?: string[]; headers?: Record<string, string> },
    ) =>
      new WebSocket(url, options?.protocols ?? [], {
        headers: options?.headers,
        localAddress: otherIp,
      }) as unknown as WebSocketLike;
    const plain = track(
      new SharedDaemonClient({
        url: `ws://${daemonIp}:${daemon.port}/ws`,
        clientId: "clsk_old_app",
        password: PASSWORD,
        reconnect: { enabled: false },
        webSocketFactory: fromOtherAddress,
      }),
    );
    await expect(plain.connect()).rejects.toThrow();
    expect(plain.lastError).toBe("Encrypted connection required: update the app");

    const encrypted = track(
      new SharedDaemonClient({
        url: `ws://${daemonIp}:${daemon.port}/ws`,
        clientId: "clsk_new_app",
        password: PASSWORD,
        reconnect: { enabled: false },
        webSocketFactory: fromOtherAddress,
        e2ee: { enabled: true, daemonPublicKeyB64: publicKeyB64 },
      }),
    );
    await encrypted.connect();
    expect((await encrypted.fetchAgents()).entries).toEqual([]);
  });

  test("PASEO_DIRECT_E2EE=required: this machine's own clients on the tailnet-style address still work", async () => {
    // The installer listens on the tailnet IP only, so the local CLI and bots connect from
    // that IP to that IP; nothing leaves the machine.
    const [daemonIp] = nonLoopbackIpv4s();
    if (!daemonIp) return;
    process.env.PASEO_DIRECT_E2EE = "required";
    const { daemon } = await startDaemon({ listen: daemonIp });
    const local = track(
      new DaemonClient({
        url: `ws://${daemonIp}:${daemon.port}/ws`,
        clientId: "clsk_local_cli",
        password: PASSWORD,
        reconnect: { enabled: false },
      }),
    );
    await local.connect();
    expect((await local.fetchAgents()).entries).toEqual([]);
  });

  test("PASEO_DIRECT_E2EE=required: files come over the encrypted socket; a plain-HTTP download from another address gets 426", async () => {
    const [daemonIp, otherIp] = nonLoopbackIpv4s();
    if (!daemonIp || !otherIp) return;
    process.env.PASEO_DIRECT_E2EE = "required";
    const { daemon, publicKeyB64 } = await startDaemon({ listen: daemonIp });
    const workspace = await mkdtemp(path.join(tmpdir(), "paseo-direct-e2ee-files-"));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const secret = "file contents that must not cross the wire in clear\n";
    await writeFile(path.join(workspace, "notes.txt"), secret);
    const proxy = await startRecordingProxy(daemonIp, daemon.port);
    cleanups.push(() => proxy.close());
    const fromOtherAddress = (
      url: string,
      options?: { protocols?: string[]; headers?: Record<string, string> },
    ) =>
      new WebSocket(url, options?.protocols ?? [], {
        headers: options?.headers,
        localAddress: otherIp,
      }) as unknown as WebSocketLike;
    const encrypted = track(
      new SharedDaemonClient({
        url: `ws://127.0.0.1:${proxy.port}/ws`,
        clientId: "clsk_new_app_files",
        password: PASSWORD,
        reconnect: { enabled: false },
        webSocketFactory: fromOtherAddress,
        e2ee: { enabled: true, daemonPublicKeyB64: publicKeyB64 },
      }),
    );
    await encrypted.connect();
    const file = await encrypted.readFile(workspace, "notes.txt");
    expect(new TextDecoder().decode(file.bytes)).toBe(secret);
    expect(proxy.downstream().includes(Buffer.from("must not cross the wire"))).toBe(false);

    // The upstream HTTP route: a token is still issued, but another address is refused.
    const token = await encrypted.requestDownloadToken(workspace, "notes.txt");
    expect(token.token).toBeTruthy();
    const download = { host: daemonIp, port: daemon.port, token: token.token! };
    const refused = await httpDownload(download, otherIp);
    expect(refused.status).toBe(426);
    expect(refused.body).toContain("Encrypted connection required");
    // This machine (CLI, desktop on the same box) still downloads over HTTP.
    const local = await httpDownload(download, daemonIp);
    expect(local).toEqual({ status: 200, body: secret });
  });

  test("the encrypted channel still checks the password", async () => {
    const { daemon, publicKeyB64 } = await startDaemon();
    const client = track(
      new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        clientId: "clsk_direct_wrong_password",
        password: "not-the-password",
        reconnect: { enabled: false },
        e2ee: { enabled: true, daemonPublicKeyB64: publicKeyB64 },
      }),
    );
    await expect(client.connect()).rejects.toThrow("Incorrect password");
  });

  test("a raw socket offering the subprotocol gets it and must handshake first", async () => {
    const { daemon } = await startDaemon();
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, [DIRECT_E2EE_SUBPROTOCOL]);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    expect(ws.protocol).toBe(DIRECT_E2EE_SUBPROTOCOL);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(
      JSON.stringify({
        type: "hello",
        clientId: "x",
        clientType: "cli",
        protocolVersion: 1,
      }),
    );
    expect(await closed).toBe(1011);
  });
});
