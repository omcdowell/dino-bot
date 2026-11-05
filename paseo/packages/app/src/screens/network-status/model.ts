import type { ActiveConnection, HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import type { PhoneNetworkState } from "@/runtime/network-monitor";
import {
  classifyHostRoute,
  type HostRoute,
  type HostTestResult,
  type NetworkTestRun,
} from "./run-tests";
import { summariseRtt, type RttStats } from "./stats";

/**
 * Builds the Network page and the fault banner from one set of inputs, so the two always agree.
 * Rows follow the network path. The lowest failing link wins; links after it that are not known
 * to be fine show "blocked" rather than a second, misleading "down".
 */

export type LinkId = "phone" | "tailscale" | "machine" | "daemon" | "agents" | "provider";
export type LinkState = "ok" | "degraded" | "down" | "unknown" | "blocked" | "checking";

export interface LinkRow {
  id: LinkId;
  state: LinkState;
  /** i18n key under `network.reasons`. */
  reason: string;
  params?: Record<string, string | number>;
  latencyMs: number | null;
  lastOkAt: number | null;
  blockedBy?: LinkId;
}

export interface NetworkHostInput {
  serverId: string;
  label: string;
  status: HostRuntimeConnectionStatus;
  statusSince: number | null;
  lastError: string | null;
  authFailure: boolean;
  lastOnlineAt: number | null;
  connection: ActiveConnection | null;
  rttSamples: ReadonlyArray<{ at: number; rttMs: number | null }>;
  agents: { total: number; errored: number; needsPermission: number; running: number };
  lastAgentEventAt: number | null;
  /** The newest error an agent on this host reported, as the daemon saw it (no polling). */
  lastAgentError: { message: string; at: number } | null;
}

export interface NetworkStatusInput {
  now: number;
  phone: PhoneNetworkState | null;
  phoneLastOnlineAt: number | null;
  phoneChangedAt: number | null;
  hasProbe: boolean;
  hosts: readonly NetworkHostInput[];
  lastRun: NetworkTestRun | null;
  running: boolean;
}

export interface HostLinks {
  serverId: string;
  label: string;
  route: HostRoute;
  rows: LinkRow[];
  rtt: RttStats;
  run: HostTestResult | null;
}

export interface NetworkStatus {
  hosts: HostLinks[];
  phone: LinkRow;
}

const RTT_WINDOW_MS = 5 * 60_000;

function lastRunIsCurrent(input: NetworkStatusInput): boolean {
  if (!input.lastRun) return false;
  return input.phoneChangedAt === null || input.lastRun.finishedAt >= input.phoneChangedAt;
}

export function buildPhoneRow(input: NetworkStatusInput): LinkRow {
  const base = { id: "phone" as const, latencyMs: null, lastOkAt: input.phoneLastOnlineAt };
  const phone = input.phone;
  if (!phone || phone.isConnected === null) return { ...base, state: "unknown", reason: "unknown" };
  if (!phone.isConnected) return { ...base, state: "down", reason: "noNetwork" };
  const internet = lastRunIsCurrent(input) ? input.lastRun?.internet : null;
  const params = { type: phone.type };
  if (!internet) return { ...base, state: "ok", reason: "connectedVia", params };
  const latencyMs = internet.medianMs;
  switch (internet.verdict) {
    case "no_internet":
      return { ...base, latencyMs, state: "down", reason: "noInternet", params };
    case "dns":
      return { ...base, latencyMs, state: "degraded", reason: "dnsFailing", params };
    case "partial":
      return { ...base, latencyMs, state: "degraded", reason: "internetPartial", params };
    default:
      return { ...base, latencyMs, state: "ok", reason: "connectedVia", params };
  }
}

function usesTailnet(route: HostRoute): boolean {
  return route === "tailnet" || route === "magicdns";
}

function buildTailscaleRow(input: NetworkStatusInput, host: NetworkHostInput): LinkRow {
  const base = { id: "tailscale" as const, latencyMs: null, lastOkAt: null };
  const tailscale = lastRunIsCurrent(input) ? input.lastRun?.tailscale : null;
  if (tailscale?.tunnelUp === false) return { ...base, state: "down", reason: "tailscaleOff" };
  if (tailscale?.tunnelUp) {
    return {
      ...base,
      state: "ok",
      reason: "tailscaleUp",
      params: { address: tailscale.tailnetAddress ?? "" },
    };
  }
  if (host.status === "online") {
    return { ...base, state: "ok", reason: "tailscaleInferred", lastOkAt: input.now };
  }
  if (!input.hasProbe) return { ...base, state: "unknown", reason: "probeUnavailable" };
  return { ...base, state: "unknown", reason: "runTests" };
}

function buildMachineRow(host: NetworkHostInput, run: HostTestResult | null): LinkRow {
  const base = { id: "machine" as const, latencyMs: null, lastOkAt: null };
  if (run?.resolve?.error) {
    return {
      ...base,
      state: "down",
      reason: "magicDnsFailing",
      params: { error: run.resolve.error },
    };
  }
  if (run?.verdict === "machine_offline")
    return { ...base, state: "down", reason: "machineOffline" };
  const answered = run?.machine?.outcome === "connected" || run?.machine?.outcome === "refused";
  if (answered && run?.machine) {
    return { ...base, state: "ok", reason: "machineAnswers", latencyMs: run.machine.ms };
  }
  if (host.status === "online") {
    return { ...base, state: "ok", reason: "machineInferred", lastOkAt: host.lastOnlineAt };
  }
  return { ...base, state: "unknown", reason: "runTests" };
}

function recentRtt(host: NetworkHostInput, now: number): RttStats {
  return summariseRtt(
    host.rttSamples.filter((sample) => now - sample.at <= RTT_WINDOW_MS).map((s) => s.rttMs),
  );
}

const RECONNECTING_GRACE_MS = 5000;

function lastAnsweredAt(host: NetworkHostInput): number | null {
  for (let index = host.rttSamples.length - 1; index >= 0; index -= 1) {
    const sample = host.rttSamples[index];
    if (sample && sample.rttMs !== null) return sample.at;
  }
  return null;
}

function buildDaemonRow(
  host: NetworkHostInput,
  run: HostTestResult | null,
  rtt: RttStats,
  now: number,
): LinkRow {
  const base = {
    id: "daemon" as const,
    latencyMs: rtt.medianMs,
    lastOkAt: host.lastOnlineAt ?? lastAnsweredAt(host),
  };
  if (host.authFailure) return { ...base, state: "down", reason: "authError" };
  if (host.status === "online") {
    const lossy = (rtt.lossPct ?? 0) > 0;
    return {
      ...base,
      state: lossy ? "degraded" : "ok",
      reason: lossy ? "daemonLossy" : "daemonOnline",
    };
  }
  if (run?.verdict === "daemon_down") return { ...base, state: "down", reason: "daemonDown" };
  if (run?.verdict === "daemon_not_answering") {
    return { ...base, state: "down", reason: "daemonNotAnswering" };
  }
  if (host.status === "connecting" || host.status === "idle") {
    const longWait = host.statusSince !== null && now - host.statusSince > RECONNECTING_GRACE_MS;
    return longWait
      ? { ...base, state: "down", reason: "daemonReconnecting" }
      : { ...base, state: "checking", reason: "daemonConnecting" };
  }
  return {
    ...base,
    state: "down",
    reason: host.lastError ? "daemonOfflineWithError" : "daemonOffline",
    params: host.lastError ? { error: host.lastError } : undefined,
  };
}

function buildAgentsRow(host: NetworkHostInput): LinkRow {
  const base = { id: "agents" as const, latencyMs: null, lastOkAt: host.lastAgentEventAt };
  const { agents } = host;
  if (host.status !== "online") return { ...base, state: "unknown", reason: "unknown" };
  if (agents.errored > 0) {
    return {
      ...base,
      state: "degraded",
      reason: "agentsErrored",
      params: { count: agents.errored },
    };
  }
  if (agents.needsPermission > 0) {
    return {
      ...base,
      state: "degraded",
      reason: "agentsNeedPermission",
      params: { count: agents.needsPermission },
    };
  }
  return {
    ...base,
    state: "ok",
    reason: "agentsOk",
    params: { count: agents.total, running: agents.running },
  };
}

const PROVIDER_LIMIT_PATTERN = /rate.?limit|\b429\b|quota|overloaded|\b529\b|exceeded/i;

/** What the daemon has seen from the provider, without a test. */
function observedProviderRow(host: NetworkHostInput): LinkRow | null {
  const error = host.lastAgentError;
  if (!error || !PROVIDER_LIMIT_PATTERN.test(error.message)) return null;
  return {
    id: "provider",
    latencyMs: null,
    lastOkAt: null,
    state: "degraded",
    reason: "providerLimited",
    params: { error: error.message.slice(0, 160) },
  };
}

function buildProviderRow(run: HostTestResult | null, host: NetworkHostInput): LinkRow {
  const base = { id: "provider" as const, latencyMs: null, lastOkAt: null };
  const provider = run?.provider;
  const observed = observedProviderRow(host);
  if (observed && (!provider || provider.error === null)) return observed;
  if (!provider) {
    if (run?.providerError) {
      return {
        ...base,
        state: "unknown",
        reason: "providerTestFailed",
        params: { error: run.providerError },
      };
    }
    return { ...base, state: "unknown", reason: run ? "providerTestUnsupported" : "runTests" };
  }
  const latencyMs = provider.httpMs;
  if (provider.error) {
    return {
      ...base,
      latencyMs,
      state: "down",
      reason: "providerUnreachable",
      params: { error: provider.error },
    };
  }
  const indicator = provider.status?.indicator;
  if (indicator && indicator !== "none") {
    return {
      ...base,
      latencyMs,
      state: "degraded",
      reason: "providerStatus",
      params: { description: provider.status?.description ?? indicator },
    };
  }
  return {
    ...base,
    latencyMs,
    state: "ok",
    reason: "providerOk",
    lastOkAt: Date.parse(provider.testedAt),
  };
}

/** Marks links after the lowest failing one as blocked unless they are known to be fine. */
export function applyBlocking(rows: LinkRow[]): LinkRow[] {
  let blocker: LinkId | null = null;
  return rows.map((row) => {
    if (blocker && (row.state === "down" || row.state === "unknown" || row.state === "checking")) {
      return { ...row, state: "blocked", blockedBy: blocker };
    }
    if (!blocker && row.state === "down") blocker = row.id;
    return row;
  });
}

export function buildNetworkStatus(input: NetworkStatusInput): NetworkStatus {
  const phone = buildPhoneRow(input);
  const hosts = input.hosts.map((host): HostLinks => {
    const { route } = classifyHostRoute(host.connection);
    const run = lastRunIsCurrent(input)
      ? (input.lastRun?.hosts.find((entry) => entry.serverId === host.serverId) ?? null)
      : null;
    const rtt = recentRtt(host, input.now);
    const rows: LinkRow[] = [phone];
    if (usesTailnet(route)) rows.push(buildTailscaleRow(input, host));
    if (route !== "loopback" && route !== "local" && route !== "relay") {
      rows.push(buildMachineRow(host, run));
    }
    rows.push(
      buildDaemonRow(host, run, rtt, input.now),
      buildAgentsRow(host),
      buildProviderRow(run, host),
    );
    return {
      serverId: host.serverId,
      label: host.label,
      route,
      rows: applyBlocking(rows),
      rtt,
      run,
    };
  });
  return { phone, hosts };
}

export interface ConnectionFault {
  serverId: string | null;
  link: LinkId;
  reason: string;
  params?: Record<string, string | number>;
}

/** The lowest failing link for the banner, from live state only (no test needed). */
export function findConnectionFault(
  status: NetworkStatus,
  serverId: string | null,
): ConnectionFault | null {
  if (status.phone.state === "down") {
    return {
      serverId: null,
      link: "phone",
      reason: status.phone.reason,
      params: status.phone.params,
    };
  }
  const host = status.hosts.find((entry) => entry.serverId === serverId);
  const failing = host?.rows.find((row) => row.state === "down");
  if (!host || !failing) return null;
  return {
    serverId: host.serverId,
    link: failing.id,
    reason: failing.reason,
    params: { ...failing.params, host: host.label },
  };
}
