import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginCache, pluginCacheKey, type PluginCacheStorage } from "./plugin-cache";
import {
  createHostClientForwarder,
  restoreCachedPlugins,
  syncLiveCatalog,
} from "./plugin-cache-runtime";
import { PluginRegistry } from "./registry";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("./navigation", () => ({ createPluginNavigation: () => ({}) }));

const audio = { play: async () => 0 };

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

function bundle(marker: string): string {
  return `(function() { return { default: function(plugin) {
    plugin.addSurface("main", function() { return ${JSON.stringify(marker)}; });
    globalThis.__evaluations = (globalThis.__evaluations || 0) + 1;
    return function() {};
  } }; })`;
}

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

type Request = { knownBundles?: Array<{ id: string; hash: string }> } | undefined;

/** A daemon with the bots plugin; `hashes: false` is a daemon from before the plugin cache. */
function fakeDaemon(options: { hashes: boolean; bundle: string }) {
  const requests: Request[] = [];
  const answers: Array<Array<{ id: string; clientBundle: string }>> = [];
  const state = { bundle: options.bundle };
  const client = {
    async getPluginCatalog(request?: Request) {
      requests.push(request);
      const hash = `h${state.bundle.length}-${state.bundle.slice(-40, -20).replace(/\W/g, "")}`;
      const entry = { id: "bots", clientBundle: state.bundle, requirements: { paseo: ">=0.8.0" } };
      let answer: Array<Record<string, unknown>>;
      if (!options.hashes || !request?.knownBundles) answer = [entry];
      else if (request.knownBundles.some((known) => known.id === "bots" && known.hash === hash)) {
        answer = [
          { ...entry, clientBundle: "", clientBundleHash: hash, clientBundleUnchanged: true },
        ];
      } else answer = [{ ...entry, clientBundleHash: hash }];
      answers.push(answer as Array<{ id: string; clientBundle: string }>);
      return answer;
    },
    async invokePluginRpc() {
      return "live";
    },
  } as unknown as DaemonClient;
  return { client, requests, answers, state };
}

const bundleBytes = (answer: Array<{ clientBundle: string }> | undefined) =>
  (answer ?? []).reduce((sum, entry) => sum + entry.clientBundle.length, 0);

async function startApp(input: {
  storage: PluginCacheStorage;
  daemon: ReturnType<typeof fakeDaemon>;
  connect?: boolean;
}) {
  const registry = createRegistry();
  const cache = createPluginCache(input.storage);
  const forwarder = createHostClientForwarder(() => null);
  await restoreCachedPlugins({
    serverId: "host-a",
    client: forwarder,
    audio,
    registry,
    cache,
    isCancelled: () => false,
  });
  const beforeConnect = registry.getSnapshot().map((plugin) => [plugin.id, plugin.source]);
  if (input.connect !== false) {
    await syncLiveCatalog({
      serverId: "host-a",
      client: input.daemon.client,
      audio,
      registry,
      cache,
      isCancelled: () => false,
    });
  }
  return { registry, cache, beforeConnect };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__evaluations");
});

