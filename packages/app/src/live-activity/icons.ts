/**
 * Bot icons for the Live Activity. The widget extension cannot reach the daemon, so the app copies
 * each bot's icon to storage the extension can read: a keychain item in the shared access group
 * `<team>.com.example.paseo.shared`, keyed by bot id (native `setBotIcon`, downscaled to 96 px PNG).
 * Pushes keep sending bot ids only.
 *
 * Same icon as the bots home, in the same order:
 * 1. the bot's avatar as the bots home keeps it on the phone: the bots plugin's persisted queries
 *    (`["bots", "avatar", botId, avatarHash, variant]`, plugins/plugin-cache.ts), never the network.
 *    A designer avatar kept as composed SVG is rasterized here (`renderSvg`); else the PNG (the
 *    smallest size of at least 96 px). Until the home has the current hash, the icon stored for an
 *    older one stays (or the Lucide tile when there is none);
 * 2. else the bot's Lucide icon (`.bot.json` "icon", default "Bot") on a rounded tile, rendered
 *    on the phone (`renderLucide`, see tile.ts);
 * 3. else nothing is stored and the widget draws the letter circle.
 *
 * Re-renders when the source (avatar hash, or path for older servers, or icon name) changed, once a day, or when the keychain
 * no longer has it (the index alone is not trusted); removes icons of bots that are gone from the
 * host that stored them. Busy bots go first. The index of what is stored lives in app storage.
 *
 * The bots' Lucide names are returned and kept (ICON_NAMES_KEY): the app adds them to the activity
 * state, so the widget draws the tile itself when the keychain has no icon (LucideTile.swift).
 */

import { pluginQueriesKey } from "@/plugins/plugin-cache";

export const BOTS_PLUGIN_ID = "bots";
export const BOTS_LIST_METHOD = "bots.list";
export const ICON_INDEX_KEY = "@paseo:live-activity-icons:v1";
export const ICON_NAMES_KEY = "@paseo:live-activity-icon-names:v1";
export const ICON_REFRESH_MS = 24 * 60 * 60 * 1000;
const PNG_PREFIX = "data:image/png;base64,";
/** The widget draws icons at 96 px (native `setBotIcon` downscales to it). */
const WIDGET_PX = 96;
const BOT_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const LUCIDE_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const MAX_BOTS = 64;

export interface IconNative {
  /** Stores (base64 PNG, downscaled natively) or removes (null) a bot's icon. False on failure. */
  setBotIcon(botId: string, base64Png: string | null): Promise<boolean>;
  /** Ids that have an icon in the keychain now. Optional: without it the index is trusted. */
  storedBotIcons?(): Promise<string[]>;
}

export interface IconClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}

export interface IconDeps {
  native: IconNative;
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
  /** The Lucide icon on its tile as base64 PNG; null for an unknown name. */
  renderLucide(name: string): Promise<string | null>;
  /** An avatar SVG (composed by the bots plugin from avatar.json) as base64 PNG; null when it fails. */
  renderSvg?(svg: string): Promise<string | null>;
  now(): number;
}

/** source: "avatar:<hash or path>" or "icon:<Lucide name>"; server: the host whose bots.list had it. */
type IconIndex = Record<string, { source: string; savedAt: number; server?: string }>;

export interface IconSyncResult {
  saved: string[];
  removed: string[];
  /** Each listed bot's Lucide icon name (valid names only). */
  names: Record<string, string>;
}

export interface IconSyncOptions {
  /** The host asked; only icons it stored are removed when its list lacks the bot. */
  serverId?: string;
  /** Bot ids to do first (the busy ones). */
  first?: readonly string[];
}

type Storage = IconDeps["storage"];

/** The Lucide names kept by the last sync; {} when none or unreadable. */
export async function loadIconNames(storage: Storage): Promise<Record<string, string>> {
  const raw = await storage.getItem(ICON_NAMES_KEY).catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const names: Record<string, string> = {};
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (BOT_ID.test(id) && typeof name === "string" && LUCIDE_NAME.test(name)) names[id] = name;
    }
    return names;
  } catch {
    return {};
  }
}

interface ListedBot {
  id: string;
  avatar: string | null;
  /** Content hash of the avatar (bots plugin `avatarHash`); null from older servers. */
  avatarHash: string | null;
  icon: string | null;
}

