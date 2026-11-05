import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { ipcMain } from "electron";

/**
 * Network probes for the app's Network page: the same three calls as the iOS/Android
 * PaseoNetworkProbe module (interfaces, name lookup, timed TCP connect).
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

export function listProbeInterfaces(): ProbeInterface[] {
  const result: ProbeInterface[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      result.push({
        name,
        address: entry.address,
        family: entry.family === "IPv6" ? "IPv6" : "IPv4",
        internal: entry.internal,
      });
    }
  }
  return result;
}

export async function resolveProbeHost(host: string): Promise<{ addresses: string[]; ms: number }> {
  const startedAt = performance.now();
  const entries = await lookup(host, { all: true });
  return { addresses: entries.map((entry) => entry.address), ms: performance.now() - startedAt };
}

export async function tcpConnectProbe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<TcpConnectResult> {
  const startedAt = performance.now();
  const socket = connect({ host, port });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await new Promise<{ outcome: TcpConnectOutcome; error?: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ outcome: "timeout" }),
      Math.min(Math.max(timeoutMs, 100), 15_000),
    );
    socket.once("connect", () => resolve({ outcome: "connected" }));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      resolve({
        outcome: error.code === "ECONNREFUSED" ? "refused" : "error",
        error: error.code ?? error.message,
      }),
    );
  });
  clearTimeout(timer);
  socket.destroy();
  return { ...outcome, ms: performance.now() - startedAt };
}

export function registerNetworkProbeHandlers(): void {
  ipcMain.handle("paseo:network-probe:listInterfaces", () => listProbeInterfaces());
  ipcMain.handle("paseo:network-probe:resolve", (_event, host: unknown) =>
    resolveProbeHost(String(host)),
  );
  ipcMain.handle(
    "paseo:network-probe:tcpConnect",
    (_event, host: unknown, port: unknown, timeoutMs: unknown) =>
      tcpConnectProbe(String(host), Number(port), Number(timeoutMs) || 3000),
  );
}
