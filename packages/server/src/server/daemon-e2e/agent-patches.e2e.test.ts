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
