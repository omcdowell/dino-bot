import { expect, test } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { AgentPatchExpander } from "./agent-patches.js";

type AgentUpdate = Extract<SessionOutboundMessage, { type: "agent_update" }>;
type AgentPatch = Extract<SessionOutboundMessage, { type: "agent_patch" }>;

const agent = {
  id: "a1",
  provider: "codex",
  cwd: "/w",
  model: null,
  createdAt: "t0",
  updatedAt: "t0",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {},
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Bot",
  labels: { bot: "x" },
  lastError: "old",
} as unknown as Extract<AgentUpdate["payload"], { kind: "upsert" }>["agent"];

const upsert = (rev: number): AgentUpdate => ({
  type: "agent_update",
  payload: { kind: "upsert", agent, project: null, subscriptionId: "s1", rev },
});
const patch = (payload: Partial<AgentPatch["payload"]>): AgentPatch => ({
  type: "agent_patch",
  payload: { agentId: "a1", subscriptionId: "s1", rev: 2, baseRev: 1, set: {}, ...payload },
});

test("a patch becomes the full agent with the changed fields applied", () => {
  const expander = new AgentPatchExpander();
  expander.observe(upsert(1));
  const result = expander.expand(
    patch({ set: { status: "running", updatedAt: "t1" }, unset: ["lastError"], seq: 7 }),
  );
  if (result.kind !== "update" || result.message.payload.kind !== "upsert")
    throw new Error("expected an update");
  expect(result.message.payload.agent).toEqual({
    ...agent,
    status: "running",
    updatedAt: "t1",
    lastError: undefined,
  });
  expect("lastError" in result.message.payload.agent).toBe(false);
  expect(result.message.payload).toMatchObject({ subscriptionId: "s1", seq: 7, rev: 2 });

  const next = expander.expand(patch({ rev: 3, baseRev: 2, set: { status: "idle" } }));
  if (next.kind !== "update" || next.message.payload.kind !== "upsert") throw new Error("update");
  expect(next.message.payload.agent.status).toBe("idle");
  expect(next.message.payload.agent.updatedAt).toBe("t1");
});

test("a patch without its base asks once for the agent in full, then applies again", () => {
  const expander = new AgentPatchExpander();
  expander.observe(upsert(1));
  expect(expander.expand(patch({ rev: 4, baseRev: 3 }))).toEqual({
    kind: "resync",
    agentId: "a1",
    subscriptionId: "s1",
  });
  expect(expander.expand(patch({ rev: 5, baseRev: 4 }))).toEqual({ kind: "drop" });
  expander.observe(upsert(1));
  expect(expander.expand(patch({ rev: 2, baseRev: 1 })).kind).toBe("update");
});

test("bases are per subscription", () => {
  const expander = new AgentPatchExpander();
  expander.observe(upsert(1));
  expect(expander.expand(patch({ subscriptionId: "other" })).kind).toBe("resync");
});
