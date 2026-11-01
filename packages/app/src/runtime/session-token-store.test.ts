import { describe, expect, test, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));

import { createSessionTokenRegistry } from "./session-token-store";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: vi.fn(async (key: string) => items.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
  };
}

describe("session token registry", () => {
  test("keeps one token per host connection and shares it between stores for it", async () => {
    const storage = memoryStorage();
    const registry = createSessionTokenRegistry(storage);
    await registry.ready;
    const main = registry.storeFor({ serverId: "srv_a", connectionId: "direct" });
    const probe = registry.storeFor({ serverId: "srv_a", connectionId: "direct" });
    const relay = registry.storeFor({ serverId: "srv_a", connectionId: "relay" });
    main.set("pst1.a.b");
    expect(probe.get()).toBe("pst1.a.b");
    expect(relay.get()).toBeNull();
    probe.set(null);
    expect(main.get()).toBeNull();
  });

  test("persists tokens and loads them on the next launch", async () => {
    const storage = memoryStorage();
    const first = createSessionTokenRegistry(storage);
    await first.ready;
    first.storeFor({ serverId: "srv_a", connectionId: "direct" }).set("pst1.a.b");
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalled());

    const relaunched = createSessionTokenRegistry(storage);
    await relaunched.ready;
    expect(relaunched.storeFor({ serverId: "srv_a", connectionId: "direct" }).get()).toBe(
      "pst1.a.b",
    );
  });

  test("forgets every token of a removed host", async () => {
    const storage = memoryStorage();
    const registry = createSessionTokenRegistry(storage);
    await registry.ready;
    registry.storeFor({ serverId: "srv_a", connectionId: "direct" }).set("pst1.a.b");
    registry.storeFor({ serverId: "srv_b", connectionId: "direct" }).set("pst1.c.d");
    registry.forgetServer("srv_a");
    expect(registry.storeFor({ serverId: "srv_a", connectionId: "direct" }).get()).toBeNull();
    expect(registry.storeFor({ serverId: "srv_b", connectionId: "direct" }).get()).toBe("pst1.c.d");
    await vi.waitFor(() =>
      expect(JSON.parse(storage.items.get("@paseo:session-tokens-v1") ?? "{}")).toEqual({
        [JSON.stringify(["srv_b", "direct"])]: { token: "pst1.c.d" },
      }),
    );
  });

  test("ignores unreadable stored data", async () => {
    const storage = memoryStorage({ "@paseo:session-tokens-v1": "{not json" });
    const registry = createSessionTokenRegistry(storage);
    await registry.ready;
    expect(registry.storeFor({ serverId: "srv_a", connectionId: "direct" }).get()).toBeNull();
  });
});
