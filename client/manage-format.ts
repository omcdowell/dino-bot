/**
 * Pure layout and rules for bot management on the phone home (build 31): the pinned row, the
 * archive filter, and the geometry of the press-and-hold pop-out. No react-native import, so it
 * runs under `tsx --test`.
 */
import { botKey, groupKey, MAX_PINS, pinProblem, type HomeState } from "../shared/manage";
import { homeOrder, mingle, type ChatRow } from "./home-format";

export type PinnedItem<B, G> = { kind: "bot"; key: string; bot: B } | { kind: "group"; key: string; group: G };
export type ArchivedItem<B, G> = PinnedItem<B, G> & { at: string };

/**
 * The state the home draws with. Until the host answers (or on a host without `home.state`), the
 * featured bot is pinned and nothing is archived: today's home.
 */
export function effectiveHomeState(state: HomeState | null | undefined, bots: ReadonlyArray<{ id: string; featured: boolean }>): HomeState {
  if (state) return state;
  const featured = bots.find((bot) => bot.featured);
  return { v: 1, pins: featured ? [botKey(featured.id)] : [], archived: {} };
}

/**
 * Pinned items (pin order, at most MAX_PINS, archived and unknown ones skipped), then every other
 * bot and group mingled by recency as before, archived ones left out; plus the archived list
 * (newest archive first) for the Archived sheet.
 */
export function homeLayout<
  B extends { id: string; name: string; order: number; featured: boolean },
  G extends { id: string; name: string; lastTs: string | null },
>(
  bots: readonly B[],
  groups: readonly G[],
  state: HomeState,
  botAt: (bot: B) => string | null | undefined,
): { pinned: PinnedItem<B, G>[]; rows: ChatRow<B, G>[]; archived: ArchivedItem<B, G>[] } {
  const botsByKey = new Map<string, B>(bots.map((bot) => [botKey(bot.id), bot]));
  const groupsByKey = new Map<string, G>(groups.map((group) => [groupKey(group.id), group]));
  const item = (key: string): PinnedItem<B, G> | null => {
    const bot = botsByKey.get(key);
    if (bot) return { kind: "bot", key, bot };
    const group = groupsByKey.get(key);
    return group ? { kind: "group", key, group } : null;
  };
  const isArchived = (key: string) => key in state.archived;
  const pinned = state.pins
    .filter((key) => !isArchived(key))
    .map(item)
    .filter((entry): entry is PinnedItem<B, G> => entry !== null)
    .slice(0, MAX_PINS);
  const pinnedKeys = new Set(pinned.map((entry) => entry.key));
  const listed = (key: string) => !isArchived(key) && !pinnedKeys.has(key);
  // homeOrder's featured slot is not used any more: every bot sorts by recency unless pinned.
  const unfeatured = bots.filter((bot) => listed(botKey(bot.id))).map((bot) => (bot.featured ? { ...bot, featured: false } : bot));
  const { rest } = homeOrder(unfeatured, botAt);
  const rows = mingle(rest, groups.filter((group) => listed(groupKey(group.id))), botAt);
  const archived = Object.entries(state.archived)
    .map(([key, at]) => {
      const entry = item(key);
      return entry ? { ...entry, at } : null;
    })
    .filter((entry): entry is ArchivedItem<B, G> => entry !== null)
    .sort((a, b) => b.at.localeCompare(a.at));
  return { pinned, rows, archived };
}

/** The sidebar's flat order: pinned items first, then the mingled rest. */
export function sidebarOrder<B, G>(layout: { pinned: PinnedItem<B, G>[]; rows: ChatRow<B, G>[] }): ChatRow<B, G>[] {
  return [...layout.pinned, ...layout.rows];
}

// ---------- pinned row ----------

export const SCREEN_MARGIN = 16;

/** Smallest space kept between neighbouring pinned names. */
export const PINNED_LABEL_GAP = 8;

