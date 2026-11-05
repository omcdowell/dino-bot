/**
 * The phone header's bot identity, read from the bots plugin's own device cache (header-cache,
 * 2026-10-12: "the header avatar and titles aren't being cached").
 *
 * The bots plugin keeps `["bots", "list"]` (the `bots.list` answer) and one
 * `["bots", "avatar", botId, avatarHash]` query per avatar (`{ dataUri, hash }`) in its query
 * client with `meta.persist`, so the app writes them to the plugin cache and installs them at start
 * before the host connects (plugins/plugin-cache.ts). The header reads that client instead of
 * keeping a second copy: the bot home and the header show the same name and avatar, on the first
 * frame, while offline.
 *
 * When the host is connected the header refreshes itself (`fetchWorkspaceBot`). An avatar whose
 * hash the device already has is not fetched again; a new one is written into the plugin's cache
 * under the plugin's key, so the home and the next cold start have it too.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { findWorkspaceBot, parseBotsList, type WorkspaceBot } from "./mobile-floating-header-model";

export const BOTS_PLUGIN_ID = "bots";
export const BOTS_LIST_METHOD = "bots.list";
export const BOTS_AVATAR_METHOD = "bots.avatar";
/** The bots plugin's query keys (paseo-bots client/bot-data.ts and client/avatar-cache.ts). */
export const BOTS_LIST_KEY = ["bots", "list"] as const;
export const BOTS_AVATAR_KEY_ROOT = ["bots", "avatar"] as const;

export interface WorkspaceBotIdentity {
  bot: WorkspaceBot;
  /** `data:image/…;base64,…`, or null when the bot has no usable avatar. */
  avatarUri: string | null;
}

const imageUri = (value: unknown): string | null =>
  typeof value === "string" && value.startsWith("data:image/") ? value : null;

const avatarDataUri = (data: unknown): string | null =>
  typeof data === "object" && data !== null
    ? imageUri((data as { dataUri?: unknown }).dataUri)
    : null;

const avatarKey = (botId: string, hash: string): QueryKey => [...BOTS_AVATAR_KEY_ROOT, botId, hash];

/**
 * The device's avatar for this bot: the copy under `hash` when given and present, else the newest
 * copy under any version (what the home shows while a changed avatar loads).
 */
export function cachedBotAvatar(
  queryClient: QueryClient,
  botId: string,
  hash: string | null,
): string | null {
  if (hash) {
    const exact = avatarDataUri(queryClient.getQueryData(avatarKey(botId, hash)));
    if (exact) return exact;
  }
  let best: { at: number; uri: string } | null = null;
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: [...BOTS_AVATAR_KEY_ROOT, botId] })) {
    const uri = avatarDataUri(query.state.data);
    if (uri && (!best || query.state.dataUpdatedAt > best.at)) {
      best = { at: query.state.dataUpdatedAt, uri };
    }
  }
  return best?.uri ?? null;
}

/** The workspace's bot as the bots plugin's device cache has it; null when it has none. */
export function readCachedWorkspaceBot(
  queryClient: QueryClient,
  workspaceDirectory: string | null,
): WorkspaceBotIdentity | null {
  const bot = findWorkspaceBot(
    parseBotsList(queryClient.getQueryData(BOTS_LIST_KEY)),
    workspaceDirectory,
  );
  if (!bot) return null;
  return {
    bot,
    avatarUri: bot.hasAvatar ? cachedBotAvatar(queryClient, bot.id, bot.avatarHash) : null,
  };
}

/** Same identity (for a stable snapshot: the header re-renders only when what it shows changes). */
export function sameIdentity(
  left: WorkspaceBotIdentity | null,
  right: WorkspaceBotIdentity | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.avatarUri === right.avatarUri &&
    left.bot.id === right.bot.id &&
    left.bot.name === right.bot.name &&
    left.bot.cwd === right.bot.cwd &&
    left.bot.hasAvatar === right.bot.hasAvatar &&
    left.bot.avatarHash === right.bot.avatarHash
  );
}

/**
 * Keeps a fetched avatar in the plugin's cache as the plugin would (persisted, never collected)
 * and drops this bot's older copies, so the device keeps one avatar per bot.
 */
export function storeBotAvatar(
  queryClient: QueryClient,
  botId: string,
  hash: string,
  dataUri: string,
): void {
  const queryKey = avatarKey(botId, hash);
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey, meta: { persist: true }, gcTime: Infinity });
  queryClient.setQueryData(queryKey, { dataUri, hash });
  queryClient.removeQueries({
    queryKey: [...BOTS_AVATAR_KEY_ROOT, botId],
    // A copy the home has on screen stays; the home prunes it once its own list has the new hash.
    predicate: (query) => query.queryKey[3] !== hash && query.getObserversCount() === 0,
  });
}

export interface BotsRpcClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}

/**
 * The workspace's bot from the host. Its avatar comes from the plugin's cache when the hash is
 * unchanged, else from `bots.avatar` (then stored there). If the avatar call fails, the cached
 * copy stays.
 */
export async function fetchWorkspaceBot(input: {
  client: BotsRpcClient;
  workspaceDirectory: string | null;
  pluginQueryClient: QueryClient | null;
}): Promise<WorkspaceBotIdentity | null> {
  const { client, pluginQueryClient } = input;
  const bot = findWorkspaceBot(
    parseBotsList(await client.invokePluginRpc(BOTS_PLUGIN_ID, BOTS_LIST_METHOD, {})),
    input.workspaceDirectory,
  );
  if (!bot) return null;
  if (!bot.hasAvatar) return { bot, avatarUri: null };
  if (pluginQueryClient && bot.avatarHash) {
    const have = avatarDataUri(pluginQueryClient.getQueryData(avatarKey(bot.id, bot.avatarHash)));
    if (have) return { bot, avatarUri: have };
  }
  let answer: { dataUri?: unknown; hash?: unknown } | null;
  try {
    answer = (await client.invokePluginRpc(BOTS_PLUGIN_ID, BOTS_AVATAR_METHOD, {
      botId: bot.id,
    })) as { dataUri?: unknown; hash?: unknown } | null;
  } catch {
    // Offline mid-refresh: keep the avatar the device has rather than flash the fallback icon.
    return {
      bot,
      avatarUri: pluginQueryClient ? cachedBotAvatar(pluginQueryClient, bot.id, null) : null,
    };
  }
  const uri = imageUri(answer?.dataUri);
  if (!uri) return { bot, avatarUri: null };
  const hash = typeof answer?.hash === "string" && answer.hash ? answer.hash : bot.avatarHash;
  if (pluginQueryClient && hash) storeBotAvatar(pluginQueryClient, bot.id, hash, uri);
  return { bot, avatarUri: uri };
}
