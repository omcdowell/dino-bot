import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

/**
 * priority_sync (PS2 B1b): a capable client gets short rows on pages and live (one-line tool
 * steps with bodyHash, reasoning preview, full assistant text) and loads bodies with
 * agent.timeline.bodies.request (callIds and seq ranges, chunked over ~12 KB, have-skip,
 * notLoaded without a resume). A client without the capability keeps full rows.
 */

let ctx: DaemonTestContext;
let cwd: string;
const clients: DaemonClient[] = [];

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "ps-short-"));
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 60_000);

const bigOutput = `${"line of output 0123456789\n".repeat(2_000)}LAST-LINE`;
const tool = (callId: string, output = bigOutput) =>
  ({
    type: "tool_call",
    callId,
    name: "shell",
    status: "completed",
    error: null,
    detail: { type: "shell", command: `cat ${callId}.log`, output, exitCode: 0 },
  }) as never;

function client(prioritySync: boolean): DaemonClient {
  const c = new DaemonClient({
    url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    clientId: `ps-short-${prioritySync}-${Math.random()}`,
    reconnect: { enabled: false },
    // compact_v2 off: these tests read paseoCompact contents (bodyHash have-skip), which compact_v2
    // sockets send as a bare marker (app reads only the marker; see compact-v2-golden).
    capabilities: (prioritySync
      ? { compact_v2: false }
      : { priority_sync: false, compact_v2: false }) as never,
  });
  clients.push(c);
  return c;
}

const marker = (item: unknown) =>
  (item as { metadata?: { paseoCompact?: Record<string, unknown> } }).metadata?.paseoCompact;

test("capable client: short page and live rows, bodies by callId and seq, chunked, have-skip", async () => {
  const manager = ctx.daemon.daemon.agentManager;
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "short" });
  await manager.appendTimelineItem(agent.id, { type: "reasoning", text: `${"r".repeat(900)}` } as never);
  await manager.appendTimelineItem(agent.id, tool("call-a"));
  const answer = `answer ${"lorem ipsum ".repeat(3_000)}`;
  await manager.appendTimelineItem(agent.id, { type: "assistant_message", text: answer } as never);

  const app = client(true);
  await app.connect();
  const page = await app.fetchAgentTimeline(agent.id, { direction: "tail", limit: 20 });
  const shortTool = page.entries.find((entry) => entry.item.type === "tool_call")!;
  expect(shortTool.item).toMatchObject({
    callId: "call-a",
    status: "completed",
    detail: { type: "shell", command: "cat call-a.log", exitCode: 0 },
  });
  expect(JSON.stringify(shortTool.item).length).toBeLessThan(500);
  expect(marker(shortTool.item)).toMatchObject({ short: true, bodyHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
  const text = page.entries.find((entry) => entry.item.type === "assistant_message")!.item;
  expect((text as { text: string }).text).toBe(answer);
  const reasoning = page.entries.find((entry) => entry.item.type === "reasoning")!.item;
  expect((reasoning as { text: string }).text.length).toBe(201);
  // full: true opts out
  const full = await app.fetchAgentTimeline(agent.id, { direction: "tail", limit: 20, full: true });
  const fullTool = full.entries.find((entry) => entry.item.type === "tool_call")!.item;
  expect((fullTool as { detail: { output: string } }).detail.output).toBe(bigOutput);

  // live rows are short too
  const live: unknown[] = [];
  const sub = app.subscribeAgentTimeline(agent.id, (message) => live.push(message));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await manager.appendTimelineItem(agent.id, tool("call-b"));
  const deadline = Date.now() + 5_000;
  const liveTool = () =>
    live
      .map((m) => (m as { payload?: { event?: { item?: { callId?: string } } } }).payload?.event?.item)
      .find((item) => item?.callId === "call-b");
  while (!liveTool() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(marker(liveTool())).toMatchObject({ short: true });
  expect(JSON.stringify(liveTool()).length).toBeLessThan(500);
  sub.unsubscribe?.();

  // bodies by callId: full item, chunked (output > 12 KB) and reassembled
  const byCall = await app.fetchAgentTimelineBodies(agent.id, { callIds: ["call-a"] });
  expect(byCall.bodies).toHaveLength(1);
  expect((byCall.bodies[0].item as { detail: { output: string } }).detail.output).toBe(bigOutput);
  expect(byCall.bodies[0].hash).toBe(marker(shortTool.item)?.bodyHash);

  // bodies by seq range: both tool rows (and the other rows in range), have skips call-a
  const all = await app.fetchAgentTimelineBodies(agent.id, {
    seqs: [[0, 1_000]],
    priority: "open",
    have: [String(marker(shortTool.item)?.bodyHash)],
  });
  expect(all.skipped).toBe(1);
  expect(all.bodies.map((body) => body.callId).filter(Boolean)).toEqual(["call-b"]);
  expect(all.bodies.some((body) => body.item?.type === "assistant_message")).toBe(true);
  const missing = await app.fetchAgentTimelineBodies(agent.id, { callIds: ["nope"], seqs: [[90_000, 90_001]] });
  expect(missing.missing).toEqual([90_000, "nope"]);
}, 60_000);

test("bodies for an agent with no timeline answer notLoaded and resume nothing", async () => {
  const app = client(true);
  await app.connect();
  const result = await app.fetchAgentTimelineBodies("00000000-0000-4000-8000-000000000000", {
    callIds: ["x"],
  });
  expect(result.notLoaded).toBe(true);
  expect(result.bodies).toEqual([]);
}, 30_000);

test("a client without priority_sync keeps full rows on pages and live", async () => {
  const manager = ctx.daemon.daemon.agentManager;
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "old" });
  await manager.appendTimelineItem(agent.id, tool("call-a"));
  const old = client(false);
  await old.connect();
  const page = await old.fetchAgentTimeline(agent.id, { direction: "tail", limit: 20 });
  const item = page.entries.find((entry) => entry.item.type === "tool_call")!.item;
  expect((item as { detail: { output: string } }).detail.output).toBe(bigOutput);
  expect(marker(item)).toBeUndefined();
  const live: unknown[] = [];
  const sub = old.subscribeAgentTimeline(agent.id, (message) => live.push(message));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await manager.appendTimelineItem(agent.id, tool("call-b"));
  const deadline = Date.now() + 5_000;
  const liveTool = () =>
    live
      .map((m) => (m as { payload?: { event?: { item?: { callId?: string } } } }).payload?.event?.item)
      .find((it) => it?.callId === "call-b");
  while (!liveTool() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect((liveTool() as { detail: { output: string } }).detail.output).toBe(bigOutput);
  sub.unsubscribe?.();
}, 60_000);

