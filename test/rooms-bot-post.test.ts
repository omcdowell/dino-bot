import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GroupsFile } from "../server/rooms/groups";
import { appendRoomMessage, readRoom } from "../server/rooms/ledger";
import { RoomHandover } from "../server/rooms/handover";
import { RoomSessions } from "../server/rooms/sessions";
import { deliveryText, RoomsService, viaNote, type TurnEndedEvent } from "../server/rooms/service";
import { countMainPost, deliverable, mainPostRefusal, route } from "../shared/rooms/router";
import { handedTo } from "../shared/rooms/handover";
import { roomsBotPostRpc } from "../shared/rooms/rpc";
import { emptyRouterState, HOP_CAP, RATE_CAP, RATE_WINDOW_MS, RoomMessageSchema, type Group, type RoomMessage } from "../shared/rooms/schema";
import { fakePaseo, fixture } from "./rooms-fakes";
import { setUserName } from "../shared/party";

// Prompts and notices name the user from the settings; these tests use a configured name.
setUserName("Sam");

const GB = 1024 ** 3;
const NAMES: Record<string, string> = { wallace: "Wallace", scrat: "Scrat", peggy: "Peggy" };
const GROUP: Group = { id: "alarm-clock", name: "Alarm Clock", members: ["wallace", "scrat", "peggy"], leads: ["wallace"] };

function setup() {
  const fx = fixture();
  let now = Date.parse("2026-10-13T17:10:00.000Z");
  let n = 0;
  const fake = fakePaseo();
  const sessions = new RoomSessions({
    roomsRoot: fx.roomsRoot,
    botsRoot: fx.botsRoot,
    optchatHome: fx.optchatHome,
    memAvailable: async () => 8 * GB,
    now: () => now,
  });
  const handover = new RoomHandover({ roomDir: (g) => sessions.dir(g), profileDir: (b) => sessions.profileDir(b), now: () => now });
  const assigns: Array<{ agentId: string; text: string }> = [];
  // main-<bot> agents are the bots' main chats; anything else (room agents included) is not a bot's chat.
  const ownerOf = async (_p: unknown, agentId: string) => (agentId.startsWith("main-") ? agentId.slice(5) : null);
  const service = new RoomsService({
    groups: new GroupsFile(fx.botsRoot),
    sessions,
    handover,
    bots: async () => Object.entries(NAMES).map(([id, name]) => ({ id, name, icon: "Bot", avatarHash: null })),
    mainChat: async () => null,
    assignDeps: () => ({
      openChat: async (bot) => ({ agentId: `main-${bot}` }),
      send: async (agentId, text) => {
        assigns.push({ agentId, text });
      },
    }),
    ownerOf,
    now: () => now,
    newId: () => `01M${String(++n).padStart(4, "0")}`,
  });
  const ledger = async () => (await readRoom(join(fx.roomsRoot, "alarm-clock"))).messages;
  const agentOf = (bot: string) => sessions.entry("alarm-clock", bot)?.agentId ?? "";
  const end = async (bot: string, text: string) => {
    const id = agentOf(bot);
    assert.ok(id, `${bot} has no room agent`);
    fake.idle(id);
    const event: TurnEndedEvent = {
      agent: { id },
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "[room …]" },
        { type: "assistant_message", text },
      ],
    };
    return service.turnEnded(fake.paseo, event);
  };
  const botPost = (bot: string, re: string, text: string, extra: { groupId?: string; agentId?: string } = {}) =>
    service.botPost(fake.paseo, { groupId: extra.groupId ?? "alarm-clock", re, text, agentId: extra.agentId ?? `main-${bot}` });
  return {
    ...fx,
    fake,
    sessions,
    handover,
    service,
    assigns,
    ledger,
    agentOf,
    end,
    botPost,
    advance: (ms: number) => (now += ms),
    post: (text: string) => service.post(fake.paseo, "alarm-clock", text),
    cleanup: () => rmSync(fx.base, { recursive: true, force: true }),
  };
}

test("bot-room post: a member's main chat posts a task result, linked to the task, at hop + 1, waking nobody", async () => {
  const s = setup();
  try {
    const task = await s.post("@peggy task: draft the launch copy");
    const createdBefore = s.fake.created.length;
    const sentBefore = s.fake.sent.length;
    const out = await s.botPost("peggy", task.id, "Done: the copy is in docs/launch.md.");
    assert.equal(out.ok, true);
    assert.equal(out.from, "peggy");
    assert.equal(out.hop, 1);
    assert.deepEqual(out.to, []);
    const post = (await s.ledger()).find((m) => m.id === out.id)!;
    assert.deepEqual(
      { from: post.from, re: post.re, via: post.via, hop: post.hop, to: post.to, text: post.text },
      { from: "peggy", re: task.id, via: "main", hop: 1, to: [], text: "Done: the copy is in docs/launch.md." },
    );
    assert.ok(RoomMessageSchema.safeParse(post).success, "a valid ledger line");
    assert.equal(s.fake.created.length, createdBefore, "no room session started");
    assert.equal(s.fake.sent.length, sentBefore, "no digest sent");
    assert.ok(roomsBotPostRpc.output.safeParse(out).success, "matches the RPC output");
  } finally {
    s.cleanup();
  }
});

