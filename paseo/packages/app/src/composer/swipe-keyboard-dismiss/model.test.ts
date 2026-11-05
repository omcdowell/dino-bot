import { describe, expect, it } from "vitest";
import { isComposerDismissSwipe, SWIPE_MAX_MS, SWIPE_MIN_DY } from "./model";

describe("isComposerDismissSwipe", () => {
  it("accepts a quick downward swipe", () => {
    expect(isComposerDismissSwipe({ dx: 4, dy: 30 }, 120)).toBe(true);
  });

  it("ignores taps and small jitter", () => {
    expect(isComposerDismissSwipe({ dx: 0, dy: 0 }, 80)).toBe(false);
    expect(isComposerDismissSwipe({ dx: 2, dy: SWIPE_MIN_DY }, 80)).toBe(false);
  });

  it("ignores upward and sideways moves", () => {
    expect(isComposerDismissSwipe({ dx: 0, dy: -40 }, 120)).toBe(false);
    expect(isComposerDismissSwipe({ dx: 30, dy: 40 }, 120)).toBe(false);
  });

  it("ignores a late drag such as long-press text selection", () => {
    expect(isComposerDismissSwipe({ dx: 0, dy: 60 }, SWIPE_MAX_MS + 1)).toBe(false);
  });
});
