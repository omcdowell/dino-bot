import { useEffect } from "react";
import { useChatImageAutoDownload } from "@/chat-images/network-policy";
import { getDurableBodyCache } from "@/runtime/replica-cache/body-cache";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { prefetchToolBodies, type PrefetchRow } from "./compact-tool-call";

/** Wait for the chat to settle (live rows stop arriving) before using the background lane. */
const PREFETCH_IDLE_MS = 1500;
const inflight = new Set<string>();

function toolRows(serverId: string, agentId: string): PrefetchRow[] {
  const timeline = selectAgentTimelineState(useSessionStore.getState().sessions[serverId], agentId);
  if (timeline.status !== "synced") return [];
  const rows: PrefetchRow[] = [];
  for (const item of timeline.items) {
    if (item.kind !== "tool_call" || item.payload.source !== "agent") continue;
    rows.push({ callId: item.payload.data.callId, metadata: item.payload.data.metadata });
  }
  return rows;
}

/**
 * B2b: on a good link only (same policy as chat-image auto-download), prefetch the open chat's
 * newest tool bodies into the durable body cache once its live timeline is synced. Never runs on
 * a stale (painted-from-disk) timeline and never on a constrained or metered link.
 */
export function useToolBodyPrefetch(input: {
  serverId: string;
  agentId: string | undefined;
  synced: boolean;
  itemCount: number;
}): void {
  const goodLink = useChatImageAutoDownload(input.serverId);
  const { serverId, agentId, synced, itemCount } = input;
  useEffect(() => {
    if (!agentId || !synced || !goodLink) return;
    const key = `${serverId}\u0000${agentId}`;
    const timer = setTimeout(() => {
      const bodyCache = getDurableBodyCache();
      const client = useSessionStore.getState().sessions[serverId]?.client;
      if (!bodyCache || !client || inflight.has(key)) return;
      inflight.add(key);
      void prefetchToolBodies({
        client,
        serverId,
        agentId,
        rows: toolRows(serverId, agentId),
        bodyCache,
        goodLink,
      })
        .catch(() => 0)
        .finally(() => inflight.delete(key));
    }, PREFETCH_IDLE_MS);
    return () => clearTimeout(timer);
  }, [serverId, agentId, synced, goodLink, itemCount]);
}
