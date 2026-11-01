/**
 * Bot avatars on the phone home, kept on the device (avatar-reload, 2026-10-12: "if i go
 * away from my phone for a while and open the app, all the bot avatars take a couple of seconds to
 * load back in"), for low bandwidth and high latency (avatar-spec §5, avatar-cache AV4).
 *
 * - One query per bot, avatar content hash (`bots.list` sends `avatarHash`) and variant, persisted
 *   by the app (`meta.persist`) and never garbage-collected, so a cold start or a return to the
 *   home paints the last avatar at once.
 * - Content-addressed: the data under a hash never changes, so a refetch (the app invalidates
 *   everything when the host confirms its cached plugin) answers from the device with no call.
 *   The bytes cross the wire only when the hash changes.
 * - Only the size needed: the server renders 64, 128 and 512 px PNGs; the phone asks for the
 *   smallest that fits the slot (`avatarPngSize`), and any copy it already has that is at least
 *   that big is used instead (a 512 serves every smaller slot; no second fetch).
 * - Drawn from avatar.json when it can: a bot saved with the designer has `avatarPack` (the pack
 *   version of its avatar.json). When the phone can draw SVG and its pack is at least that new,
 *   it asks for the JSON (~300 B) instead of a PNG and composes the SVG itself (composeAvatarSvg),
 *   once per hash, at every size. The composed SVG is kept with the JSON, so the Live Activity can
 *   draw it from the phone's copy too (paseo live-activity/icons.ts).
 * - While a new hash loads, the previous avatar of that bot stays on screen (no fallback flash);
 *   once it has loaded, the older copies are dropped.
 * - Older servers send no hash: the key falls back to the avatar path and refetches as before;
 *   servers that ignore `size` send the full image (no `size` in the answer), which serves any slot.
 *
 * Keys: `["bots", "avatar", botId, hash]` (full image), `[…, hash, 64 | 128 | 512]` (one PNG
 * size), `[…, hash, "json"]` (drawn from avatar.json); `[…, path]` for servers without hashes.
 */
import type { QueryClient, QueryKey, QueryObserverOptions } from "@tanstack/react-query";
import { composeAvatarSvg, parseAvatar, type AvatarJson, type AvatarPack } from "../shared/avatar";
import { AVATAR_PNG_SIZES, type AvatarPngSize } from "../shared/home-rpc";

export interface AvatarData {
  /** PNG data URI; null when drawn from avatar.json (`svg`) or when the bot has no usable image. */
  dataUri: string | null;
  hash?: string | null;
  /** The PNG's size in px when the server sent the size asked for; absent = the full avatar.png. */
  size?: number;
  /** The bot's avatar.json, when drawn from it. */
  avatar?: AvatarJson;
  /** composeAvatarSvg(avatar, pack): what the phone draws (and the Live Activity rasterizes). */
  svg?: string;
  /** The pack `svg` was composed with. */
  packVersion?: number;
}

export interface AvatarBot {
  id: string;
  avatar: string | null;
  avatarHash?: string | null;
  /** packVersion of the bot's avatar.json; null/absent: no avatar.json (or an older server). */
  avatarPack?: number | null;
}

/** What `bots.avatar` is asked (shared/home-rpc.ts botsAvatarRpc). */
export interface AvatarRequest {
  botId: string;
  size?: AvatarPngSize;
  format?: "png" | "json";
}

export interface AvatarAnswer {
  dataUri: string | null;
  hash?: string | null;
  /** null or absent: the full avatar.png (AV1 sends null for a plain avatar.png). */
  size?: number | null;
  avatar?: unknown;
}

export type GetAvatar = (input: AvatarRequest) => Promise<AvatarAnswer>;

/**
 * What a slot needs. `size`: the PNG size to ask for (absent: the full image, as before).
 * `pack`: set when the phone can draw SVG; the pack this session draws with.
 */
export interface AvatarNeed {
  size?: AvatarPngSize;
  pack?: AvatarPack | null;
}

export const AVATAR_KEY_ROOT = ["bots", "avatar"] as const;

/**
 * The PNG size for a slot of `points` (layout units): the smallest of 64/128/512 that covers it at
 * up to 2x (a 3x screen draws a 2x PNG for avatars: the art is flat line art, and 512 is 4x the
 * bytes of 128), allowing 25% upscaling, so 18-40 pt slots take 64, 44-80 pt take 128, larger 512.
 */
export function avatarPngSize(points: number, pixelRatio = 2): AvatarPngSize {
  const px = points * Math.min(Math.max(pixelRatio, 1), 2);
  for (const size of AVATAR_PNG_SIZES) if (size * 1.25 >= px) return size;
  return 512;
}

/** `["bots", "avatar", botId, hash | path]`, plus the variant when given. */
export function avatarKey(bot: AvatarBot, variant?: AvatarPngSize | "json"): QueryKey {
  const base = [...AVATAR_KEY_ROOT, bot.id, bot.avatarHash ?? bot.avatar ?? ""];
  return variant === undefined ? base : [...base, variant];
}

const isAvatar = (data: unknown): data is AvatarData =>
  typeof data === "object" && data !== null && "dataUri" in data;

const drawable = (data: AvatarData, canSvg: boolean) => !!data.dataUri || (canSvg && !!data.svg);

