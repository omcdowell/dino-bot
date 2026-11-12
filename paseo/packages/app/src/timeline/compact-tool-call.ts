import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { DurableBodyCache } from "@/runtime/replica-cache/body-cache";

/**
 * Tool calls fetched compacted (compactTimeline) or short (priority_sync) carry
 * metadata.paseoCompact and only a preview of their output. Expanding one loads the full item once;
 * the result is kept in a small in-memory cache so a re-expand is instant, and (B2b) on disk under
 * the daemon's bodyHash so it survives app restarts. The session store keeps the compact row:
 * nothing is re-rendered or re-persisted for a row the user only looked at.
 */
export const COMPACT_METADATA_KEY = "paseoCompact";
const CACHE_LIMIT = 20;
/** B2b: prefetch at most this many bodies per open chat (newest first). */
export const PREFETCH_MAX_BODIES = 24;

export interface CompactMarker {
  omittedBytes?: number;
  short?: boolean;
  bodyHash?: string;
}

export function isCompactToolCall(metadata: Record<string, unknown> | undefined): boolean {
  const marker = metadata?.[COMPACT_METADATA_KEY];
  return Boolean(marker) && typeof marker === "object";
}

export function readCompactMarker(
  metadata: Record<string, unknown> | undefined,
): CompactMarker | null {
  const marker = metadata?.[COMPACT_METADATA_KEY];
  if (!marker || typeof marker !== "object") return null;
  const value = marker as Record<string, unknown>;
  return {
    ...(typeof value.omittedBytes === "number" ? { omittedBytes: value.omittedBytes } : {}),
    ...(value.short === true ? { short: true } : {}),
    ...(typeof value.bodyHash === "string" ? { bodyHash: value.bodyHash } : {}),
  };
}

interface BodyItem {
  type: string;
  detail?: unknown;
}

export interface FullToolCallClient {
  fetchAgentTimelineItem(agentId: string, callId: string): Promise<{ item: BodyItem | null }>;
  /** priority_sync daemons only (rows marked `short`); old daemons never mark rows short. */
  fetchAgentTimelineBodies?(
    agentId: string,
    keys: {
      callIds?: string[];
      priority?: "tap" | "open" | "other" | "background";
      have?: string[];
    },
  ): Promise<{
    bodies: { callId?: string; hash?: string; item: unknown }[];
    notLoaded: boolean;
  }>;
}

export interface FullToolCallOptions {
  serverId?: string;
  marker?: CompactMarker | null;
  bodyCache?: DurableBodyCache | null;
}

const cache = new Map<string, Promise<ToolCallDetail | null>>();

function detailOf(item: BodyItem | null | undefined): ToolCallDetail | null {
  return item?.type === "tool_call" ? ((item.detail as ToolCallDetail) ?? null) : null;
}

async function fetchFull(
  client: FullToolCallClient,
  agentId: string,
  callId: string,
  options: FullToolCallOptions,
): Promise<ToolCallDetail | null> {
  const { serverId, marker, bodyCache } = options;
  const hash = marker?.bodyHash;
  if (bodyCache && serverId && hash) {
    const stored = await bodyCache.get<BodyItem>(serverId, hash);
    const detail = detailOf(stored);
    if (detail) return detail;
  }
  if (marker?.short && client.fetchAgentTimelineBodies) {
    const result = await client.fetchAgentTimelineBodies(agentId, {
      callIds: [callId],
      priority: "tap",
    });
    const body = result.bodies.find((entry) => entry.callId === callId) ?? result.bodies[0];
    if (body) {
      const item = body.item as BodyItem;
      const bodyHash = body.hash ?? hash;
      if (bodyCache && serverId && bodyHash) void bodyCache.put(serverId, bodyHash, item);
      return detailOf(item);
    }
    // notLoaded / missing: the item request can resume a stored agent.
  }
  const payload = await client.fetchAgentTimelineItem(agentId, callId);
  if (bodyCache && serverId && hash && payload.item)
    void bodyCache.put(serverId, hash, payload.item);
  return detailOf(payload.item);
}

export function loadFullToolCallDetail(
  client: FullToolCallClient,
  agentId: string,
  callId: string,
  options: FullToolCallOptions = {},
): Promise<ToolCallDetail | null> {
  const key = `${agentId}\u0000${callId}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const load = fetchFull(client, agentId, callId, options).catch(() => {
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

export interface PrefetchRow {
  callId: string;
  metadata?: Record<string, unknown>;
}

/**
 * B2b prefetch for an open chat, only on a good link (the caller checks the same policy as chat
 * images: not constrained, not metered, not save-data). Asks the daemon's background lane for the
 * newest final short rows whose body is not on disk yet (by callId, so nothing is sent twice and
 * no `have` list goes up the link).
 * Returns how many bodies were stored.
 */
export async function prefetchToolBodies(input: {
  client: FullToolCallClient;
  serverId: string;
  agentId: string;
  rows: readonly PrefetchRow[];
  bodyCache: DurableBodyCache;
  goodLink: boolean;
  max?: number;
}): Promise<number> {
  const { client, serverId, agentId, rows, bodyCache, goodLink } = input;
  if (!goodLink || !client.fetchAgentTimelineBodies) return 0;
  const held = await bodyCache.hashes(serverId);
  const wanted: { callId: string; hash: string }[] = [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const marker = readCompactMarker(row.metadata);
    if (!marker?.short || !marker.bodyHash || held.has(marker.bodyHash)) continue;
    wanted.push({ callId: row.callId, hash: marker.bodyHash });
    if (wanted.length >= (input.max ?? PREFETCH_MAX_BODIES)) break;
  }
  if (wanted.length === 0) return 0;
  const result = await client.fetchAgentTimelineBodies(agentId, {
    callIds: wanted.map((entry) => entry.callId),
    priority: "background",
  });
  let stored = 0;
  for (const body of result.bodies) {
    const hash = body.hash ?? wanted.find((entry) => entry.callId === body.callId)?.hash;
    if (!hash) continue;
    await bodyCache.put(serverId, hash, body.item);
    stored += 1;
  }
  return stored;
}
