import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  CheckedJsonFrameDecoder,
  isCheckedJsonFrame,
  isCompressedJsonFrame,
  JsonFrameDecompressor,
} from "@getpaseo/protocol/binary-frames/compressed-json";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { toClientAgentPayload } from "../agent/agent-projections.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

/**
 * agent_patches end to end: a capable client receives agent_patch frames (changed fields only)
 * yet its listeners see the same full agent_update stream an old client gets, turn start and
 * end included. An old client (no agent_patches) still gets full snapshots.
 */

let ctx: DaemonTestContext;
let cwd: string;
const clients: DaemonClient[] = [];

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "agent-patches-"));
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 60_000);

type AgentUpdate = Extract<SessionOutboundMessage, { type: "agent_update" }>;

async function observer(capabilities?: Record<string, unknown>) {
  const wire: string[] = [];
  const wireBytes: Record<string, number> = {};
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    clientId: `agent-patches-${Math.random().toString(36).slice(2, 8)}`,
    ...(capabilities ? { capabilities: capabilities as never } : {}),
    // Tap: decode the same frames the client gets, to see what was on the wire.
    webSocketFactory: (url: string) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      const checked = new CheckedJsonFrameDecoder();
      const plain = new JsonFrameDecompressor();
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        const bytes = new Uint8Array(data);
        let text: string | null = null;
        if (!isBinary) text = data.toString("utf8");
        else if (isCheckedJsonFrame(bytes)) {
          const result = checked.decode(bytes);
          text = result.kind === "message" ? result.text : null;
        } else if (isCompressedJsonFrame(bytes)) text = plain.decompress(bytes);
        if (!text) return;
        const type = (JSON.parse(text) as { message?: { type?: string } }).message?.type;
        if (!type) return;
        wire.push(type);
        wireBytes[type] = (wireBytes[type] ?? 0) + bytes.byteLength;
      });
      return ws as never;
    },
  });
  clients.push(client);
  await client.connect();
  const updates: AgentUpdate["payload"][] = [];
  const observation = client.observeAgents({ scope: "active" } as never);
  observation.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type === "agent_update") updates.push(message.payload);
    },
  });
  await observation.ready;
  return { client, wire, wireBytes, updates };
}

function statuses(updates: AgentUpdate["payload"][], agentId: string): string[] {
  const out: string[] = [];
  for (const update of updates) {
    if (update.kind !== "upsert" || update.agent.id !== agentId) continue;
    if (out.at(-1) !== update.agent.status) out.push(update.agent.status);
  }
  return out;
}

test("capable clients get patches but see full updates; old clients keep full snapshots", async () => {
  const modern = await observer();
  const old = await observer({ agent_patches: false });

  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "patches" });
  await ctx.client.sendAgentMessage(agent.id, "hello there, how are you");
  await ctx.client.waitForFinish(agent.id, 15_000);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // On the wire: the modern socket carried patches, the old one never did.
  expect(modern.wire).toContain("agent_patch");
  expect(old.wire).not.toContain("agent_patch");

  // To listeners both streams are full agents that end in the same state.
  const lastModern = modern.updates.findLast((u) => u.kind === "upsert");
  const lastOld = old.updates.findLast((u) => u.kind === "upsert");
  if (lastModern?.kind !== "upsert" || lastOld?.kind !== "upsert") throw new Error("no upserts");
  expect(lastModern.agent).toEqual(lastOld.agent);
  expect(statuses(modern.updates, agent.id)).toEqual(statuses(old.updates, agent.id));
  expect(statuses(modern.updates, agent.id)).toContain("running");
  expect(statuses(modern.updates, agent.id).at(-1)).toBe("idle");
  // Every expanded update is a complete agent.
  for (const update of modern.updates) {
    if (update.kind === "upsert") expect(update.agent).toMatchObject({ id: agent.id, cwd });
  }
  // Repeats that change nothing are not sent at all.
  expect(modern.updates.length).toBeLessThanOrEqual(old.updates.length);
});

test("A6: compact_v2 clients patch on the snapshot row; priority_sync-only and agent_patches-only apps are unchanged", async () => {
  // The agent exists before anyone subscribes, as when the app opens the sidebar and then a turn runs.
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "patch base" });
  await ctx.client.sendAgentMessage(agent.id, "warm up");
  await ctx.client.waitForFinish(agent.id, 15_000);

  const modern = await observer();
  const b1d = await observer({ compact_v2: false });
  const build7 = await observer({ priority_sync: false, compact_v2: false });
  const old = await observer({ agent_patches: false, priority_sync: false, compact_v2: false });
  const mark = {
    modern: modern.wire.length,
    b1d: b1d.wire.length,
    build7: build7.wire.length,
    old: old.wire.length,
  };

  await ctx.client.sendAgentMessage(agent.id, "hello there, how are you");
  await ctx.client.waitForFinish(agent.id, 15_000);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const during = (wire: string[], from: number) =>
    wire.slice(from).filter((type) => type === "agent_update" || type === "agent_patch");
  // Modern: the snapshot was rev 1, so the turn carries only patches.
  expect(during(modern.wire, mark.modern)).not.toContain("agent_update");
  expect(during(modern.wire, mark.modern)).toContain("agent_patch");
  // B1d app (priority_sync, no compact_v2): no observeSnapshot, so first change in full.
  expect(during(b1d.wire, mark.b1d)[0]).toBe("agent_update");
  // Build 3/7 (agent_patches, no priority_sync): first change still in full, then patches.
  expect(during(build7.wire, mark.build7)[0]).toBe("agent_update");
  expect(during(build7.wire, mark.build7)).toContain("agent_patch");
  expect(during(old.wire, mark.old)).not.toContain("agent_patch");

  // Listeners on all three see the same final agent.
  const last = (updates: AgentUpdate["payload"][]) => {
    const found = updates.findLast((u) => u.kind === "upsert" && u.agent.id === agent.id);
    if (found?.kind !== "upsert") throw new Error("no upsert");
    return found.agent;
  };
  // D0 is gated on priority_sync: modern and B1d get the trimmed persistence handle, build 3/7 and
  // old get it in full. Otherwise all four end in the same agent.
  expect(last(old.updates).persistence).toHaveProperty("metadata");
  expect(last(build7.updates)).toEqual(last(old.updates));
  expect(last(b1d.updates)).toEqual(toClientAgentPayload(last(old.updates)));
  expect(last(modern.updates)).toEqual(toClientAgentPayload(last(old.updates)));
  expect(statuses(modern.updates, agent.id)).toEqual(statuses(old.updates, agent.id));
  expect(last(modern.updates).status).toBe("idle");
});
