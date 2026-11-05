import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AudioEngine } from "@/audio";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPluginCache, type CatalogPlugin, type PluginCache } from "./plugin-cache";
import type { PluginRegistry } from "./registry";

export const pluginCache = createPluginCache(AsyncStorage);

/** `paseo:plugins:*` performance marks: start-up timing of plugin UI (measure/plugin-start.mjs). */
export function markPlugins(name: string, detail?: Record<string, number>): void {
  try {
    globalThis.performance?.mark?.(`paseo:plugins:${name}`, detail ? { detail } : undefined);
  } catch {
    // marks are diagnostics only
  }
}

const notConnected = () => Promise.reject(new Error("The host is not connected yet."));

/**
 * A daemon client for cached installs: every call goes to the host's current client, so a cached
 * install keeps working when the host connects (or reconnects on another client). Until there is
 * a client, calls fail with "not connected".
 */
export function createHostClientForwarder(getClient: () => DaemonClient | null): DaemonClient {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined;
        const client = getClient();
        if (!client) return notConnected;
        const value: unknown = Reflect.get(client, property, client);
        return typeof value === "function" ? value.bind(client) : value;
      },
    },
  ) as DaemonClient;
}

/**
 * Installs the host's cached plugins when nothing is installed for it yet (start-up, before the
 * host answers). A cached bundle that fails to evaluate is forgotten, so the live catalog sends it.
 */
export async function restoreCachedPlugins(input: {
  serverId: string;
  client: DaemonClient;
  audio: Pick<AudioEngine, "play">;
  registry: PluginRegistry;
  cache?: Pick<PluginCache, "load" | "forget">;
  isCancelled: () => boolean;
}): Promise<boolean> {
  const cache = input.cache ?? pluginCache;
  markPlugins("cache-read-start");
  const cached = await cache.load(input.serverId);
  markPlugins("cache-read");
  if (!cached || input.isCancelled() || input.registry.hasCatalog(input.serverId)) return false;
  input.registry.installCatalog(
    input.serverId,
    cached.plugins.map((plugin) => plugin.entry),
    {
      client: input.client,
      audio: input.audio,
      source: "cache",
      queries: new Map(
        cached.plugins.flatMap((plugin) =>
          plugin.queries ? [[plugin.entry.id, plugin.queries]] : [],
        ),
      ),
    },
  );
  const installed = new Set(
    input.registry
      .getSnapshot()
      .filter((plugin) => plugin.serverId === input.serverId)
      .map((plugin) => plugin.id),
  );
  for (const plugin of cached.plugins) {
    if (plugin.entry.clientBundle && !installed.has(plugin.entry.id)) {
      void cache.forget(input.serverId, plugin.entry.id);
    }
  }
  markPlugins("cache-installed");
  return true;
}

async function fetchCatalog(
  serverId: string,
  client: DaemonClient,
  cache: Pick<PluginCache, "knownBundles" | "resolve">,
): Promise<{ catalog: CatalogPlugin[]; fromCache: string[] }> {
  const answer = await client.getPluginCatalog({ knownBundles: cache.knownBundles(serverId) });
  const resolved = cache.resolve(serverId, answer);
  if (resolved.missing.length === 0) {
    const fromCache = answer
      .filter((entry) => entry.clientBundleUnchanged)
      .map((entry) => entry.id);
    markCatalog(answer);
    return { catalog: resolved.catalog, fromCache };
  }
  // The daemon called a bundle unchanged that the app no longer has: ask for everything.
  const full = await client.getPluginCatalog({ knownBundles: [] });
  markCatalog(full);
  return { catalog: cache.resolve(serverId, full).catalog, fromCache: [] };
}

/** What the daemon sent: bundle characters received and bundles it called unchanged. */
function markCatalog(answer: readonly CatalogPlugin[]): void {
  markPlugins("catalog-response", {
    bundleChars: answer.reduce((sum, entry) => sum + entry.clientBundle.length, 0),
    unchanged: answer.filter((entry) => entry.clientBundleUnchanged).length,
  });
}

/**
 * One live catalog sync: asks the daemon with the bundle hashes the app has, fills unchanged
 * bundles from the cache, installs, then keeps the catalog and the plugins' persisted queries.
 * An unchanged bundle that fails to evaluate is forgotten and fetched again in full, once.
 */
export async function syncLiveCatalog(input: {
  serverId: string;
  client: DaemonClient;
  audio: Pick<AudioEngine, "play">;
  registry: PluginRegistry;
  replacePluginId?: string;
  cache?: PluginCache;
  isCancelled: () => boolean;
}): Promise<void> {
  const { serverId, client, registry } = input;
  const cache = input.cache ?? pluginCache;
  await cache.load(serverId);
  markPlugins("catalog-request");
  let { catalog, fromCache } = await fetchCatalog(serverId, client, cache);
  if (input.isCancelled()) return;
  const install = () =>
    registry.installCatalog(serverId, catalog, {
      replacePluginId: input.replacePluginId,
      client,
      audio: input.audio,
    });
  install();
  const failed = fromCache.filter((id) => registry.getEvaluationError(serverId, id) !== undefined);
  if (failed.length > 0) {
    await Promise.all(failed.map((id) => cache.forget(serverId, id)));
    ({ catalog } = await fetchCatalog(serverId, client, cache));
    if (input.isCancelled()) return;
    install();
  }
  markPlugins("live-installed");
  await cache.saveCatalog(serverId, catalog);
  await cache.track(
    serverId,
    registry
      .getSnapshot()
      .filter((plugin) => plugin.serverId === serverId && plugin.source !== "cache"),
  );
}
