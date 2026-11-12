/**
 * HS1: Noise msg1 carried in the direct E2EE upgrade (Sec-WebSocket-Protocol). The daemon
 * answers e2ee_ready as its first frame; the client sends no in-band hello. Old clients
 * (only DIRECT_E2EE_SUBPROTOCOL) and a carrier stripped in transit fall back to the in-band
 * hello, still end-to-end encrypted. See docs/perf/priority-sync/handshake-security.md.
 */
import { createServer, connect, type Server, type Socket } from "node:net";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import pino from "pino";
import { DIRECT_E2EE_SUBPROTOCOL } from "@getpaseo/protocol/daemon-endpoints";
import {
  exportPublicKey,
  generateKeyPair,
  UPGRADE_CARRIER_ACCEPTED_SUBPROTOCOL,
  UPGRADE_CARRIER_MSG1_PREFIX,
} from "@getpaseo/relay/e2ee";
import { DaemonClient } from "../test-utils/index.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { hashDaemonPassword } from "../auth.js";
import { loadOrCreateDaemonKeyPair } from "../daemon-keypair.js";

const PASSWORD = "dinobot-hs1-test-password-0123456789";

interface Proxy {
  port: number;
  upstream: () => Buffer;
  downstream: () => Buffer;
  close: () => Promise<void>;
}

