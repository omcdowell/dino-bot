/**
 * Bot management on the phone home (build 31): pins, archive, create and edit bots and groups.
 * Pure shapes and rules shared by the server and the client; imports nothing but `zod`.
 *
 * Items are keyed "bot:<id>" or "group:<id>". The state lives on the host in `~/bots/.home.json`
 * so the phone and the laptop agree.
 */
import { z } from "zod";

/** Pinned items shown in the row at the top of the phone home. */
export const MAX_PINS = 3;
export const PIN_FULL_MESSAGE = "You have 3 bots pinned already.";

export type ItemKind = "bot" | "group";
export type ItemKey = `${ItemKind}:${string}`;

export const ITEM_KEY_RE = /^(bot|group):[a-z0-9][a-z0-9_-]{0,63}$/;
export const ItemKeySchema = z.string().regex(ITEM_KEY_RE, "not a bot or group key");

export const botKey = (id: string): ItemKey => `bot:${id}`;
export const groupKey = (id: string): ItemKey => `group:${id}`;

export function parseKey(key: string): { kind: ItemKind; id: string } | null {
  if (!ITEM_KEY_RE.test(key)) return null;
  const at = key.indexOf(":");
  return { kind: key.slice(0, at) as ItemKind, id: key.slice(at + 1) };
}

export const HomeStateSchema = z.object({
  v: z.literal(1),
  /** Pinned items in pin order (oldest pin first), at most MAX_PINS. */
  pins: z.array(z.string()),
  /** Archived item -> when it was archived (ISO). Hidden from home and sidebar; nothing is deleted. */
  archived: z.record(z.string(), z.string()),
});
export type HomeState = z.infer<typeof HomeStateSchema>;

/** A state with no pins and nothing archived. */
export const EMPTY_HOME_STATE: HomeState = { v: 1, pins: [], archived: {} };

/** Why `key` cannot be pinned in `state` (null: it can, or it already is). */
export function pinProblem(state: HomeState, key: string): string | null {
  if (state.pins.includes(key)) return null;
  if (state.pins.length >= MAX_PINS) return PIN_FULL_MESSAGE;
  return null;
}

/** Pin or unpin. Pinning a full row throws PIN_FULL_MESSAGE; pinning unarchives nothing. */
export function setPinned(state: HomeState, key: string, pinned: boolean): HomeState {
  if (!pinned) return state.pins.includes(key) ? { ...state, pins: state.pins.filter((k) => k !== key) } : state;
  if (state.pins.includes(key)) return state;
  const problem = pinProblem(state, key);
  if (problem) throw new Error(problem);
  return { ...state, pins: [...state.pins, key] };
}

/** Archive (also unpins, so an archived item never holds a pin slot) or unarchive. */
export function setArchived(state: HomeState, key: string, archived: boolean, at: string): HomeState {
  if (!archived) {
    if (!(key in state.archived)) return state;
    const { [key]: _gone, ...rest } = state.archived;
    return { ...state, archived: rest };
  }
  return {
    ...state,
    pins: state.pins.filter((k) => k !== key),
    archived: { ...state.archived, [key]: state.archived[key] ?? at },
  };
}

/** Bot folder id for a new bot's name: "Tweety Bird" -> "tweety-bird". Empty when nothing usable is left. */
export function botIdFor(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/** Group id for a new group's name (same rule as a bot id, max 41 chars for GROUP_ID_RE). */
export function groupIdFor(name: string): string {
  return botIdFor(name).slice(0, 41).replace(/-+$/g, "");
}

/** The AGENTS.md a new bot starts with. */
export function agentsTemplate(name: string): string {
  const title = name.trim() || "New bot";
  return `# ${title}\n\n${title} - describe what this bot owns in one line.\n\nYou are a PM who orchestrates subagents; delegate work as task units.\n`;
}

export const NAME_MAX = 60;
export const AGENTS_MD_MAX = 200_000;
/** Decoded size cap for an uploaded avatar PNG (the picker sends at most 384 px). */
export const AVATAR_UPLOAD_MAX = 768 * 1024;
