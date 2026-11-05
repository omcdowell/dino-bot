/** Pure keyboard geometry for `keyboard-inset.ts` (no react-native import, so it is unit-testable). */

export interface WindowFrame {
  /** Top of the view in window coordinates. */
  y: number;
  height: number;
}

/**
 * How far the keyboard reaches up into the view: the bottom padding that keeps the view's content
 * above it. `keyboardTop` is the keyboard's top edge in window coordinates, or null when hidden.
 */
export function keyboardOverlap(frame: WindowFrame | null, keyboardTop: number | null): number {
  if (!frame || keyboardTop === null || !Number.isFinite(keyboardTop)) return 0;
  const overlap = frame.y + frame.height - keyboardTop;
  return overlap > 0 ? Math.round(overlap) : 0;
}

/**
 * The keyboard's top edge from a keyboard event, or null when the event hides it. iOS reports a
 * hide as a frame that starts at (or below) the bottom of the screen, or with zero height.
 */
export function keyboardTopFrom(kind: "show" | "hide" | "change", end: { screenY: number; height: number } | undefined): number | null {
  if (kind === "hide" || !end || !(end.height > 0)) return null;
  return end.screenY;
}

/** `swipe-dismiss.ts`: a quick, mostly vertical swipe down (not a late long-press selection drag). */
export const SWIPE_MIN_DY = 20;
export const SWIPE_MAX_MS = 450;

export function isDismissSwipe(g: { dx: number; dy: number }, elapsedMs: number): boolean {
  return g.dy > SWIPE_MIN_DY && g.dy > 2 * Math.abs(g.dx) && elapsedMs <= SWIPE_MAX_MS;
}
