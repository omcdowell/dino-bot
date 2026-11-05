import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GroupEditError, GroupsFile, GROUPS_FILE, membersProblem } from "../server/rooms/groups";
import { readRoom } from "../server/rooms/ledger";
import { RoomSessions } from "../server/rooms/sessions";
import { RoomsService } from "../server/rooms/service";
import { roomsSetMembersRpc } from "../shared/rooms/rpc";
import { fakePaseo, fixture } from "./rooms-fakes";

const GB = 1024 ** 3;
const NAMES: Record<string, string> = { wallace: "Wallace", scrat: "Scrat", peggy: "Peggy", flint: "Flint" };
/** On disk in the old single-lead form; it loads as `leads: ["wallace"]`, and an edit writes `leads`. */
const ALARM = { id: "alarm-clock", name: "Alarm Clock", members: ["wallace", "scrat", "peggy"], lead: "wallace" };
const ALARM_READ = { id: "alarm-clock", name: "Alarm Clock", members: ["wallace", "scrat", "peggy"], leads: ["wallace"] };

/** Four bots on the host, three in Alarm Clock (Flint is not), plus a second group. */
function setup(groups: unknown = { v: 1, groups: [ALARM, { id: "launch", name: "Launch", members: ["flint", "peggy"], lead: "flint" }] }) {
  const fx = fixture(["wallace", "scrat", "peggy", "flint"], groups);
  let n = 0;
  const now = Date.parse("2026-10-13T16:40:00.000Z");
  const fake = fakePaseo();
  const sessions = new RoomSessions({
    roomsRoot: fx.roomsRoot,
    botsRoot: fx.botsRoot,
    optchatHome: fx.optchatHome,
    memAvailable: async () => 8 * GB,
    now: () => now,
  });
  const changes: string[] = [];
  const errors: unknown[] = [];
  const groupsFile = new GroupsFile(fx.botsRoot);
  const service = new RoomsService({
    groups: groupsFile,
    sessions,
    bots: async () => Object.entries(NAMES).map(([id, name]) => ({ id, name, icon: "Bot", avatarHash: null })),
    mainChat: async () => null,
    assignDeps: () => ({ openChat: async (bot) => ({ agentId: `main-${bot}` }), send: async () => {} }),
    onChange: (g) => changes.push(g),
    onError: (e) => errors.push(e),
    now: () => now,
    newId: () => `01M${String(++n).padStart(4, "0")}`,
  });
  const path = join(fx.botsRoot, GROUPS_FILE);
  return {
    ...fx,
    fake,
    sessions,
    service,
    groupsFile,
    changes,
    errors,
    path,
    file: () => JSON.parse(readFileSync(path, "utf8")),
    set: (members: string[], leads: string[], group = "alarm-clock") => service.setMembers(fake.paseo, group, members, leads),
    ledger: async (group = "alarm-clock") => (await readRoom(join(fx.roomsRoot, group))).messages,
    cleanup: () => rmSync(fx.base, { recursive: true, force: true }),
  };
}

test("add a member: file rewritten, other groups untouched, .bak kept, system line, push", async () => {
  const s = setup();
  try {
    const before = readFileSync(s.path, "utf8");
    const out = await s.set(["wallace", "scrat", "peggy", "flint"], ["wallace"]);
    assert.deepEqual(out, { members: ["wallace", "scrat", "peggy", "flint"], leads: ["wallace"], added: ["flint"], removed: [] });
    const file = s.file();
    assert.deepEqual(file.groups[0], { ...ALARM_READ, members: ["wallace", "scrat", "peggy", "flint"] }, "old lead key replaced by leads");
    assert.equal("lead" in file.groups[0], false);
    assert.deepEqual(file.groups[1], { id: "launch", name: "Launch", members: ["flint", "peggy"], lead: "flint" });
    assert.equal(readFileSync(`${s.path}.bak`, "utf8"), before);
    assert.deepEqual(s.groupsFile.get("alarm-clock")?.members, ["wallace", "scrat", "peggy", "flint"], "re-read at once");
    const lines = await s.ledger();
    assert.deepEqual(lines.map((m) => [m.from, m.text, m.to]), [["system", "Flint joined the group", []]]);
    assert.deepEqual(s.changes, ["alarm-clock"]);
    // No temp file left behind.
    assert.equal(existsSync(`${s.path}.${process.pid}.tmp`), false);
  } finally {
    s.cleanup();
  }
});

