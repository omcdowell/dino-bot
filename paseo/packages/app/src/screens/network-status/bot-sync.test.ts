import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import type { OutboxRecord } from "@/stores/outbox-store";
import { buildBotSyncRows } from "./bot-sync";

const NOW = Date.parse("2026-10-10T00:00:00Z");

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    serverId: "box",
    status: "idle",
    title: null,
    labels: {},
    lastActivityAt: new Date(NOW - 60_000),
    pendingPermissions: [],
    archivedAt: null,
    ...overrides,
  } as Agent;
}

function record(agentId: string, state: OutboxRecord["state"]): OutboxRecord {
  return {
    serverId: "box",
    agentId,
    clientMessageId: `${agentId}-${state}`,
    state,
  } as OutboxRecord;
}

describe("buildBotSyncRows", () => {
  it("keeps open, waiting and recent agents, most urgent first", () => {
    const agents = new Map([
      ["old", agent("old", { lastActivityAt: new Date(NOW - 3 * 86_400_000) })],
      ["recent", agent("recent", { labels: { bot: "emmet" } })],
      ["waiting", agent("waiting", { lastActivityAt: new Date(NOW - 3 * 86_400_000) })],
      ["archived", agent("archived", { archivedAt: new Date(NOW) })],
    ]);
    const rows = buildBotSyncRows({
      serverId: "box",
      hostStatus: "online",
      agents,
      initializing: new Map(),
      historyApplied: new Map([["recent", true]]),
      records: [
        record("waiting", "outbox"),
        record("waiting", "failed"),
        record("recent", "taken"),
      ],
      now: NOW,
    });
    expect(rows.map((row) => row.agentId)).toEqual(["waiting", "recent"]);
    expect(rows[0]).toMatchObject({ waiting: 1, failed: 1, sync: "notLoaded" });
    expect(rows[1]).toMatchObject({ title: "emmet", group: "emmet", sync: "upToDate", waiting: 0 });
  });

  it("shows open timelines as reconnecting while the host is down", () => {
    const rows = buildBotSyncRows({
      serverId: "box",
      hostStatus: "connecting",
      agents: new Map([["a", agent("a")]]),
      initializing: new Map(),
      historyApplied: new Map([["a", true]]),
      records: [],
      now: NOW,
    });
    expect(rows[0]?.sync).toBe("reconnecting");
  });
});
