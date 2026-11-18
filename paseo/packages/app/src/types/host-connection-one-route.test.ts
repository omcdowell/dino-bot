// IO1 one route per host: a phone paired before the fix holds the MagicDNS name and the tailnet IP
// for one daemon and switched between them under load (new client each time, bots screen remount,
// lost dictation). The app keeps the tailnet IP and drops the name beside it.
import { describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import {
  directConnectionsFromOffer,
  dropShadowedMagicDnsConnections,
  normalizeStoredHostProfile,
  upsertHostConnectionInProfiles,
  type DirectTcpHostConnection,
  type HostConnection,
  type HostProfile,
} from "./host-connection";

const NAME = "box.example-tailnet.ts.net:6767";
const IP = "100.64.0.7:6767";

function direct(endpoint: string): DirectTcpHostConnection {
  return { id: `direct:${endpoint}`, type: "directTcp", endpoint, useTls: false };
}

function host(connections: HostConnection[], preferredConnectionId: string | null): HostProfile {
  return {
    serverId: "srv_box",
    label: "box",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("dropShadowedMagicDnsConnections", () => {
  it("drops the MagicDNS name when the tailnet IP on the same port is there", () => {
    expect(dropShadowedMagicDnsConnections([direct(NAME), direct(IP)])).toEqual([direct(IP)]);
    expect(dropShadowedMagicDnsConnections([direct(IP), direct(NAME)])).toEqual([direct(IP)]);
  });

  it("keeps a lone name, a name on another port and non-direct connections", () => {
    const lone = [direct(NAME)];
    expect(dropShadowedMagicDnsConnections(lone)).toBe(lone);
    const otherPort = [direct("box.tail1.ts.net:6768"), direct(IP)];
    expect(dropShadowedMagicDnsConnections(otherPort)).toEqual(otherPort);
    const lan = [direct(NAME), direct("192.168.1.20:6767")];
    expect(dropShadowedMagicDnsConnections(lan)).toEqual(lan);
    const socket: HostConnection = {
      id: "socket:/tmp/p.sock",
      type: "directSocket",
      path: "/tmp/p.sock",
    };
    expect(dropShadowedMagicDnsConnections([socket, direct(NAME), direct(IP)])).toEqual([
      socket,
      direct(IP),
    ]);
  });
});

describe("one route per host", () => {
  it("a stored host with both routes loads with the IP only, preferred moved off the name", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_box",
      label: "box",
      connections: [
        { id: `direct:${NAME}`, type: "directTcp", endpoint: NAME, daemonPublicKeyB64: "key" },
        { id: `direct:${IP}`, type: "directTcp", endpoint: IP, daemonPublicKeyB64: "key" },
      ],
      preferredConnectionId: `direct:${NAME}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(profile?.connections.map((c) => c.id)).toEqual([`direct:${IP}`]);
    expect(profile?.preferredConnectionId).toBe(`direct:${IP}`);
  });

  it("an old pairing code with both addresses gives the IP only", () => {
    const connections = directConnectionsFromOffer({
      v: 3,
      serverId: "srv_box",
      daemonPublicKeyB64: "key",
      endpoints: [NAME, IP],
    });
    expect(connections.map((c) => c.endpoint)).toEqual([IP]);
  });

  it("upserting the name next to the IP does not add it back", () => {
    const [profile] = upsertHostConnectionInProfiles({
      profiles: [host([direct(IP)], `direct:${IP}`)],
      serverId: "srv_box",
      connection: direct(NAME),
    });
    expect(profile!.connections).toEqual([direct(IP)]);
    expect(profile!.preferredConnectionId).toBe(`direct:${IP}`);
  });

  it("upserting the IP next to a stored name replaces the name", () => {
    const [profile] = upsertHostConnectionInProfiles({
      profiles: [host([direct(NAME)], `direct:${NAME}`)],
      serverId: "srv_box",
      connection: direct(IP),
    });
    expect(profile!.connections).toEqual([direct(IP)]);
    expect(profile!.preferredConnectionId).toBe(`direct:${IP}`);
  });
});
