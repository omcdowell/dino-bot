import type { Agent } from "@/stores/session-store";

/**
 * Chats labelled `paseo.keep-live` (the bots plugin sets it on each bot's current chat) are kept
 * subscribed from connect so opening one needs no fetch. Only agents the daemon holds in memory
 * qualify: a closed agent would be resumed by its first fetch, the #5040 failure.
 */
export const KEEP_LIVE_LABEL = "paseo.keep-live";

export function isKeepLiveAgent(agent: Agent): boolean {
  const value = agent.labels?.[KEEP_LIVE_LABEL];
  if (value === undefined || value === "" || value === "0" || value === "false") return false;
  if (agent.archivedAt) return false;
  return agent.status !== "closed";
}

/** Keep-live agent ids, highest catch-up priority first: attention, then most recent activity. */
export function selectKeepLiveAgentIds(agents: Iterable<Agent>): string[] {
  return [...agents]
    .filter(isKeepLiveAgent)
    .sort((left, right) => {
      const attention =
        Number(right.requiresAttention === true) - Number(left.requiresAttention === true);
      if (attention !== 0) return attention;
      return (
        right.lastActivityAt.getTime() - left.lastActivityAt.getTime() ||
        left.id.localeCompare(right.id)
      );
    })
    .map((agent) => agent.id);
}

export type KeepLivePhase = "running" | "idle";

export function keepLivePhase(agent: Agent): KeepLivePhase {
  return agent.status === "running" || agent.turn.phase !== "idle" ? "running" : "idle";
}

/** Phase changes of keep-live agents between two directory snapshots. */
export function diffKeepLivePhases(
  previous: ReadonlyMap<string, KeepLivePhase>,
  agents: Iterable<Agent>,
): {
  phases: Map<string, KeepLivePhase>;
  changes: Array<{ agentId: string; phase: KeepLivePhase }>;
} {
  const phases = new Map<string, KeepLivePhase>();
  const changes: Array<{ agentId: string; phase: KeepLivePhase }> = [];
  for (const agent of agents) {
    if (!isKeepLiveAgent(agent)) continue;
    const phase = keepLivePhase(agent);
    phases.set(agent.id, phase);
    const before = previous.get(agent.id);
    if (before !== undefined && before !== phase) changes.push({ agentId: agent.id, phase });
  }
  return { phases, changes };
}