test("capable client: a burst of live rows shares one frame; the first text of a turn is not held", async () => {
  const manager = ctx.daemon.daemon.agentManager;
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "coalesce" });
  const app = client(true);
  await app.connect();
  const frames: number[] = [];
  const patched = app as unknown as { handleJsonPayload: (payload: unknown, n: unknown) => unknown };
  const original = patched.handleJsonPayload.bind(app);
  patched.handleJsonPayload = (payload, n) => {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    const parsed = JSON.parse(text) as { type?: string; m?: unknown[] };
    frames.push(parsed.type === "batch" ? parsed.m!.length : 1);
    return original(payload, n);
  };
  const live: Array<{ payload?: { event?: { item?: { callId?: string; type?: string } } } }> = [];
  const sub = app.subscribeAgentTimeline(agent.id, (message) => live.push(message as never));
  await new Promise((resolve) => setTimeout(resolve, 100));
  frames.length = 0;
  for (let i = 0; i < 6; i += 1) await manager.appendTimelineItem(agent.id, tool(`burst-${i}`, "ok"));
  await manager.appendTimelineItem(agent.id, { type: "assistant_message", text: "first words" } as never);
  const deadline = Date.now() + 5_000;
  const hasText = () => live.some((m) => m.payload?.event?.item?.type === "assistant_message");
  while (!hasText() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(live.filter((m) => m.payload?.event?.item?.callId?.startsWith("burst-"))).toHaveLength(6);
  // 6 tool rows + the first text: one or two frames, not seven
  expect(frames.length).toBeLessThanOrEqual(2);
  sub.unsubscribe?.();
}, 60_000);

test("hello.f: the priority chat's page follows server_info without a request; old clients unaffected", async () => {
  const manager = ctx.daemon.daemon.agentManager;
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "notified" });
  await manager.appendTimelineItem(agent.id, { type: "assistant_message", text: "the reply" } as never);
  const app = new DaemonClient({
    url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    clientId: `ps-f-${Math.random()}`,
    reconnect: { enabled: false },
    priorityChat: { agentId: agent.id },
  });
  clients.push(app);
  const sent: string[] = [];
  const patched = app as unknown as { sendJsonMessage: (e: unknown, type: string, m: unknown) => unknown };
  const original = patched.sendJsonMessage.bind(app);
  patched.sendJsonMessage = (e, type, m) => {
    sent.push(type);
    return original(e, type, m);
  };
  await app.connect();
  const page = await app.priorityChatPage()!;
  expect(page.agentId).toBe(agent.id);
  expect(page.entries.some((entry) => (entry.item as { text?: string }).text === "the reply")).toBe(true);
  expect(sent.filter((type) => type.includes("timeline"))).toEqual([]);
}, 60_000);
