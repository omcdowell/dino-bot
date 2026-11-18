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
 *
 * avatar-cache-cc (2026-11-17: a bot's avatar sometimes took a second to load when its chat
 * opened): the home keeps avatars under variant keys, `[…, hash, 64 | 128 | 512]` (one PNG
 * size) or `[…, hash, "json"]` (avatar.json drawn as SVG, no PNG). The header looked only at
 * `[…, hash]`, so it fetched the full 512 px PNG again for bots the home already had, and for a bot
 * drawn from avatar.json it had no picture until two round trips were done. It now takes any PNG
 * copy of the current hash, and fetches only the size it draws (HEADER_AVATAR_PX), kept under the
 * plugin's key for that size.
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

const avatarKey = (botId: string, hash: string, size?: number): QueryKey =>
  size === undefined
    ? [...BOTS_AVATAR_KEY_ROOT, botId, hash]
    : [...BOTS_AVATAR_KEY_ROOT, botId, hash, size];

/**
 * The PNG size the header asks for: its avatar is 32 pt (workspace-mobile-header.tsx), drawn from
 * a 64 px PNG at up to 2x, as the plugin's avatarPngSize(32) picks.
 */
export const HEADER_AVATAR_PX = 64;

/**
 * The device's PNG of this avatar version under any of the plugin's keys for it (full image or a
 * size; an SVG-only copy has none): the smallest at least HEADER_AVATAR_PX, else the largest.
 */
function hashAvatar(queryClient: QueryClient, botId: string, hash: string): string | null {
  let best: { px: number; uri: string } | null = null;
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: [...BOTS_AVATAR_KEY_ROOT, botId, hash] })) {
    const data = query.state.data;
    const uri = avatarDataUri(data);
    if (!uri) continue;
    const size = (data as { size?: unknown }).size;
    const px = typeof size === "number" ? size : Number.POSITIVE_INFINITY;
    const better =
      !best ||
      (px >= HEADER_AVATAR_PX
        ? best.px < HEADER_AVATAR_PX || px < best.px
        : best.px < HEADER_AVATAR_PX && px > best.px);
    if (better) best = { px, uri };
  }
  return best?.uri ?? null;
}

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
    const exact = hashAvatar(queryClient, botId, hash);
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
 * Keeps a fetched avatar in the plugin's cache as the plugin would (persisted, never collected;
 * under `[…, hash, size]` when the host sent that size, else `[…, hash]` for the full image) and
 * drops this bot's older copies, so the device keeps one avatar version per bot.
 */
export function storeBotAvatar(
  queryClient: QueryClient,
  botId: string,
  hash: string,
  dataUri: string,
  size?: number,
): void {
  const queryKey = avatarKey(botId, hash, size);
  queryClient.getQueryCache().build(queryClient, {
    queryKey,
    meta: { persist: true },
    gcTime: Infinity,
  });
  queryClient.setQueryData(
    queryKey,
    size === undefined ? { dataUri, hash } : { dataUri, hash, size },
  );
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
    const have = hashAvatar(pluginQueryClient, bot.id, bot.avatarHash);
    if (have) return { bot, avatarUri: have };
  }
  let answer: { dataUri?: unknown; hash?: unknown; size?: unknown } | null;
  try {
    // A host that sends hashes takes `size` (one that ignores it sends the full image, no `size`).
    answer = (await client.invokePluginRpc(
      BOTS_PLUGIN_ID,
      BOTS_AVATAR_METHOD,
      bot.avatarHash ? { botId: bot.id, size: HEADER_AVATAR_PX } : { botId: bot.id },
    )) as { dataUri?: unknown; hash?: unknown; size?: unknown } | null;
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
  const size = typeof answer?.size === "number" ? answer.size : undefined;
  if (pluginQueryClient && hash) storeBotAvatar(pluginQueryClient, bot.id, hash, uri, size);
  return { bot, avatarUri: uri };
}