/** TCP proxy that records both directions; `rewriteUp` may edit the first upstream chunk. */
async function startProxy(
  targetPort: number,
  rewriteUp: (chunk: Buffer) => Buffer = (chunk) => chunk,
): Promise<Proxy> {
  const up: Buffer[] = [];
  const down: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const target = connect(targetPort, "127.0.0.1");
    sockets.add(client);
    sockets.add(target);
    let first = true;
    client.on("data", (raw) => {
      const chunk = first ? rewriteUp(Buffer.from(raw)) : Buffer.from(raw);
      first = false;
      up.push(chunk);
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
    for (const s of [client, target]) {
      s.on("close", end);
      s.on("error", end);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind");
  return {
    port: address.port,
    upstream: () => Buffer.concat(up),
    downstream: () => Buffer.concat(down),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

async function startDaemon() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const daemon = await createTestPaseoDaemon({
    auth: { password: hashDaemonPassword(PASSWORD) },
    logger: pino({ level: "trace" }, sink),
  });
  cleanups.push(() => daemon.close());
  const keyPair = await loadOrCreateDaemonKeyPair(daemon.paseoHome);
  return {
    daemon,
    publicKeyB64: keyPair.publicKeyB64,
    logs: () => lines.join(""),
  };
}

function client(port: number, publicKeyB64: string, upgradeCarrier?: boolean) {
  const c = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "clsk_hs1",
    password: PASSWORD,
    reconnect: { enabled: false },
    e2ee: {
      enabled: true,
      daemonPublicKeyB64: publicKeyB64,
      ...(upgradeCarrier === undefined ? {} : { upgradeCarrier }),
    },
  });
  cleanups.push(() => c.close());
  return c;
}

/** WebSocket frames from the server after the 101 response: [opcode, payload]. */
function serverFrames(downstream: Buffer): Array<{ opcode: number; payload: Buffer }> {
  const start = downstream.indexOf("\r\n\r\n") + 4;
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let i = start;
  while (i + 2 <= downstream.length) {
    const opcode = downstream[i]! & 0x0f;
    let len = downstream[i + 1]! & 0x7f;
    let off = i + 2;
    if (len === 126) {
      len = downstream.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      len = Number(downstream.readBigUInt64BE(off));
      off += 8;
    }
    frames.push({ opcode, payload: downstream.subarray(off, off + len) });
    i = off + len;
  }
  return frames;
}

/** Upgrade request plus every client frame, unmasked, as text. */
function upstreamText(upstream: Buffer): string {
  const head = upstream.subarray(0, upstream.indexOf("\r\n\r\n") + 4).toString("latin1");
  return (
    head +
    clientFrames(upstream)
      .map((f) => f.payload.toString("latin1"))
      .join("\n")
  );
}

function msg1Of(upstream: string): string {
  const match = upstream.match(
    new RegExp(`${UPGRADE_CARRIER_MSG1_PREFIX.replace(/\./g, "\\.")}([A-Za-z0-9_-]+)`),
  );
  if (!match) throw new Error("no carrier in upgrade");
  return match[1]!;
}

describe("direct E2EE: msg1 in the upgrade (HS1)", () => {
  test("new client, new daemon: ready is the first frame, no in-band hello, password never in clear", async () => {
    const { daemon, publicKeyB64, logs } = await startDaemon();
    const proxy = await startProxy(daemon.port);
    cleanups.push(() => proxy.close());
    const c = client(proxy.port, publicKeyB64);
    await c.connect();
    expect((await c.fetchAgents()).entries).toEqual([]);

    const upstream = upstreamText(proxy.upstream());
    expect(upstream.replace(/, /g, ",")).toContain(
      `Sec-WebSocket-Protocol: ${DIRECT_E2EE_SUBPROTOCOL},${UPGRADE_CARRIER_ACCEPTED_SUBPROTOCOL},${UPGRADE_CARRIER_MSG1_PREFIX}`,
    );
    expect(upstream).not.toContain("e2ee_hello");
    expect(upstream).not.toContain(PASSWORD);
    expect(upstream).not.toContain("paseo.bearer.");
    const downstream = proxy.downstream();
    expect(downstream.toString("latin1")).toMatch(
      new RegExp(
        `Sec-WebSocket-Protocol: ${UPGRADE_CARRIER_ACCEPTED_SUBPROTOCOL.replace(/\./g, "\\.")}\\r\\n`,
      ),
    );
    const first = serverFrames(downstream)[0]!;
    expect(JSON.parse(first.payload.toString("utf8")).type).toBe("e2ee_ready");
    expect(downstream.toString("latin1")).not.toContain("server_info");
    // msg1 is not logged anywhere (connection, admission, trace).
    expect(logs()).not.toContain(msg1Of(upstream));
  });

  test("compact hello (cb) to a carrier daemon: smaller hello, capabilities still honoured", async () => {
    const { daemon, publicKeyB64 } = await startDaemon();
    const sizes: Record<string, { hello: number; binaryDown: number }> = {};
    for (const [label, carrier] of [
      ["carrier", true],
      ["inband", false],
    ] as const) {
      const proxy = await startProxy(daemon.port);
      cleanups.push(() => proxy.close());
      const c = client(proxy.port, publicKeyB64, carrier);
      await c.connect();
      await c.fetchAgents();
      const up = clientFrames(proxy.upstream()).filter((f) => f.opcode === 1 || f.opcode === 2);
      const hello = carrier ? up[0]! : up[1]!;
      const down = serverFrames(proxy.downstream());
      sizes[label] = {
        hello: hello.payload.length,
        binaryDown: down.filter((f) => f.opcode === 2).length,
      };
      await c.close();
    }
    console.info(`[hs1] hello record bytes: ${JSON.stringify(sizes)}`);
    expect(sizes.carrier!.hello).toBeLessThan(sizes.inband!.hello - 400);
    // compressed_frames came through the bits: the daemon sends binary frames to both.
    expect(sizes.carrier!.binaryDown).toBeGreaterThan(0);
    expect(sizes.inband!.binaryDown).toBeGreaterThan(0);
  });

  test("old client (builds 3/7: only the E2EE subprotocol) is unchanged: in-band hello", async () => {
    const { daemon, publicKeyB64 } = await startDaemon();
    const proxy = await startProxy(daemon.port);
    cleanups.push(() => proxy.close());
    const c = client(proxy.port, publicKeyB64, false);
    await c.connect();
    expect((await c.fetchAgents()).entries).toEqual([]);
    const upstream = upstreamText(proxy.upstream());
    expect(upstream).toContain(`Sec-WebSocket-Protocol: ${DIRECT_E2EE_SUBPROTOCOL}\r\n`);
    expect(upstream).toContain("e2ee_hello");
    expect(proxy.downstream().toString("latin1")).toContain(
      `Sec-WebSocket-Protocol: ${DIRECT_E2EE_SUBPROTOCOL}\r\n`,
    );
  });

  test("downgrade: carrier stripped in transit -> in-band hello, still E2EE, never plaintext", async () => {
    const { daemon, publicKeyB64 } = await startDaemon();
    const strip = (chunk: Buffer) =>
      Buffer.from(
        chunk
          .toString("latin1")
          .replace(/^(Sec-WebSocket-Protocol: )[^\r]*/im, `$1${DIRECT_E2EE_SUBPROTOCOL}`),
        "latin1",
      );
    const proxy = await startProxy(daemon.port, strip);
    cleanups.push(() => proxy.close());
    const c = client(proxy.port, publicKeyB64);
    const started = performance.now();
    await c.connect();
    const ms = performance.now() - started;
    expect((await c.fetchAgents()).entries).toEqual([]);
    const upstream = upstreamText(proxy.upstream());
    expect(upstream).toContain("e2ee_hello");
    expect(upstream).not.toContain(PASSWORD);
    expect(upstream).not.toContain('"type":"hello"');
    // The selected subprotocol told the client at once: no 1 s fallback wait.
    expect(ms).toBeLessThan(900);
  });

  test("tampered carried msg1 fails like a tampered in-band msg1 (1011), password never sent", async () => {
    const { daemon, publicKeyB64 } = await startDaemon();
    const tamper = (chunk: Buffer) => {
      const text = chunk.toString("latin1");
      const msg1 = msg1Of(text);
      const flipped = (msg1[10] === "A" ? "B" : "A") + "";
      return Buffer.from(
        text.replace(msg1, msg1.slice(0, 10) + flipped + msg1.slice(11)),
        "latin1",
      );
    };
    const proxy = await startProxy(daemon.port, tamper);
    cleanups.push(() => proxy.close());
    const c = client(proxy.port, publicKeyB64);
    await expect(c.connect()).rejects.toThrow();
    const frames = serverFrames(proxy.downstream());
    expect(frames.some((f) => f.opcode === 8 && f.payload.readUInt16BE(0) === 1011)).toBe(true);
    expect(upstreamText(proxy.upstream())).not.toContain(PASSWORD);
  });

  test("replayed upgrade: fresh ready, recorded records refused (1011), nothing admitted", async () => {
    const { daemon, publicKeyB64 } = await startDaemon();
    const proxy = await startProxy(daemon.port);
    cleanups.push(() => proxy.close());
    const c = client(proxy.port, publicKeyB64);
    await c.connect();
    await c.fetchAgents();
    const original = proxy.upstream().toString("latin1");
    const msg1 = msg1Of(original);

    // Attacker replays the upgrade (same carrier) and then the recorded client frames.
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, [
      DIRECT_E2EE_SUBPROTOCOL,
      UPGRADE_CARRIER_ACCEPTED_SUBPROTOCOL,
      `${UPGRADE_CARRIER_MSG1_PREFIX}${msg1}`,
    ]);
    const received: string[] = [];
    ws.on("message", (data) => received.push(String(data)));
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    expect(ws.protocol).toBe(UPGRADE_CARRIER_ACCEPTED_SUBPROTOCOL);
    // Client frames are masked on the wire; resend the first recorded record unmasked.
    const upFrames = clientFrames(proxy.upstream());
    ws.send(upFrames[0]!.payload.toString("utf8"));
    expect(await closed).toBe(1011);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!).type).toBe("e2ee_ready");
    // Fresh responder ephemeral: not the ready the original session got.
    expect(serverFrames(proxy.downstream())[0]!.payload.toString("utf8")).not.toBe(received[0]);
  });

  test("wrong pinned key: daemon cannot read the carried msg1 (1011), password never sent", async () => {
    const { daemon } = await startDaemon();
    const proxy = await startProxy(daemon.port);
    cleanups.push(() => proxy.close());
    const c = client(proxy.port, exportPublicKey(generateKeyPair().publicKey));
    await expect(c.connect()).rejects.toThrow();
    expect(upstreamText(proxy.upstream())).not.toContain(PASSWORD);
    const frames = serverFrames(proxy.downstream());
    expect(frames.some((f) => f.opcode === 8 && f.payload.readUInt16BE(0) === 1011)).toBe(true);
  });
});

/** Masked client frames after the upgrade request: [opcode, unmasked payload]. */
function clientFrames(upstream: Buffer): Array<{ opcode: number; payload: Buffer }> {
  const start = upstream.indexOf("\r\n\r\n") + 4;
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let i = start;
  while (i + 2 <= upstream.length) {
    const opcode = upstream[i]! & 0x0f;
    let len = upstream[i + 1]! & 0x7f;
    let off = i + 2;
    if (len === 126) {
      len = upstream.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      len = Number(upstream.readBigUInt64BE(off));
      off += 8;
    }
    const mask = upstream.subarray(off, off + 4);
    off += 4;
    const payload = Buffer.from(upstream.subarray(off, off + len));
    for (let k = 0; k < payload.length; k += 1) payload[k]! ^= mask[k % 4]!;
    frames.push({ opcode, payload });
    i = off + len;
  }
  return frames;
}
