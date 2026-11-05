/**
 * The avatar options pack on the phone (avatar-spec §1): the app ships one (`AVATAR_PACK`); when the
 * server reports a newer `packVersion` (`bots.list` `avatarPackVersion`), the app fetches that pack
 * once in the background and keeps it on the device (a persisted query, `meta.persist`). The
 * downloaded pack is used from the next open, never swapped in mid-session: what is on screen was
 * drawn with one pack.
 *
 * - `sessionPack(queryClient)`: the pack for this session, chosen once per query client: the newest
 *   kept pack that parses and is newer than the bundled one, else the bundled one.
 * - `updateAvatarPack(...)`: the background fetch. One request per version (concurrent calls share
 *   it; a failure is retried at the next call). Nothing is fetched when the server's pack is not
 *   newer than both the bundled and the kept one.
 */
import type { QueryClient } from "@tanstack/react-query";
import { AVATAR_PACK, type AvatarPack } from "../shared/avatar";

export const AVATAR_PACK_KEY_ROOT = ["bots", "avatar-pack"] as const;

/** Kept on the device under `["bots", "avatar-pack", packVersion]`. */
export interface StoredPack {
  packVersion: number;
  json: string;
}

export type FetchPack = (input: { have: number }) => Promise<{ packVersion: number; json: string | null }>;

const isArray = Array.isArray;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !isArray(v);

/** The pack in `json`, or null when it is not one (bad JSON, missing lists, wrong version). */
export function parsePack(json: string, expectVersion?: number): AvatarPack | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const { packVersion, characters, eyes, accessories, palette } = value;
  if (typeof packVersion !== "number" || !Number.isInteger(packVersion) || packVersion < 1) return null;
  if (expectVersion !== undefined && packVersion !== expectVersion) return null;
  if (!isArray(characters) || characters.length === 0 || !isArray(eyes) || !isArray(accessories) || !isArray(palette)) {
    return null;
  }
  for (const c of characters) {
    if (!isObject(c) || typeof c.id !== "string" || !isArray(c.body) || !isArray(c.eyes) || !isObject(c.geo)) return null;
    if (!isArray((c.geo as Record<string, unknown>).frame)) return null;
  }
  return value as unknown as AvatarPack;
}

function storedPacks(queryClient: QueryClient): StoredPack[] {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: [...AVATAR_PACK_KEY_ROOT] })
    .map((query) => query.state.data as StoredPack | undefined)
    .filter((data): data is StoredPack => !!data && typeof data.json === "string" && typeof data.packVersion === "number")
    .sort((a, b) => b.packVersion - a.packVersion);
}

const sessions = new WeakMap<QueryClient, AvatarPack>();

/** The pack this session draws with (chosen at the first call, then fixed). */
export function sessionPack(queryClient: QueryClient, bundled: AvatarPack = AVATAR_PACK): AvatarPack {
  let pack = sessions.get(queryClient);
  if (!pack) {
    pack = bundled;
    for (const stored of storedPacks(queryClient)) {
      if (stored.packVersion <= bundled.packVersion) break;
      const parsed = parsePack(stored.json, stored.packVersion);
      if (parsed) {
        pack = parsed;
        break;
      }
    }
    sessions.set(queryClient, pack);
  }
  return pack;
}

/** The newest pack version the phone has (bundled or kept), whether or not this session uses it. */
export function newestPackVersion(queryClient: QueryClient, bundled: AvatarPack = AVATAR_PACK): number {
  const stored = storedPacks(queryClient).find((p) => parsePack(p.json, p.packVersion));
  return Math.max(bundled.packVersion, stored?.packVersion ?? 0);
}

/**
 * Fetches and keeps the server's pack when it is newer than every pack the phone has. Resolves to
 * the version kept, or null when nothing was needed or the fetch failed (retried next call).
 */
export async function updateAvatarPack(
  queryClient: QueryClient,
  serverVersion: number | null | undefined,
  fetchPack: FetchPack,
  bundled: AvatarPack = AVATAR_PACK,
): Promise<number | null> {
  if (typeof serverVersion !== "number" || !Number.isInteger(serverVersion)) return null;
  const have = newestPackVersion(queryClient, bundled);
  if (serverVersion <= have) return null;
  try {
    const stored = await queryClient.fetchQuery<StoredPack>({
      queryKey: [...AVATAR_PACK_KEY_ROOT, serverVersion],
      queryFn: async () => {
        const answer = await fetchPack({ have });
        if (!answer.json || answer.packVersion !== serverVersion || !parsePack(answer.json, serverVersion)) {
          throw new Error(`avatar pack ${serverVersion}: unusable answer`);
        }
        return { packVersion: answer.packVersion, json: answer.json };
      },
      staleTime: Infinity,
      gcTime: Infinity,
      retry: false,
      meta: { persist: true },
    });
    // Older kept packs are no longer needed (the session's own pack object stays in memory).
    queryClient.removeQueries({
      queryKey: [...AVATAR_PACK_KEY_ROOT],
      predicate: (query) => typeof query.queryKey[2] === "number" && (query.queryKey[2] as number) < stored.packVersion,
    });
    return stored.packVersion;
  } catch {
    return null;
  }
}
