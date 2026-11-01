import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  CheckedJsonFrameCompressor,
  JsonFrameCompressor,
} from "@getpaseo/protocol/binary-frames/compressed-json-node";
import {
  COMPRESSED_JSON_MIN_BYTES,
  decodeCompressionReset,
} from "@getpaseo/protocol/binary-frames/compressed-json";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createPluginDaemonTransportFactory } from "./daemon-transport.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";
import { PluginRuntime } from "./runtime.js";
import type { PluginSessionSocket } from "./session-socket.js";

/**
 * The plugin child's DaemonClient and the daemon's plugin session share one IPC channel for the
 * life of the process. Compressed frames (compressed_frames) carry history per socket, so a frame
 * the daemon sends on a session the child has already abandoned must never reach the client's
 * next transport: its fresh decompressor cannot decode it ("invalid distance"), and that throw
 * used to kill the plugin process (bots, 2026-10-10T08:19:06Z).
 */

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true })));
});

async function createPlugin(id: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }), "utf8");
  await writeFile(
    path.join(directory, "index.server.ts"),
    `export default function contribute() { return () => undefined; }`,
    "utf8",
  );
  return directory;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * One plugin child run in-process: a real DaemonClient on the real IPC transport, behind an
 * ordered, asynchronous message channel like Node's. The daemon side can stop reading what the
 * child sends (a stalled daemon event loop) while it still writes to the child.
 */
