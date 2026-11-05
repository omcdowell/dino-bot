import { test } from "node:test";
import assert from "node:assert/strict";
import { homeOrder, mingle } from "../client/home-format";

const bot = (id: string, order: number, featured = false) => ({ id, name: id, order, featured });
const bots = [bot("fat", 0, true), bot("scrat", 1), bot("peggy", 2), bot("wallace", 3), bot("quiet", 4)];
const at: Record<string, string> = {
  fat: "2026-10-13T08:00:00Z",
  scrat: "2026-10-13T07:30:00Z",
  peggy: "2026-10-13T06:00:00Z",
  wallace: "2026-10-12T22:00:00Z",
};
const activity = (b: { id: string }) => at[b.id] ?? null;
const group = (id: string, lastTs: string | null) => ({ id, name: id, lastTs });
const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

test("a group rises among the bots by its last room message; the featured bot stays pinned", () => {
  const { featured, rest } = homeOrder(bots, activity);
  assert.equal(featured?.id, "fat");
  const rows = mingle(rest, [group("alarm-clock", "2026-10-13T07:00:00Z")], activity);
  assert.deepEqual(keys(rows), ["scrat", "group:alarm-clock", "peggy", "wallace", "quiet"]);
});

test("the newest group goes to the top of the list", () => {
  const { rest } = homeOrder(bots, activity);
  assert.deepEqual(keys(mingle(rest, [group("alarm-clock", "2026-10-13T09:00:00Z")], activity)), [
    "group:alarm-clock", "scrat", "peggy", "wallace", "quiet",
  ]);
});

test("several groups interleave by time; a tie keeps the bot first", () => {
  const { rest } = homeOrder(bots, activity);
  const rows = mingle(rest, [group("b", "2026-10-13T06:00:00Z"), group("a", "2026-10-13T07:45:00Z")], activity);
  assert.deepEqual(keys(rows), ["group:a", "scrat", "peggy", "group:b", "wallace", "quiet"]);
});

test("a group with no messages goes last; no groups leaves the bot order unchanged", () => {
  const { rest } = homeOrder(bots, activity);
  assert.deepEqual(keys(mingle(rest, [group("new", null)], activity)), ["scrat", "peggy", "wallace", "quiet", "group:new"]);
  assert.deepEqual(keys(mingle(rest, [], activity)), rest.map((b) => b.id));
});

test("rows carry the item", () => {
  const rows = mingle([bot("scrat", 1)], [group("g", "2026-10-13T09:00:00Z")], activity);
  assert.equal(rows[0]!.kind === "group" && rows[0]!.group.id, "g");
  assert.equal(rows[1]!.kind === "bot" && rows[1]!.bot.id, "scrat");
});
