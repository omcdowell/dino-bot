/**
 * Plugin cache (2026-10-11: "on the desktop app, i have to wait for the plugin to load").
 *
 * Per host, the app keeps each plugin's last client bundle (with the hash the daemon gave it) and
 * the plugin queries that opt in with `meta: { persist: true }`. At start the app installs them
 * before the host connects, so plugin UI (bots sidebar, phone home) shows the last known state at
 * once; the live catalog then confirms or replaces them. On connect the app sends the hashes it
 * has, and a current daemon resends only bundles that changed (pluginBundleCache).
 *
 * Storage keys, all under `paseo:plugin-cache:v1:<serverId>`:
 * - `…`                    the host's catalog: plugin ids, bundle hashes and requirements;
 * - `…:bundle:<pluginId>`  `{ hash, clientBundle }`, rewritten only when the bundle changes;
 * - `…:queries:<pluginId>` the plugin's persisted queries (TanStack dehydrated state), debounced.
 */
import {
  dehydrate,
  QueryClient,
  type DefaultedQueryObserverOptions,
  type DefaultError,
  type DehydratedState,
  type Query,
  type QueryKey,
  type QueryObserverOptions,
} from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";

export type CatalogPlugin = Awaited<ReturnType<DaemonClient["getPluginCatalog"]>>[number];

export interface CachedPlugin {
  entry: CatalogPlugin;
  /** Persisted queries to start from; null when none were kept. */
  queries: DehydratedState | null;
}

export interface CachedHost {
  serverId: string;
  savedAt: number;
  plugins: CachedPlugin[];
}

export interface PluginCacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface TrackedPlugin {
  id: string;
  queryClient: QueryClient;
  lifetime: AbortController;
}

const PREFIX = "paseo:plugin-cache:v1";
export const pluginCacheKey = (serverId: string) => `${PREFIX}:${serverId}`;
const bundleKey = (serverId: string, pluginId: string) =>
  `${pluginCacheKey(serverId)}:bundle:${pluginId}`;
const queriesKey = (serverId: string, pluginId: string) =>
  `${pluginCacheKey(serverId)}:queries:${pluginId}`;
/** Where a plugin's persisted queries are kept (read by the Live Activity for the bots' avatars). */
export const pluginQueriesKey = queriesKey;

const IndexSchema = z.object({
  version: z.literal(1),
  serverId: z.string(),
  savedAt: z.number(),
  plugins: z.array(
    z.object({
      id: z.string(),
      hash: z.string().nullable(),
      requirements: z.object({ paseo: z.string().optional() }).optional(),
    }),
  ),
});
type CacheIndex = z.infer<typeof IndexSchema>;

const BundleSchema = z.object({ hash: z.string().nullable(), clientBundle: z.string().min(1) });
const DehydratedSchema = z.object({
  queries: z.array(z.unknown()),
  mutations: z.array(z.unknown()),
});

/** Plugin queries opt in with `meta: { persist: true }`; only successful data is kept. */
export function shouldPersistQuery(query: Pick<Query, "meta" | "state">): boolean {
  return query.meta?.persist === true && query.state.status === "success";
}

/**
 * A plugin's query client. Persisted queries are the plugin's device cache, so they are never
 * garbage-collected (unless the plugin sets its own `gcTime`): with TanStack's default 5 min, a
 * screen left off for 5 minutes (the phone home while a chat is open) lost its data, the device
 * copy was rewritten without it, and the next visit or cold start fetched it again (avatar-reload,
 * 2026-10-12). Other queries keep the default.
 */
class PluginQueryClient extends QueryClient {
  override defaultQueryOptions<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
    TPageParam = never,
  >(
    options:
      | QueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey, TPageParam>
      | DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>,
  ): DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey> {
    if (options._defaulted)
      return options as DefaultedQueryObserverOptions<
        TQueryFnData,
        TError,
        TData,
        TQueryData,
        TQueryKey
      >;
    const defaulted = super.defaultQueryOptions(options);
    if (defaulted.meta?.persist === true && defaulted.gcTime === undefined) {
      defaulted.gcTime = Infinity;
    }
    return defaulted;
  }
}

export function createPluginQueryClient(): QueryClient {
  return new PluginQueryClient();
}

export function dehydratePersisted(client: QueryClient): DehydratedState {
  return dehydrate(client, {
    shouldDehydrateQuery: shouldPersistQuery,
    shouldDehydrateMutation: () => false,
  });
}

/**
 * The persisted queries trimmed to `maxBytes` of JSON: the largest go first, so one big entry
 * (a bot avatar is up to 512 KB) does not cost the plugin its whole device cache.
 */