/**
 * Pinned row: the width is split in three equal columns whatever the count, and the columns
 * present are spread evenly (one: centred). Returns each column's width and centre x, and
 * `labelWidth`: the room a name really has (13 Oct: "if there is space, full name should be
 * shown"). Alone, the screen width minus margins; with neighbours, the distance between centres
 * minus a small gap, so names never collide. Never wider than the screen around the outer centres.
 */
export function pinnedColumns(
  count: number,
  width: number,
): { columnWidth: number; centres: number[]; labelWidth: number } {
  const n = Math.max(0, Math.min(MAX_PINS, Math.floor(count)));
  const columnWidth = Math.max(0, (width - 2 * SCREEN_MARGIN) / MAX_PINS);
  if (n === 0) return { columnWidth, centres: [], labelWidth: columnWidth };
  const gap = (width - n * columnWidth) / (n + 1);
  const centres = Array.from({ length: n }, (_, i) => gap * (i + 1) + columnWidth * i + columnWidth / 2);
  const room = n === 1 ? width - 2 * SCREEN_MARGIN : centres[1]! - centres[0]! - PINNED_LABEL_GAP;
  const labelWidth = Math.max(0, Math.min(room, 2 * centres[0]!));
  return { columnWidth, centres, labelWidth };
}

/** Avatar size in the pinned row: as large as today's Fat Controller when alone. */
export function pinnedAvatarSize(count: number): number {
  return count <= 1 ? 88 : 68;
}

// ---------- press and hold ----------

/** The held pinned item: a fixed square (r5). */
export const HELD_SQUARE = 176;
/** Held list rows: pill inset from the screen edges, and the avatar's padding inside it. */
export const PILL_MARGIN = 16;
export const PILL_AVATAR_PADDING = 14;
/** A resting list row's side padding. */
export const ROW_PADDING = 16;
export const CIRCLE_SIZE = 52;
export const CIRCLE_GAP = 20;
/** Circles sit this far below the tile, or above it when below would end within BOTTOM_GUARD of the bottom. */
export const CIRCLES_OFFSET = 22;
export const BOTTOM_GUARD = 34;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the held pinned square sits: the same height as the pinned tile (vertical centre kept),
 * starting over the tile and sliding sideways only, to the horizontal centre of the screen.
 */
export function heldSquare(tile: Rect, screenWidth: number): { top: number; startLeft: number; endLeft: number } {
  const centreX = tile.x + tile.width / 2;
  const centreY = tile.y + tile.height / 2;
  return {
    top: Math.round(centreY - HELD_SQUARE / 2),
    startLeft: Math.round(centreX - HELD_SQUARE / 2),
    endLeft: Math.round(screenWidth / 2 - HELD_SQUARE / 2),
  };
}

/** The lifted pill grows to this (r4/r5 mock-ups). */
export const PILL_LIFT_SCALE = 1.02;

/**
 * The held list row: a pill where the row already is, sized so that once lifted (scaled to
 * PILL_LIFT_SCALE about its centre) it sits PILL_MARGIN from each screen edge. On b31 the pill was
 * laid out at the margin and then scaled, which left about 12 pt.
 */
export function heldPill(row: Rect, screenWidth: number): Rect {
  const width = Math.round(((screenWidth - 2 * PILL_MARGIN) / PILL_LIFT_SCALE) * 10) / 10;
  return { x: (screenWidth - width) / 2, y: row.y, width, height: row.height };
}

/**
 * The held list row is drawn once (14 Oct: no ghosting): the resting row's content, scaled
 * about its centre and moved to the pill's centre so it sits PILL_AVATAR_PADDING inside the lifted
 * pill. The pill keeps PILL_MARGIN from the screen edges, which is where the resting content
 * already ends, so the content has to shrink a little (~0.92 on a 402 pt screen).
 */
export function heldRowContent(row: Rect, screenWidth: number): { scale: number; shiftX: number } {
  const pill = heldPill(row, screenWidth);
  const inner = pill.width * PILL_LIFT_SCALE - 2 * PILL_AVATAR_PADDING;
  return {
    scale: inner / (row.width - 2 * ROW_PADDING),
    shiftX: pill.x + pill.width / 2 - (row.x + row.width / 2),
  };
}

