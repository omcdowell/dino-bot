import { test } from "node:test";
import assert from "node:assert/strict";
import { keyboardOverlap, keyboardTopFrom } from "../client/keyboard-geometry";

// iPhone 17: 874 pt tall, safe top 62. The app's plugin ScreenHeader is 62 + 8 + 56 + 1 = 127 pt,
// so the plugin screen's container starts at y = 127 and runs to the bottom of the window.
const SCREEN = 874;
const HEADER = 127;
const KEYBOARD = 336; // with the QuickType bar
const screenFrame = { y: HEADER, height: SCREEN - HEADER };

test("keyboard up: the inset is the full keyboard height for a screen mounted under a header", () => {
  const top = keyboardTopFrom("change", { screenY: SCREEN - KEYBOARD, height: KEYBOARD });
  assert.equal(keyboardOverlap(screenFrame, top), KEYBOARD);
});

test("regression: RN KeyboardAvoidingView math (parent-relative frame) came out short by the header", () => {
  // KeyboardAvoidingView uses onLayout's frame, y = 0 relative to the plugin body.
  const kavPadding = Math.max(0 + (SCREEN - HEADER) - (SCREEN - KEYBOARD), 0);
  assert.equal(kavPadding, KEYBOARD - HEADER);
  assert.equal(keyboardOverlap(screenFrame, SCREEN - KEYBOARD) - kavPadding, HEADER);
});

test("keyboard hidden: no inset", () => {
  assert.equal(keyboardOverlap(screenFrame, keyboardTopFrom("hide", { screenY: SCREEN - KEYBOARD, height: KEYBOARD })), 0);
  assert.equal(keyboardOverlap(screenFrame, keyboardTopFrom("change", { screenY: SCREEN, height: 0 })), 0);
  // iOS will-change-frame on hide: frame moved below the screen.
  assert.equal(keyboardOverlap(screenFrame, keyboardTopFrom("change", { screenY: SCREEN, height: KEYBOARD })), 0);
  assert.equal(keyboardOverlap(screenFrame, null), 0);
  assert.equal(keyboardOverlap(null, 400), 0);
});

test("a view that already ends above the keyboard needs no inset (e.g. Android adjustResize)", () => {
  assert.equal(keyboardOverlap({ y: 127, height: 400 }, 538), 0);
});

test("a view that ends above the window bottom (tab bar, sheet) is padded only by the part covered", () => {
  assert.equal(keyboardOverlap({ y: 127, height: 700 }, 538), 127 + 700 - 538);
});

test("fractional window coordinates round to whole points", () => {
  assert.equal(keyboardOverlap({ y: 126.66, height: 747.34 }, 537.5), 337);
});
