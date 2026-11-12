import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { CompactV2Decoder, createMemoryFeatureCache } from "@getpaseo/protocol/compact-v2";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

/**
 * compact_v2 (CV1) goldens.
 *
 * 1. A B1b client (priority_sync on, no compact_v2) gets exactly the messages it got before
 *    compact_v2 existed: golden recorded with this test at 8d89284 (565382b + 409927f) with
 *    CV2_GOLDEN_WRITE=1. Batch frames are unwrapped and messages compared as a multiset (lanes may
 *    reorder across domains), after replacing run-specific values by placeholders.
 * 2. A compact_v2 client in the same run, doing the same requests, decodes (protocol/compact-v2)
 *    to the same messages as the B1b client, except the documented unread fields: status
 *    permissions, paseoCompact contents, the agent copy on non-tail timeline pages.
 */

const GOLDEN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__golden__",
  "compact-v2-b1b-client.json",
);

let ctx: DaemonTestContext;
let cwd: string;
const clients: DaemonClient[] = [];

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "cv2-golden-"));
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 60_000);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PREFIXED = /\b[a-z]{2,6}_[A-Za-z0-9_-]{8,}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

type Msg = Record<string, unknown>;

function normalizer(replacements: Array<[string, string]>) {
  const str = (value: string) => {
    let out = value;
    for (const [from, to] of replacements) out = out.split(from).join(to);
    return out
      .replace(UUID, "<id>")
      .replace(PREFIXED, (raw) => (/[\dA-Z]/.test(raw) ? "<id>" : raw))
      .replace(ISO, "<iso>");
  };
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return str(value);
    if (typeof value === "number") {
      if (
        value > 1e12 ||
        /(At|Ms|ms|Time|time|Id|epoch|uptime|pid|port|elapsed|duration|seq|Seq|rev|Rev)/.test(key ?? "")
      )
        return "<n>";
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value as object)
          .sort()
          .map((k) => [str(k), walk((value as Msg)[k], k)]),
      );
    return value;
  };
  return (message: unknown) => JSON.stringify(walk(message));
}

function capturingClient(clientId: string, capabilities: Record<string, unknown>, frames: string[]) {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    clientId,
    reconnect: { enabled: false },
    capabilities: {
      compressed_frames: false,
      checked_frames: false,
      zstd_frames: false,
      ...capabilities,
    } as never,
    webSocketFactory: (url: string) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      const emit = ws.emit.bind(ws);
      ws.emit = ((event: string, ...args: unknown[]) => {
        if (event === "message" && args[1] === false) frames.push(String(args[0]));
        return emit(event, ...args);
      }) as typeof ws.emit;
      return ws as never;
    },
  });
  clients.push(client);
  return client;
}

const unwrap = (frames: string[]): Msg[] =>
  frames.flatMap((frame) => {
    const parsed = JSON.parse(frame) as Msg;
    return parsed.type === "batch" ? (parsed.m as Msg[]) : [parsed];
  });

/** The unread fields compact_v2 does not carry, removed from a B1b-client message. */
function withoutUnread(message: Msg): Msg {
  const out = JSON.parse(JSON.stringify(message)) as Msg;
  const inner = out.message as { type: string; payload: Msg } | undefined;
  if (!inner) return out;
  const p = inner.payload;
  if (inner.type === "status") delete p.permissions;
  const items: Msg[] = [];
  if (inner.type === "fetch_agent_timeline_response") {
    if (p.direction !== "tail") p.agent = null;
    for (const row of p.entries as Msg[]) items.push(row.item as Msg);
  }
  if (inner.type === "agent_stream" && (p.event as Msg | undefined)?.item)
    items.push((p.event as Msg).item as Msg);
  for (const item of items) {
    const metadata = item.metadata as Msg | undefined;
    if (metadata?.paseoCompact) metadata.paseoCompact = {};
  }
  return out;
}

