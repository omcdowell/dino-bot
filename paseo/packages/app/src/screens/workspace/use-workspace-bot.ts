import { useCallback, useRef, useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { useInstalledPlugin } from "@/plugins/registry";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  BOTS_PLUGIN_ID,
  fetchWorkspaceBot,
  readCachedWorkspaceBot,
  sameIdentity,
  type WorkspaceBotIdentity,
} from "./workspace-bot-cache";

export type { WorkspaceBotIdentity } from "./workspace-bot-cache";

/** Avatars change by hand-editing `.bot.json`; the header can be a few minutes behind. */
const BOT_STALE_MS = 10 * 60_000;

const noSubscription = () => () => undefined;

/** The bots plugin's cached identity for this workspace, re-read when the plugin's cache changes. */
function useCachedWorkspaceBot(
  pluginQueryClient: QueryClient | null,
  workspaceDirectory: string | null,
): WorkspaceBotIdentity | null {
  const last = useRef<WorkspaceBotIdentity | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) =>
      pluginQueryClient ? pluginQueryClient.getQueryCache().subscribe(onChange) : noSubscription(),
    [pluginQueryClient],
  );
  const getSnapshot = useCallback(() => {
    const next = pluginQueryClient
      ? readCachedWorkspaceBot(pluginQueryClient, workspaceDirectory)
      : null;
    if (!sameIdentity(last.current, next)) last.current = next;
    return last.current;
  }, [pluginQueryClient, workspaceDirectory]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * The bot this workspace belongs to (its folder is the bot's folder), with its avatar, for the
 * phone header. Shown from the bots plugin's device cache at once (cold start, offline,
 * reconnecting, switching chats) and refreshed from the host while it is connected
 * (workspace-bot-cache.ts). Null when neither knows the workspace as a bot's — the header then
 * shows the workspace title and the active tab's own icon.
 */
export function useWorkspaceBot(input: {
  serverId: string;
  workspaceDirectory: string | null;
  enabled: boolean;
}): WorkspaceBotIdentity | null {
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const pluginQueryClient = useInstalledPlugin(input.serverId, BOTS_PLUGIN_ID)?.queryClient ?? null;
  const cached = useCachedWorkspaceBot(pluginQueryClient, input.workspaceDirectory);
  const query = useFetchQuery({
    queryKey: ["workspace-bot-identity", input.serverId, input.workspaceDirectory],
    dataShape: "value",
    staleTimeMs: BOT_STALE_MS,
    enabled: input.enabled && isConnected && Boolean(client && input.workspaceDirectory),
    retry: false,
    queryFn: async (): Promise<WorkspaceBotIdentity | null> =>
      client
        ? fetchWorkspaceBot({
            client,
            workspaceDirectory: input.workspaceDirectory,
            pluginQueryClient,
          })
        : null,
  });
  if (!input.enabled) return null;
  // The last answer from the host wins (also while it is offline); until there is one, the cache.
  return query.data !== undefined ? query.data : cached;
}
