import { describe, expect, it, vi } from "vitest";

vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => null }));

import {
  decideInternetVerdict,
  parseCloudflareTrace,
  runInternetProbes,
  type InternetTargetResult,
  type ProbeFetch,
} from "./internet-probes";
import { findTailnetAddress, isTailnetAddress, type NetworkProbe } from "./probe";
import {
  classifyHostRoute,
  runNetworkTests,
  type NetworkTestClient,
  type ProviderTestPayload,
} from "./run-tests";
import { summariseRtt } from "./stats";

function target(id: InternetTargetResult["id"], okCount: number): InternetTargetResult {
  return { id, label: id, okCount, attempts: 3, medianMs: okCount ? 50 : null, error: null };
}

function fakeFetch(fail: (url: string) => boolean): ProbeFetch {
  return async (url: string) => {
    if (fail(url)) throw new TypeError("Network request failed");
    if (url.includes("cdn-cgi/trace")) {
      return new Response("ip=203.0.113.9\nloc=PH\ncolo=MNL\ntls=TLSv1.3\n", { status: 200 });
    }
    if (url.includes("generate_204")) return new Response(null, { status: 204 });
    return new Response("{}", { status: 200 });
  };
}

function clock(): () => number {
  let now = 0;
  return () => {
    now += 10;
    return now;
  };
}

function fakeProbe(overrides: Partial<NetworkProbe> = {}): NetworkProbe {
  return {
    kind: "native",
    listInterfaces: async () => [
      { name: "lo0", address: "127.0.0.1", family: "IPv4", internal: true },
      { name: "utun4", address: "100.64.0.14", family: "IPv4", internal: false },
    ],
    resolve: async () => ({ addresses: ["100.64.0.10"], ms: 4 }),
    tcpConnect: async () => ({ outcome: "connected", ms: 30 }),
    ...overrides,
  };
}

function fakeClient(overrides: Partial<NetworkTestClient> = {}): NetworkTestClient {
  return {
    ping: async () => ({ rttMs: 40 }),
    runNetworkSpeedTest: async (_direction, bytes) => ({ bytes, elapsedMs: 1000, serverMs: 1 }),
    runProviderTest: async () => ({ requestId: "r" }) as ProviderTestPayload,
    ...overrides,
  };
}

describe("internet probes", () => {
  it("names a DNS problem when the IP targets answer and google.com does not", () => {
    expect(
      decideInternetVerdict([
        target("cloudflare", 3),
        target("google_dns", 3),
        target("google", 0),
      ]),
    ).toBe("dns");
    expect(
      decideInternetVerdict([
        target("cloudflare", 0),
        target("google_dns", 0),
        target("google", 0),
      ]),
    ).toBe("no_internet");
    expect(
      decideInternetVerdict([
        target("cloudflare", 3),
        target("google_dns", 2),
        target("google", 3),
      ]),
    ).toBe("partial");
  });

  it("reads the Cloudflare trace", () => {
    expect(parseCloudflareTrace("ip=1.2.3.4\nloc=PH\ntls=TLSv1.3\n")).toEqual({
      ip: "1.2.3.4",
      loc: "PH",
      colo: null,
      tls: "TLSv1.3",
    });
  });

  it("times three requests per target and keeps the trace", async () => {
    const fetchImpl = vi.fn(fakeFetch(() => false));
    const result = await runInternetProbes({ fetch: fetchImpl, now: clock(), isWeb: false });
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(result.verdict).toBe("online");
    expect(result.trace?.loc).toBe("PH");
    expect(result.medianMs).toBeGreaterThan(0);
  });

  it("uses an opaque request for google.com in a browser", async () => {
    const fetchImpl = vi.fn(fakeFetch(() => false));
    await runInternetProbes({ fetch: fetchImpl, now: clock(), isWeb: true, attempts: 1 });
    const googleCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("google.com"));
    expect(googleCall?.[1]).toMatchObject({ mode: "no-cors" });
  });
});

