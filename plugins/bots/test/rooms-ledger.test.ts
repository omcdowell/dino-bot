import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRoomMessage, readRoom, roomDir, roomsRoot, ROOM_FILE } from "../server/rooms/ledger";
import { GroupsFile, validateGroups } from "../server/rooms/groups";
import type { RoomMessage } from "../shared/rooms/schema";
import { fixture } from "./rooms-fakes";

const msg = (id: string, over: Partial<RoomMessage> = {}): RoomMessage => ({
  v: 1,
  id,
  ts: "2026-10-13T16:40:00.000Z",
  group: "alarm-clock",
  from: "user",
  text: `text ${id}`,
  hop: 0,
  to: [],
  ...over,
});

test("roomsRoot honours PASEO_BOTS_ROOMS", () => {
  assert.equal(roomsRoot({ PASEO_BOTS_ROOMS: "/x/rooms" }), "/x/rooms");
  assert.match(roomsRoot({}), /\.local\/state\/bot-rooms$/);
});

test("append then read: oldest first, dir 0700, file 0600", async () => {
  const { base, roomsRoot: root } = fixture();
  try {
    const dir = roomDir(root, "alarm-clock");
    await appendRoomMessage(dir, msg("A"));
    await appendRoomMessage(dir, msg("B", { from: "wallace", hop: 1, to: ["scrat"], re: "A" }));
    const { messages, truncated } = await readRoom(dir);
    assert.deepEqual(messages.map((m) => m.id), ["A", "B"]);
    assert.equal(messages[1]!.re, "A");
    assert.equal(truncated, false);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, ROOM_FILE)).mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("read skips bad lines; a torn last line does not swallow the next append", async () => {
  const { base, roomsRoot: root } = fixture();
  try {
    const dir = roomDir(root, "alarm-clock");
    await appendRoomMessage(dir, msg("A"));
    appendFileSync(join(dir, ROOM_FILE), '{"v":1,"id":"torn"');
    await appendRoomMessage(dir, msg("B"));
    appendFileSync(join(dir, ROOM_FILE), '{"v":2,"id":"future"}\nnot json\n');
    const { messages } = await readRoom(dir);
    assert.deepEqual(messages.map((m) => m.id), ["A", "B"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("before and limit page backwards", async () => {
  const { base, roomsRoot: root } = fixture();
  try {
    const dir = roomDir(root, "alarm-clock");
    for (const id of ["A", "B", "C", "D", "E"]) await appendRoomMessage(dir, msg(id));
    assert.deepEqual((await readRoom(dir, { limit: 2 })).messages.map((m) => m.id), ["D", "E"]);
    const page = await readRoom(dir, { before: "D", limit: 2 });
    assert.deepEqual(page.messages.map((m) => m.id), ["B", "C"]);
    assert.equal(page.truncated, true);
    assert.deepEqual((await readRoom(dir, { before: "nope" })).messages, []);
    assert.deepEqual((await readRoom(join(root, "missing"))).messages, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("concurrent appends all land as whole lines", async () => {
  const { base, roomsRoot: root } = fixture();
  try {
    const dir = roomDir(root, "alarm-clock");
    await Promise.all(Array.from({ length: 12 }, (_, i) => appendRoomMessage(dir, msg(`M${i}`, { text: "x".repeat(5000) }))));
    const lines = readFileSync(join(dir, ROOM_FILE), "utf8").trim().split("\n");
    assert.equal(lines.length, 12);
    for (const line of lines) JSON.parse(line);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("appendRoomMessage refuses a malformed message", async () => {
  const { base, roomsRoot: root } = fixture();
  try {
    await assert.rejects(appendRoomMessage(roomDir(root, "g"), { id: "x" } as unknown as RoomMessage));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("groups: valid file loads; bad groups are left out with a reason", () => {
  const { base, botsRoot } = fixture(["wallace", "scrat", "peggy"]);
  try {
    const g = (over: object) => ({ id: "alarm-clock", name: "Alarm Clock", members: ["wallace", "scrat"], lead: "wallace", ...over });
    const read = validateGroups(
      {
        v: 1,
        groups: [
          g({}),
          g({ id: "Bad_Id" }),
          g({ id: "solo", members: ["wallace"] }),
          g({ id: "ghost", members: ["wallace", "nobody"] }),
          g({ id: "nolead", lead: "peggy" }),
          g({ id: "noleads", lead: undefined, leads: [] }),
          g({}),
          g({ id: "nine", members: Array(9).fill("wallace") }),
        ],
      },
      botsRoot,
    );
    assert.deepEqual(read.groups.map((x) => x.id), ["alarm-clock"]);
    assert.equal(read.errors.length, 7);
    assert.match(read.errors.join("\n"), /not bots under .*nobody/);
    assert.deepEqual(validateGroups({ v: 2, groups: [] }, botsRoot).groups, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("GroupsFile re-reads on mtime change; missing file = no groups", () => {
  const { base, botsRoot } = fixture(["wallace", "scrat", "peggy"]);
  try {
    const file = new GroupsFile(botsRoot);
    assert.deepEqual(file.get("alarm-clock")?.leads, ["wallace"], "old single lead read as [lead]");
    const path = join(botsRoot, ".groups.json");
    writeFileSync(path, JSON.stringify({ v: 1, groups: [{ id: "alarm-clock", name: "AC", members: ["scrat", "peggy"], leads: ["scrat", "peggy"] }] }));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    assert.deepEqual(file.get("alarm-clock")?.leads, ["scrat", "peggy"]);
    rmSync(path);
    assert.deepEqual(file.list(), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
