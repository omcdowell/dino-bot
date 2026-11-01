/**
 * Pure rule for the composer's swipe-down-to-dismiss gesture (13 Oct: "swiping down on the
 * text input box doesnt close the keyboard").
 *
 * A swipe counts when it has moved down more than SWIPE_MIN_DY, mostly vertically, and early in the
 * touch. A long-press text selection only starts dragging after ~500 ms, so it never counts.
 */
export const SWIPE_MIN_DY = 20;
export const SWIPE_MAX_MS = 450;

export interface SwipeDelta {
  dx: number;
  dy: number;
}

export function isComposerDismissSwipe(delta: SwipeDelta, elapsedMs: number): boolean {
  return delta.dy > SWIPE_MIN_DY && delta.dy > 2 * Math.abs(delta.dx) && elapsedMs <= SWIPE_MAX_MS;
}
