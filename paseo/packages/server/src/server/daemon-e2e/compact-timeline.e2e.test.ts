import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AgentNotLoadedError } from "@getpaseo/client/internal/daemon-client";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

let ctx: DaemonTestContext;
let cwd: string;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "compact-timeline-"));
});

afterEach(async () => {
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 60_000);

test("compact fetches omit large tool output and the item RPC loads it in full", async () => {
  expect(ctx.client.getLastServerInfoMessage()?.features?.compactTimeline).toBe(true);
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "compact" });
  const output = `${"line of output\n".repeat(2_000)}LAST-LINE`;
  await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
    type: "tool_call",
    callId: "call-big",
    name: "shell",
    status: "completed",
    error: null,
    detail: { type: "shell", command: "cat big.log", output, exitCode: 0 },
  });
  await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
    type: "assistant_message",
    text: "done",
  });

  const full = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 10 });
  const compact = await ctx.client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    limit: 10,
    compact: true,
  });
  const fullBytes = JSON.stringify(full.entries).length;
  const compactBytes = JSON.stringify(compact.entries).length;
  expect(compactBytes).toBeLessThan(fullBytes / 5);
  expect(compact.endCursor).toEqual(full.endCursor);
  expect(compact.entries.map((entry) => entry.seqEnd)).toEqual(
    full.entries.map((entry) => entry.seqEnd),
  );
  const compactTool = compact.entries.find((entry) => entry.item.type === "tool_call")?.item;
  if (compactTool?.type !== "tool_call" || compactTool.detail.type !== "shell") {
    throw new Error("expected a compacted shell tool call");
  }
  expect(compactTool.detail.output?.endsWith("LAST-LINE")).toBe(true);
  expect(compactTool.metadata?.paseoCompact).toMatchObject({ omittedBytes: expect.any(Number) });

  const item = await ctx.client.fetchAgentTimelineItem(agent.id, "call-big");
  if (item.item?.type !== "tool_call" || item.item.detail.type !== "shell") {
    throw new Error("expected the full tool call");
  }
  expect(item.item.detail.output).toBe(output);
  expect(item.item.metadata?.paseoCompact).toBeUndefined();
}, 30_000);

test("an ifLoaded fetch for a stored agent answers notLoaded and does not resume it", async () => {
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "stored" });
  await ctx.daemon.daemon.agentManager.closeAgent(agent.id);
  expect(ctx.daemon.daemon.agentManager.getAgent(agent.id)).toBeNull();

  await expect(
    ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 10, ifLoaded: true }),
  ).rejects.toBeInstanceOf(AgentNotLoadedError);
  await expect(ctx.client.fetchAgentTimelineItem(agent.id, "anything")).rejects.toThrow(
    "Agent is not loaded",
  );
  expect(ctx.daemon.daemon.agentManager.getAgent(agent.id)).toBeNull();

  // The bots plugin labelling an old chat (keep-live "0") writes the stored record only.
  await ctx.client.updateAgent(agent.id, { labels: { "paseo.keep-live": "0" } });
  expect(ctx.daemon.daemon.agentManager.getAgent(agent.id)).toBeNull();

  // A plain fetch still resumes on demand, as before.
  await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 10 });
  expect(ctx.daemon.daemon.agentManager.getAgent(agent.id)).not.toBeNull();
}, 30_000);

test("lean fetches leave out reasoning and cut every tool call to a one-line stub", async () => {
  expect(ctx.client.getLastServerInfoMessage()?.features?.leanTimeline).toBe(true);
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "lean" });
  const manager = ctx.daemon.daemon.agentManager;
  await manager.appendTimelineItem(agent.id, { type: "user_message", text: "check the logs" });
  await manager.appendTimelineItem(agent.id, {
    type: "reasoning",
    text: "Thinking about which log to read. ".repeat(40),
  });
  await manager.appendTimelineItem(agent.id, {
    type: "tool_call",
    callId: "call-mid",
    name: "shell",
    status: "completed",
    error: null,
    // Below the compact threshold: compact keeps it whole, lean still stubs it.
    detail: { type: "shell", command: "tail -n 20 app.log", output: "ok\n".repeat(300), exitCode: 0 },
  });
  await manager.appendTimelineItem(agent.id, {
    type: "tool_call",
    callId: "call-read",
    name: "read",
    status: "completed",
    error: null,
    detail: { type: "read", filePath: "/w/notes.md", content: "notes ".repeat(500) },
  });
  await manager.appendTimelineItem(agent.id, { type: "assistant_message", text: "All fine." });

  const page = (options: { compact?: boolean; lean?: boolean }) =>
    ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 20, ...options });
  const full = await page({});
  const compact = await page({ compact: true });
  const lean = await page({ compact: true, lean: true });

  const kinds = (p: typeof full) => p.entries.map((entry) => entry.item.type);
  expect(kinds(full)).toContain("reasoning");
  expect(kinds(lean)).toEqual(kinds(full).filter((kind) => kind !== "reasoning"));
  expect(lean.endCursor).toEqual(full.endCursor);
  expect(lean.startCursor).toEqual(full.startCursor);

  const tools = lean.entries.flatMap((entry) => (entry.item.type === "tool_call" ? [entry.item] : []));
  expect(tools.map((tool) => tool.detail)).toEqual([
    { type: "shell", command: "tail -n 20 app.log", exitCode: 0 },
    { type: "read", filePath: "/w/notes.md" },
  ]);
  for (const tool of tools) {
    expect(tool.metadata?.paseoCompact).toMatchObject({ lean: true, omittedBytes: expect.any(Number) });
  }
  const assistant = lean.entries.find((entry) => entry.item.type === "assistant_message");
  expect(assistant?.item).toMatchObject({ text: "All fine." });

  const bytes = (p: typeof full) => JSON.stringify(p.entries).length;
  expect(bytes(lean)).toBeLessThan(bytes(compact) / 3);

  // Expanding a stub still loads the whole tool call.
  const item = await ctx.client.fetchAgentTimelineItem(agent.id, "call-mid");
  if (item.item?.type !== "tool_call" || item.item.detail.type !== "shell") {
    throw new Error("expected the full tool call");
  }
  expect(item.item.detail.output).toBe("ok\n".repeat(300));
});
