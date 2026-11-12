import { describe, expect, test } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import {
  isIdleDelegatedAgent,
  priorityFirstPage,
  slimAgentSnapshot,
  PARENT_AGENT_LABEL,
} from "./slim.js";

function agent(overrides: Partial<AgentSnapshotPayload> = {}): AgentSnapshotPayload {
  return {
    id: "a",
    provider: "codex",
    cwd: "/tmp",
    model: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: { provider: "codex", sessionId: "s" },
    runtimeInfo: { provider: "codex", sessionId: "s" },
    title: "t",
    labels: {},
    ...overrides,
  };
}

describe("slimAgentSnapshot", () => {
  test("drops capabilities, persistence and runtimeInfo and marks the row slim", () => {
    const slim = slimAgentSnapshot(agent()) as Record<string, unknown>;
    expect(slim.capabilities).toBeUndefined();
    expect(slim.persistence).toBeUndefined();
    expect(slim.runtimeInfo).toBeUndefined();
    expect(slim.slim).toBe(true);
    expect(slim.title).toBe("t");
  });
});

describe("isIdleDelegatedAgent", () => {
  const child = { labels: { [PARENT_AGENT_LABEL]: "p" } };
  test("idle child is omitted, active or unread children and parents are not", () => {
    expect(isIdleDelegatedAgent(agent(child))).toBe(true);
    expect(isIdleDelegatedAgent(agent({ ...child, status: "running" }))).toBe(false);
    expect(isIdleDelegatedAgent(agent({ ...child, requiresAttention: true }))).toBe(false);
    expect(
      isIdleDelegatedAgent(
        agent({
          ...child,
          pendingPermissions: [{ id: "x", provider: "codex", name: "n", kind: "tool" }],
        }),
      ),
    ).toBe(false);
    expect(isIdleDelegatedAgent(agent())).toBe(false);
  });
});

describe("priorityFirstPage", () => {
  const rank = (item: string) => {
    if (item.startsWith("p")) return 0;
    return item.startsWith("r") ? 1 : 2;
  };
  test("pinned, then active, then recency fill up to the limit", () => {
    const result = priorityFirstPage(["a", "r1", "b", "p1", "c", "d"], 4, rank);
    expect(result.page).toEqual(["p1", "r1", "a", "b"]);
    expect(result.anchor).toBe("b");
    expect(result.hasMore).toBe(true);
  });
  test("no more when everything fits", () => {
    const result = priorityFirstPage(["a", "r1"], 4, rank);
    expect(result).toEqual({ page: ["r1", "a"], anchor: "a", hasMore: false });
  });
  test("keeps every priority row and at least one fill so the cursor can advance", () => {
    const result = priorityFirstPage(["p1", "r1", "r2", "a", "b"], 2, rank);
    expect(result.page).toEqual(["p1", "r1", "r2", "a"]);
    expect(result.anchor).toBe("a");
    expect(result.hasMore).toBe(true);
  });
});
