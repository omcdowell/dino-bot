import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getHostRuntimeStore, getHostRuntimeConnectionStatusSince } from "@/runtime/host-runtime";
import { useNetworkMonitorStore } from "@/runtime/network-monitor";
import {
  buildNetworkStatus,
  type NetworkHostInput,
  type NetworkStatus,
} from "@/screens/network-status/model";
import { getNetworkProbe } from "@/screens/network-status/probe";
import { useNetworkTestStore } from "@/screens/network-status/test-store";
import { useSessionStore, type Agent } from "@/stores/session-store";

/**
 * One selector for the Network page and the fault banner: the phone network, every host's
 * connection, recent heartbeat round trips, agents and the last "Run tests" result.
 */

const TICK_MS = 2000;

function subscribeHosts(listener: () => void): () => void {
  return getHostRuntimeStore().subscribeAll(listener);
}

function getHostsVersion(): number {
  return getHostRuntimeStore().getVersion();
}

function summariseAgents(agents: Map<string, Agent> | undefined): NetworkHostInput["agents"] & {
  lastEventAt: number | null;
  lastError: NetworkHostInput["lastAgentError"];
} {
  let total = 0;
  let errored = 0;
  let needsPermission = 0;
  let running = 0;
  let lastEventAt: number | null = null;
  let lastError: NetworkHostInput["lastAgentError"] = null;
  for (const agent of agents?.values() ?? []) {
    if (agent.archivedAt) continue;
    total += 1;
    if (agent.status === "error") {
      errored += 1;
      const at = agent.updatedAt.getTime();
      if (agent.lastError && (!lastError || at > lastError.at)) {
        lastError = { message: agent.lastError, at };
      }
    }
    if (agent.status === "running") running += 1;
    if (agent.pendingPermissions.length > 0) needsPermission += 1;
    const at = agent.lastActivityAt.getTime();
    if (lastEventAt === null || at > lastEventAt) lastEventAt = at;
  }
  return { total, errored, needsPermission, running, lastEventAt, lastError };
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function collectHostInputs(
  agentsByServer: Record<string, Map<string, Agent> | undefined>,
): NetworkHostInput[] {
  const store = getHostRuntimeStore();
  const labels = new Map(store.getHosts().map((host) => [host.serverId, host.label]));
  return store.listServerIds().map((serverId) => {
    const snapshot = store.getSnapshot(serverId);
    const client = store.getClient(serverId);
    const agents = summariseAgents(agentsByServer[serverId]);
    return {
      serverId,
      label: labels.get(serverId) ?? serverId,
      status: snapshot?.connectionStatus ?? "idle",
      statusSince: getHostRuntimeConnectionStatusSince(serverId),
      lastError: snapshot?.lastError ?? null,
      authFailure: Boolean(snapshot?.authFailureReason),
      lastOnlineAt: parseTime(snapshot?.lastOnlineAt ?? null),
      connection: snapshot?.activeConnection ?? null,
      rttSamples: client?.getLivenessRttSamples() ?? [],
      agents,
      lastAgentEventAt: agents.lastEventAt,
      lastAgentError: agents.lastError,
    };
  });
}

/** Re-renders every couple of seconds so "reconnecting for n s" and RTT windows stay fresh. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function useNetworkStatus(): NetworkStatus {
  const now = useNow();
  const hostsVersion = useSyncExternalStore(subscribeHosts, getHostsVersion, getHostsVersion);
  const monitor = useNetworkMonitorStore();
  const lastRun = useNetworkTestStore((state) => state.runs[0] ?? null);
  const running = useNetworkTestStore((state) => state.running);
  const sessions = useSessionStore((state) => state.sessions);
  return useMemo(() => {
    void hostsVersion;
    const agentsByServer = Object.fromEntries(
      Object.entries(sessions).map(([serverId, session]) => [serverId, session.agents]),
    );
    return buildNetworkStatus({
      now,
      phone: monitor.phone,
      phoneLastOnlineAt: monitor.lastOnlineAt,
      phoneChangedAt: monitor.changedAt,
      hasProbe: getNetworkProbe() !== null,
      hosts: collectHostInputs(agentsByServer),
      lastRun,
      running,
    });
  }, [hostsVersion, lastRun, monitor, now, running, sessions]);
}
