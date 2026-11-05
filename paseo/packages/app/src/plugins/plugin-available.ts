/**
 * Whether a host runs a given plugin, before the app calls one of its RPCs.
 *
 * Push registration and the Live Activity sync call the push plugin (id "apns") on every
 * connect. A host without it (the public tarball before paseo-apns is bundled, or any plain
 * Paseo host) answered each call with "Plugin is not available: apns" in its log (rel-demo bug 8).
 * Asking the daemon's plugin list first keeps those calls off such hosts.
 *
 * The list is cached per client for a short time so one connect does not list twice. If the
 * list cannot be read (offline, an old daemon, a client without listPlugins) the answer is
 * "unknown" and callers fall back to trying the call, as before.
 */

export interface PluginListClient {
  listPlugins?: () => Promise<ReadonlyArray<{ id: string; status: string }>>;
}

export const PLUGIN_LIST_TTL_MS = 30_000;

interface CacheEntry {
  at: number;
  running: Promise<ReadonlySet<string> | null>;
}

const cache = new WeakMap<object, CacheEntry>();

export async function pluginAvailable(
  client: PluginListClient,
  pluginId: string,
  now: () => number = Date.now,
): Promise<boolean> {
  if (typeof client.listPlugins !== "function") return true;
  let entry = cache.get(client);
  if (!entry || now() - entry.at > PLUGIN_LIST_TTL_MS) {
    const list = client.listPlugins();
    entry = {
      at: now(),
      running: list
        .then((plugins) => new Set(plugins.filter((p) => p.status === "running").map((p) => p.id)))
        .catch(() => null),
    };
    cache.set(client, entry);
  }
  const running = await entry.running;
  if (running === null) {
    cache.delete(client);
    return true;
  }
  return running.has(pluginId);
}

/** Drop the cached list (tests; or after a plugin is installed from the app). */
export function forgetPluginList(client: object): void {
  cache.delete(client);
}
