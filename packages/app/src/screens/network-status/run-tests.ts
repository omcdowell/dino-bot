import { parseHostPort } from "@getpaseo/protocol/daemon-endpoints";
import type { DiagnosticsProviderTestResponse } from "@getpaseo/protocol/messages";
import type { ActiveConnection } from "@/runtime/host-runtime";
import { runInternetProbes, type InternetProbeDeps, type InternetResult } from "./internet-probes";
import {
  findTailnetAddress,
  isTailnetAddress,
  type NetworkProbe,
  type TcpConnectResult,
} from "./probe";
import { formatMbps, summariseRtt, type RttStats } from "./stats";

/**
 * "Run tests" on the Network page. Everything here runs on demand only: nothing polls.
 * Order follows the network path: phone → internet, phone → Tailscale, Tailscale → machine,
 * machine → Paseo daemon, daemon → model provider.
 */

export type ProviderTestPayload = DiagnosticsProviderTestResponse["payload"];

export interface NetworkTestClient {
  ping(params?: { timeoutMs?: number }): Promise<{ rttMs: number }>;
  runNetworkSpeedTest(
    direction: "down" | "up",
    bytes: number,
  ): Promise<{ bytes: number; elapsedMs: number; serverMs: number }>;
  runProviderTest(provider?: string): Promise<ProviderTestPayload>;
}

export interface NetworkTestHost {
  serverId: string;
  label: string;
  connection: ActiveConnection | null;
  client: NetworkTestClient | null;
  online: boolean;
  networkDiagnostics: boolean;
}

export type HostRoute = "tailnet" | "magicdns" | "lan" | "loopback" | "public" | "relay" | "local";

export type HostVerdict =
  | "ok"
  | "tailscale_off"
  | "dns_failed"
  | "machine_offline"
  | "daemon_down"
  | "daemon_not_answering"
  | "offline"
  | "untested";

export interface HostTestResult {
  serverId: string;
  label: string;
  route: HostRoute;
  host: string | null;
  port: number | null;
  resolve: { addresses: string[]; ms: number | null; error: string | null } | null;
  machine: (TcpConnectResult & { port: number }) | null;
  daemonPort: (TcpConnectResult & { port: number }) | null;
  rtt: (RttStats & { values: Array<number | null> }) | null;
  speed: { downMbps: number | null; upMbps: number | null; error: string | null } | null;
  provider: ProviderTestPayload | null;
  providerError: string | null;
  verdict: HostVerdict;
}

export interface TailscaleTestResult {
  /** False when there is no probe (plain browser). */
  available: boolean;
  tunnelUp: boolean | null;
  tailnetAddress: string | null;
  error: string | null;
}

export interface NetworkTestRun {
  startedAt: number;
  finishedAt: number;
  internet: InternetResult;
  tailscale: TailscaleTestResult;
  hosts: HostTestResult[];
}

export interface NetworkTestDeps extends InternetProbeDeps {
  probe: NetworkProbe | null;
  hosts: NetworkTestHost[];
  pingCount?: number;
  speedDownBytes?: number;
  speedUpBytes?: number;
  onProgress?: (step: NetworkTestStep) => void;
}

export type NetworkTestStep = "internet" | "tailscale" | "hosts" | "done";

const SSH_PORT = 22;
const TCP_TIMEOUT_MS = 3000;
const PING_TIMEOUT_MS = 5000;
export const DEFAULT_PING_COUNT = 5;
export const DEFAULT_SPEED_DOWN_BYTES = 256 * 1024;
export const DEFAULT_SPEED_UP_BYTES = 64 * 1024;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host.startsWith("127.") || host === "::1";
}

function isPrivateLan(host: string): boolean {
  return (
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".local")
  );
}

export function classifyHostRoute(connection: ActiveConnection | null): {
  route: HostRoute;
  host: string | null;
  port: number | null;
} {
  if (!connection) return { route: "local", host: null, port: null };
  if (connection.type === "relay") return { route: "relay", host: null, port: null };
  if (connection.type !== "directTcp") return { route: "local", host: null, port: null };
  try {
    const { host, port } = parseHostPort(connection.endpoint);
    return { route: routeForHost(host), host, port };
  } catch {
    return { route: "public", host: null, port: null };
  }
}

function routeForHost(host: string): HostRoute {
  if (isLoopback(host)) return "loopback";
  if (isTailnetAddress(host)) return "tailnet";
  if (host.endsWith(".ts.net") || !host.includes(".")) return "magicdns";
  if (isPrivateLan(host)) return "lan";
  return "public";
}

export async function runTailscaleTest(probe: NetworkProbe | null): Promise<TailscaleTestResult> {
  if (!probe) return { available: false, tunnelUp: null, tailnetAddress: null, error: null };
  try {
    const tailnetAddress = findTailnetAddress(await probe.listInterfaces());
    return { available: true, tunnelUp: tailnetAddress !== null, tailnetAddress, error: null };
  } catch (error) {
    return { available: true, tunnelUp: null, tailnetAddress: null, error: errorText(error) };
  }
}