describe("plugin cache at start-up and on connect", () => {
  it("shows the cached plugin before the host answers, and the daemon does not resend its bundle", async () => {
    const { storage } = memoryStorage();
    const daemon = fakeDaemon({ hashes: true, bundle: bundle("one") });

    const first = await startApp({ storage, daemon });
    expect(first.beforeConnect).toEqual([]);
    expect(daemon.requests[0]).toEqual({ knownBundles: [] });
    expect(bundleBytes(daemon.answers[0])).toBe(bundle("one").length);

    Reflect.deleteProperty(globalThis, "__evaluations");
    const second = await startApp({ storage, daemon });
    expect(second.beforeConnect).toEqual([["bots", "cache"]]);
    expect(daemon.requests[1]?.knownBundles).toEqual([{ id: "bots", hash: expect.any(String) }]);
    expect(bundleBytes(daemon.answers[1])).toBe(0);
    const [plugin] = second.registry.getSnapshot();
    expect(plugin?.source).toBe("live");
    expect(Reflect.get(globalThis, "__evaluations")).toBe(1);
    await expect(plugin?.invoke("bots.list", {})).resolves.toBe("live");
  });

  it("installs a changed bundle when the host has a new one", async () => {
    const { storage } = memoryStorage();
    const daemon = fakeDaemon({ hashes: true, bundle: bundle("one") });
    await startApp({ storage, daemon });
    daemon.state.bundle = bundle("two-longer");

    const { registry } = await startApp({ storage, daemon });
    expect(bundleBytes(daemon.answers[1])).toBe(bundle("two-longer").length);
    expect(registry.getSnapshot()[0]?.clientBundle).toBe(bundle("two-longer"));
    const third = await startApp({ storage, daemon, connect: false });
    expect(third.registry.getSnapshot()[0]?.clientBundle).toBe(bundle("two-longer"));
  });

  it("works with a daemon from before the plugin cache: full bundles, cached start-up still shown", async () => {
    const { storage } = memoryStorage();
    const daemon = fakeDaemon({ hashes: false, bundle: bundle("one") });
    await startApp({ storage, daemon });
    const second = await startApp({ storage, daemon });
    expect(second.beforeConnect).toEqual([["bots", "cache"]]);
    expect(daemon.requests[1]).toEqual({ knownBundles: [] });
    expect(bundleBytes(daemon.answers[1])).toBe(bundle("one").length);
    expect(second.registry.getSnapshot().map((plugin) => plugin.source)).toEqual(["live"]);
  });

  it("falls back to the live bundle when the cached one fails to load", async () => {
    const { items, storage } = memoryStorage();
    const daemon = fakeDaemon({ hashes: true, bundle: bundle("one") });
    await startApp({ storage, daemon });
    // The stored bundle is broken, but its hash still claims the current one.
    const key = `${pluginCacheKey("host-a")}:bundle:bots`;
    const stored = JSON.parse(items.get(key) ?? "{}") as { hash: string };
    items.set(
      key,
      JSON.stringify({ hash: stored.hash, clientBundle: "(function() { throw 1; })" }),
    );

    const second = await startApp({ storage, daemon });
    expect(second.beforeConnect).toEqual([]);
    // The broken bundle was forgotten at start-up, so the daemon sends it in full.
    expect(daemon.requests[1]).toEqual({ knownBundles: [] });
    expect(second.registry.getSnapshot().map((plugin) => [plugin.id, plugin.source])).toEqual([
      ["bots", "live"],
    ]);
    expect(second.registry.getEvaluationError("host-a", "bots")).toBeUndefined();
  });

  it("asks again in full when an unchanged bundle is missing or fails to evaluate", async () => {
    const { items, storage } = memoryStorage();
    const daemon = fakeDaemon({ hashes: true, bundle: bundle("one") });
    await startApp({ storage, daemon });
    const key = `${pluginCacheKey("host-a")}:bundle:bots`;
    const stored = JSON.parse(items.get(key) ?? "{}") as { hash: string };
    items.set(
      key,
      JSON.stringify({ hash: stored.hash, clientBundle: "(function() { throw 1; })" }),
    );
    const registry = createRegistry();
    const cache = createPluginCache(storage);
    // Not restored (e.g. the host connected first): the live sync meets the broken bundle.
    await syncLiveCatalog({
      serverId: "host-a",
      client: daemon.client,
      audio,
      registry,
      cache,
      isCancelled: () => false,
    });
    expect(daemon.requests.slice(1).map((request) => request?.knownBundles?.length)).toEqual([
      1, 0,
    ]);
    expect(registry.getSnapshot().map((plugin) => plugin.source)).toEqual(["live"]);
    expect(registry.getEvaluationError("host-a", "bots")).toBeUndefined();
  });

  it("the host forwarder fails calls until the host has a client, then follows it", async () => {
    let current: DaemonClient | null = null;
    const forwarder = createHostClientForwarder(() => current);
    await expect(forwarder.invokePluginRpc("bots", "bots.list", {})).rejects.toThrow(
      "not connected",
    );
    current = fakeDaemon({ hashes: true, bundle: "x" }).client;
    await expect(forwarder.invokePluginRpc("bots", "bots.list", {})).resolves.toBe("live");
  });
});