function withinLimit(state: DehydratedState, maxBytes: number): DehydratedState {
  if (JSON.stringify(state).length <= maxBytes) return state;
  const sized = state.queries.map((query) => ({ query, size: JSON.stringify(query).length }));
  const dropped = new Set<(typeof sized)[number]["query"]>();
  let total = JSON.stringify({ ...state, queries: [] }).length + sized.length;
  for (const { size } of sized) total += size;
  for (const entry of [...sized].sort((a, b) => b.size - a.size)) {
    if (total <= maxBytes) break;
    dropped.add(entry.query);
    total -= entry.size + 1;
  }
  return { ...state, queries: state.queries.filter((query) => !dropped.has(query)) };
}

function parseJson<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

interface KnownBundle {
  hash: string | null;
  clientBundle: string;
}

export function createPluginCache(
  storage: PluginCacheStorage,
  options: { debounceMs?: number; now?: () => number; maxQueryBytes?: number } = {},
) {
  const debounceMs = options.debounceMs ?? 2_000;
  const now = options.now ?? Date.now;
  const maxQueryBytes = options.maxQueryBytes ?? 1_000_000;
  /** Bundles the app has per host (from storage, then from live catalogs), by plugin id. */
  const bundles = new Map<string, Map<string, KnownBundle>>();
  const loads = new Map<string, Promise<CachedHost | null>>();
  const writtenQueries = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const tracked = new Map<string, Map<string, TrackedPlugin>>();

  const hostBundles = (serverId: string) => {
    let byId = bundles.get(serverId);
    if (!byId) {
      byId = new Map();
      bundles.set(serverId, byId);
    }
    return byId;
  };
  const quietly = (work: Promise<unknown>) => work.then(() => undefined).catch(() => undefined);

  async function read(serverId: string): Promise<CachedHost | null> {
    const index = parseJson(await storage.getItem(pluginCacheKey(serverId)), IndexSchema);
    if (!index || index.serverId !== serverId) return null;
    const plugins = await Promise.all(
      index.plugins.map(async (plugin): Promise<CachedPlugin | null> => {
        const [rawBundle, rawQueries] = await Promise.all([
          storage.getItem(bundleKey(serverId, plugin.id)),
          storage.getItem(queriesKey(serverId, plugin.id)),
        ]);
        const bundle = parseJson(rawBundle, BundleSchema);
        // A bundle written for another catalog (an interrupted save) is not used.
        if (!bundle || bundle.hash !== plugin.hash) return null;
        const queries = parseJson(rawQueries, DehydratedSchema) as DehydratedState | null;
        if (!hostBundles(serverId).has(plugin.id)) {
          hostBundles(serverId).set(plugin.id, {
            hash: plugin.hash,
            clientBundle: bundle.clientBundle,
          });
        }
        return {
          entry: {
            id: plugin.id,
            clientBundle: bundle.clientBundle,
            ...(plugin.requirements ? { requirements: plugin.requirements } : {}),
            ...(plugin.hash ? { clientBundleHash: plugin.hash } : {}),
          },
          queries,
        };
      }),
    );
    const kept = plugins.filter((plugin): plugin is CachedPlugin => plugin !== null);
    return kept.length > 0 ? { serverId, savedAt: index.savedAt, plugins: kept } : null;
  }

  function writeQueries(serverId: string, plugin: TrackedPlugin): Promise<void> {
    const key = queriesKey(serverId, plugin.id);
    timers.delete(key);
    if (plugin.lifetime.signal.aborted) return Promise.resolve();
    const state = withinLimit(dehydratePersisted(plugin.queryClient), maxQueryBytes);
    const json = JSON.stringify(state);
    if (writtenQueries.get(key) === json) return Promise.resolve();
    writtenQueries.set(key, json);
    if (state.queries.length === 0 || json.length > maxQueryBytes) {
      return quietly(storage.removeItem(key));
    }
    return quietly(storage.setItem(key, json));
  }

  return {
    /** The host's cached plugins, read once per host (later calls share the first read). */
    load(serverId: string): Promise<CachedHost | null> {
      let load = loads.get(serverId);
      if (!load) {
        load = read(serverId).catch(() => null);
        loads.set(serverId, load);
      }
      return load;
    },

    /** What to send as `knownBundles`: every bundle the app has for the host with a daemon hash. */
    knownBundles(serverId: string): Array<{ id: string; hash: string }> {
      return [...(bundles.get(serverId) ?? new Map<string, KnownBundle>())].flatMap(
        ([id, bundle]) => (bundle.hash ? [{ id, hash: bundle.hash }] : []),
      );
    },

    /**
     * Fills `clientBundleUnchanged` entries from the bundles the app has. `missing` lists plugins
     * the daemon called unchanged but whose bundle the app no longer has (ask again without hashes).
     */
    resolve(
      serverId: string,
      catalog: readonly CatalogPlugin[],
    ): { catalog: CatalogPlugin[]; missing: string[] } {
      const missing: string[] = [];
      const resolved = catalog.map((entry) => {
        if (!entry.clientBundleUnchanged) return entry;
        const known = bundles.get(serverId)?.get(entry.id);
        if (!known || known.hash !== entry.clientBundleHash) {
          missing.push(entry.id);
          return entry;
        }
        const { clientBundleUnchanged: _unchanged, ...rest } = entry;
        return { ...rest, clientBundle: known.clientBundle };
      });
      return { catalog: resolved, missing };
    },

    /** Drops a plugin's bundle (it failed to evaluate), so the next request asks for it in full. */
    forget(serverId: string, pluginId: string): Promise<void> {
      bundles.get(serverId)?.delete(pluginId);
      return quietly(storage.removeItem(bundleKey(serverId, pluginId)));
    },

    /** Keeps a live (resolved) catalog: bundles that changed, then the host's index. */
    async saveCatalog(serverId: string, catalog: readonly CatalogPlugin[]): Promise<void> {
      const byId = hostBundles(serverId);
      const live = catalog.filter((entry) => entry.clientBundle && !entry.clientBundleUnchanged);
      for (const [id] of byId) {
        if (live.some((entry) => entry.id === id)) continue;
        byId.delete(id);
        await quietly(storage.removeItem(bundleKey(serverId, id)));
        await quietly(storage.removeItem(queriesKey(serverId, id)));
      }
      for (const entry of live) {
        const hash = entry.clientBundleHash ?? null;
        const known = byId.get(entry.id);
        if (known && known.hash === hash && known.clientBundle === entry.clientBundle) continue;
        byId.set(entry.id, { hash, clientBundle: entry.clientBundle });
        await quietly(
          storage.setItem(
            bundleKey(serverId, entry.id),
            JSON.stringify({ hash, clientBundle: entry.clientBundle }),
          ),
        );
      }
      const index: CacheIndex = {
        version: 1,
        serverId,
        savedAt: now(),
        plugins: live.map((entry) => {
          const plugin: CacheIndex["plugins"][number] = {
            id: entry.id,
            hash: entry.clientBundleHash ?? null,
          };
          if (entry.requirements) plugin.requirements = entry.requirements;
          return plugin;
        }),
      };
      await quietly(storage.setItem(pluginCacheKey(serverId), JSON.stringify(index)));
    },

    /**
     * Keeps these installed plugins' persisted queries: written now, then again (debounced)
     * whenever their query cache changes, until each plugin's lifetime ends.
     */
    track(serverId: string, plugins: readonly TrackedPlugin[]): Promise<void> {
      const byId = tracked.get(serverId) ?? new Map<string, TrackedPlugin>();
      tracked.set(serverId, byId);
      const writes: Promise<void>[] = [];
      for (const plugin of plugins) {
        if (byId.get(plugin.id) === plugin) continue;
        byId.set(plugin.id, plugin);
        const key = queriesKey(serverId, plugin.id);
        const unsubscribe = plugin.queryClient.getQueryCache().subscribe((event) => {
          if (plugin.lifetime.signal.aborted || timers.has(key)) return;
          if (event.type !== "updated" && event.type !== "added" && event.type !== "removed")
            return;
          if (event.query.meta?.persist !== true) return;
          timers.set(
            key,
            setTimeout(() => void writeQueries(serverId, plugin), debounceMs),
          );
        });
        plugin.lifetime.signal.addEventListener(
          "abort",
          () => {
            unsubscribe();
            if (byId.get(plugin.id) === plugin) byId.delete(plugin.id);
          },
          { once: true },
        );
        writes.push(writeQueries(serverId, plugin));
      }
      return Promise.all(writes).then(() => undefined);
    },

    /** Writes pending query changes now (tests, app going to the background). */
    async flush(): Promise<void> {
      const pending: Promise<void>[] = [];
      for (const [serverId, byId] of tracked) {
        for (const plugin of byId.values()) {
          const key = queriesKey(serverId, plugin.id);
          const timer = timers.get(key);
          if (!timer) continue;
          clearTimeout(timer);
          pending.push(writeQueries(serverId, plugin));
        }
      }
      await Promise.all(pending);
    },
  };
}

export type PluginCache = ReturnType<typeof createPluginCache>;
