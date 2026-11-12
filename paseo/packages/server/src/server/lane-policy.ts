import type { WSOutboundMessage } from "@getpaseo/protocol/messages";
import type { Lane } from "./priority-send-queue.js";

/**
 * PS2 lane policy (design.md section 1). Pure: message + what the server knows about the socket.
 *   0 control: attention, permission, acks, pong, token, small status   (never waits)
 *   1 now: the open chat (stream + tail/after pages), replies to requests, tapped bodies
 *   2 navigate: directory (agents, workspaces, projects, agent patches) - one ordering domain
 *   3 other chats' text: stream + tail/after pages of chats that are not open
 *   4/5 bodies (open / other chats, prefetch), 6 background: older history pages
 * Unknown message types go to lane 1: a user is probably waiting on them.
 */
export const CONTROL_MAX_BYTES = 2048;

const CONTROL_TYPES = new Set([
  "agent_attention_required",
  "terminal_attention_required",
  "agent_permission_request",
  "agent_permission_resolved",
  "send_agent_message_received",
  "clear_agent_attention_response",
  "status",
]);

const DIRECTORY_TYPES = new Set([
  "fetch_agents_response",
  "fetch_workspaces_response",
  "agent_update",
  "agent_patch",
  "workspace_update",
  "workspace.update",
  "project.update",
  "project.list.response",
]);

export const DIRECTORY_DOMAIN = "dir";
/** B1c: requestId prefix of the unasked page of a chat that just notified (lane 1). */
export const NOTIFIED_PUSH_PREFIX = "push:";
export const agentDomain = (agentId: string) => `agent:${agentId}`;

export interface LaneContext {
  /** The chat open on this socket (client_heartbeat.focusedAgentId), or the inferred one. */
  focusedAgentId: string | null;
}

export interface LaneDecision {
  lane: Lane;
  domain: string | null;
}

function payloadAgentId(payload: unknown): string | null {
  const agentId = (payload as { agentId?: unknown } | null)?.agentId;
  return typeof agentId === "string" ? agentId : null;
}

export function decideLane(
  message: WSOutboundMessage,
  payloadBytes: number,
  context: LaneContext,
): LaneDecision {
  if (message.type !== "session") return { lane: 0, domain: null };
  const inner = message.message;
  const type = inner.type;
  if (CONTROL_TYPES.has(type)) {
    return { lane: payloadBytes <= CONTROL_MAX_BYTES ? 0 : 1, domain: null };
  }
  if (DIRECTORY_TYPES.has(type)) return { lane: 2, domain: DIRECTORY_DOMAIN };
  if (type === "agent_stream") {
    const agentId = payloadAgentId(inner.payload);
    if (!agentId) return { lane: 1, domain: null };
    return { lane: agentId === context.focusedAgentId ? 1 : 3, domain: agentDomain(agentId) };
  }
  if (type === "fetch_agent_timeline_response") {
    const payload = inner.payload as { agentId?: string; direction?: string; requestId?: string };
    const agentId = payloadAgentId(payload);
    if (!agentId) return { lane: 1, domain: null };
    if (payload.requestId?.startsWith(NOTIFIED_PUSH_PREFIX)) return { lane: 1, domain: agentDomain(agentId) };
    // Older history merges by window (order-free): background.
    if (payload.direction === "before") return { lane: 6, domain: null };
    return { lane: agentId === context.focusedAgentId ? 1 : 3, domain: agentDomain(agentId) };
  }
  if (type === "agent.timeline.body" || type === "agent.timeline.bodies.done") {
    // Bodies are immutable and idempotent (order-free). tap: a user is waiting.
    const payload = inner.payload as { agentId?: string; priority?: string };
    const lane = BODY_LANES[payload.priority ?? ""];
    if (lane !== undefined) return { lane, domain: null };
    return { lane: payloadAgentId(payload) === context.focusedAgentId ? 4 : 5, domain: null };
  }
  return { lane: 1, domain: null };
}

const BODY_LANES: Record<string, Lane> = { tap: 1, open: 4, other: 5, background: 6 };
