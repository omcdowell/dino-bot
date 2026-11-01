import { describe, expect, it } from "vitest";

import { directEndpointProblem, isLoopbackEndpoint } from "./direct-endpoint-policy";

const tcp = (endpoint: string) => ({
  id: `direct:${endpoint}`,
  type: "directTcp" as const,
  endpoint,
});
const publicBuild = { tailnetOnly: true };

describe("direct endpoint policy (rel-security B1)", () => {
  it("public build: only Tailscale and loopback addresses get a direct socket", () => {
    for (const endpoint of [
      "box.tail1234.ts.net:6767",
      "BOX.TAIL1234.TS.NET:6767",
      "100.64.0.1:6767",
      "100.127.255.254:6767",
      "localhost:6767",
      "127.0.0.1:6767",
      "[::1]:6767",
    ]) {
      expect(directEndpointProblem(tcp(endpoint), publicBuild)).toBeNull();
    }
    for (const endpoint of [
      "192.168.1.23:6767",
      "172.16.0.1:6767",
      "10.1.1.1:6767",
      "box.local:6767",
      "box:6767",
      "100.63.0.1:6767",
      "100.128.0.1:6767",
      "8.8.8.8:6767",
      "ts.net.evil.com:6767",
      "[fd7a:115c:a1e0::1]:6767",
      "[fe80::1]:6767",
    ]) {
      expect(directEndpointProblem(tcp(endpoint), publicBuild)).toMatch(/only through Tailscale/);
    }
  });

  it("own build and non-TCP connections are not limited", () => {
    expect(directEndpointProblem(tcp("192.168.1.23:6767"), { tailnetOnly: false })).toBeNull();
    expect(
      directEndpointProblem(
        { id: "socket", type: "directSocket", path: "/tmp/p.sock" } as never,
        publicBuild,
      ),
    ).toBeNull();
  });

  it("recognises loopback only", () => {
    expect(isLoopbackEndpoint("localhost:6767")).toBe(true);
    expect(isLoopbackEndpoint("127.1.2.3:1")).toBe(true);
    expect(isLoopbackEndpoint("[::1]:6767")).toBe(true);
    expect(isLoopbackEndpoint("localhost.evil.com:6767")).toBe(false);
    expect(isLoopbackEndpoint("128.0.0.1:6767")).toBe(false);
  });
});