function listedBots(value: unknown): ListedBot[] | null {
  if (typeof value !== "object" || value === null) return null;
  const bots = (value as { bots?: unknown }).bots;
  if (!Array.isArray(bots)) return null;
  const out: ListedBot[] = [];
  for (const bot of bots.slice(0, MAX_BOTS)) {
    if (typeof bot !== "object" || bot === null) continue;
    const { id, avatar, avatarHash, icon } = bot as {
      id?: unknown;
      avatar?: unknown;
      avatarHash?: unknown;
      icon?: unknown;
    };
    if (typeof id !== "string" || !BOT_ID.test(id)) continue;
    out.push({
      id,
      avatar: typeof avatar === "string" && avatar ? avatar : null,
      avatarHash: typeof avatarHash === "string" && avatarHash ? avatarHash : null,
      icon: typeof icon === "string" && LUCIDE_NAME.test(icon) ? icon : null,
    });
  }
  return out;
}

async function loadIndex(deps: IconDeps): Promise<IconIndex> {
  const raw = await deps.storage.getItem(ICON_INDEX_KEY).catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const index: IconIndex = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const e = entry as { source?: unknown; savedAt?: unknown; server?: unknown } | null;
      if (BOT_ID.test(id) && typeof e?.source === "string" && typeof e.savedAt === "number") {
        index[id] = { source: e.source, savedAt: e.savedAt };
        if (typeof e.server === "string") index[id].server = e.server;
      }
    }
    return index;
  } catch {
    return {};
  }
}

/** The host's bots, the `first` ones first. Throws when the bots plugin did not answer. */
async function hostBots(client: IconClient, first: readonly string[]): Promise<ListedBot[]> {
  const bots = listedBots(await client.invokePluginRpc(BOTS_PLUGIN_ID, BOTS_LIST_METHOD, {}));
  if (!bots) throw new Error("bots.list: unexpected answer");
  const lead = new Set(first);
  return bots.sort((a, b) => Number(lead.has(b.id)) - Number(lead.has(a.id)));
}

/** Ids the keychain really holds; null when the native side cannot tell (trust the index). */
async function keychainIds(deps: IconDeps, index: IconIndex): Promise<Set<string> | null> {
  if (!deps.native.storedBotIcons) return null;
  return new Set(await deps.native.storedBotIcons().catch(() => Object.keys(index)));
}

/** An avatar the bots home keeps on the phone: composed SVG, or a PNG (base64) of `size` px (absent: full). */
export type SavedAvatar = { svg: string } | { png: string; size?: number };

/** A kept avatar query's drawable copy; null when the home loaded nothing drawable for it. */
function savedCopy(data: unknown): SavedAvatar | null {
  const d = (data ?? null) as { dataUri?: unknown; svg?: unknown; size?: unknown } | null;
  if (typeof d?.svg === "string" && d.svg.startsWith("<svg")) return { svg: d.svg };
  if (typeof d?.dataUri !== "string" || !d.dataUri.startsWith(PNG_PREFIX)) return null;
  const png = d.dataUri.slice(PNG_PREFIX.length);
  return typeof d.size === "number" ? { png, size: d.size } : { png };
}

/** [bot id, hash or path, copy] of a kept `["bots", "avatar", id, version, …]` query; null for others. */
function avatarEntry(query: unknown): [string, string, SavedAvatar | null] | null {
  const { queryKey, state } = (query ?? {}) as { queryKey?: unknown; state?: { data?: unknown } };
  if (!Array.isArray(queryKey) || queryKey[0] !== "bots" || queryKey[1] !== "avatar") return null;
  const [, , id, version] = queryKey as unknown[];
  if (typeof id !== "string" || !BOT_ID.test(id) || typeof version !== "string") return null;
  return [id, version, savedCopy(state?.data)];
}

async function keptQueries(storage: Storage, serverId: string): Promise<unknown[]> {
  const raw = await storage.getItem(pluginQueriesKey(serverId, BOTS_PLUGIN_ID)).catch(() => null);
  if (!raw) return [];
  try {
    const queries = (JSON.parse(raw) as { queries?: unknown }).queries;
    return Array.isArray(queries) ? queries : [];
  } catch {
    return [];
  }
}

/**
 * The bots plugin's avatars kept on the phone for this host, by bot id then hash (or path): what the
 * phone home draws, read from the persisted query cache. Empty when there is none or it is
 * unreadable. A version the home loaded with nothing drawable (file missing, not a PNG) maps to [].
 */
export async function readSavedAvatars(
  storage: Storage,
  serverId: string,
): Promise<Map<string, Map<string, SavedAvatar[]>>> {
  const out = new Map<string, Map<string, SavedAvatar[]>>();
  for (const query of await keptQueries(storage, serverId)) {
    const entry = avatarEntry(query);
    if (!entry) continue;
    const [id, version, copy] = entry;
    let byVersion = out.get(id);
    if (!byVersion) out.set(id, (byVersion = new Map()));
    byVersion.set(version, [...(byVersion.get(version) ?? []), ...(copy ? [copy] : [])]);
  }
  return out;
}

