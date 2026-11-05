import { test } from "node:test";
import assert from "node:assert/strict";
import type { RoomMessage } from "../shared/rooms/schema";
import { pendingArrived, startPending } from "../client/group-pending";

const msg = (id: string, from: string, text: string): RoomMessage => ({
  v: 1,
  id,
  ts: "2026-11-05T01:00:00.000Z",
  group: "g",
  from,
  text,
  hop: from === "user" ? 0 : 1,
  to: [],
});

const before = [msg("m1", "user", "hello"), msg("m2", "wallace", "hi")];

test("no pending copy: nothing to drop", () => {
  assert.equal(pendingArrived(null, before), false);
});

test("the sent message is not in the thread yet: the optimistic copy stays", () => {
  const pending = startPending("Plan the trip", "Sending to Wallace…", before);
  assert.equal(pendingArrived(pending, before), false);
});

test("review video bug: the host shows the message before rooms.post answers (no id yet), so it is matched by text", () => {
  const pending = startPending("Plan the trip ", "Sending to Wallace…", before);
  assert.equal(pending.id, null);
  const after = [...before, msg("m3", "user", "Plan the trip")]; // the host trims
  assert.equal(pendingArrived(pending, after), true);
});

test("an older message with the same text does not count: only one new since Send", () => {
  const thread = [...before, msg("m3", "user", "ok")];
  const pending = startPending("ok", "", thread);
  assert.equal(pendingArrived(pending, thread), false);
  assert.equal(pendingArrived(pending, [...thread, msg("m4", "user", "ok")]), true);
});

test("a bot's line with the same text is not the owner's message", () => {
  const pending = startPending("yes", "", before);
  assert.equal(pendingArrived(pending, [...before, msg("m3", "wallace", "yes")]), false);
});

test("once rooms.post answered, the id decides", () => {
  const pending = { ...startPending("go", "", before), id: "m9" };
  assert.equal(pendingArrived(pending, [...before, msg("m3", "user", "go")]), false);
  assert.equal(pendingArrived(pending, [...before, msg("m9", "user", "go")]), true);
});
