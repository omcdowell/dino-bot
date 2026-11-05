/**
 * Geometry and data rules for the phone's floating workspace header (option D): no solid bar,
 * just Liquid Glass controls floating over the chat, with the chat fading out under them.
 *
 * Kept free of React so the numbers the chat inset, the fade and the toasts all depend on are
 * defined (and tested) in one place.
 */

/** iOS-standard 44pt touch target; every control and pill in the row is this tall. */
export const MOBILE_FLOATING_HEADER_CONTROL_SIZE = 44;
/** Space between the status bar (safe area) and the controls. */
export const MOBILE_FLOATING_HEADER_TOP_GAP = 2;
/** Space kept clear below the controls before the first line of content. */
export const MOBILE_FLOATING_HEADER_BOTTOM_GAP = 8;
/** Horizontal margin of the control row, and the gap between its controls. */
export const MOBILE_FLOATING_HEADER_SIDE_MARGIN = 12;
export const MOBILE_FLOATING_HEADER_GAP = 8;
/** How far below the inset the fade keeps going, so it ends softly, not on a line. */
const FADE_TAIL = 24;

/**
 * Distance from the top of the screen to where content can start without being covered: the
 * chat's top inset, the padding of tabs that do not scroll under, and the toast offset.
 */
export function resolveMobileFloatingHeaderInset(safeAreaTop: number): number {
  return (
    Math.max(0, safeAreaTop) +
    MOBILE_FLOATING_HEADER_TOP_GAP +
    MOBILE_FLOATING_HEADER_CONTROL_SIZE +
    MOBILE_FLOATING_HEADER_BOTTOM_GAP
  );
}

export interface MobileFloatingHeaderFadeStop {
  /** 0..1 down the fade. */
  offset: number;
  /** Opacity of the screen background colour at this point. */
  opacity: number;
}

/**
 * The scroll-edge fade behind the controls: the screen background, solid behind the status bar,
 * still mostly opaque behind the controls (so the text sliding under them does not fight their
 * labels), then easing out to nothing below them. Shaped like iOS 26's soft scroll edge.
 */
export function resolveMobileFloatingHeaderFade(safeAreaTop: number): {
  height: number;
  stops: MobileFloatingHeaderFadeStop[];
} {
  const top = Math.max(0, safeAreaTop);
  const inset = resolveMobileFloatingHeaderInset(top);
  const height = inset + FADE_TAIL;
  const controlsTop = top + MOBILE_FLOATING_HEADER_TOP_GAP;
  const controlsBottom = controlsTop + MOBILE_FLOATING_HEADER_CONTROL_SIZE;
  const at = (y: number) => Math.min(1, Math.max(0, y / height));
  const points: MobileFloatingHeaderFadeStop[] = [
    { offset: 0, opacity: 1 },
    { offset: at(top), opacity: 1 },
    { offset: at(controlsTop + MOBILE_FLOATING_HEADER_CONTROL_SIZE * 0.5), opacity: 0.9 },
    { offset: at(controlsBottom), opacity: 0.72 },
    { offset: at(inset), opacity: 0.4 },
    { offset: at(inset + FADE_TAIL * 0.5), opacity: 0.12 },
    { offset: 1, opacity: 0 },
  ];
  // Without a status bar the first two points coincide; keep offsets strictly increasing.
  return {
    height,
    stops: points.filter((stop, index) => index === 0 || stop.offset > points[index - 1].offset),
  };
}

/**
 * Whether a tab draws its own content under the floating controls. Only the native chat does:
 * it takes the inset as scroll inset, so its history scrolls under the glass and its first
 * message still rests below it. Everything else (terminals, browsers, files, drafts, and the web
 * chat, whose virtualizer measures from a fixed top padding) is laid out below the controls.
 */
export function drawsUnderMobileFloatingHeader(input: { kind: string; platform: string }): boolean {
  return input.platform !== "web" && input.kind === "agent";
}

/** The header sheet's Tabs group lists the tab you are on first, like the Terminal profiles list. */
export function orderTabsActiveFirst<T extends { key: string }>(
  tabs: readonly T[],
  activeKey: string | null | undefined,
): T[] {
  const index = tabs.findIndex((tab) => tab.key === activeKey);
  if (index <= 0) return [...tabs];
  return [tabs[index], ...tabs.slice(0, index), ...tabs.slice(index + 1)];
}

export interface WorkspaceBot {
  id: string;
  name: string;
  cwd: string;
  hasAvatar: boolean;
  /** Content hash of the avatar (`bots.list` `avatarHash`); null from older servers. */
  avatarHash: string | null;
}

/** The bots plugin's `bots.list` answer, keeping only what the header needs. */
export function parseBotsList(value: unknown): WorkspaceBot[] {
  if (typeof value !== "object" || value === null) return [];
  const bots = (value as { bots?: unknown }).bots;
  if (!Array.isArray(bots)) return [];
  const out: WorkspaceBot[] = [];
  for (const bot of bots) {
    if (typeof bot !== "object" || bot === null) continue;
    const { id, name, cwd, avatar, avatarHash } = bot as Record<string, unknown>;
    if (typeof id !== "string" || typeof cwd !== "string" || !id || !cwd) continue;
    out.push({
      id,
      name: typeof name === "string" && name ? name : id,
      cwd,
      hasAvatar: typeof avatar === "string" && avatar.length > 0,
      avatarHash: typeof avatarHash === "string" && avatarHash ? avatarHash : null,
    });
  }
  return out;
}

function normalizeDirectory(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** A workspace is a bot's when its directory is the bot's folder. */
export function findWorkspaceBot(
  bots: readonly WorkspaceBot[],
  workspaceDirectory: string | null | undefined,
): WorkspaceBot | null {
  if (!workspaceDirectory) return null;
  const target = normalizeDirectory(workspaceDirectory);
  return bots.find((bot) => normalizeDirectory(bot.cwd) === target) ?? null;
}
