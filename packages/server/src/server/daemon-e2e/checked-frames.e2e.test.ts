import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  CheckedJsonOpcode,
  CompressedJsonOpcode,
  CompressionResetOpcode,
  isCheckedJsonFrame,
  ZstdJsonOpcode,
} from "@getpaseo/protocol/binary-frames/compressed-json";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

/**
 * Checked frames end to end (checked_frames): a frame broken on the way to the client makes it
 * ask for a reset; the daemon resends from that frame and the socket, its session and every
 * pending request survive. Before this, a broken compressed frame dropped the socket (and, before
 * the plugin-reattach fix, threw out of the message handler).
 */

let ctx: DaemonTestContext;
let cwd: string;
const extraClients: DaemonClient[] = [];

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "checked-frames-"));
});

afterEach(async () => {
  await Promise.all(extraClients.splice(0).map((client) => client.close()));
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 60_000);

interface WireLog {
  inboundOpcodes: number[];
  outboundKinds?: Array<"text" | number>;
  corruptUplink?: Set<number>;
  resetsSent: number;
  corrupted: number;
  sockets: number;
}

/** A Node WebSocket that flips bytes in the chosen checked frames before the client sees them. */
function corruptingFactory(corruptFrames: Set<number>, log: WireLog) {
  return (url: string) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    log.sockets += 1;
    let checkedIndex = 0;
    const emit = ws.emit.bind(ws);
    ws.emit = ((event: string, ...args: unknown[]) => {
      if (event === "message" && args[1] === true) {
        const data = new Uint8Array(args[0] as Buffer);
        log.inboundOpcodes.push(data[0] ?? -1);
        if (isCheckedJsonFrame(data)) {
          checkedIndex += 1;
          if (corruptFrames.has(checkedIndex)) {
            const copy = Buffer.from(data);
            copy[copy.length - 2] = (copy[copy.length - 2] ?? 0) ^ 0x5a;
            log.corrupted += 1;
            return emit(event, copy, true);
          }
        }
      }
      return emit(event, ...args);
    }) as typeof ws.emit;
    const send = ws.send.bind(ws);
    let uplinkIndex = 0;
    ws.send = ((data: unknown, ...rest: unknown[]) => {
      if (data instanceof Uint8Array && data[0] === CompressionResetOpcode) log.resetsSent += 1;
      log.outboundKinds?.push(typeof data === "string" ? "text" : ((data as Uint8Array)[0] ?? -1));
      if (data instanceof Uint8Array && data[0] === CheckedJsonOpcode) {
        uplinkIndex += 1;
        if (log.corruptUplink?.has(uplinkIndex)) {
          const copy = Buffer.from(data);
          copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0x5a;
          return (send as (...a: unknown[]) => void)(copy, ...rest);
        }
      }
      return (send as (...a: unknown[]) => void)(data, ...rest);
    }) as typeof ws.send;
    return ws as never;
  };
}

function newClient(options: { corrupt: number[]; log: WireLog; capabilities?: object }) {
  const client = new DaemonClient({
    ...(options.capabilities ? { capabilities: options.capabilities as never } : {}),
    url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    clientId: `checked-frames-${Math.random().toString(36).slice(2, 8)}`,
    reconnect: { enabled: true, baseDelayMs: 50, maxDelayMs: 50 },
    webSocketFactory: corruptingFactory(new Set(options.corrupt), options.log),
  });
  extraClients.push(client);
  return client;
}

test("a corrupted frame is reset and resent on the same socket; every request still answers", async () => {
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "checked" });
  for (let index = 0; index < 5; index += 1) {
    await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
      type: "assistant_message",
      text: `reply ${index} ${"lorem ipsum ".repeat(30)}`,
    });
    await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
      type: "user_message",
      text: `question ${index}`,
    });
  }
  const log: WireLog = { inboundOpcodes: [], resetsSent: 0, corrupted: 0, sockets: 0 };
  // Frame 1 is server_info; break two later ones, far apart.
  const client = newClient({ corrupt: [3, 9], log });
  await client.connect();

  const pages = [];
  for (let index = 0; index < 8; index += 1) {
    pages.push(
      await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 10, ifLoaded: true }),
    );
  }

  expect(log.corrupted).toBe(2);
  expect(log.resetsSent).toBe(2);
  expect(log.sockets).toBe(1);
  expect(client.getConnectionState()).toEqual({ status: "connected" });
  const reference = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 10 });
  for (const page of pages) expect(page.entries).toEqual(reference.entries);
  // Every JSON frame on a checked socket is checked, small ones too; no legacy 0x20 frames.
  expect(log.inboundOpcodes).not.toContain(CompressedJsonOpcode);
  // A current client gets the zstd stream.
  expect(log.inboundOpcodes).toContain(ZstdJsonOpcode);
  expect(log.inboundOpcodes).not.toContain(CheckedJsonOpcode);
});

test("a client without zstd_frames keeps checked DEFLATE frames and their reset", async () => {
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "deflate" });
  await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
    type: "assistant_message",
    text: `reply ${"lorem ipsum ".repeat(30)}`,
  });
  const log: WireLog = { inboundOpcodes: [], resetsSent: 0, corrupted: 0, sockets: 0 };
  const client = newClient({ corrupt: [3], log, capabilities: { zstd_frames: false } });
  await client.connect();
  for (let index = 0; index < 4; index += 1)
    await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 10, ifLoaded: true });
  expect(log.resetsSent).toBe(1);
  expect(log.sockets).toBe(1);
  expect(log.inboundOpcodes).toContain(CheckedJsonOpcode);
  expect(log.inboundOpcodes).not.toContain(ZstdJsonOpcode);
});

test("client frames go up compressed once the daemon reads them; a broken one costs a reconnect, not a wrong message", async () => {
  const log: WireLog = {
    inboundOpcodes: [],
    outboundKinds: [],
    corruptUplink: new Set([4]),
    resetsSent: 0,
    corrupted: 0,
    sockets: 0,
  };
  const client = newClient({ corrupt: [], log });
  await client.connect();
  expect(client.getLastServerInfoMessage()?.features?.checkedUplink).toBe(true);
  for (let index = 0; index < 6; index += 1) {
    await client.fetchAgents({}).catch(() => undefined);
  }
  await expect.poll(() => log.sockets, { timeout: 10_000 }).toBe(2);
  await expect
    .poll(() => client.getConnectionState().status, { timeout: 10_000 })
    .toBe("connected");
  expect((await client.fetchAgents({})).entries).toBeDefined();
  // hello goes as text (the daemon has not said it reads compressed frames yet); then 0x21.
  expect(log.outboundKinds?.[0]).toBe("text");
  expect(log.outboundKinds?.slice(1)).toContain(CheckedJsonOpcode);
  expect(log.outboundKinds?.filter((kind) => kind === "text").length).toBeLessThanOrEqual(2 + 2);
});

test("old clients keep plain 0x20 compressed frames", async () => {
  const log: WireLog = { inboundOpcodes: [], resetsSent: 0, corrupted: 0, sockets: 0 };
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    clientId: "checked-frames-old",
    reconnect: { enabled: false },
    // An app build from before checked_frames: compressed_frames only.
    capabilities: { checked_frames: false } as never,
    webSocketFactory: corruptingFactory(new Set(), log),
  });
  extraClients.push(client);
  await client.connect();
  await client.fetchAgents({});

  expect(log.inboundOpcodes).toContain(CompressedJsonOpcode);
  expect(log.inboundOpcodes).not.toContain(CheckedJsonOpcode);
});
