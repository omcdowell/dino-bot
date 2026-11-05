import { test } from "node:test";
import assert from "node:assert/strict";
import { isDismissSwipe, SWIPE_MAX_MS, SWIPE_MIN_DY } from "../client/keyboard-geometry";

test("a quick downward swipe dismisses", () => {
  assert.equal(isDismissSwipe({ dx: 4, dy: 30 }, 120), true);
});

test("a tap or a small jitter does not", () => {
  assert.equal(isDismissSwipe({ dx: 0, dy: 0 }, 80), false);
  assert.equal(isDismissSwipe({ dx: 2, dy: SWIPE_MIN_DY }, 80), false);
});

test("upward or sideways moves do not", () => {
  assert.equal(isDismissSwipe({ dx: 0, dy: -40 }, 120), false);
  assert.equal(isDismissSwipe({ dx: 30, dy: 40 }, 120), false);
});

test("a late drag (long-press text selection) does not", () => {
  assert.equal(isDismissSwipe({ dx: 0, dy: 60 }, SWIPE_MAX_MS + 1), false);
});
