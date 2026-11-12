import { describe, expect, it } from "vitest";
import type { WSOutboundMessage } from "@getpaseo/protocol/messages";
import { CONTROL_MAX_BYTES, DIRECTORY_DOMAIN, agentDomain, decideLane } from "./lane-policy.js";

const session = (message: unknown) => ({ type: "session", message }) as unknown as WSOutboundMessage;
const ctx = { focusedAgentId: "open" };

describe("decideLane", () => {
  it.each([
    ["agent_attention_required", 0],
    ["agent_permission_request", 0],
    ["send_agent_message_received", 0],
    ["fetch_agents_response", 2],
    ["agent_patch", 2],
    ["agent_update", 2],
    ["project.update", 2],
    ["something_new_response", 1],
  ])("%s -> lane %i", (type, lane) => {
    expect(decideLane(session({ type, payload: {} }), 100, ctx).lane).toBe(lane);
  });

  it("non-session envelopes (pong, token) are control", () => {
    expect(decideLane({ type: "pong" } as unknown as WSOutboundMessage, 10, ctx).lane).toBe(0);
  });

  it("demotes an oversized control message to lane 1", () => {
    expect(
      decideLane(session({ type: "status", payload: {} }), CONTROL_MAX_BYTES + 1, ctx).lane,
    ).toBe(1);
  });

  it("the open chat is lane 1, other chats lane 3, both in their agent domain", () => {
    const open = decideLane(session({ type: "agent_stream", payload: { agentId: "open" } }), 1, ctx);
    const other = decideLane(session({ type: "agent_stream", payload: { agentId: "x" } }), 1, ctx);
    expect(open).toEqual({ lane: 1, domain: agentDomain("open") });
    expect(other).toEqual({ lane: 3, domain: agentDomain("x") });
  });

  it("tail/after pages share the agent domain; older history is background without a domain", () => {
    const page = (direction: string, agentId = "x") =>
      session({ type: "fetch_agent_timeline_response", payload: { agentId, direction } });
    expect(decideLane(page("tail"), 1, ctx)).toEqual({ lane: 3, domain: agentDomain("x") });
    expect(decideLane(page("after", "open"), 1, ctx)).toEqual({ lane: 1, domain: agentDomain("open") });
    expect(decideLane(page("before"), 1, ctx)).toEqual({ lane: 6, domain: null });
  });

  it("directory messages share one domain", () => {
    expect(decideLane(session({ type: "agent_patch", payload: {} }), 1, ctx).domain).toBe(DIRECTORY_DOMAIN);
  });

  it("bodies take their lane from priority; without one, open-chat bodies 4, others 5", () => {
    const body = (priority?: string, agentId = "x") =>
      session({ type: "agent.timeline.body", payload: { agentId, ...(priority ? { priority } : {}) } });
    expect(decideLane(body("tap"), 20_000, ctx)).toEqual({ lane: 1, domain: null });
    expect(decideLane(body("open"), 1, ctx).lane).toBe(4);
    expect(decideLane(body("other"), 1, ctx).lane).toBe(5);
    expect(decideLane(body("background"), 1, ctx).lane).toBe(6);
    expect(decideLane(body(undefined, "open"), 1, ctx).lane).toBe(4);
    expect(decideLane(body(), 1, ctx).lane).toBe(5);
    const done = session({ type: "agent.timeline.bodies.done", payload: { agentId: "x", priority: "tap" } });
    expect(decideLane(done, 1, ctx).lane).toBe(1);
  });

  it("with no focus every chat is lane 3", () => {
    expect(
      decideLane(session({ type: "agent_stream", payload: { agentId: "open" } }), 1, { focusedAgentId: null })
        .lane,
    ).toBe(3);
  });

  it("the unasked page of a chat that just notified rides lane 1 in its agent's domain (B1c)", () => {
    const push = session({
      type: "fetch_agent_timeline_response",
      payload: { agentId: "other", direction: "tail", requestId: "push:1" },
    });
    expect(decideLane(push, 100, ctx)).toEqual({ lane: 1, domain: agentDomain("other") });
  });
});

