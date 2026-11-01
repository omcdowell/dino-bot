/**
 * The phone home's top fade.
 *
 * Build 20 ("a much longer fade on the bot home starting from the center of the triple
 * dots. match the fade in the chat header d mock up") used the D mockup's `.fade2` curve from the
 * ⋯ centre, but drew it in two pieces: the solid bar down to its edge, then an overlay starting at
 * 0.88. The 12% step where they met, exactly where the plugin's scroll view clipped its content,
 * was the hard line, and the fade lay over the avatar at rest.
 *
 * Now ("the hard line is still there, the fade covers the top of the avatar when it should
 * be in clear view", then "make sure the resting point is in the correct place"): one layer, one
 * gradient, from the top of the screen. The bar floats on it, the plugin's content runs under it
 * to the top of the screen (so nothing is clipped below the status bar) but rests exactly where it
 * did in builds 18/19, and the fade is fitted to that: clear by the top of the avatar.
 *
 * Curve shape: the D mockup's stops (solid, 0.94, 0.78, 0.45, 0.15, clear at 22/42/60/74/82 of
 * 82), scaled to the run from the status bar to the avatar.
 */
export const HOME_FADE_CURVE: ReadonlyArray<{ at: number; opacity: number }> = [
  { at: 0, opacity: 1 },
  { at: 22, opacity: 0.94 },
  { at: 42, opacity: 0.78 },
  { at: 60, opacity: 0.45 },
  { at: 74, opacity: 0.15 },
  { at: 82, opacity: 0 },
];

/** Length of the fade below the ⋯ centre, in points. */
export const HOME_FADE_LENGTH = HOME_FADE_CURVE[HOME_FADE_CURVE.length - 1].at;

/**
 * The plugin home's top padding above its first item (the featured bot's avatar box): at rest the
 * avatar's crown starts this far below the bar's bottom edge. The fade must be fully clear by then.
 */
export const HOME_FIRST_ITEM_TOP_GAP = 8;

/** Opacity of the curve `at` points below the ⋯ centre (linear between stops, like CSS). */
export function homeFadeOpacity(at: number): number {
  if (at <= 0) return 1;
  for (let i = 1; i < HOME_FADE_CURVE.length; i++) {
    const a = HOME_FADE_CURVE[i - 1];
    const b = HOME_FADE_CURVE[i];
    if (at <= b.at) return a.opacity + ((b.opacity - a.opacity) * (at - a.at)) / (b.at - a.at);
  }
  return 0;
}

export interface HomeFadeStop {
  /** 0..1 down the fade layer. */
  offset: number;
  opacity: number;
}

/**
 * The single fade layer, measured from the top of the screen, fitted to the home's resting layout
 * (on build 21: "make sure the resting point is in the correct place"):
 * - the content rests where it always has, its top at the bar's bottom edge (`barBottomY`), so the
 *   scroll inset is exactly that;
 * - the layer is solid behind the status bar (to `safeAreaTop`), then follows the D mockup's curve,
 *   squeezed to end fully clear at the top of the first item, so at rest the avatar and its crown
 *   are in clear view and only content scrolled up under the bar fades.
 */
export function homeFadeLayer(input: { safeAreaTop: number; barBottomY: number }): {
  height: number;
  stops: HomeFadeStop[];
  contentInsetTop: number;
} {
  const solidUntil = Math.max(0, input.safeAreaTop);
  const clearAt = Math.max(solidUntil + 1, input.barBottomY + HOME_FIRST_ITEM_TOP_GAP);
  const length = clearAt - solidUntil;
  const stops: HomeFadeStop[] = [{ offset: 0, opacity: 1 }];
  for (const point of HOME_FADE_CURVE) {
    const offset = (solidUntil + (point.at / HOME_FADE_LENGTH) * length) / clearAt;
    if (offset > stops[stops.length - 1].offset) stops.push({ offset, opacity: point.opacity });
  }
  return { height: clearAt, stops, contentInsetTop: Math.max(0, input.barBottomY) };
}
