import type { AudioEngine } from "@/audio";
import { useMemo, useSyncExternalStore } from "react";
import { hydrate, type DehydratedState } from "@tanstack/react-query";
import { createPaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { resolveAppVersion } from "@/utils/app-version";
import { createPluginClientRuntime } from "./client-runtime";
import { runPluginClientBundle } from "./evaluate";
import { PluginEventHub } from "./events";
import { createPluginQueryClient, dehydratePersisted, type CatalogPlugin } from "./plugin-cache";
import type { InstalledPlugin } from "./types";

export class PluginRegistry {
  private readonly byHost = new Map<string, InstalledPlugin[]>();
  private readonly listeners = new Set<() => void>();
  private snapshot: InstalledPlugin[] = [];
  private readonly disposed = new WeakSet<InstalledPlugin>();
  private readonly evaluationErrors = new Map<string, string>();
  private readonly liveHosts = new Set<string>();
  /** The daemon client each installation was made with (a cached install: the host forwarder). */
  private readonly clients = new WeakMap<InstalledPlugin, DaemonClient>();

  constructor(
    private readonly dependencies: {
      version: string | null;
      createRuntime: typeof createPluginClientRuntime;
    },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): InstalledPlugin[] => this.snapshot;

  /** Whether a catalog (live or cached, even an empty one) is installed for this host. */
  hasCatalog = (serverId: string): boolean => this.byHost.has(serverId);

  getEvaluationError(serverId: string, pluginId: string): string | undefined {
    return this.evaluationErrors.get(`${serverId}/${pluginId}`);
  }

  installCatalog(
    serverId: string,
    catalog: CatalogPlugin[],
    options: {
      replacePluginId?: string;
      client: DaemonClient;
      audio: Pick<AudioEngine, "play">;
      /** "cache": from the device cache, before the host answered (plugin cache). */
      source?: "live" | "cache";
      /** Persisted plugin queries to start from, by plugin id. */
      queries?: ReadonlyMap<string, DehydratedState>;
    },
  ): boolean {
    const source = options.source ?? "live";
    const previous = this.byHost.get(serverId) ?? [];
    const previousTimelineBundles = previous
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    const preserved = catalog.flatMap((entry) => {
      const existing = previous.find(
        (plugin) =>
          plugin.id !== options.replacePluginId &&
          plugin.id === entry.id &&
          plugin.clientBundle === entry.clientBundle &&
          plugin.requirements?.paseo === entry.requirements?.paseo &&
          this.canKeep(plugin, source, options.client),
      );
      return existing ? [existing] : [];
    });
    for (const plugin of preserved) {
      if (plugin.source !== "cache" || source !== "live") continue;
      // The live catalog confirms a cached install: it stays (no second evaluation, no remount),
      // its calls already follow the host's live client, and its cached data refreshes.
      plugin.source = "live";
      this.clients.set(plugin, options.client);
      void plugin.queryClient.invalidateQueries();
    }
    const removed = previous.filter((plugin) => !preserved.includes(plugin));
    // Replacements start from the persisted data of what they replace.
    const carried = new Map<string, DehydratedState>();
    for (const plugin of removed) carried.set(plugin.id, dehydratePersisted(plugin.queryClient));
    // Cached installs stay on screen until their replacements are published (no gap); live ones
    // are torn down before their replacement is evaluated.
    const removedNow = removed.filter((plugin) => plugin.source !== "cache");
    if (removedNow.length > 0) {
      this.byHost.set(
        serverId,
        previous.filter((plugin) => !removedNow.includes(plugin)),
      );
      this.publish();
      for (const plugin of removedNow) this.dispose(plugin);
    }
    const installed = catalog.flatMap((entry) => {
      const key = `${serverId}/${entry.id}`;
      let installation: InstalledPlugin | undefined;
      try {
        if (!entry.clientBundle) return [];
        assertPluginCompatibility({ ...entry, version: this.dependencies.version, runtime: "app" });
        const existing = preserved.find(
          (plugin) => plugin.id === entry.id && plugin.clientBundle === entry.clientBundle,
        );
        if (existing) {
          this.evaluationErrors.delete(key);
          return [existing];
        }
        const client = options.client;
        installation = {
          lifetime: new AbortController(),
          paseo: createPaseoApi(client),
          // A confirmed cached install calls the live client directly (see `installCatalog`).
          invoke: (method, input) =>
            (installation ? (this.clients.get(installation) ?? client) : client).invokePluginRpc(
              entry.id,
              method,
              input,
            ),
          id: entry.id,
          serverId,
          clientBundle: entry.clientBundle,
          requirements: entry.requirements,
          queryClient: createPluginQueryClient(),
          source,
          events: new PluginEventHub(),
          cleanup: () => undefined,
          surfaces: [],
          settingsScreens: [],
          sidebarItems: { header: [], footer: [] },
          legacySidebarItems: [],
          workspacePanels: [],
          commandCenterItems: [],
          clientSlashCommands: [],
          attachmentSources: [],
          themes: [],
          timelineTransformers: [],
          timelineRenderers: [],
        };
        this.clients.set(installation, client);
        const seed = options.queries?.get(entry.id) ?? carried.get(entry.id);
        if (seed) hydrate(installation.queryClient, seed);
        installation.events?.setLive(this.liveHosts.has(serverId));
        const runtime = this.dependencies.createRuntime(installation, options.audio);
        const evaluated = runPluginClientBundle(entry.id, entry.clientBundle, runtime, () =>
          this.publish(),
        );
        Object.assign(installation, evaluated);
        const paseo = installation.paseo;
        installation.cleanup = async () => {
          const results = await Promise.allSettled([paseo.dispose(), evaluated.cleanup()]);
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Plugin cleanup failed",
            );
        };
        this.evaluationErrors.delete(key);
        return [installation];
      } catch (error) {
        installation?.lifetime.abort();
        void installation?.paseo
          .dispose()
          .catch((failure) => console.warn(`[Plugins] API cleanup failed for ${key}`, failure));
        // A cached bundle that fails is skipped quietly; the live catalog installs (or reports) it.
        if (source === "live") {
          this.evaluationErrors.set(key, error instanceof Error ? error.message : String(error));
        }
        console.warn(`[Plugins] Failed to evaluate ${source} ${serverId}/${entry.id}`, error);
        return [];
      }
    });
    const configuredIds = new Set(catalog.map((entry) => entry.id));
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`) && !configuredIds.has(key.slice(serverId.length + 1))) {
        this.evaluationErrors.delete(key);
      }
    }
    this.byHost.set(serverId, installed);
    this.publish();
    for (const plugin of removed) if (plugin.source === "cache") this.dispose(plugin);
    const installedTimelineBundles = installed
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    return (
      previousTimelineBundles.length !== installedTimelineBundles.length ||
      previousTimelineBundles.some((bundle, index) => bundle !== installedTimelineBundles[index])
    );
  }

  /**
   * A live catalog keeps an installation only if it was made with the same client (its calls and
   * subscriptions are bound to it), or if it is a cached install, whose calls follow the host.
   */
  private canKeep(
    plugin: InstalledPlugin,
    source: "live" | "cache",
    client: DaemonClient,
  ): boolean {
    if (source === "cache") return plugin.source === "cache";
    return plugin.source === "cache" || this.clients.get(plugin) === client;
  }

  /** pluginEvents: deliver one pushed event to the plugin installed from this host. */
  dispatchEvent(serverId: string, pluginId: string, name: string, data: unknown): void {
    this.byHost
      .get(serverId)
      ?.find((plugin) => plugin.id === pluginId)
      ?.events?.dispatch(name, data);
  }

  /** pluginEvents: whether this host is pushing plugin events to this app right now. */
  setEventsLive(serverId: string, live: boolean): void {
    this.liveHosts[live ? "add" : "delete"](serverId);
    for (const plugin of this.byHost.get(serverId) ?? []) plugin.events?.setLive(live);
  }

  isEventsLive(serverId: string): boolean {
    return this.liveHosts.has(serverId);
  }

  removeHost(serverId: string): void {
    this.liveHosts.delete(serverId);
    const installed = this.byHost.get(serverId);
    if (!installed) return;
    for (const plugin of installed) this.dispose(plugin);
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`)) this.evaluationErrors.delete(key);
    }
    this.byHost.delete(serverId);
    this.publish();
  }

  private dispose(plugin: InstalledPlugin): void {
    if (this.disposed.has(plugin)) return;
    this.disposed.add(plugin);
    plugin.lifetime.abort();
    plugin.queryClient.clear();
    plugin.events?.clear();
    try {
      void Promise.resolve(plugin.cleanup()).catch((error) => {
        console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
      });
    } catch (error) {
      console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
    }
  }

  private publish(): void {
    this.snapshot = [...this.byHost.values()]
      .flat()
      .sort((left, right) =>
        `${left.serverId}/${left.id}`.localeCompare(`${right.serverId}/${right.id}`),
      );
    for (const listener of this.listeners) listener();
  }
}

export const pluginRegistry = new PluginRegistry({
  version: resolveAppVersion(),
  createRuntime: createPluginClientRuntime,
});

export function useInstalledPlugins(): InstalledPlugin[] {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getSnapshot,
    pluginRegistry.getSnapshot,
  );
}

export function useInstalledPlugin(serverId: string, pluginId: string): InstalledPlugin | null {
  return (
    useInstalledPlugins().find(
      (plugin) => plugin.serverId === serverId && plugin.id === pluginId,
    ) ?? null
  );
}

export function usePluginInstallations(pluginId: string): InstalledPlugin[] {
  const installed = useInstalledPlugins();
  return useMemo(() => installed.filter((plugin) => plugin.id === pluginId), [installed, pluginId]);
}
