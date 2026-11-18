import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createPluginCache, pluginCacheKey, type PluginCacheStorage } from "./plugin-cache";

function memoryStorage() {
  const items = new Map<string, string>();
  const storage: PluginCacheStorage = {
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value);
    },
    removeItem: async (key) => {
      items.delete(key);
    },
  };
  return { items, storage };
}

const bots = { id: "bots", clientBundle: "bots-bundle-1", clientBundleHash: "h1" };
const apns = { id: "apns", clientBundle: "apns-bundle", clientBundleHash: "a1" };

function trackedPlugin(id: string) {
  return { id, queryClient: new QueryClient(), lifetime: new AbortController() };
}

describe("plugin cache", () => {
  it("keeps a live catalog's bundles and gives them back, with their hashes, after a restart", async () => {
    const { storage } = memoryStorage();
    await createPluginCache(storage).saveCatalog("host-a", [
      bots,
      { ...apns, requirements: { paseo: ">=0.8.0" } },
    ]);

    const restarted = createPluginCache(storage);
    const cached = await restarted.load("host-a");
    expect(cached?.plugins.map((plugin) => plugin.entry)).toEqual([
      bots,
      { ...apns, requirements: { paseo: ">=0.8.0" } },
    ]);
    expect(restarted.knownBundles("host-a")).toEqual([
      { id: "bots", hash: "h1" },
      { id: "apns", hash: "a1" },
    ]);
    expect(await restarted.load("host-b")).toBeNull();
    expect(restarted.knownBundles("host-b")).toEqual([]);
  });

  it("fills unchanged entries from the bundles it has, and reports the ones it lost", async () => {
    const { storage } = memoryStorage();
    const cache = createPluginCache(storage);
    await cache.saveCatalog("host-a", [bots]);

    const answer = [
      { id: "bots", clientBundle: "", clientBundleHash: "h1", clientBundleUnchanged: true },
      { id: "apns", clientBundle: "", clientBundleHash: "a1", clientBundleUnchanged: true },
      { id: "new", clientBundle: "new-bundle", clientBundleHash: "n1" },
    ];
    expect(cache.resolve("host-a", answer)).toEqual({
      catalog: [
        { id: "bots", clientBundle: "bots-bundle-1", clientBundleHash: "h1" },
        answer[1],
        answer[2],
      ],
      missing: ["apns"],
    });
  });

  it("rewrites a bundle only when it changes; a missing plugin is kept, then dropped after the grace period", async () => {
    const { items, storage } = memoryStorage();
    const cache = createPluginCache(storage);
    await cache.saveCatalog("host-a", [bots, apns]);
    items.set(`${pluginCacheKey("host-a")}:queries:apns`, '{"queries":[],"mutations":[]}');
    const writes: string[] = [];
    const counting: PluginCacheStorage = {
      ...storage,
      setItem: async (key, value) => {
        writes.push(key);
        await storage.setItem(key, value);
      },
    };
    let clock = 1_000;
    const sameCache = createPluginCache(counting, { now: () => clock, absentGraceMs: 500 });
    await sameCache.load("host-a");
    await sameCache.saveCatalog("host-a", [bots]);
    expect(writes).toEqual([pluginCacheKey("host-a")]);
    // apns is missing, not removed: its bundle and queries stay, and its hash is still sent.
    expect(items.has(`${pluginCacheKey("host-a")}:bundle:apns`)).toBe(true);
    expect(items.has(`${pluginCacheKey("host-a")}:queries:apns`)).toBe(true);
    expect(sameCache.knownBundles("host-a")).toEqual([
      { id: "bots", hash: "h1" },
      { id: "apns", hash: "a1" },
    ]);
    expect(JSON.parse(items.get(pluginCacheKey("host-a")) ?? "{}").absent).toEqual([
      { id: "apns", hash: "a1", since: 1_000 },
    ]);

    clock = 1_400;
    await sameCache.saveCatalog("host-a", [
      { ...bots, clientBundle: "bots-bundle-2", clientBundleHash: "h2" },
    ]);
    expect(writes.slice(1)).toEqual([
      `${pluginCacheKey("host-a")}:bundle:bots`,
      pluginCacheKey("host-a"),
    ]);
    expect(items.has(`${pluginCacheKey("host-a")}:bundle:apns`)).toBe(true);

    clock = 1_500;
    await sameCache.saveCatalog("host-a", [
      { ...bots, clientBundle: "bots-bundle-2", clientBundleHash: "h2" },
    ]);
    expect([...items.keys()].some((key) => key.includes(":apns"))).toBe(false);
    expect(sameCache.knownBundles("host-a")).toEqual([{ id: "bots", hash: "h2" }]);
    expect(JSON.parse(items.get(pluginCacheKey("host-a")) ?? "{}").absent).toBeUndefined();
  });

  it("an absent plugin's bundle and queries survive a restart, and its return clears its absence", async () => {
    const { items, storage } = memoryStorage();
    await createPluginCache(storage).saveCatalog("host-a", [bots, apns]);
    const stored = { queries: [{ queryKey: ["x"], state: { data: 1 } }], mutations: [] };
    items.set(`${pluginCacheKey("host-a")}:queries:apns`, JSON.stringify(stored));
    let clock = 1_000;
    const missing = createPluginCache(storage, { now: () => clock });
    await missing.load("host-a");
    await missing.saveCatalog("host-a", [bots]);

    const restarted = createPluginCache(storage, { now: () => clock });
    const cached = await restarted.load("host-a");
    expect(cached?.plugins.map((plugin) => plugin.entry.id)).toEqual(["bots"]);
    expect(restarted.knownBundles("host-a")).toEqual([
      { id: "bots", hash: "h1" },
      { id: "apns", hash: "a1" },
    ]);
    expect(restarted.parkedQueries("host-a").get("apns")).toEqual(stored);

    clock = 2_000;
    const back = restarted.resolve("host-a", [
      bots,
      { id: "apns", clientBundle: "", clientBundleHash: "a1", clientBundleUnchanged: true },
    ]);
    expect(back.missing).toEqual([]);
    await restarted.saveCatalog("host-a", back.catalog);
    expect(restarted.parkedQueries("host-a").size).toBe(0);
    const index = JSON.parse(items.get(pluginCacheKey("host-a")) ?? "{}");
    expect(index.absent).toBeUndefined();
    expect(index.plugins.map((plugin: { id: string }) => plugin.id)).toEqual(["bots", "apns"]);
  });

  it("caches bundles from daemons without hashes for start-up, but never claims to know them", async () => {
    const { storage } = memoryStorage();
    await createPluginCache(storage).saveCatalog("host-a", [{ id: "bots", clientBundle: "old" }]);
    const restarted = createPluginCache(storage);
    expect((await restarted.load("host-a"))?.plugins[0]?.entry).toEqual({
      id: "bots",
      clientBundle: "old",
    });
    expect(restarted.knownBundles("host-a")).toEqual([]);
  });

  it("forgets a bundle that failed, so the next request asks for it in full", async () => {
    const { storage } = memoryStorage();
    const cache = createPluginCache(storage);
    await cache.saveCatalog("host-a", [bots, apns]);
    await cache.forget("host-a", "bots");
    expect(cache.knownBundles("host-a")).toEqual([{ id: "apns", hash: "a1" }]);
    const restarted = createPluginCache(storage);
    expect((await restarted.load("host-a"))?.plugins.map((plugin) => plugin.entry.id)).toEqual([
      "apns",
    ]);
  });

  it("ignores unreadable or mismatched storage", async () => {
    const { items, storage } = memoryStorage();
    items.set(pluginCacheKey("host-a"), "{not json");
    expect(await createPluginCache(storage).load("host-a")).toBeNull();
    await createPluginCache(storage).saveCatalog("host-a", [bots]);
    // An interrupted save: the bundle on disk is from another catalog.
    items.set(
      `${pluginCacheKey("host-a")}:bundle:bots`,
      JSON.stringify({ hash: "other", clientBundle: "x" }),
    );
    expect(await createPluginCache(storage).load("host-a")).toBeNull();
  });

  it("keeps only queries marked persist, debounced, and gives them back after a restart", async () => {
    const { storage } = memoryStorage();
    const cache = createPluginCache(storage, { debounceMs: 10 });
    await cache.saveCatalog("host-a", [bots]);
    const plugin = trackedPlugin("bots");
    await plugin.queryClient.fetchQuery({
      queryKey: ["bots", "list"],
      queryFn: async () => ({ bots: [{ id: "flint" }] }),
      meta: { persist: true },
    });
    await plugin.queryClient.fetchQuery({
      queryKey: ["bots", "workers"],
      queryFn: async () => ({ workers: 3 }),
    });
    await cache.track("host-a", [plugin]);

    const first = await createPluginCache(storage).load("host-a");
    const queries = first?.plugins[0]?.queries?.queries ?? [];
    expect(queries.map((query) => query.queryKey)).toEqual([["bots", "list"]]);
    expect(queries[0]?.state.data).toEqual({ bots: [{ id: "flint" }] });

    plugin.queryClient.setQueryData(["bots", "list"], { bots: [{ id: "flint" }, { id: "scrat" }] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = await createPluginCache(storage).load("host-a");
    expect(second?.plugins[0]?.queries?.queries[0]?.state.data).toEqual({
      bots: [{ id: "flint" }, { id: "scrat" }],
    });

    plugin.lifetime.abort();
    plugin.queryClient.setQueryData(["bots", "list"], { bots: [] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterTeardown = await createPluginCache(storage).load("host-a");
    expect(afterTeardown?.plugins[0]?.queries?.queries[0]?.state.data).toEqual({
      bots: [{ id: "flint" }, { id: "scrat" }],
    });
  });

  it("over the size limit drops the largest queries first and keeps the rest", async () => {
    const { storage } = memoryStorage();
    const cache = createPluginCache(storage, { maxQueryBytes: 1_500 });
    await cache.saveCatalog("host-a", [bots]);
    const plugin = trackedPlugin("bots");
    for (const [key, data] of [
      [["bots", "list"], { bots: ["flint"] }],
      [["bots", "avatar", "flint"], "a".repeat(150)],
      [["bots", "avatar", "huge"], "h".repeat(2_000)],
    ] as const) {
      await plugin.queryClient.fetchQuery({
        queryKey: [...key],
        queryFn: async () => data,
        meta: { persist: true },
      });
    }
    await cache.track("host-a", [plugin]);
    const kept = await createPluginCache(storage).load("host-a");
    expect(kept?.plugins[0]?.queries?.queries.map((query) => query.queryKey)).toEqual([
      ["bots", "list"],
      ["bots", "avatar", "flint"],
    ]);
  });

  it("does not keep queries over the size limit", async () => {
    const { items, storage } = memoryStorage();
    const cache = createPluginCache(storage, { maxQueryBytes: 100 });
    await cache.saveCatalog("host-a", [bots]);
    const plugin = trackedPlugin("bots");
    await plugin.queryClient.fetchQuery({
      queryKey: ["big"],
      queryFn: async () => "x".repeat(200),
      meta: { persist: true },
    });
    await cache.track("host-a", [plugin]);
    expect([...items.keys()].some((key) => key.includes(":queries:"))).toBe(false);
  });
});
