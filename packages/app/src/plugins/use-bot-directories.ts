import { useCallback, useMemo, useSyncExternalStore } from "react";
import { botDirectoryKey, roomKey } from "@/components/sidebar/bot-workspaces";
import { BOTS_LIST_KEY, BOTS_PLUGIN_ID } from "@/screens/workspace/workspace-bot-cache";
import { parseBotsList } from "@/screens/workspace/mobile-floating-header-model";
import { useInstalledPlugins } from "./registry";

const EMPTY: ReadonlySet<string> = new Set();
/** The bots plugin's group chat list (paseo-bots client/group-data.ts ROOMS_LIST_KEY). */
const ROOMS_LIST_KEY = ["rooms", "list"] as const;

function groupIds(value: unknown): string[] {
  const groups = (value as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    const id = (group as { id?: unknown } | null)?.id;
    return typeof id === "string" && id ? [id] : [];
  });
}

/**
 * Every bot's folder and group chat on every host (`botDirectoryKey`, `roomKey`), from the bots
 * plugin's own `bots.list` and `rooms.list` caches, kept current as the plugin refreshes them.
 * Empty when disabled or without the plugin.
 */
export function useBotDirectoryKeys(enabled: boolean): ReadonlySet<string> {
  const plugins = useInstalledPlugins();
  const botPlugins = useMemo(
    () => (enabled ? plugins.filter((plugin) => plugin.id === BOTS_PLUGIN_ID) : []),
    [enabled, plugins],
  );
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribers = botPlugins.map((plugin) =>
        plugin.queryClient.getQueryCache().subscribe(onChange),
      );
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
    [botPlugins],
  );
  const getSnapshot = useCallback(
    () =>
      botPlugins
        .flatMap((plugin) => [
          ...parseBotsList(plugin.queryClient.getQueryData(BOTS_LIST_KEY)).map((bot) =>
            botDirectoryKey(plugin.serverId, bot.cwd),
          ),
          ...groupIds(plugin.queryClient.getQueryData(ROOMS_LIST_KEY)).map((id) =>
            roomKey(plugin.serverId, id),
          ),
        ])
        .sort()
        .join("\n"),
    [botPlugins],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => (snapshot ? new Set(snapshot.split("\n")) : EMPTY), [snapshot]);
}
