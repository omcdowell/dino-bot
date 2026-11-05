import { describe, expect, test } from "vitest";
import { directConnectionsFromOffer, normalizeStoredHostProfile } from "@/types/host-connection";
import { DIRECT_KEY_MISSING_MESSAGE, directTcpE2eeConfig, isLoopbackEndpoint } from "./direct-e2ee";

const KEY = "ZGFlbW9uLXB1YmxpYy1rZXktZm9yLXRlc3RzLTAxMjM0NTY=";

describe("directTcpE2eeConfig", () => {
  test("a pinned key turns on the protected encrypted channel", () => {
    expect(
      directTcpE2eeConfig(
        { endpoint: "100.64.0.7:6767", daemonPublicKeyB64: ` ${KEY} ` },
        { required: true },
      ),
    ).toEqual({
      e2ee: {
        enabled: true,
        daemonPublicKeyB64: KEY,
        minimumMode: "protected",
      },
    });
  });

  test("public flavour: no key to another machine throws before any socket opens", () => {
    expect(() => directTcpE2eeConfig({ endpoint: "100.64.0.7:6767" }, { required: true })).toThrow(
      DIRECT_KEY_MISSING_MESSAGE,
    );
    expect(() =>
      directTcpE2eeConfig({ endpoint: "box.tail1234.ts.net:6767" }, { required: true }),
    ).toThrow(DIRECT_KEY_MISSING_MESSAGE);
  });

  test("loopback without a key stays plaintext (bytes never leave the device)", () => {
    expect(directTcpE2eeConfig({ endpoint: "localhost:6767" }, { required: true })).toEqual({});
    expect(directTcpE2eeConfig({ endpoint: "127.0.0.1:6767" }, { required: true })).toEqual({});
    expect(directTcpE2eeConfig({ endpoint: "[::1]:6767" }, { required: true })).toEqual({});
  });

  test("own flavour keeps upstream behaviour without a key", () => {
    expect(directTcpE2eeConfig({ endpoint: "192.168.1.5:6767" }, { required: false })).toEqual({});
  });

  test("isLoopbackEndpoint", () => {
    expect(isLoopbackEndpoint("app.localhost:6767")).toBe(true);
    expect(isLoopbackEndpoint("127.8.9.10:1")).toBe(true);
    expect(isLoopbackEndpoint("127.example.com:1")).toBe(false);
    expect(isLoopbackEndpoint("100.64.0.1:6767")).toBe(false);
  });
});

describe("direct connections carry the daemon key", () => {
  const offer = {
    v: 3 as const,
    serverId: "srv_e2ee",
    daemonPublicKeyB64: KEY,
    endpoints: ["box.tail1234.ts.net:6767", "100.64.0.7:6767"],
  };

  test("from the pairing offer", () => {
    expect(directConnectionsFromOffer(offer).map((c) => c.daemonPublicKeyB64)).toEqual([KEY, KEY]);
  });

  test("through storage", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_e2ee",
      connections: directConnectionsFromOffer(offer),
    });
    expect(profile?.connections).toEqual(directConnectionsFromOffer(offer));
  });

  test("a stored connection without a key stays keyless (no silent pin)", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_old",
      connections: [{ type: "directTcp", endpoint: "100.64.0.7:6767" }],
    });
    expect(profile?.connections[0]).not.toHaveProperty("daemonPublicKeyB64");
  });
});