/** The kept avatar as a base64 PNG for the widget: the SVG rasterized, else (or if that fails) a PNG. */
async function savedPng(deps: IconDeps, copies: readonly SavedAvatar[]): Promise<string | null> {
  const copy = pickSavedAvatar(copies);
  if (copy && "svg" in copy && deps.renderSvg) {
    const png = await deps.renderSvg(copy.svg).catch(() => null);
    if (png) return png;
  }
  const fallback = pickSavedAvatar(copies.filter((c) => "png" in c));
  return fallback && "png" in fallback ? fallback.png : null;
}

/** The copy to draw at widget size: the SVG, else the smallest PNG of at least 96 px, else the biggest. */
export function pickSavedAvatar(saved: readonly SavedAvatar[]): SavedAvatar | null {
  const svg = saved.find((s) => "svg" in s);
  if (svg) return svg;
  const px = (s: SavedAvatar) => ("png" in s ? (s.size ?? Infinity) : 0);
  const pngs = saved.filter((s) => "png" in s).sort((a, b) => px(a) - px(b));
  return pngs.find((s) => px(s) >= WIDGET_PX) ?? pngs[pngs.length - 1] ?? null;
}

/** Brings the stored icons in line with the host's bots. Throws when the bots plugin is missing. */
export async function syncBotIcons(
  client: IconClient,
  deps: IconDeps,
  options: IconSyncOptions = {},
): Promise<IconSyncResult> {
  const bots = await hostBots(client, options.first ?? []);
  const index = await loadIndex(deps);
  const saved =
    options.serverId === undefined
      ? new Map<string, Map<string, SavedAvatar[]>>()
      : await readSavedAvatars(deps.storage, options.serverId);
  const result: IconSyncResult = { saved: [], removed: [], names: {} };
  for (const bot of bots) if (bot.icon) result.names[bot.id] = bot.icon;
  await deps.storage.setItem(ICON_NAMES_KEY, JSON.stringify(result.names)).catch(() => undefined);
  const now = deps.now();
  const server = options.serverId;
  // An index entry whose keychain item is gone is stored again.
  const stored = await keychainIds(deps, index);

  const remove = async (id: string) => {
    if (await deps.native.setBotIcon(id, null)) {
      delete index[id];
      result.removed.push(id);
    }
  };
  const save = async (id: string, source: string, png: string) => {
    if (await deps.native.setBotIcon(id, png)) {
      index[id] =
        server === undefined ? { source, savedAt: now } : { source, savedAt: now, server };
      result.saved.push(id);
    }
  };
  const fresh = (id: string, source: string) => {
    const held = index[id];
    if (!held || held.source !== source || now - held.savedAt >= ICON_REFRESH_MS) return false;
    return stored === null || stored.has(id);
  };
  /** Stores the bot's icon; false when it has nothing drawable. */
  const syncOne = async (bot: ListedBot): Promise<boolean> => {
    if (bot.avatar) {
      const version = bot.avatarHash ?? bot.avatar;
      const source = `avatar:${version}`;
      if (fresh(bot.id, source)) return true;
      const copies = saved.get(bot.id)?.get(version);
      const png = await savedPng(deps, copies ?? []);
      if (png) {
        await save(bot.id, source, png);
        return true;
      }
      // The home has not kept this version yet: keep the avatar stored for an older one.
      const held = index[bot.id];
      const kept = stored === null || stored.has(bot.id);
      if (copies === undefined && held?.source.startsWith("avatar:") && kept) return true;
      // No avatar on the phone (or the file is missing or not a PNG): the Lucide icon, as the home.
    }
    if (!bot.icon) return false;
    const source = `icon:${bot.icon}`;
    if (fresh(bot.id, source)) return true;
    const png = await deps.renderLucide(bot.icon).catch(() => null);
    if (!png) return false;
    await save(bot.id, source, png);
    return true;
  };

  // Bots no longer listed: removed, but only when this host stored them (another host may list
  // other bots; all share the keychain).
  const listed = new Set(bots.map((b) => b.id));
  for (const [id, entry] of Object.entries(index)) {
    const mine = server === undefined || entry.server === undefined || entry.server === server;
    if (!listed.has(id) && mine) await remove(id);
  }
  for (const bot of bots) {
    if (!(await syncOne(bot)) && index[bot.id]) await remove(bot.id);
  }
  await deps.storage.setItem(ICON_INDEX_KEY, JSON.stringify(index)).catch(() => undefined);
  return result;
}
