import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-community/netinfo", () => ({ default: {} }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => null }));

import type { PhoneNetworkState } from "@/runtime/network-monitor";
import {
  buildNetworkStatus,
  findConnectionFault,
  type NetworkHostInput,
  type NetworkStatusInput,
} from "./model";
import type { NetworkTestRun } from "./run-tests";

const NOW = 1_000_000;

const wifi: PhoneNetworkState = {
  type: "wifi",
  isConnected: true,
  isExpensive: false,
  cellularGeneration: null,
  carrier: null,
  ipAddress: "192.168.1.20",
  subnet: null,
  wifiStrength: null,
  wifiFrequency: null,
  linkSpeedMbps: null,
};

function host(overrides: Partial<NetworkHostInput> = {}): NetworkHostInput {
  return {
    serverId: "box",
    label: "my-desktop",
    status: "online",
    statusSince: NOW - 60_000,
    lastError: null,
    authFailure: false,
    lastOnlineAt: NOW - 60_000,
    connection: { type: "directTcp", endpoint: "100.64.0.10:6767", display: "" },
    rttSamples: [
      { at: NOW - 30_000, rttMs: 80 },
      { at: NOW - 20_000, rttMs: 120 },
    ],
    agents: { total: 3, errored: 0, needsPermission: 0, running: 1 },
    lastAgentEventAt: NOW - 1000,
    lastAgentError: null,
    ...overrides,
  };
}

function input(overrides: Partial<NetworkStatusInput> = {}): NetworkStatusInput {
  return {
    now: NOW,
    phone: wifi,
    phoneLastOnlineAt: NOW,
    phoneChangedAt: null,
    hasProbe: true,
    hosts: [host()],
    lastRun: null,
    running: false,
    ...overrides,
  };
}

function states(status: ReturnType<typeof buildNetworkStatus>) {
  return Object.fromEntries(status.hosts[0]?.rows.map((row) => [row.id, row.state]) ?? []);
}

describe("buildNetworkStatus", () => {
  it("shows a healthy tailnet path, inferring Tailscale and the machine from the live socket", () => {
    const status = buildNetworkStatus(input());
    expect(states(status)).toEqual({
      phone: "ok",
      tailscale: "ok",
      machine: "ok",
      daemon: "ok",
      agents: "ok",
      provider: "unknown",
    });
    expect(status.hosts[0]?.rtt.medianMs).toBe(80);
  });

  it("blocks the links after a phone with no network", () => {
    const status = buildNetworkStatus(
      input({
        phone: { ...wifi, isConnected: false, type: "none" },
        hosts: [host({ status: "connecting", statusSince: NOW - 30_000, lastOnlineAt: null })],
      }),
    );
    expect(states(status)).toMatchObject({
      phone: "down",
      tailscale: "blocked",
      machine: "blocked",
      daemon: "blocked",
    });
    expect(findConnectionFault(status, "box")).toMatchObject({
      link: "phone",
      reason: "noNetwork",
    });
  });

  it("blames Tailscale when the last test found no tunnel", () => {
    const run: NetworkTestRun = {
      startedAt: NOW - 5000,
      finishedAt: NOW - 1000,
      internet: { verdict: "online", medianMs: 50, targets: [], trace: null },
      tailscale: { available: true, tunnelUp: false, tailnetAddress: null, error: null },
      hosts: [],
    };
    const status = buildNetworkStatus(
      input({ lastRun: run, hosts: [host({ status: "offline", statusSince: NOW - 60_000 })] }),
    );
    expect(states(status)).toMatchObject({ tailscale: "down", daemon: "blocked" });
    expect(findConnectionFault(status, "box")).toMatchObject({
      link: "tailscale",
      reason: "tailscaleOff",
      params: { host: "my-desktop" },
    });
  });

  it("ignores a test run from before the network changed", () => {
    const run: NetworkTestRun = {
      startedAt: NOW - 50_000,
      finishedAt: NOW - 40_000,
      internet: { verdict: "no_internet", medianMs: null, targets: [], trace: null },
      tailscale: { available: true, tunnelUp: false, tailnetAddress: null, error: null },
      hosts: [],
    };
    const status = buildNetworkStatus(input({ lastRun: run, phoneChangedAt: NOW - 10_000 }));
    expect(status.phone.state).toBe("ok");
  });

  it("shows a provider limit the daemon has seen, without a test", () => {
    const status = buildNetworkStatus(
      input({
        hosts: [
          host({
            lastAgentError: {
              message: 'Consumer "alice" exceeded quota (five_hour)',
              at: NOW - 5000,
            },
          }),
        ],
      }),
    );
    expect(status.hosts[0]?.rows.find((row) => row.id === "provider")).toMatchObject({
      state: "degraded",
      reason: "providerLimited",
    });
  });

  it("waits a few seconds before calling a reconnect a fault", () => {
    const brief = buildNetworkStatus(
      input({ hosts: [host({ status: "connecting", statusSince: NOW - 1000 })] }),
    );
    expect(findConnectionFault(brief, "box")).toBeNull();
    const long = buildNetworkStatus(
      input({ hosts: [host({ status: "connecting", statusSince: NOW - 20_000 })] }),
    );
    expect(findConnectionFault(long, "box")).toMatchObject({
      link: "daemon",
      reason: "daemonReconnecting",
    });
  });

  it("marks a lossy link as degraded and reports the provider status page", () => {
    const status = buildNetworkStatus(
      input({
        hosts: [
          host({
            rttSamples: [
              { at: NOW - 3000, rttMs: 90 },
              { at: NOW - 2000, rttMs: null },
            ],
          }),
        ],
        lastRun: {
          startedAt: NOW - 3000,
          finishedAt: NOW - 100,
          internet: { verdict: "online", medianMs: 40, targets: [], trace: null },
          tailscale: { available: true, tunnelUp: true, tailnetAddress: "100.64.0.2", error: null },
          hosts: [
            {
              serverId: "box",
              label: "my-desktop",
              route: "tailnet",
              host: "100.64.0.10",
              port: 6767,
              resolve: null,
              machine: { outcome: "connected", ms: 30, port: 22 },
              daemonPort: { outcome: "connected", ms: 31, port: 6767 },
              rtt: null,
              speed: null,
              provider: {
                requestId: "r",
                provider: "claude",
                url: "https://api.anthropic.com/",
                viaBaseUrl: false,
                dnsMs: 1,
                tcpMs: 2,
                tlsMs: 3,
                httpMs: 140,
                httpStatus: 404,
                error: null,
                lastProviderError: null,
                status: {
                  indicator: "minor",
                  description: "Partially Degraded Service",
                  components: [],
                  incidents: [],
                },
                statusError: null,
                testedAt: new Date(NOW).toISOString(),
              },
              providerError: null,
              verdict: "ok",
            },
          ],
        },
      }),
    );
    expect(states(status)).toMatchObject({
      daemon: "degraded",
      machine: "ok",
      provider: "degraded",
    });
    expect(status.hosts[0]?.rows.find((row) => row.id === "machine")?.latencyMs).toBe(30);
  });
});
