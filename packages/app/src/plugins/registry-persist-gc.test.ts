// @vitest-environment jsdom
/**
 * avatar-reload (Sam 2026-10-12: "if i go away from my phone for a while and open the app, all
 * the bot avatars take a couple of seconds to load back in").
 *
 * Plugin queries marked `meta: { persist: true }` are the plugin's device cache. A plugin query
 * client used TanStack's default gcTime (5 min): once the phone home was off screen (a chat open,
 * which replaces the home) for 5 minutes, its avatar queries were garbage-collected, the device
 * cache was rewritten without them, and the next home (or cold start) fetched every avatar again
 * over the network while showing the fallback icons.
 */
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginCache, dehydratePersisted, type PluginCacheStorage } from "./plugin-cache";
import { PluginRegistry } from "./registry";

vi.mock("./navigation", () => ({ createPluginNavigation: () => ({}) }));

const audio = { play: async () => 0 };
const client = { invokePluginRpc: async () => undefined } as unknown as DaemonClient;
const FIVE_MIN = 5 * 60 * 1000;
const AVATAR_KEY = ["bots", "avatar", "flint", "hash-1"];
const PLAIN_KEY = ["bots", "workers"];

function createRegistry() {
  return new PluginRegistry({
    version: "0.8.0",
    createRuntime: () =>
      ({
        paseo: { dispose: async () => {} },
        rpc: async () => undefined,
        openSurface: () => undefined,
        openPanel: () => undefined,
        addComposerPill: () => ({ update() {}, remove() {} }),
        addHeaderButton: () => ({ update() {}, remove() {} }),
      }) as never,
  });
}

const entry = {
  id: "bots",
  clientBundle: `(function() { return { default: function(plugin) {
    plugin.addSurface("home", function() { return "home"; });
    return function() {};
  } }; })`,
  requirements: { paseo: ">=0.8.0" },
};

function persistedAvatar() {
  const source = new QueryClient();
  source.getQueryCache().build(source, { queryKey: AVATAR_KEY, meta: { persist: true } });
  source.setQueryData(AVATAR_KEY, { dataUri: "data:image/png;base64,AAAA" });
  return dehydratePersisted(source);
}

function memoryStorage(): PluginCacheStorage {
  const items = new Map<string, string>();
  return {
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => void items.set(key, value),
    removeItem: async (key) => void items.delete(key),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("persisted plugin queries are not garbage-collected", () => {
  it("keeps cached avatars hydrated at a cold start while the home is not on screen", () => {
    const registry = createRegistry();
    registry.installCatalog("host-a", [entry], {
      client,
      audio,
      source: "cache",
      queries: new Map([["bots", persistedAvatar()]]),
    });
    const [plugin] = registry.getSnapshot();
    vi.advanceTimersByTime(FIVE_MIN + 1_000);
    expect(plugin?.queryClient.getQueryData(AVATAR_KEY)).toEqual({
      dataUri: "data:image/png;base64,AAAA",
    });
  });

  it("keeps an avatar the home loaded after the home unmounts, and its device copy", async () => {
    const registry = createRegistry();
    registry.installCatalog("host-a", [entry], { client, audio });
    const [plugin] = registry.getSnapshot();
    if (!plugin) throw new Error("not installed");
    const storage = memoryStorage();
    const cache = createPluginCache(storage, { debounceMs: 10 });
    await cache.saveCatalog("host-a", [entry]);
    await cache.track("host-a", [plugin]);

    // The home mounts (one observer per avatar), loads, then a chat replaces it.
    const observer = new QueryObserver(plugin.queryClient, {
      queryKey: AVATAR_KEY,
      queryFn: async () => ({ dataUri: "data:image/png;base64,AAAA" }),
      staleTime: Infinity,
      meta: { persist: true },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();

    await vi.advanceTimersByTimeAsync(FIVE_MIN + 1_000);
    expect(plugin.queryClient.getQueryData(AVATAR_KEY)).toEqual({
      dataUri: "data:image/png;base64,AAAA",
    });
    // What the next cold start installs from.
    const restarted = await createPluginCache(storage).load("host-a");
    expect(restarted?.plugins[0]?.queries?.queries.map((query) => query.queryKey)).toEqual([
      AVATAR_KEY,
    ]);
  });

  it("still collects queries that are not persisted", async () => {
    const registry = createRegistry();
    registry.installCatalog("host-a", [entry], { client, audio });
    const [plugin] = registry.getSnapshot();
    if (!plugin) throw new Error("not installed");
    const observer = new QueryObserver(plugin.queryClient, {
      queryKey: PLAIN_KEY,
      queryFn: async () => ({ workers: 1 }),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(FIVE_MIN + 1_000);
    expect(plugin.queryClient.getQueryCache().find({ queryKey: PLAIN_KEY })).toBeUndefined();
  });
});