test("bot-room post: refused for a non-member, an unknown group, an unknown --re and a caller that is not a bot's chat", async () => {
  const s = setup();
  try {
    const task = await s.post("@scrat task: count acorns");
    const before = (await s.ledger()).length;

    const outsider = await s.service.botPost(s.fake.paseo, { groupId: "alarm-clock", re: task.id, text: "hi", agentId: "main-gromit" });
    assert.deepEqual([outsider.ok, outsider.code], [false, "not_member"]);
    assert.match(outsider.reason!, /gromit is not a member of alarm-clock/);

    const group = await s.botPost("scrat", task.id, "hi", { groupId: "no-such-group" });
    assert.deepEqual([group.ok, group.code], [false, "unknown_group"]);

    const re = await s.botPost("scrat", "01MNOPE", "hi");
    assert.deepEqual([re.ok, re.code], [false, "unknown_re"]);
    assert.match(re.reason!, /no message 01MNOPE in alarm-clock/);

    const room = await s.botPost("scrat", task.id, "hi", { agentId: s.agentOf("scrat") || "agent-1" });
    assert.deepEqual([room.ok, room.code], [false, "not_bot"], "a room session (or any non-bot agent) cannot post");

    const mismatch = await s.service.botPost(s.fake.paseo, { groupId: "alarm-clock", re: task.id, text: "hi", agentId: "main-scrat", from: "peggy" });
    assert.deepEqual([mismatch.ok, mismatch.code], [false, "not_bot"]);

    const empty = await s.botPost("scrat", task.id, "   ");
    assert.deepEqual([empty.ok, empty.code], [false, "empty"]);

    assert.equal((await s.ledger()).length, before, "refusals write nothing");
  } finally {
    s.cleanup();
  }
});

test("bot-room post: operator `from` (no agent) posts as that bot; a --re in another group is unknown", async () => {
  const s = setup();
  try {
    const task = await s.post("@scrat task: count acorns");
    const out = await s.service.botPost(s.fake.paseo, { groupId: "alarm-clock", re: task.id, text: "42 acorns", from: "scrat" });
    assert.deepEqual([out.ok, out.from], [true, "scrat"]);
    const none = await s.service.botPost(s.fake.paseo, { groupId: "alarm-clock", re: task.id, text: "x" });
    assert.deepEqual([none.ok, none.code], [false, "not_bot"]);
  } finally {
    s.cleanup();
  }
});

test("bot-room post: hop cap: hop is the --re message's hop + 1; over HOP_CAP is refused, at the cap it posts but wakes nobody", async () => {
  const s = setup();
  try {
    await s.post("@wallace start");
    const dir = join(s.roomsRoot, "alarm-clock");
    const at = (id: string, hop: number): RoomMessage => ({ v: 1, id, ts: "2026-10-13T17:10:30.000Z", group: "alarm-clock", from: "wallace", text: "@scrat task: x", hop, to: ["scrat"] });
    await appendRoomMessage(dir, at("01MHOP6", HOP_CAP));
    await appendRoomMessage(dir, at("01MHOP5", HOP_CAP - 1));

    const over = await s.botPost("scrat", "01MHOP6", "done");
    assert.deepEqual([over.ok, over.code], [false, "hop_cap"]);
    assert.match(over.reason!, /hop 7, over the cap of 6/);

    const atCap = await s.botPost("scrat", "01MHOP5", "done, @wallace please check");
    assert.deepEqual([atCap.ok, atCap.hop, atCap.to], [true, HOP_CAP, []]);
    assert.deepEqual(atCap.refused, [{ bot: "wallace", reason: "hop_cap" }]);
  } finally {
    s.cleanup();
  }
});

test("bot-room post: rate cap: each post takes one of the room's RATE_CAP slots per 10 min; then refused until the window moves", async () => {
  const s = setup();
  try {
    const task = await s.post("@scrat task: count acorns");
    for (let i = 1; i <= RATE_CAP; i++) {
      const out = await s.botPost("scrat", task.id, `update ${i}`);
      assert.equal(out.ok, true, `post ${i}`);
    }
    const capped = await s.botPost("scrat", task.id, "one more");
    assert.deepEqual([capped.ok, capped.code], [false, "rate_cap"]);
    // A retry of an earlier post is a duplicate, not a new post: answered ok, nothing written.
    const lines = (await s.ledger()).length;
    const dup = await s.botPost("scrat", task.id, "update 1");
    assert.deepEqual([dup.ok, dup.duplicate], [true, true]);
    assert.equal((await s.ledger()).length, lines);

    s.advance(RATE_WINDOW_MS + 1);
    assert.equal((await s.botPost("scrat", task.id, "later")).ok, true);
  } finally {
    s.cleanup();
  }
});

