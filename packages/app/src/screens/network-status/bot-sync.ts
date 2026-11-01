import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import type { Agent } from "@/stores/session-store";
import type { OutboxRecord } from "@/stores/outbox-store";

/** Per-agent sync rows for the Network page (open, waiting, or active in the last day). */

export type BotSyncState = "upToDate" | "reconnecting" | "updating" | "notLoaded";

export interface BotSyncRow {
  serverId: string;
  agentId: string;
  title: string;
  group: string | null;
  status: Agent["status"];
  sync: BotSyncState;
  lastEventAt: number;
  waiting: number;
  failed: number;
  queued: number;
  needsPermission: boolean;
  lastError: string | null;
}

const RECENT_MS = 24 * 60 * 60_000;
const MAX_ROWS = 40;

export interface BotSyncInput {
  serverId: string;
  hostStatus: HostRuntimeConnectionStatus;
  agents: ReadonlyMap<string, Agent>;
  initializing: ReadonlyMap<string, boolean>;
  historyApplied: ReadonlyMap<string, boolean>;
  records: readonly OutboxRecord[];
  now: number;
}

function syncState(input: BotSyncInput, agentId: string): BotSyncState {
  const loaded = input.historyApplied.get(agentId) === true;
  if (input.hostStatus !== "online") return loaded ? "reconnecting" : "notLoaded";
  if (input.initializing.get(agentId)) return "updating";
  return loaded ? "upToDate" : "notLoaded";
}

function buildRow(
  input: BotSyncInput,
  agent: Agent,
  pending: { waiting: number; failed: number } | undefined,
): BotSyncRow | null {
  if (agent.archivedAt) return null;
  const lastEventAt = agent.lastActivityAt.getTime();
  const opened = input.historyApplied.get(agent.id) === true;
  const recent = input.now - lastEventAt <= RECENT_MS || agent.status === "running";
  if (!pending && !opened && !recent) return null;
  return {
    serverId: input.serverId,
    agentId: agent.id,
    title: agent.title ?? agent.labels.bot ?? agent.id.slice(0, 8),
    group: agent.labels.bot ?? null,
    status: agent.status,
    sync: syncState(input, agent.id),
    lastEventAt,
    waiting: pending?.waiting ?? 0,
    failed: pending?.failed ?? 0,
    queued: agent.messageQueue?.items.length ?? 0,
    needsPermission: agent.pendingPermissions.length > 0,
    lastError: agent.status === "error" ? (agent.lastError ?? null) : null,
  };
}

export function buildBotSyncRows(input: BotSyncInput): BotSyncRow[] {
  const pendingByAgent = new Map<string, { waiting: number; failed: number }>();
  for (const record of input.records) {
    if (record.serverId !== input.serverId || record.state === "taken") continue;
    const entry = pendingByAgent.get(record.agentId) ?? { waiting: 0, failed: 0 };
    if (record.state === "failed" || record.state === "unknown") entry.failed += 1;
    else entry.waiting += 1;
    pendingByAgent.set(record.agentId, entry);
  }
  const rows: BotSyncRow[] = [];
  for (const agent of input.agents.values()) {
    const row = buildRow(input, agent, pendingByAgent.get(agent.id));
    if (row) rows.push(row);
  }
  const urgency = (row: BotSyncRow) => row.waiting + row.failed + (row.needsPermission ? 1 : 0);
  rows.sort((a, b) => urgency(b) - urgency(a) || b.lastEventAt - a.lastEventAt);
  return rows.slice(0, MAX_ROWS);
}
