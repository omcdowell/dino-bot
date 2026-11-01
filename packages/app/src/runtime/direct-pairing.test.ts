import { describe, expect, it } from "vitest";

import { directConnectionsFromOffer } from "@/types/host-connection";

import { raceDirectEndpoints } from "./direct-pairing";

const offer = {
  v: 3 as const,
  serverId: "srv",
  daemonPublicKeyB64: "key",
  endpoints: ["box.ts.net:6767", "100.64.0.7:6767", "box.ts.net:6767", "192.168.1.20:6767"],
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("direct (v3) pairing", () => {
  it("turns offer endpoints into direct connections in order, without duplicates", () => {
    expect(directConnectionsFromOffer(offer).map((c) => c.id)).toEqual([
      "direct:box.ts.net:6767",
      "direct:100.64.0.7:6767",
      "direct:192.168.1.20:6767",
    ]);
  });

  it("keeps the first endpoint that answers as the offered server and closes the rest", async () => {
    const closed: string[] = [];
    const delays: Record<string, number> = {
      "box.ts.net:6767": 30,
      "100.64.0.7:6767": 5,
      "192.168.1.20:6767": 10,
    };
    const won = await raceDirectEndpoints({
      serverId: "srv",
      connections: directConnectionsFromOffer(offer),
      probe: async (c) => {
        await wait(delays[c.endpoint] ?? 0);
        return { client: c.endpoint, serverId: "srv", hostname: "box" };
      },
      close: (client) => {
        closed.push(client);
      },
    });
    expect(won.connection.endpoint).toBe("100.64.0.7:6767");
    await wait(40);
    expect(closed.sort()).toEqual(["192.168.1.20:6767", "box.ts.net:6767"]);
  });

  it("ignores an endpoint that answers as another server", async () => {
    const won = await raceDirectEndpoints({
      serverId: "srv",
      connections: directConnectionsFromOffer(offer),
      probe: async (c) => {
        if (c.endpoint === "100.64.0.7:6767")
          return { client: c.endpoint, serverId: "other", hostname: null };
        await wait(10);
        if (c.endpoint === "box.ts.net:6767") throw new Error("ENOTFOUND");
        return { client: c.endpoint, serverId: "srv", hostname: "box" };
      },
      close: () => undefined,
    });
    expect(won.connection.endpoint).toBe("192.168.1.20:6767");
  });

  it("fails with the last error when nothing answers", async () => {
    await expect(
      raceDirectEndpoints({
        serverId: "srv",
        connections: directConnectionsFromOffer(offer),
        probe: async () => {
          throw new Error("unreachable");
        },
        close: () => undefined,
      }),
    ).rejects.toThrow("unreachable");
  });
});