test("remove a member: its live room session is archived and forgotten, its queue dropped", async () => {
  const s = setup();
  try {
    // Scrat gets a room session (first delivery) and then one more message waits in his queue.
    await s.service.post(s.fake.paseo, "alarm-clock", "@scrat one");
    const agentId = s.sessions.entry("alarm-clock", "scrat")!.agentId;
    await s.service.post(s.fake.paseo, "alarm-clock", "@scrat two");
    const queued = (await s.service.thread(s.fake.paseo, "alarm-clock")).members.find((m) => m.botId === "scrat");
    assert.equal(queued?.queued, 1);

    const out = await s.set(["wallace", "peggy"], ["wallace"]);
    assert.deepEqual(out.removed, ["scrat"]);
    assert.deepEqual(s.fake.archived, [agentId]);
    assert.equal(s.sessions.entry("alarm-clock", "scrat"), null);
    const router = JSON.parse(readFileSync(join(s.roomsRoot, "alarm-clock", "router.json"), "utf8"));
    assert.equal(router.queues.scrat, undefined);
    assert.equal((await s.ledger()).at(-1)!.text, "Scrat left the group");
    // A late turn_ended from the archived agent is not his room's any more: ignored.
    assert.equal(
      await s.service.turnEnded(s.fake.paseo, {
        agent: { id: agentId },
        outcome: { kind: "completed" },
        timeline: [{ type: "assistant_message", text: "late" }],
      }),
      false,
    );
    const thread = await s.service.thread(s.fake.paseo, "alarm-clock");
    assert.deepEqual(thread.members.map((m) => m.botId), ["wallace", "peggy"]);
  } finally {
    s.cleanup();
  }
});

test("set the lead: one system line; an Sam message with no @name now goes to the new lead", async () => {
  const s = setup();
  try {
    await s.set(["wallace", "scrat", "peggy"], ["peggy"]);
    assert.deepEqual(s.file().groups[0].leads, ["peggy"]);
    assert.deepEqual((await s.ledger()).map((m) => m.text), ["Peggy is now a lead", "Wallace is no longer a lead"]);
    const out = await s.service.post(s.fake.paseo, "alarm-clock", "morning");
    assert.deepEqual(out.to, ["peggy"]);
  } finally {
    s.cleanup();
  }
});

test("two leads: toggle one on, Sam's message wakes both; a lead can be removed while another remains", async () => {
  const s = setup();
  try {
    const out = await s.set(["wallace", "scrat", "peggy"], ["wallace", "peggy"]);
    assert.deepEqual(out.leads, ["wallace", "peggy"]);
    assert.deepEqual(s.file().groups[0].leads, ["wallace", "peggy"]);
    assert.deepEqual((await s.ledger()).map((m) => m.text), ["Peggy is now a lead"]);
    assert.deepEqual((await s.service.post(s.fake.paseo, "alarm-clock", "morning")).to, ["wallace", "peggy"]);
    assert.deepEqual((await s.service.post(s.fake.paseo, "alarm-clock", "@scrat date?")).to, ["scrat", "wallace", "peggy"]);
    // Leads are written in member order, whatever order the app sent.
    await s.set(["wallace", "scrat", "peggy"], ["peggy", "wallace"]);
    assert.deepEqual(s.file().groups[0].leads, ["wallace", "peggy"]);
    // Removing a lead member is fine while another lead remains; it is no longer listed as a lead.
    const rm = await s.set(["scrat", "peggy"], ["peggy"]);
    assert.deepEqual([rm.removed, rm.leads], [["wallace"], ["peggy"]]);
    assert.equal((await s.ledger()).at(-1)!.text, "Wallace left the group", "no extra 'no longer a lead' line for a removed member");
  } finally {
    s.cleanup();
  }
});