function createInProcessPluginChild(pluginId: string, options: { connectTimeoutMs?: number } = {}) {
  const parentListeners = new Map<string, Array<(...args: never[]) => void>>();
  const childHandlers = new Set<(message: PluginProcessRequest) => void>();
  const toParent: PluginProcessMessage[] = [];
  const toChild: PluginProcessRequest[] = [];
  const crashes: Error[] = [];
  const hellosSent: number[] = [];
  let parentReading = true;
  let client: DaemonClient | null = null;

  const emitToParent = (event: string, ...args: unknown[]) => {
    for (const listener of parentListeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  };
  const flushToParent = () => {
    // The daemon may stall again from inside a handler, so check before every message.
    for (let next = toParent.shift(); next; next = toParent.shift()) {
      if (!parentReading) {
        toParent.unshift(next);
        return;
      }
      emitToParent("message", next);
    }
  };
  const flushToChild = () => {
    while (toChild.length > 0) {
      const message = toChild.shift()!;
      // A handler may close its transport (unsubscribe) mid-delivery: iterate a snapshot.
      for (const handler of Array.from(childHandlers)) {
        try {
          handler(message);
        } catch (error) {
          // In the real child this is an uncaught exception: the process dies.
          crashes.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  };
  const childSend = (message: PluginProcessMessage) => {
    if (message.type === "paseo_frame" && typeof message.data === "string") {
      if (message.data.includes('"type":"hello"')) hellosSent.push(message.link ?? 0);
    }
    toParent.push(message);
    setImmediate(flushToParent);
  };

  const transportFactory = createPluginDaemonTransportFactory({
    send: childSend,
    onMessage(handler) {
      childHandlers.add(handler);
      return () => childHandlers.delete(handler);
    },
  });

  const child = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    killed: false,
    send(message: PluginProcessRequest, callback?: (error: Error | null) => void) {
      if (message.type === "initialize") {
        client = new DaemonClient({
          url: `ipc://plugin/${pluginId}`,
          clientId: `plugin:${pluginId}`,
          clientType: "cli",
          reconnect: { enabled: true, baseDelayMs: 10, maxDelayMs: 10 },
          ...(options.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
          transportFactory,
        });
        void client
          .connect()
          .then(() => childSend({ type: "ready", methods: [], providers: [], usageSources: [] }));
      } else if (message.type === "shutdown") {
        void client?.close().finally(() => {
          child.connected = false;
          emitToParent("close", 0, null);
        });
      } else {
        const copy =
          message.type === "paseo_frame" && typeof message.data !== "string"
            ? { ...message, data: new Uint8Array(message.data) }
            : message;
        toChild.push(copy);
        setImmediate(flushToChild);
      }
      callback?.(null);
      return true;
    },
    kill() {
      child.killed = true;
      child.connected = false;
      queueMicrotask(() => emitToParent("close", null, null));
      return true;
    },
    disconnect() {
      child.connected = false;
    },
    on(event: string, listener: (...args: never[]) => void) {
      const registered = parentListeners.get(event) ?? [];
      registered.push(listener);
      parentListeners.set(event, registered);
      return child;
    },
  };

  return {
    child,
    crashes,
    hellosSent,
    get client(): DaemonClient {
      if (!client) throw new Error("child has not initialized");
      return client;
    },
    stallDaemon() {
      parentReading = false;
    },
    resumeDaemon() {
      parentReading = true;
      setImmediate(flushToParent);
    },
  };
}

/** Like the daemon's websocket server: one compressor per socket, made at that socket's hello. */
function createCompressingSessionHost() {
  const sockets: PluginSessionSocket[] = [];
  const compressors = new WeakMap<PluginSessionSocket, JsonFrameCompressor>();
  const hellos: PluginSessionSocket[] = [];
  const send = (socket: PluginSessionSocket, message: unknown) => {
    const text = JSON.stringify(message);
    const compressor = text.length >= COMPRESSED_JSON_MIN_BYTES ? compressors.get(socket) : null;
    socket.send(compressor ? compressor.compress(text) : text);
  };
  const status = (serverId: string) => ({
    type: "session",
    message: {
      type: "status",
      payload: {
        status: "server_info",
        serverId,
        hostname: "reattach-compression-test",
        version: "0.4.0",
        features: {},
        // Long enough to compress, and repetitive, so later frames lean on history.
        padding: "agent_update ".repeat(40),
      },
    },
  });
  return {
    sockets,
    hellos,
    send,
    status,
    host: {
      async attachPluginSocket(_pluginId: string, socket: PluginSessionSocket) {
        sockets.push(socket);
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        socket.on("message", (data) => {
          if (typeof data !== "string") return;
          const message = JSON.parse(data) as { type?: string; capabilities?: object };
          if (message.type !== "hello") return;
          compressors.set(socket, new JsonFrameCompressor());
          hellos.push(socket);
          send(socket, status(`hello_${hellos.length}`));
        });
        return { closed };
      },
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("keeps a stale compressed frame from an abandoned session away from the redialled client", async () => {
  const directory = await createPlugin("reattach-compression");
  const plugin = createInProcessPluginChild("reattach-compression");
  const daemon = createCompressingSessionHost();
  const runtime = new PluginRuntime(pino({ level: "silent" }), "0.4.0", {
    spawnChild: () => plugin.child,
    sessionHost: daemon.host,
  });
  try {
    await runtime.startPlugin("reattach-compression", directory);
    const received: string[] = [];
    plugin.client.subscribeRawMessages((message) => {
      const serverId = (message as { payload?: { serverId?: string } }).payload?.serverId;
      if (serverId) received.push(serverId);
    });
    const first = daemon.sockets[0]!;
    // Compressed frames flow: both ends now hold the same history.
    daemon.send(first, daemon.status("before_1"));
    daemon.send(first, daemon.status("before_2"));
    await waitFor(() => received.includes("before_2"));

    // The daemon's event loop stalls (08:15-08:19Z). The child's liveness probe times out, it
    // drops its transport and redials: its paseo_close and new hello queue up unread.
    plugin.stallDaemon();
    plugin.client.ensureConnected({ verify: true });
    await waitFor(() => plugin.client.getConnectionState().status === "connecting", 10_000);

    // Still unaware of the close, the daemon finishes old work on the old socket.
    daemon.send(first, daemon.status("stale"));
    await tick();
    await tick();

    // The daemon catches up: it reads the close and the new hello and re-attaches.
    plugin.resumeDaemon();
    await waitFor(() => plugin.client.getConnectionState().status === "connected");
    const replacement = daemon.hellos.at(-1)!;
    expect(replacement).not.toBe(first);
    daemon.send(replacement, daemon.status("after"));
    await waitFor(() => received.includes("after"));

    expect(plugin.crashes).toEqual([]);
    expect(received).not.toContain("stale");
    // Dropped as another link's frame, not decoded, failed and recovered from by redialling.
    expect(plugin.client.lastError ?? "").not.toMatch(/did not decode/);
    expect(daemon.hellos).toHaveLength(2);
    expect(daemon.sockets.filter((socket) => socket.readyState === 1)).toEqual([replacement]);
    expect(runtime.getLogs("reattach-compression").map((entry) => entry.message)).toContain(
      "[paseo] Re-attached plugin session",
    );
  } finally {
    await runtime.stopAll();
  }
}, 20_000);

it("settles on the child's newest link when it redials more than once during a stall", async () => {
  const directory = await createPlugin("reattach-redials");
  const plugin = createInProcessPluginChild("reattach-redials", { connectTimeoutMs: 200 });
  const daemon = createCompressingSessionHost();
  const runtime = new PluginRuntime(pino({ level: "silent" }), "0.4.0", {
    spawnChild: () => plugin.child,
    sessionHost: daemon.host,
  });
  try {
    await runtime.startPlugin("reattach-redials", directory);
    const received: string[] = [];
    plugin.client.subscribeRawMessages((message) => {
      const serverId = (message as { payload?: { serverId?: string } }).payload?.serverId;
      if (serverId) received.push(serverId);
    });
    const first = daemon.sockets[0]!;
    daemon.send(first, daemon.status("before"));
    await waitFor(() => received.includes("before"));

    plugin.stallDaemon();
    // While the daemon reads nothing, each connect attempt times out: a hello, then a close.
    plugin.client.ensureConnected({ verify: true });
    await waitFor(() => plugin.hellosSent.length >= 4);
    daemon.send(first, daemon.status("stale"));
    await tick();

    plugin.resumeDaemon();
    await waitFor(() => plugin.client.getConnectionState().status === "connected");
    const live = daemon.sockets.filter((socket) => socket.readyState === 1);
    expect(live).toHaveLength(1);
    daemon.send(live[0]!, daemon.status("after"));
    await waitFor(() => received.includes("after"));

    expect(plugin.crashes).toEqual([]);
    expect(received).not.toContain("stale");
    expect(plugin.client.lastError ?? "").not.toMatch(/did not decode/);
  } finally {
    await runtime.stopAll();
  }
}, 20_000);

it("the plugin client answers a broken checked frame with a reset over IPC and keeps its session", async () => {
  const directory = await createPlugin("checked-reset");
  const plugin = createInProcessPluginChild("checked-reset");
  const sockets: PluginSessionSocket[] = [];
  const compressors = new WeakMap<PluginSessionSocket, CheckedJsonFrameCompressor>();
  const resets: Array<{ generation: number; seq: number }> = [];
  let corruptNext = false;
  const send = (socket: PluginSessionSocket, serverId: string) => {
    const frame = compressors.get(socket)!.compress(
      JSON.stringify({
        type: "session",
        message: {
          type: "status",
          payload: { status: "server_info", serverId, hostname: null, version: "0.4.0" },
        },
      }),
    );
    if (corruptNext) {
      corruptNext = false;
      frame[frame.length - 2] ^= 0x5a;
    }
    socket.send(frame);
  };
  const host = {
    async attachPluginSocket(_pluginId: string, socket: PluginSessionSocket) {
      sockets.push(socket);
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));
      socket.on("message", (data) => {
        if (typeof data !== "string") {
          // Like websocket-server handleCompressionReset.
          const request = decodeCompressionReset(new Uint8Array(data as Uint8Array));
          if (!request) return;
          resets.push(request);
          const answer = compressors.get(socket)!.reset(request);
          if (!answer || answer === "stale") return;
          socket.send(answer.ack);
          for (const frame of answer.frames) socket.send(frame);
          return;
        }
        const message = JSON.parse(data) as { type?: string; capabilities?: object };
        if (message.type !== "hello") return;
        compressors.set(socket, new CheckedJsonFrameCompressor());
        send(socket, "hello");
      });
      return { closed };
    },
  };
  const runtime = new PluginRuntime(pino({ level: "silent" }), "0.4.0", {
    spawnChild: () => plugin.child,
    sessionHost: host,
  });
  try {
    await runtime.startPlugin("checked-reset", directory);
    const received: string[] = [];
    plugin.client.subscribeRawMessages((message) => {
      const serverId = (message as { payload?: { serverId?: string } }).payload?.serverId;
      if (serverId) received.push(serverId);
    });
    const socket = sockets[0]!;
    send(socket, "one");
    corruptNext = true;
    send(socket, "two");
    send(socket, "three");
    await waitFor(() => received.includes("three"));

    expect(received).toEqual(["one", "two", "three"]);
    expect(resets).toEqual([{ generation: 0, seq: 2 }]);
    expect(plugin.crashes).toEqual([]);
    expect(sockets).toHaveLength(1);
    expect(plugin.client.getConnectionState()).toEqual({ status: "connected" });
  } finally {
    await runtime.stopAll();
  }
}, 20_000);