/** The held pinned square's avatar size; the resting tile pads 8 pt above and 20 pt below. */
export const HELD_AVATAR = 72;
const TILE_PAD_TOP = 8;
const TILE_PAD_BOTTOM = 20;
const SQUARE_SPARE = 12;

/**
 * The held pinned tile is the resting tile drawn once, scaled so its avatar is HELD_AVATAR (capped so
 * it fits the square), and moved down so its content (not its padding) is centred in the square.
 */
export function heldTileContent(tile: Rect, avatarSize: number): { scale: number; shiftY: number } {
  const content = tile.height - TILE_PAD_TOP - TILE_PAD_BOTTOM;
  const fit = content > 0 ? (HELD_SQUARE - 2 * SQUARE_SPARE) / content : Infinity;
  const scale = Math.min(HELD_AVATAR / avatarSize, fit);
  return { scale, shiftY: ((TILE_PAD_BOTTOM - TILE_PAD_TOP) / 2) * scale };
}

/**
 * Milliseconds until a critically damped spring released at rest from `from` is within `to` of its
 * target: solves (1 + u)·e^(−u) = to / from for u = ω·t.
 */
export function criticalSpringTime(from: number, to: number, stiffness: number, mass: number): number {
  if (from <= to) return 0;
  const ratio = to / from;
  let lo = 0;
  let hi = 60;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if ((1 + mid) * Math.exp(-mid) > ratio) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2 / Math.sqrt(stiffness / mass)) * 1000;
}

/**
 * Top of the circle row for a held tile occupying [top, top + height]: CIRCLES_OFFSET below it,
 * unless that would end within BOTTOM_GUARD of the screen bottom; then CIRCLES_OFFSET above it.
 */
export function circlesPlacement(tileTop: number, tileHeight: number, screenHeight: number): { top: number; where: "below" | "above" } {
  const below = tileTop + tileHeight + CIRCLES_OFFSET;
  if (below + CIRCLE_SIZE <= screenHeight - BOTTOM_GUARD) return { top: below, where: "below" };
  return { top: tileTop - CIRCLES_OFFSET - CIRCLE_SIZE, where: "above" };
}

/** The Pin circle for `key`: Unpin when pinned; greyed (with the message to show on tap) when the row is full. */
export function pinCircle(state: HomeState, key: string): { pinned: boolean; disabled: boolean; message: string | null } {
  const pinned = state.pins.includes(key);
  const message = pinned ? null : pinProblem(state, key);
  return { pinned, disabled: message !== null, message };
}

// ---------- group editor ----------

/** Toggle a member: removing one also drops its lead; the first member added becomes lead when there is none. */
export function toggleMember(edit: { members: string[]; leads: string[] }, botId: string): { members: string[]; leads: string[] } {
  if (edit.members.includes(botId)) {
    return { members: edit.members.filter((m) => m !== botId), leads: edit.leads.filter((l) => l !== botId) };
  }
  const members = [...edit.members, botId];
  return { members, leads: edit.leads.length ? edit.leads : [botId] };
}

/** Toggle lead on a member (non-members cannot lead). */
export function toggleLead(edit: { members: string[]; leads: string[] }, botId: string): { members: string[]; leads: string[] } {
  if (!edit.members.includes(botId)) return edit;
  return edit.leads.includes(botId)
    ? { ...edit, leads: edit.leads.filter((l) => l !== botId) }
    : { ...edit, leads: [...edit.leads, botId] };
}

/** Hint next to "Members" in the group sheet: desktop/web users click, phone users tap. */
export function leadHint(os: string): string {
  return `${os === "web" ? "click" : "tap"} to make lead`;
}

/** Dark theme when the base surface is dark (the plugin theme has no flag). Unknown colours: light. */
export function isDarkSurface(color: string): boolean {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return false;
  const full = hex.length === 3 ? hex.split("").map((ch) => ch + ch).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.5;
}
