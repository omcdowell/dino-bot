import { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dehydratePersisted } from "./plugin-cache";
import { PluginRegistry } from "./registry";

const audio = { play: async () => 0 };

vi.mock("./navigation", () => ({ createPluginNavigation: () => ({}) }));

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
    return function() { globalThis.__pluginCleanups = (globalThis.__pluginCleanups || 0) + 1; };
  } }; })`;
}

const entry = (clientBundle: string) => ({
  id: "bots",
  clientBundle,
  requirements: { paseo: ">=0.8.0" },
});

function setPersisted(client: QueryClient, data: unknown) {
  client.getQueryCache().build(client, { queryKey: ["bots", "list"], meta: { persist: true } });
  client.setQueryData(["bots", "list"], data);
}

function persistedList(data: unknown) {
  const client = new QueryClient();
  setPersisted(client, data);
  return dehydratePersisted(client);
}

const liveClient = { invokePluginRpc: async () => "live" } as unknown as DaemonClient;
const otherClient = { invokePluginRpc: async () => "other" } as unknown as DaemonClient;
const forwardingClient = { invokePluginRpc: async () => "forwarded" } as unknown as DaemonClient;

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__evaluations");
  Reflect.deleteProperty(globalThis, "__pluginCleanups");
});

describe("PluginRegistry with the plugin cache", () => {
  it("installs a cached catalog before the host answers, with its persisted data", () => {
    const registry = createRegistry();
    expect(registry.hasCatalog("host-a")).toBe(false);
    registry.installCatalog("host-a", [entry(bundle("one"))], {
      client: forwardingClient,
      audio,
      source: "cache",
      queries: new Map([["bots", persistedList({ bots: ["flint"] })]]),
    });
    const [cached] = registry.getSnapshot();
    expect(registry.hasCatalog("host-a")).toBe(true);
    expect(cached?.source).toBe("cache");
    expect(cached?.surfaces.map((surface) => surface.id)).toEqual(["main"]);
    expect(cached?.queryClient.getQueryData(["bots", "list"])).toEqual({ bots: ["flint"] });
  });

  it("keeps the cached install when the live bundle is the same: no second evaluation, then refreshes", async () => {
    const registry = createRegistry();
    registry.installCatalog("host-a", [entry(bundle("one"))], {
      client: forwardingClient,
      audio,
      source: "cache",
      queries: new Map([["bots", persistedList({ bots: ["flint"] })]]),
    });
    const [cached] = registry.getSnapshot();
    const snapshots: number[] = [];
    registry.subscribe(() => snapshots.push(registry.getSnapshot().length));

    registry.installCatalog("host-a", [entry(bundle("one"))], { client: liveClient, audio });

    const [live] = registry.getSnapshot();
    expect(live).toBe(cached);
    expect(live?.source).toBe("live");
    expect(Reflect.get(globalThis, "__evaluations")).toBe(1);
    expect(snapshots.every((count) => count === 1)).toBe(true);
    expect(live?.queryClient.getQueryState(["bots", "list"])?.isInvalidated).toBe(true);
    // Its RPCs now go to the live client.
    await expect(live?.invoke("bots.list", {})).resolves.toBe("live");
  });

  it("replaces a cached install whose bundle changed without a gap, starting from its data", () => {
    const registry = createRegistry();
    registry.installCatalog("host-a", [entry(bundle("one"))], {
      client: forwardingClient,
      audio,
      source: "cache",
      queries: new Map([["bots", persistedList({ bots: ["flint"] })]]),
    });
    const [cached] = registry.getSnapshot();
    const snapshots: number[] = [];
    registry.subscribe(() => snapshots.push(registry.getSnapshot().length));

    registry.installCatalog("host-a", [entry(bundle("two"))], { client: liveClient, audio });

    const [live] = registry.getSnapshot();
    expect(live).not.toBe(cached);
    expect(live?.source).toBe("live");
    expect(snapshots.every((count) => count === 1)).toBe(true);
    expect(live?.queryClient.getQueryData(["bots", "list"])).toEqual({ bots: ["flint"] });
    expect(cached?.lifetime.signal.aborted).toBe(true);
    expect(Reflect.get(globalThis, "__pluginCleanups")).toBe(1);
  });

  it("does not install a cached bundle that fails, and reports no error for it", () => {
    const registry = createRegistry();
    registry.installCatalog("host-a", [entry("(function() { throw new Error('broken'); })")], {
      client: forwardingClient,
      audio,
      source: "cache",
    });
    expect(registry.getSnapshot()).toEqual([]);
    expect(registry.getEvaluationError("host-a", "bots")).toBeUndefined();

    registry.installCatalog("host-a", [entry(bundle("one"))], { client: liveClient, audio });
    expect(registry.getSnapshot().map((plugin) => plugin.source)).toEqual(["live"]);
  });

  it("keeps a live install across a reconnect of the same client, and replaces it for a new client", () => {
    const registry = createRegistry();
    registry.installCatalog("host-a", [entry(bundle("one"))], { client: liveClient, audio });
    const [first] = registry.getSnapshot();
    if (first) setPersisted(first.queryClient, { bots: ["flint"] });

    registry.installCatalog("host-a", [entry(bundle("one"))], { client: liveClient, audio });
    expect(registry.getSnapshot()[0]).toBe(first);

    registry.installCatalog("host-a", [entry(bundle("one"))], { client: otherClient, audio });
    const [second] = registry.getSnapshot();
    expect(second).not.toBe(first);
    expect(second?.queryClient.getQueryData(["bots", "list"])).toEqual({ bots: ["flint"] });
  });
});
