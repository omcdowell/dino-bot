import { describe, expect, it } from "vitest";
import {
  HOME_FADE_LENGTH,
  HOME_FIRST_ITEM_TOP_GAP,
  homeFadeLayer,
  homeFadeOpacity,
} from "./home-top-fade-stops";

// iPhone 17: 62 pt safe area; the bar is 8 pt padding + the 44 pt ⋯ button + 8 pt padding.
const SAFE_TOP = 62;
const BAR_BOTTOM = 62 + 8 + 44 + 8;

describe("home top fade", () => {
  it("keeps the D mockup's curve shape", () => {
    expect(HOME_FADE_LENGTH).toBe(82);
    expect(homeFadeOpacity(0)).toBe(1);
    expect(homeFadeOpacity(22)).toBeCloseTo(0.94);
    expect(homeFadeOpacity(82)).toBe(0);
  });

  it("leaves the content resting where builds 18/19 had it: top at the bar's bottom edge", () => {
    expect(homeFadeLayer({ safeAreaTop: SAFE_TOP, barBottomY: BAR_BOTTOM }).contentInsetTop).toBe(
      BAR_BOTTOM,
    );
  });

  it("is one gradient, solid behind the status bar, fully clear by the top of the first item", () => {
    const layer = homeFadeLayer({ safeAreaTop: SAFE_TOP, barBottomY: BAR_BOTTOM });
    const firstItemTop = BAR_BOTTOM + HOME_FIRST_ITEM_TOP_GAP;
    expect(layer.height).toBe(firstItemTop);
    expect(layer.stops[0]).toEqual({ offset: 0, opacity: 1 });
    const solid = layer.stops[1];
    expect(solid.opacity).toBe(1);
    expect(solid.offset * layer.height).toBeCloseTo(SAFE_TOP);
    expect(layer.stops.at(-1)).toEqual({ offset: 1, opacity: 0 });
    expect(layer.stops.map((stop) => stop.opacity)).toEqual([1, 1, 0.94, 0.78, 0.45, 0.15, 0]);
    for (let index = 1; index < layer.stops.length; index += 1) {
      expect(layer.stops[index].offset).toBeGreaterThan(layer.stops[index - 1].offset);
      expect(layer.stops[index].opacity).toBeLessThanOrEqual(layer.stops[index - 1].opacity);
    }
  });

  it("still works without a status bar", () => {
    const layer = homeFadeLayer({ safeAreaTop: 0, barBottomY: 60 });
    expect(layer.stops[0]).toEqual({ offset: 0, opacity: 1 });
    expect(layer.stops.at(-1)).toEqual({ offset: 1, opacity: 0 });
    expect(layer.contentInsetTop).toBe(60);
  });
});
