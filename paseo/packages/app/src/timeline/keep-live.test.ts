import { expect, test } from "vitest";
import type { Agent } from "@/stores/session-store";
import { diffKeepLivePhases, KEEP_LIVE_LABEL, selectKeepLiveAgentIds } from "./keep-live";

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id,
    status: "idle",
    labels: { [KEEP_LIVE_LABEL]: "1" },
    lastActivityAt: new Date(1_000),
    turn: { phase: "idle", cancellationRequestId: null },
    ...patch,
  } as Agent;
}

test("only labelled, loaded, unarchived agents are keep-live", () => {
  const ids = selectKeepLiveAgentIds([
    agent("bot"),
    agent("plain", { labels: {} }),
    agent("off", { labels: { [KEEP_LIVE_LABEL]: "0" } }),
    agent("closed", { status: "closed" }),
    agent("archived", { archivedAt: new Date() }),
  ]);
  expect(ids).toEqual(["bot"]);
});

test("attention first, then most recent activity", () => {
  const ids = selectKeepLiveAgentIds([
    agent("old", { lastActivityAt: new Date(1) }),
    agent("new", { lastActivityAt: new Date(5) }),
    agent("needs-you", { lastActivityAt: new Date(0), requiresAttention: true }),
  ]);
  expect(ids).toEqual(["needs-you", "new", "old"]);
});

test("phase diff reports running and idle transitions of keep-live agents only", () => {
  const first = diffKeepLivePhases(new Map(), [agent("a"), agent("b", { status: "running" })]);
  expect(first.changes).toEqual([]);
  const second = diffKeepLivePhases(first.phases, [
    agent("a", { status: "running" }),
    agent("b"),
    agent("c", { labels: {}, status: "running" }),
  ]);
  expect(second.changes).toEqual([
    { agentId: "a", phase: "running" },
    { agentId: "b", phase: "idle" },
  ]);
});
