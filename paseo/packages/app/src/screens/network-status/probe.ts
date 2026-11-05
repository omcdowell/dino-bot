import { requireOptionalNativeModule } from "expo-modules-core";
import { getDesktopHost } from "@/desktop/host";

/**
 * Low-level network probes: the native PaseoNetworkProbe module on iOS and Android, the desktop
 * bridge in Electron, and nothing in a plain browser (which cannot open raw sockets).
 */

export interface ProbeInterface {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

export type TcpConnectOutcome = "connected" | "refused" | "timeout" | "error";

export interface TcpConnectResult {
  outcome: TcpConnectOutcome;
  ms: number;
  error?: string;
}

export interface ResolveResult {
  addresses: string[];
  ms: number;
}

export interface NetworkProbe {
  kind: "native" | "desktop";
  listInterfaces(): Promise<ProbeInterface[]>;
  resolve(host: string): Promise<ResolveResult>;
  tcpConnect(host: string, port: number, timeoutMs: number): Promise<TcpConnectResult>;
}

interface NativeNetworkProbeModule {
  listInterfaces(): Promise<ProbeInterface[]>;
  resolve(host: string): Promise<ResolveResult>;
  tcpConnect(host: string, port: number, timeoutMs: number): Promise<TcpConnectResult>;
}

let cached: NetworkProbe | null | undefined;

export function getNetworkProbe(): NetworkProbe | null {
  if (cached !== undefined) return cached;
  cached = resolveNetworkProbe();
  return cached;
}

function resolveNetworkProbe(): NetworkProbe | null {
  const native = requireOptionalNativeModule<NativeNetworkProbeModule>("PaseoNetworkProbe");
  if (native) {
    return {
      kind: "native",
      listInterfaces: () => native.listInterfaces(),
      resolve: (host) => native.resolve(host),
      tcpConnect: (host, port, timeoutMs) => native.tcpConnect(host, port, timeoutMs),
    };
  }
  const bridge = getDesktopHost()?.networkProbe;
  if (bridge?.listInterfaces && bridge.resolve && bridge.tcpConnect) {
    const { listInterfaces, resolve, tcpConnect } = bridge;
    return {
      kind: "desktop",
      listInterfaces: async () => (await listInterfaces()) as ProbeInterface[],
      resolve: async (host) => (await resolve(host)) as ResolveResult,
      tcpConnect: async (host, port, timeoutMs) =>
        (await tcpConnect(host, port, timeoutMs)) as TcpConnectResult,
    };
  }
  return null;
}

/** Tailscale hands out 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailnetAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.startsWith("fd7a:115c:a1e0:")) return true;
  const parts = lower.split(".");
  if (parts.length !== 4) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return first === 100 && second >= 64 && second <= 127;
}

export function findTailnetAddress(interfaces: readonly ProbeInterface[]): string | null {
  const matches = interfaces.filter((entry) => !entry.internal && isTailnetAddress(entry.address));
  return matches.find((entry) => entry.family === "IPv4")?.address ?? matches[0]?.address ?? null;
}
