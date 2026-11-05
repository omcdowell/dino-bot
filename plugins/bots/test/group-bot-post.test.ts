import { test } from "node:test";
import assert from "node:assert/strict";
import type { Group, RoomMessage } from "../shared/rooms/schema";
import { replyLine, threadItems } from "../client/group-format";
import { normaliseMessage } from "../client/group-cache";

const GROUP: Group = { id: "alarm-clock", name: "Alarm Clock", members: ["wallace", "scrat", "peggy"], leads: ["wallace"] };
const NAMES = { wallace: "Wallace", scrat: "Scrat", peggy: "Peggy" };
const msg = (id: string, from: string, text: string, extra: Partial<RoomMessage> = {}): RoomMessage => ({
  v: 1, id, ts: "2026-10-13T17:10:00.000Z", group: GROUP.id, from, text, hop: 0, to: [], ...extra,
});

test("replyLine: first words of the task, mentions and task: dropped; a missing task says from main chat", () => {
  assert.equal(replyLine({ text: "@peggy task: draft the launch copy" }), "re: draft the launch copy");
  assert.equal(replyLine({ text: "@Peggy, @scrat task: one two three four five six seven eight nine" }), "re: one two three four five six seven eight…");
  assert.equal(replyLine(undefined), "from main chat");
  assert.equal(replyLine({ text: "@peggy" }), "from main chat");
});

test("threadItems: a main-chat post (via main) carries a re: line; room replies do not", () => {
  const items = threadItems(
    [
      msg("A", "user", "@peggy task: draft the launch copy", { to: ["peggy", "wallace"] }),
      msg("B", "peggy", "On it.", { re: "A", hop: 1 }),
      msg("C", "peggy", "Done: docs/launch.md", { re: "A", hop: 1, via: "main" }),
      msg("D", "scrat", "orphan", { re: "ZZZ", hop: 1, via: "main" }),
    ],
    GROUP,
    NAMES,
  );
  const bots = items.filter((i): i is Extract<typeof i, { kind: "bot" }> => i.kind === "bot");
  assert.deepEqual(bots.map((b) => [b.msg.id, b.reLine]), [["B", undefined], ["C", "re: draft the launch copy"], ["D", "from main chat"]]);
});

test("group cache keeps via: main", () => {
  assert.equal(normaliseMessage({ ...msg("C", "peggy", "x"), via: "main" })!.via, "main");
  assert.equal(normaliseMessage({ ...msg("C", "peggy", "x"), via: "other" })!.via, undefined);
});