/** True when `data` can fill a slot with this need without a fetch. */
export function satisfies(data: AvatarData, need: AvatarNeed): boolean {
  if (data.svg) return !!need.pack;
  if (!data.dataUri) return false;
  if (data.size === undefined) return true; // the full image
  return need.size !== undefined && data.size >= need.size;
}

/** Wants the JSON: the phone draws SVG and its pack has everything this bot's avatar.json uses. */
function wantsJson(bot: AvatarBot, need: AvatarNeed): boolean {
  return !!need.pack && typeof bot.avatarPack === "number" && bot.avatarPack <= need.pack.packVersion;
}

/**
 * The key this slot reads: a copy the device already has that satisfies it (SVG first, then the
 * smallest PNG big enough), else the one to fetch.
 */
export function resolveAvatarKey(queryClient: QueryClient, bot: AvatarBot, need: AvatarNeed = {}): QueryKey {
  const hash = bot.avatarHash;
  if (!hash || need.size === undefined) return avatarKey(bot);
  let best: { key: QueryKey; rank: number } | undefined;
  let jsonAnsweredPng = false;
  for (const query of queryClient.getQueryCache().findAll({ queryKey: [...AVATAR_KEY_ROOT, bot.id, hash] })) {
    const data = query.state.data;
    if (!isAvatar(data)) continue;
    if (query.queryKey[4] === "json" && !data.svg) jsonAnsweredPng = true;
    if (!satisfies(data, need)) continue;
    const rank = data.svg ? 0 : (data.size ?? 100_000);
    if (!best || rank < best.rank) best = { key: query.queryKey, rank };
  }
  if (best) return best.key;
  // The server had no avatar.json for this hash (it sent a PNG): ask for the size instead.
  if (wantsJson(bot, need) && !jsonAnsweredPng) return avatarKey(bot, "json");
  return avatarKey(bot, need.size);
}

/** The newest avatar the device has for this bot under any version (shown while one loads). */
export function cachedAvatar(queryClient: QueryClient, botId: string, canSvg = true): AvatarData | undefined {
  let best: { at: number; data: AvatarData } | undefined;
  for (const query of queryClient.getQueryCache().findAll({ queryKey: [...AVATAR_KEY_ROOT, botId] })) {
    const data = query.state.data;
    if (!isAvatar(data) || !drawable(data, canSvg)) continue;
    if (!best || query.state.dataUpdatedAt > best.at) best = { at: query.state.dataUpdatedAt, data };
  }
  return best?.data;
}

/** Drops this bot's avatar copies other than `keep` (an older hash, or the pre-hash path key). */
export function pruneAvatars(queryClient: QueryClient, bot: AvatarBot): void {
  const keep = avatarKey(bot)[3];
  queryClient.removeQueries({
    queryKey: [...AVATAR_KEY_ROOT, bot.id],
    predicate: (query) => query.queryKey[3] !== keep,
  });
}

/** The answer as device data: avatar.json composed into SVG when it parses with `pack`. */
function fromAnswer(answer: AvatarAnswer, pack: AvatarPack | null | undefined): AvatarData | null {
  if (answer.avatar !== undefined && answer.avatar !== null && pack) {
    const parsed = parseAvatar(answer.avatar, pack);
    if (parsed.ok) {
      try {
        return {
          dataUri: null,
          hash: answer.hash ?? null,
          avatar: parsed.avatar,
          svg: composeAvatarSvg(parsed.avatar, pack),
          packVersion: pack.packVersion,
        };
      } catch {
        // An id the pack has but cannot draw: take the PNG instead.
      }
    }
  }
  if (answer.avatar !== undefined && !answer.dataUri) return null;
  const data: AvatarData = { dataUri: answer.dataUri, hash: answer.hash ?? null };
  if (typeof answer.size === "number") data.size = answer.size;
  return data;
}

/** useQuery options for one bot's avatar in a slot with this need. */
export function avatarQueryOptions(
  queryClient: QueryClient,
  bot: AvatarBot,
  getAvatar: GetAvatar,
  need: AvatarNeed = {},
): QueryObserverOptions<AvatarData, Error, AvatarData, AvatarData, QueryKey> {
  const queryKey = resolveAvatarKey(queryClient, bot, need);
  const hash = bot.avatarHash ?? null;
  const variant = queryKey[4];
  return {
    queryKey,
    queryFn: async (): Promise<AvatarData> => {
      if (hash) {
        const have = queryClient.getQueryData(queryKey);
        if (isAvatar(have) && drawable(have, !!need.pack)) return have;
      }
      if (variant === "json") {
        const got = fromAnswer(await getAvatar({ botId: bot.id, format: "json", ...(need.size ? { size: need.size } : {}) }), need.pack);
        if (got) return got;
        // JSON this pack cannot draw: the PNG of the size needed.
      }
      const request: AvatarRequest = { botId: bot.id };
      const size = typeof variant === "number" ? (variant as AvatarPngSize) : need.size;
      if (size !== undefined && hash) request.size = size;
      return fromAnswer(await getAvatar(request), null) ?? { dataUri: null, hash };
    },
    enabled: !!bot.avatar,
    staleTime: Infinity,
    gcTime: Infinity,
    // The last avatar of this bot while a changed one loads: no fallback icon in between.
    placeholderData: () => (bot.avatar ? cachedAvatar(queryClient, bot.id, !!need.pack) : undefined),
    meta: { persist: true },
  };
}
