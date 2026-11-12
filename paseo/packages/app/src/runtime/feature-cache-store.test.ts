import { describe, expect, test, vi } from "vitest";
import { CompactV2Decoder } from "@getpaseo/protocol/compact-v2";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));

import { createFeatureCacheRegistry } from "./feature-cache-store";

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

const features = { slimDirectory: true, directorySync: true };
const status = (payload: Record<string, unknown>) => ({
  type: "session",
  message: { type: "status", payload: { status: "server_info", serverId: "srv_a", ...payload } },
});

describe("compact_v2 feature cache", () => {
  test("keeps one map per host and persists it for the next launch", async () => {
    const storage = memoryStorage();
    const first = createFeatureCacheRegistry(storage);
    await first.ready;
    first.cacheFor("srv_a").set({ hash: "h1", features });
    expect(first.cacheFor("srv_b").get()).toBeNull();
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalled());

    const next = createFeatureCacheRegistry(storage);
    await next.ready;
    expect(next.cacheFor("srv_a").get()).toEqual({ hash: "h1", features });
    next.forgetServer("srv_a");
    expect(next.cacheFor("srv_a").get()).toBeNull();
  });

  test("a cold launch restores a hash-only server_info from the stored map", async () => {
    const storage = memoryStorage({
      "@paseo:feature-cache-v1": JSON.stringify({ srv_a: { hash: "h1", features } }),
    });
    const registry = createFeatureCacheRegistry(storage);
    await registry.ready;
    const decoder = new CompactV2Decoder(registry.cacheFor("srv_a"));
    expect(decoder.cachedFeaturesHash()).toBe("h1");
    const decoded = decoder.decode(status({ cv2: 1, fh: "h1" })) as ReturnType<typeof status>;
    expect(decoded.message.payload).toEqual({ status: "server_info", serverId: "srv_a", features });
  });

  test("ignores unreadable storage", async () => {
    const registry = createFeatureCacheRegistry(memoryStorage({ "@paseo:feature-cache-v1": "{nope" }));
    await registry.ready;
    expect(registry.cacheFor("srv_a").get()).toBeNull();
  });
});