async function measureRtt(
  client: NetworkTestClient,
  count: number,
): Promise<HostTestResult["rtt"]> {
  const values: Array<number | null> = [];
  for (let index = 0; index < count; index += 1) {
    try {
      values.push((await client.ping({ timeoutMs: PING_TIMEOUT_MS })).rttMs);
    } catch {
      values.push(null);
    }
  }
  return { ...summariseRtt(values), values };
}

async function measureSpeed(
  client: NetworkTestClient,
  downBytes: number,
  upBytes: number,
): Promise<HostTestResult["speed"]> {
  try {
    const down = await client.runNetworkSpeedTest("down", downBytes);
    const up = await client.runNetworkSpeedTest("up", upBytes);
    return {
      downMbps: formatMbps(down.bytes, down.elapsedMs),
      upMbps: formatMbps(up.bytes, up.elapsedMs),
      error: null,
    };
  } catch (error) {
    return { downMbps: null, upMbps: null, error: errorText(error) };
  }
}

async function probeMachine(
  probe: NetworkProbe,
  result: HostTestResult,
): Promise<{ address: string | null }> {
  const host = result.host;
  if (!host || result.port === null) return { address: null };
  let address: string | null = host;
  if (!isIpLiteral(host)) {
    try {
      const resolved = await probe.resolve(host);
      result.resolve = { addresses: resolved.addresses, ms: resolved.ms, error: null };
      address = resolved.addresses[0] ?? null;
    } catch (error) {
      result.resolve = { addresses: [], ms: null, error: errorText(error) };
      return { address: null };
    }
  }
  if (!address) return { address: null };
  const [machine, daemonPort] = await Promise.all([
    probe.tcpConnect(address, SSH_PORT, TCP_TIMEOUT_MS),
    probe.tcpConnect(address, result.port, TCP_TIMEOUT_MS),
  ]);
  result.machine = { ...machine, port: SSH_PORT };
  result.daemonPort = { ...daemonPort, port: result.port };
  return { address };
}

function answers(result: TcpConnectResult | null): boolean {
  return result?.outcome === "connected" || result?.outcome === "refused";
}

export function decideHostVerdict(
  result: HostTestResult,
  tailscale: TailscaleTestResult,
): HostVerdict {
  const pingOk = result.rtt !== null && result.rtt.medianMs !== null;
  if (pingOk) return "ok";
  const viaTailnet = result.route === "tailnet" || result.route === "magicdns";
  if (viaTailnet && tailscale.tunnelUp === false) return "tailscale_off";
  if (result.resolve?.error) return "dns_failed";
  if (result.machine || result.daemonPort) {
    if (result.daemonPort?.outcome === "connected") return "daemon_not_answering";
    if (answers(result.machine)) return "daemon_down";
    return "machine_offline";
  }
  return result.rtt ? "daemon_not_answering" : "offline";
}

async function runHostTest(
  host: NetworkTestHost,
  deps: NetworkTestDeps,
  tailscale: TailscaleTestResult,
): Promise<HostTestResult> {
  const result: HostTestResult = {
    serverId: host.serverId,
    label: host.label,
    ...classifyHostRoute(host.connection),
    resolve: null,
    machine: null,
    daemonPort: null,
    rtt: null,
    speed: null,
    provider: null,
    providerError: null,
    verdict: "untested",
  };
  if (deps.probe) await probeMachine(deps.probe, result);
  if (host.client && host.online) {
    result.rtt = await measureRtt(host.client, deps.pingCount ?? DEFAULT_PING_COUNT);
    if (host.networkDiagnostics) {
      result.speed = await measureSpeed(
        host.client,
        deps.speedDownBytes ?? DEFAULT_SPEED_DOWN_BYTES,
        deps.speedUpBytes ?? DEFAULT_SPEED_UP_BYTES,
      );
      try {
        result.provider = await host.client.runProviderTest();
      } catch (error) {
        result.providerError = errorText(error);
      }
    }
  }
  result.verdict = decideHostVerdict(result, tailscale);
  return result;
}

export async function runNetworkTests(deps: NetworkTestDeps): Promise<NetworkTestRun> {
  const startedAt = deps.now();
  deps.onProgress?.("internet");
  const [internet, tailscale] = await Promise.all([
    runInternetProbes(deps),
    runTailscaleTest(deps.probe),
  ]);
  deps.onProgress?.("hosts");
  const hosts = await Promise.all(deps.hosts.map((host) => runHostTest(host, deps, tailscale)));
  deps.onProgress?.("done");
  return { startedAt, finishedAt: deps.now(), internet, tailscale, hosts };
}