async function scenario(both: DaemonClient[]) {
  const each = <T>(fn: (client: DaemonClient) => Promise<T>) => Promise.all(both.map(fn));
  await each((client) => client.fetchAgents({ subscribe: {} }));
  await each((client) => client.fetchWorkspaces({ subscribe: {} } as never));
  const open = await ctx.client.createAgent({ provider: "codex", cwd, title: "cv2 open" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await ctx.client.createAgent({ provider: "codex", cwd, title: "cv2 other" });
  await each((client) => client.fetchAgents({ slim: true } as never));
  await each((client) => client.fetchWorkspaces({}));
  const subs = both.map((client) => client.subscribeAgentTimeline(open.id, () => {}));
  await each((client) => client.fetchAgentTimeline(open.id, { direction: "tail", limit: 20 }));
  const manager = ctx.daemon.daemon.agentManager;
  for (let index = 0; index < 3; index += 1) {
    await manager.appendTimelineItem(open.id, {
      type: "reasoning",
      text: `thinking ${index}\n${"because ".repeat(60)}`,
    } as never);
    await manager.appendTimelineItem(open.id, {
      type: "tool_call",
      callId: `call-${index}`,
      name: "execute",
      status: "completed",
      error: null,
      detail: {
        type: "shell",
        command: `cat src/module-${index}.ts`,
        output: `output ${index}\n`.repeat(200),
        exitCode: 0,
      },
      metadata: { kind: "execute", title: `Inspect ${index}` },
    } as never);
    await manager.appendTimelineItem(open.id, {
      type: "tool_call",
      callId: `read-${index}`,
      name: "read_file",
      status: "completed",
      error: null,
      detail: { type: "read", filePath: `src/${index}.ts`, content: "x\n".repeat(300) },
    } as never);
    await manager.appendTimelineItem(open.id, {
      type: "assistant_message",
      text: `answer ${index} ${"lorem ipsum ".repeat(30)}`,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const tails = await each((client) =>
    client.fetchAgentTimeline(open.id, { direction: "tail", limit: 4 }),
  );
  await Promise.all(
    both.map((client, index) => {
      const start = tails[index]!.startCursor;
      return start
        ? client.fetchAgentTimeline(open.id, {
            direction: "before",
            cursor: { epoch: start.epoch, seq: start.seq },
            limit: 10,
          })
        : null;
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const sub of subs) sub.unsubscribe?.();
}

/**
 * SI1: A6 (agent_patch on the snapshot row) rides on compact_v2, so a compact client's
 * fetch_agents_response says patchBase:true. The B1b client never gets it (no observeSnapshot).
 */
function withoutPatchBaseMarker(message: unknown): unknown {
  const m = message as { message?: { type?: string; payload?: Record<string, unknown> } };
  if (m?.message?.type !== "fetch_agents_response" || !m.message.payload) return message;
  const { patchBase: _patchBase, ...payload } = m.message.payload;
  return { ...m, message: { ...m.message, payload } };
}

test("B1b clients keep their bytes; compact_v2 clients decode to the same messages", async () => {
  const b1bFrames: string[] = [];
  const compactFrames: string[] = [];
  const b1b = capturingClient("cv2-golden-b1b", { priority_sync: true, compact_v2: false }, b1bFrames);
  const compact = capturingClient("cv2-golden-compact", { priority_sync: true, compact_v2: true }, compactFrames);
  await Promise.all([b1b.connect(), compact.connect()]);
  await scenario([b1b, compact]);

  const normalize = normalizer([
    [cwd, "<cwd>"],
    [path.basename(cwd), "<cwdname>"],
    [String(ctx.daemon.port), "<port>"],
    [hostname(), "<host>"],
  ]);
  const got = unwrap(b1bFrames).map(normalize).sort();
  expect(got.length).toBeGreaterThan(20);
  if (process.env.CV2_GOLDEN_WRITE === "1") {
    mkdirSync(path.dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + "\n");
    return;
  }
  // 1. B1b client: unchanged.
  expect(existsSync(GOLDEN)).toBe(true);
  expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")) as string[]);

  // 2. compact_v2 client: smaller, and the same messages once decoded.
  const compactBytes = compactFrames.reduce((sum, frame) => sum + frame.length, 0);
  const b1bBytes = b1bFrames.reduce((sum, frame) => sum + frame.length, 0);
  expect(compactBytes).toBeLessThan(b1bBytes);
  expect(compactFrames.join("\n")).toContain('"cv2":1');
  const decoder = new CompactV2Decoder(createMemoryFeatureCache());
  const decoded = unwrap(compactFrames)
    .map((message) => decoder.decode(message))
    .map(withoutPatchBaseMarker)
    .map(normalize)
    .sort();
  const expected = unwrap(b1bFrames).map(withoutUnread).map(normalize).sort();
  expect(decoded).toEqual(expected);
}, 60_000);
