import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

/**
 * priority_sync (PS2 B1b) golden with tool calls and reasoning: short rows must never reach a
 * client without the capability, on pages or live. Same method as priority-sync-golden:
 * recorded in the f79beee tree with PS_GOLDEN_WRITE=1.
 *
 * priority_sync (PS2) golden: a client WITHOUT the capability gets the same frames, in the same
 * order, as from f79beee (before lanes). The golden file was recorded by running this exact test in
 * the f79beee tree with PS_GOLDEN_WRITE=1. Frames are compared as text after replacing run-specific
 * values (ids, times, paths) by stable placeholders; key order and every other byte are kept.
 * Compression is off so the frames are readable; compressed sockets share the same send path.
 */

const GOLDEN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__golden__",
  "priority-sync-old-client-tools.json",
);

let ctx: DaemonTestContext;
let cwd: string;
const clients: DaemonClient[] = [];

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "ps-golden-"));
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 60_000);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PREFIXED = /\b[a-z]{2,6}_[A-Za-z0-9_-]{8,}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

function normalizer(replacements: Array<[string, string]>) {
  const ids = new Map<string, string>();
  const id = (raw: string) => {
    if (!ids.has(raw)) ids.set(raw, `<id${ids.size}>`);
    return ids.get(raw)!;
  };
  const str = (value: string) => {
    let out = value;
    for (const [from, to] of replacements) out = out.split(from).join(to);
    return out
      .replace(UUID, id)
      .replace(PREFIXED, (raw) => (/[\dA-Z]/.test(raw) ? id(raw) : raw))
      .replace(ISO, "<iso>");
  };
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return str(value);
    if (typeof value === "number") {
      if (value > 1e12 || /(At|Ms|ms|Time|time|Id|epoch|uptime|pid|port|elapsed|duration)/.test(key ?? ""))
        return "<n>";
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [str(k), walk(v, k)]),
      );
    return value;
  };
  return (frame: string) => JSON.stringify(walk(JSON.parse(frame)));
}

test("a client without priority_sync gets full tool calls and reasoning, as at f79beee", async () => {
  const frames: string[] = [];
  const old = new DaemonClient({
    url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    clientId: "ps-golden-old-tools",
    reconnect: { enabled: false },
    capabilities: {
      priority_sync: false,
      // Builds 3 and 7 predate compact_v2 too.
      compact_v2: false,
      compressed_frames: false,
      checked_frames: false,
      zstd_frames: false,
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
  clients.push(old);
  await old.connect();
  const open = await ctx.client.createAgent({ provider: "codex", cwd, title: "golden tools" });
  const sub = old.subscribeAgentTimeline(open.id, () => {});
  await old.fetchAgentTimeline(open.id, { direction: "tail", limit: 20 });
  const manager = ctx.daemon.daemon.agentManager;
  for (let index = 0; index < 3; index += 1) {
    await manager.appendTimelineItem(open.id, {
      type: "reasoning",
      text: `thinking ${index}\n${"because ".repeat(120)}`,
    } as never);
    await manager.appendTimelineItem(open.id, {
      type: "tool_call",
      callId: `call-${index}`,
      name: "shell",
      status: "completed",
      error: null,
      detail: {
        type: "shell",
        command: `cat src/module-${index}.ts`,
        output: `output ${index}\n`.repeat(400 * (index + 1)),
        exitCode: 0,
      },
    } as never);
    await manager.appendTimelineItem(open.id, {
      type: "tool_call",
      callId: `fail-${index}`,
      name: "shell",
      status: "failed",
      error: `boom ${index}\n${"stack ".repeat(100)}`,
      detail: { type: "shell", command: "false", output: "x\n".repeat(500), exitCode: 1 },
    } as never);
    await manager.appendTimelineItem(open.id, {
      type: "assistant_message",
      text: `answer ${index} ${"lorem ipsum ".repeat(200)}`,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  await old.fetchAgentTimeline(open.id, { direction: "tail", limit: 20 });
  await old.fetchAgentTimeline(open.id, { direction: "tail", limit: 20, compact: true });
  await old.fetchAgentTimeline(open.id, { direction: "tail", limit: 20, lean: true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  sub.unsubscribe?.();

  const normalize = normalizer([
    [cwd, "<cwd>"],
    [path.basename(cwd), "<cwdname>"],
    [String(ctx.daemon.port), "<port>"],
    [hostname(), "<host>"],
  ]);
  const got = frames.map(normalize);
  expect(got.length).toBeGreaterThan(10);
  expect(got.some((frame) => frame.includes("output 2"))).toBe(true);
  for (const frame of frames) expect(frame.includes('"short":true')).toBe(false);
  if (process.env.PS_GOLDEN_WRITE === "1") {
    mkdirSync(path.dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + "\n");
    return;
  }
  expect(existsSync(GOLDEN)).toBe(true);
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as string[];
  expect(got).toEqual(golden);
}, 60_000);