describe("tailnet detection", () => {
  it("knows the Tailscale ranges", () => {
    expect(isTailnetAddress("100.64.0.10")).toBe(true);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailnetAddress("192.168.1.2")).toBe(false);
    expect(
      findTailnetAddress([
        { name: "en0", address: "192.168.1.5", family: "IPv4", internal: false },
        { name: "utun3", address: "100.64.0.9", family: "IPv4", internal: false },
      ]),
    ).toBe("100.64.0.9");
  });

  it("classifies the host route from the connection", () => {
    const direct = (endpoint: string) => ({
      type: "directTcp" as const,
      endpoint,
      display: endpoint,
    });
    expect(classifyHostRoute(direct("100.64.0.10:6767")).route).toBe("tailnet");
    expect(classifyHostRoute(direct("my-desktop:6767")).route).toBe("magicdns");
    expect(classifyHostRoute(direct("box.tail1234.ts.net:6767")).route).toBe("magicdns");
    expect(classifyHostRoute(direct("192.168.1.10:6767")).route).toBe("lan");
    expect(classifyHostRoute(direct("localhost:6767")).route).toBe("loopback");
    expect(
      classifyHostRoute({ type: "relay", endpoint: "relay.example:443", display: "relay" }).route,
    ).toBe("relay");
  });
});

describe("rtt summary", () => {
  it("reports median, p95, jitter and loss", () => {
    const stats = summariseRtt([40, 60, null, 50, 200]);
    expect(stats.medianMs).toBe(50);
    expect(stats.p95Ms).toBe(200);
    expect(stats.lossPct).toBe(20);
    expect(stats.jitterMs).toBeCloseTo((20 + 10 + 150) / 3);
  });
});

describe("runNetworkTests", () => {
  const host = (overrides: Record<string, unknown> = {}) => ({
    serverId: "box",
    label: "my-desktop",
    connection: {
      type: "directTcp" as const,
      endpoint: "my-desktop:6767",
      display: "my-desktop:6767",
    },
    client: fakeClient(),
    online: true,
    networkDiagnostics: true,
    ...overrides,
  });

  it("walks the whole path when everything answers", async () => {
    const run = await runNetworkTests({
      fetch: fakeFetch(() => false),
      now: clock(),
      isWeb: false,
      probe: fakeProbe(),
      hosts: [host()],
    });
    expect(run.tailscale).toMatchObject({ tunnelUp: true, tailnetAddress: "100.64.0.14" });
    const [result] = run.hosts;
    expect(result?.route).toBe("magicdns");
    expect(result?.resolve?.addresses).toEqual(["100.64.0.10"]);
    expect(result?.machine?.outcome).toBe("connected");
    expect(result?.rtt?.medianMs).toBe(40);
    expect(result?.speed?.downMbps).toBeCloseTo((256 * 1024 * 8) / 1_000_000);
    expect(result?.provider).not.toBeNull();
    expect(result?.verdict).toBe("ok");
  });

  it("says Tailscale is off when the tunnel is down and box is unreachable", async () => {
    const run = await runNetworkTests({
      fetch: fakeFetch(() => false),
      now: clock(),
      isWeb: false,
      probe: fakeProbe({
        listInterfaces: async () => [],
        resolve: async () => {
          throw new Error("nodename nor servname provided");
        },
      }),
      hosts: [host({ online: false })],
    });
    expect(run.hosts[0]?.verdict).toBe("tailscale_off");
  });

  it("tells a sleeping machine from a stopped daemon", async () => {
    const offline = await runNetworkTests({
      fetch: fakeFetch(() => false),
      now: clock(),
      isWeb: false,
      probe: fakeProbe({ tcpConnect: async () => ({ outcome: "timeout", ms: 3000 }) }),
      hosts: [host({ online: false })],
    });
    expect(offline.hosts[0]?.verdict).toBe("machine_offline");
    const stopped = await runNetworkTests({
      fetch: fakeFetch(() => false),
      now: clock(),
      isWeb: false,
      probe: fakeProbe({
        tcpConnect: async (_host, port) => ({
          outcome: port === 22 ? "connected" : "refused",
          ms: 20,
        }),
      }),
      hosts: [host({ online: false })],
    });
    expect(stopped.hosts[0]?.verdict).toBe("daemon_down");
  });

  it("skips the daemon RPCs on an older daemon and still pings", async () => {
    const client = fakeClient({
      runNetworkSpeedTest: vi.fn(),
      runProviderTest: vi.fn(),
    });
    const run = await runNetworkTests({
      fetch: fakeFetch(() => false),
      now: clock(),
      isWeb: false,
      probe: null,
      hosts: [host({ client, networkDiagnostics: false })],
    });
    expect(client.runNetworkSpeedTest).not.toHaveBeenCalled();
    expect(run.hosts[0]?.speed).toBeNull();
    expect(run.hosts[0]?.verdict).toBe("ok");
    expect(run.tailscale.available).toBe(false);
  });
});
