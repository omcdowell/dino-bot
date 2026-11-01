import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

/**
 * Tool calls fetched compacted (compactTimeline) carry metadata.paseoCompact and only a preview of
 * their output. Expanding one loads the full item once; the result is kept in a small cache so a
 * re-expand is instant. The session store keeps the compact row: nothing is re-rendered or
 * re-persisted for a row the user only looked at.
 */
export const COMPACT_METADATA_KEY = "paseoCompact";
const CACHE_LIMIT = 20;

export function isCompactToolCall(metadata: Record<string, unknown> | undefined): boolean {
  const marker = metadata?.[COMPACT_METADATA_KEY];
  return Boolean(marker) && typeof marker === "object";
}

export interface FullToolCallClient {
  fetchAgentTimelineItem(
    agentId: string,
    callId: string,
  ): Promise<{ item: { type: string; detail?: unknown } | null }>;
}

const cache = new Map<string, Promise<ToolCallDetail | null>>();

export function loadFullToolCallDetail(
  client: FullToolCallClient,
  agentId: string,
  callId: string,
): Promise<ToolCallDetail | null> {
  const key = `${agentId}\u0000${callId}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const load = client
    .fetchAgentTimelineItem(agentId, callId)
    .then((payload) =>
      payload.item?.type === "tool_call" ? ((payload.item.detail as ToolCallDetail) ?? null) : null,
    )
    .catch(() => {
      cache.delete(key);
      return null;
    });
  cache.set(key, load);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return load;
}

export function clearFullToolCallCache(): void {
  cache.clear();
}