test("validation: unknown bot, too few/many, duplicate, lead not a member; the file is not touched", async () => {
  const s = setup();
  try {
    const before = readFileSync(s.path, "utf8");
    const cases: Array<[string[], string[], RegExp]> = [
      [["wallace", "ghost"], ["wallace"], /Not a bot on this host: ghost/],
      [["wallace"], ["wallace"], /at least 2 members/],
      [["wallace", "scrat", "scrat"], ["wallace"], /listed twice/],
      [["wallace", "scrat"], ["peggy"], /Every lead must be a member/],
      [["wallace", "scrat"], ["wallace", "peggy"], /Every lead must be a member/],
      [["wallace", "scrat"], [], /at least one lead/],
      [["wallace", "scrat"], ["scrat", "scrat"], /lead is listed twice/],
      [["wallace", "../etc"], ["wallace"], /Not a bot/],
    ];
    for (const [members, lead, re] of cases) {
      await assert.rejects(s.set(members, lead), (e: unknown) => e instanceof GroupEditError && re.test(e.message));
    }
    await assert.rejects(s.set(["wallace", "scrat"], ["wallace"], "nope"), /Unknown group: nope/);
    assert.equal(readFileSync(s.path, "utf8"), before);
    assert.equal(existsSync(`${s.path}.bak`), false);
    assert.deepEqual(await s.ledger(), []);
    assert.equal(membersProblem(Array.from({ length: 9 }, (_, i) => `b${i}`), ["b0"], s.botsRoot), "A group has at most 8 members.");
  } finally {
    s.cleanup();
  }
});

test("RPC contract: the input schema takes a members list and leads; method name is daemon-safe", () => {
  assert.equal(roomsSetMembersRpc.name, "rooms.members.set");
  const ok = roomsSetMembersRpc.input.safeParse({ groupId: "alarm-clock", members: ["wallace", "scrat"], leads: ["wallace", "scrat"] });
  assert.equal(ok.success, true);
  assert.equal(roomsSetMembersRpc.input.safeParse({ groupId: "Alarm Clock", members: ["wallace"], leads: ["wallace"] }).success, false);
  assert.equal(roomsSetMembersRpc.input.safeParse({ groupId: "alarm-clock", members: ["../x"], leads: ["wallace"] }).success, false);
  assert.equal(roomsSetMembersRpc.input.safeParse({ groupId: "alarm-clock", members: ["wallace"], lead: "wallace" }).success, false, "old lead field alone is not accepted");
});

test("a hand-edited file still loads: extra fields, other formatting, and edits keep unknown fields", async () => {
  // As Emmet's make-groups.sh or a person would write it: no indentation, an extra field, a note.
  const hand = `{"v":1,"note":"hand edited","groups":[{"id":"alarm-clock","name":" Alarm Clock ","members":["wallace","scrat","peggy"],"lead":"wallace","emoji":"⏰"}]}`;
  const s = setup(JSON.parse(hand));
  try {
    writeFileSync(s.path, hand);
    const read = s.groupsFile.read();
    assert.deepEqual(read.errors, []);
    assert.deepEqual(read.groups, [ALARM_READ]);
    await s.set(["wallace", "scrat"], ["scrat"]);
    const file = s.file();
    assert.equal(file.note, "hand edited");
    assert.equal(file.groups[0].emoji, "⏰");
    assert.deepEqual([file.groups[0].members, file.groups[0].leads, file.groups[0].lead], [["wallace", "scrat"], ["scrat"], undefined]);
    assert.equal(readFileSync(`${s.path}.bak`, "utf8"), hand);
    // A hand edit after an app edit is picked up (mtime/size change).
    writeFileSync(s.path, hand);
    assert.deepEqual(s.groupsFile.get("alarm-clock")?.members, ["wallace", "scrat", "peggy"]);
  } finally {
    s.cleanup();
  }
});

test("a broken file is refused for edits and left as it is", async () => {
  const s = setup();
  try {
    writeFileSync(s.path, "{ not json");
    await assert.rejects(s.set(["wallace", "scrat"], ["wallace"]), /does not parse/);
    assert.equal(readFileSync(s.path, "utf8"), "{ not json");
  } finally {
    s.cleanup();
  }
});

test("file mode is kept on rewrite", async () => {
  const s = setup();
  try {
    const { chmodSync } = await import("node:fs");
    chmodSync(s.path, 0o600);
    await s.set(["wallace", "scrat", "peggy", "flint"], ["wallace"]);
    assert.equal(statSync(s.path).mode & 0o777, 0o600);
  } finally {
    s.cleanup();
  }
});
