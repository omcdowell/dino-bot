import { test } from "node:test";
import assert from "node:assert/strict";
import { claimTapJump, TAP_JUMP_WINDOW_MS } from "../client/tap-jump";

const TAP_AT = 1_760_000_000_000;

test("a fresh tap jumps once; Back to the same screen does not jump again", () => {
  const consumed = new Set<string>();
  assert.equal(claimTapJump(`${TAP_AT}`, consumed, TAP_AT + 50), true);
  assert.equal(claimTapJump(`${TAP_AT}`, consumed, TAP_AT + 2_000), false);
});

test("no nonce, no jump", () => {
  assert.equal(claimTapJump(undefined, new Set(), TAP_AT), false);
  assert.equal(claimTapJump("", new Set(), TAP_AT), false);
  assert.equal(claimTapJump("not-a-time", new Set(), TAP_AT), false);
});

// The bug: the bot screen stays mounted (hidden) under the chat it opened. When the host reconnects
// (daemon restart) or the plugin is reloaded, the plugin bundle is evaluated again, so the set of used
// taps starts empty and the hidden screen remounts. An old tap must not jump again.
test("an old tap does not jump after the plugin is evaluated again", () => {
  const afterReconnect = new Set<string>();
  assert.equal(claimTapJump(`${TAP_AT}`, afterReconnect, TAP_AT + 23_000), false);
  assert.equal(claimTapJump(`${TAP_AT}`, afterReconnect, TAP_AT + 60 * 60_000), false);
});

test("the window edge", () => {
  assert.equal(claimTapJump(`${TAP_AT}`, new Set(), TAP_AT + TAP_JUMP_WINDOW_MS), true);
  assert.equal(claimTapJump(`${TAP_AT}`, new Set(), TAP_AT + TAP_JUMP_WINDOW_MS + 1), false);
});
