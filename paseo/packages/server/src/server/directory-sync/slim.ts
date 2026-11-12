import type { AgentSnapshotPayload, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";

/** B3 slim directory: rows and first-page policy for clients that send `slim: true`. */

export const SLIM_DIRECTORY_PAGE_LIMIT = 25;
export const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

/**
 * Sidebar row without the heavy per-agent detail (capabilities, persistence,
 * runtimeInfo). The full row comes from `fetch_agent_request` when the chat opens.
 */
export function slimAgentSnapshot(agent: AgentSnapshotPayload): AgentSnapshotPayload {
  const {
    capabilities: _capabilities,
    persistence: _persistence,
    runtimeInfo: _runtime,
    ...rest
  } = agent;
  return { ...rest, slim: true } as AgentSnapshotPayload;
}

export function isAgentActive(agent: AgentSnapshotPayload): boolean {
  return (
    agent.status === "running" ||
    agent.status === "initializing" ||
    (agent.pendingPermissions?.length ?? 0) > 0 ||
    agent.attentionReason === "permission"
  );
}

/** A delegated child (labelled with its parent) that is not doing or asking anything. */
export function isIdleDelegatedAgent(agent: AgentSnapshotPayload): boolean {
  if (!agent.labels?.[PARENT_AGENT_LABEL]) return false;
  return !isAgentActive(agent) && agent.requiresAttention !== true;
}

export function isWorkspaceActive(workspace: WorkspaceDescriptorPayload): boolean {
  return workspace.status === "needs_input" || workspace.status === "running";
}

/**
 * First page for slim clients. `items` must already be in the request's sort order
 * (recency). Rows with rank < 2 (0 pinned, 1 needs-input/running) go first, in rank
 * order, all of them; the rest of the page is filled in sort order. `anchor` is the
 * last fill row: a later page from its cursor in plain sort order misses nothing
 * (every newer row is either a priority row or a fill) and may repeat priority rows,
 * which clients merge by id.
 */
export function priorityFirstPage<T>(
  items: readonly T[],
  limit: number,
  rank: (item: T) => number,
): { page: T[]; anchor: T | null; hasMore: boolean } {
  const priority: Array<{ item: T; rank: number }> = [];
  const rest: T[] = [];
  for (const item of items) {
    const value = rank(item);
    if (value < 2) priority.push({ item, rank: value });
    else rest.push(item);
  }
  priority.sort((left, right) => left.rank - right.rank);
  const fills = rest.slice(0, Math.max(limit - priority.length, rest.length > 0 ? 1 : 0));
  return {
    page: [...priority.map((entry) => entry.item), ...fills],
    anchor: fills.at(-1) ?? null,
    hasMore: rest.length > fills.length,
  };
}
