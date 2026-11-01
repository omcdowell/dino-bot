import AsyncStorage from "@react-native-async-storage/async-storage";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { pluginSettingsKey } from "./settings/use-settings";
import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { hostSupportsFeature, useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { pluginRegistry } from "./registry";
import {
  createHostClientForwarder,
  restoreCachedPlugins,
  syncLiveCatalog,
} from "./plugin-cache-runtime";

export function PluginCatalogSync({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient;
}) {
  const audio = useVoiceAudioEngineOptional();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostPluginsSupport(serverId);
  const pushesEvents = useHostFeature(serverId, "pluginEvents");

  useEffect(() => {
    let cancelled = false;
    let refreshQueue = Promise.resolve();
    if (!audio || supported === false) {
      pluginRegistry.removeHost(serverId);
      return;
    }
    // Plugin cache: while the host is away (or before its handshake), what is installed stays:
    // the cached plugins at start-up, or the live ones across a reconnect.
    if (!connected || supported === null) return;
    const refresh = (replacePluginId?: string) => {
      refreshQueue = refreshQueue.then(() =>
        syncLiveCatalog({
          serverId,
          client,
          audio,
          registry: pluginRegistry,
          replacePluginId,
          isCancelled: () => cancelled,
        }).catch((error) => {
          if (!cancelled) {
            console.warn(`[Plugins] Failed to load catalog for ${serverId}`, error);
          }
          return undefined;
        }),
      );
      return refreshQueue;
    };
    const observation = client.observeEvents([
      "status.plugin_catalog_changed",
      "status.plugin_settings_changed",
      // COMPAT(pluginEvents): added in v0.11.3, remove gate after 2027-04-10.
      ...(pushesEvents ? (["plugin.event"] as const) : []),
    ]);
    observation.subscribe({
      snapshot: () => {
        if (pushesEvents) pluginRegistry.setEventsLive(serverId, true);
        void refresh();
      },
      update: (message) => {
        if (message.type === "plugin.event") {
          const { pluginId, name, data } = message.payload;
          pluginRegistry.dispatchEvent(serverId, pluginId, name, data);
          return;
        }
        if (message.type !== "status") return;
        if (message.payload.status === "plugin_settings_changed") {
          const { pluginId, settingsId } = message.payload;
          if (typeof settingsId === "string") {
            const plugin = pluginRegistry
              .getSnapshot()
              .find((item) => item.serverId === serverId && item.id === pluginId);
            void plugin?.queryClient.invalidateQueries({ queryKey: pluginSettingsKey(settingsId) });
          }
        }
        if (message.payload.status === "plugin_catalog_changed") {
          const pluginId = message.payload.pluginId;
          if (typeof pluginId === "string") void refresh(pluginId);
        }
      },
    });
    return () => {
      cancelled = true;
      pluginRegistry.setEventsLive(serverId, false);
      void observation
        .release()
        .catch((error) => console.warn("[Plugins] Failed to release catalog", error));
    };
  }, [audio, client, connected, pushesEvents, serverId, supported]);

  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId]);
  return null;
}

/** Whether the host runs plugins; null until its first handshake (the app keeps its cache). */
function useHostPluginsSupport(serverId: string): boolean | null {
  return useSessionStore((state) => {
    const serverInfo = state.sessions[serverId]?.serverInfo;
    return serverInfo ? hostSupportsFeature(serverInfo, "plugins") : null;
  });
}

/**
 * Plugin cache: installs the host's cached plugins at start-up, before the host connects (it may
 * have no client yet), so plugin UI shows the last known state at once. Mount once per saved host.
 */
export function PluginCacheRestore({ serverId }: { serverId: string }) {
  const audio = useVoiceAudioEngineOptional();
  // The phone-home cache this replaces (paseo:plugin-home-cache:v1) is no longer read.
  useEffect(() => {
    void AsyncStorage.removeItem(`paseo:plugin-home-cache:v1:${serverId}`).catch(() => undefined);
  }, [serverId]);
  useEffect(() => {
    if (!audio || pluginRegistry.hasCatalog(serverId)) return;
    let cancelled = false;
    void restoreCachedPlugins({
      serverId,
      client: createHostClientForwarder(
        () => getHostRuntimeStore().getSnapshot(serverId)?.client ?? null,
      ),
      audio,
      registry: pluginRegistry,
      isCancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
    };
  }, [audio, serverId]);
  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId]);
  return null;
}