test("bot-room post: an @mention wakes that member through the router (room digest says it came from the main chat)", async () => {
  const s = setup();
  try {
    const task = await s.post("@peggy task: draft the launch copy");
    await s.end("peggy", "On it, in my main chat.");
    const out = await s.botPost("peggy", task.id, "Draft done. @scrat can you check the numbers?");
    assert.deepEqual([out.ok, out.to], [true, ["scrat"]]);
    const scrat = s.fake.created.find((c) => c.labels?.["room-member"] === "scrat");
    assert.ok(scrat, "scrat's room session started");
    assert.match(scrat!.prompt!, new RegExp(`${out.id}  \\d\\d:\\d\\dZ peggy \\(from its main chat, re ${task.id}\\): Draft done\\. @scrat`));
    assert.match(scrat!.prompt!, /^\[room alarm-clock to scrat msgs=\d+ hop=1\]/, "the post's hop");
    // Sam's task wakes the lead too; the post itself never queues its own bot.
    const state = JSON.parse(readFileSync(join(s.roomsRoot, "alarm-clock", "router.json"), "utf8"));
    assert.ok(!(state.queues.peggy ?? []).includes(out.id));
  } finally {
    s.cleanup();
  }
});

test("bot-room post: the poster's own room session sees the post as its own (context, not queued); its main memory does not get it back", async () => {
  const s = setup();
  try {
    const task = await s.post("@peggy task: draft the launch copy");
    await s.end("peggy", "Taking it to my main chat.");
    const out = await s.botPost("peggy", task.id, "Draft done: docs/launch.md");
    // Later Sam asks peggy something in the room: her digest carries the post, marked as hers.
    await s.post("@peggy where is it?");
    const toPeggy = s.fake.sent.filter((x) => x.agentId === s.agentOf("peggy")).at(-1)!;
    assert.match(toPeggy.text, new RegExp(`${out.id}  \\d\\d:\\d\\dZ peggy \\(you, from your main chat, re ${task.id}; already posted, do not answer it\\): Draft done`));
    assert.match(toPeggy.text, /user: @peggy where is it\?/);
    // Handover: the post goes to the other members' main memory, not back to peggy's.
    assert.ok(!s.handover.pending(GROUP, "peggy").some((m) => m.id === out.id));
    assert.ok(s.handover.pending(GROUP, "scrat").some((m) => m.id === out.id));
  } finally {
    s.cleanup();
  }
});

test("router: mainPostRefusal / countMainPost / deliverable keep main-chat posts as context only", () => {
  const now = Date.parse("2026-10-13T17:10:00.000Z");
  let state = emptyRouterState();
  assert.equal(mainPostRefusal(0, state, now), null);
  assert.equal(mainPostRefusal(HOP_CAP - 1, state, now), null);
  assert.equal(mainPostRefusal(HOP_CAP, state, now), "hop_cap");
  for (let i = 0; i < RATE_CAP; i++) state = countMainPost(state, now);
  assert.equal(mainPostRefusal(0, state, now), "rate_cap");
  assert.equal(mainPostRefusal(0, state, now + RATE_WINDOW_MS), null, "old wakes leave the window");

  const msg = (id: string, from: string, text: string, extra: Partial<RoomMessage> = {}): RoomMessage => ({
    v: 1, id, ts: new Date(now).toISOString(), group: GROUP.id, from, text, hop: 0, to: [], ...extra,
  });
  let st = emptyRouterState();
  st = route(GROUP, msg("A", "user", "@scrat hi"), st, now, NAMES).state;
  st = route(GROUP, msg("B", "scrat", "my room reply"), st, now, NAMES).state;
  st = route(GROUP, msg("C", "scrat", "from main", { via: "main", re: "A", hop: 1 }), st, now, NAMES).state;
  st = route(GROUP, msg("D", "user", "@scrat again"), st, now, NAMES).state;
  const { digest } = deliverable(st, "scrat", false);
  assert.deepEqual(digest.map((m) => m.id), ["A", "C", "D"], "own room line left out, own main-chat post kept");
  const text = deliveryText(GROUP, "scrat", digest, "Main chat: not open.");
  assert.match(text, /C  \d\d:\d\dZ scrat \(you, from your main chat, re A; already posted, do not answer it\): from main/);
  assert.equal(viaNote(msg("E", "peggy", "x", { via: "main", re: "A" }), "scrat"), " (from its main chat, re A)");
  assert.equal(viaNote(msg("F", "peggy", "x"), "scrat"), "");
});

test("handedTo: everything but the member's own main-chat posts", () => {
  assert.equal(handedTo({ from: "peggy", via: "main" }, "peggy"), false);
  assert.equal(handedTo({ from: "peggy", via: "main" }, "scrat"), true);
  assert.equal(handedTo({ from: "peggy" }, "peggy"), true);
});
