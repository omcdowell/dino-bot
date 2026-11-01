import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { RoomSessions, procMemAvailable, type SessionsOptions } from "../server/rooms/sessions";
import { fakePaseo, fixture } from "./rooms-fakes";

const GB = 1024 ** 3;

function setup(over: Partial<SessionsOptions> = {}) {
  const fx = fixture();
  let now = Date.parse("2026-10-13T16:00:00.000Z");
  const sessions = new RoomSessions({
    roomsRoot: fx.roomsRoot,
    botsRoot: fx.botsRoot,
    optchatHome: fx.optchatHome,
    memAvailable: async () => 8 * GB,
    now: () => now,
    ...over,
  });
  const fake = fakePaseo();
  const target = (bot: string, group = "alarm-clock") => ({ group, groupName: "Alarm Clock", bot, botName: bot[0]!.toUpperCase() + bot.slice(1) });
  let takes = 0;
  const take = (text = "digest") => () => {
    takes += 1;
    return { text, hop: 1, re: "01RE" };
  };
  return {
    ...fx,
    sessions,
    fake,
    target,
    take,
    takes: () => takes,
    advance: (ms: number) => (now += ms),
    cleanup: () => rmSync(fx.base, { recursive: true, force: true }),
  };
}

test("first delivery starts a room agent: cwd, labels, env, title, prompt", async () => {
  const s = setup();
  try {
    const out = await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take("hello room"));
    assert.equal(out.kind, "started");
    assert.equal(s.fake.created.length, 1);
    const c = s.fake.created[0]!;
    const dir = join(s.roomsRoot, "alarm-clock");
    assert.equal(c.cwd, dir);
    assert.equal(c.title, "Wallace · Alarm Clock");
    assert.equal(c.prompt, "hello room");
    assert.deepEqual(c.labels, { room: "alarm-clock", "room-member": "wallace", "paseo.keep-live": "0" });
    assert.deepEqual(c.env, {
      OPTCHAT_ROOM: "alarm-clock",
      OPTCHAT_ROOM_MEMBER: "wallace",
      OPTCHAT_ROOM_DIR: dir,
      OPTCHAT_ROOM_MAIN: join(s.optchatHome, "profiles", "wallace"),
      OPTCHAT_ROOM_BOTS: s.botsRoot,
      OPTCHAT_ROOM_SETTINGS: join(s.botsRoot, ".settings.json"),
    });
    assert.deepEqual(c.config, { provider: "optchat" }, "no bot profile and no defaultModel setting: OptChat picks the model");
    const file = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
    assert.equal(file.wallace.agentId, out.kind === "started" ? out.agentId : "");
    assert.equal(file.wallace.turns, 0);
  } finally {
    s.cleanup();
  }
});

test("adoption guard: no bot= label and cwd never inside a bot folder", async () => {
  const s = setup();
  try {
    await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take());
    const c = s.fake.created[0]!;
    assert.equal(c.labels?.bot, undefined);
    for (const bot of ["wallace", "scrat", "peggy"]) {
      assert.ok(relative(join(s.botsRoot, bot), c.cwd).startsWith(".."), `${c.cwd} under ${bot}`);
    }
    // A rooms root inside a bot folder is refused outright.
    const bad = new RoomSessions({ roomsRoot: join(s.botsRoot, "wallace", "rooms"), botsRoot: s.botsRoot, memAvailable: async () => 8 * GB });
    await assert.rejects(bad.deliver(s.fake.paseo, s.target("wallace"), s.take()), /inside a bot folder/);
  } finally {
    s.cleanup();
  }
});

test("no second agent while one is live: busy until its turn ends, then the same agent gets a send", async () => {
  const s = setup();
  try {
    const first = await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take());
    const id = first.kind === "started" ? first.agentId : "";
    assert.equal((await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take())).kind, "busy");
    assert.equal(s.takes(), 1, "busy: queue not drained");
    // Status already idle but the plugin has not seen turn_ended: still pending.
    s.fake.idle(id);
    assert.equal((await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take())).kind, "busy");
    s.sessions.turnEnded("alarm-clock", "wallace");
    const again = await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take("second"));
    assert.deepEqual(again, { kind: "sent", agentId: id });
    assert.equal(s.fake.created.length, 1);
    assert.deepEqual(s.fake.sent.map((x) => [x.agentId, x.text]), [[id, "second"]]);
    assert.equal(s.sessions.entry("alarm-clock", "wallace")?.turns, 1);
  } finally {
    s.cleanup();
  }
});

test("a delivery whose turn never ends stops counting as busy once the agent reads idle past the grace", async () => {
  const s = setup();
  try {
    const first = await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take());
    const id = first.kind === "started" ? first.agentId : "";
    s.advance(5 * 60_000);
    // Still running: busy however long it takes.
    assert.equal((await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take())).kind, "busy");
    s.fake.idle(id); // refused input, no turn_ended seen
    const again = await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take("next"));
    assert.deepEqual(again, { kind: "sent", agentId: id });
  } finally {
    s.cleanup();
  }
});

test("empty queue sends nothing", async () => {
  const s = setup();
  try {
    assert.equal((await s.sessions.deliver(s.fake.paseo, s.target("wallace"), () => null)).kind, "empty");
    assert.equal(s.fake.created.length, 0);
  } finally {
    s.cleanup();
  }
});

test("env is re-injected on session_open for room agents only", async () => {
  const s = setup();
  try {
    const out = await s.sessions.deliver(s.fake.paseo, s.target("scrat"), s.take());
    const id = out.kind === "started" ? out.agentId : "";
    const req = { agentId: id, workspaceId: null, provider: "optchat", cwd: "x", reason: "resume" as const, purpose: "interactive" as const, env: { KEEP: "1" } as Record<string, string> };
    // A fresh instance (daemon restart) finds the agent on disk.
    const fresh = new RoomSessions({ roomsRoot: s.roomsRoot, botsRoot: s.botsRoot, optchatHome: s.optchatHome });
    const opened = fresh.sessionOpen(req, ["alarm-clock"]);
    assert.equal(opened?.env.KEEP, "1");
    assert.equal(opened?.env.OPTCHAT_ROOM, "alarm-clock");
    assert.equal(opened?.env.OPTCHAT_ROOM_MEMBER, "scrat");
    assert.equal(opened?.reason, "resume");
    assert.equal(fresh.sessionOpen({ ...req, agentId: "someone-else" }, ["alarm-clock"]), undefined);
  } finally {
    s.cleanup();
  }
});

test("quiet check archives idle agents after 15 min and forgets vanished ones", async () => {
  const s = setup();
  try {
    const a = await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take());
    const b = await s.sessions.deliver(s.fake.paseo, s.target("scrat"), s.take());
    const wid = a.kind === "started" ? a.agentId : "";
    const sid = b.kind === "started" ? b.agentId : "";
    s.fake.idle(wid);
    s.sessions.turnEnded("alarm-clock", "wallace");
    s.advance(14 * 60_000);
    assert.deepEqual(await s.sessions.quietCheck(s.fake.paseo, ["alarm-clock"]), []);
    s.advance(60_000);
    // scrat is still mid-turn: kept even though it is old.
    assert.deepEqual(await s.sessions.quietCheck(s.fake.paseo, ["alarm-clock"]), [{ group: "alarm-clock", bot: "wallace" }]);
    assert.deepEqual(s.fake.archived, [wid]);
    assert.equal(s.sessions.entry("alarm-clock", "wallace"), null);
    // Archived by hand elsewhere: entry dropped, no archive call.
    s.fake.agents.get(sid)!.archivedAt = "x";
    await s.sessions.quietCheck(s.fake.paseo, ["alarm-clock"]);
    assert.equal(s.sessions.entry("alarm-clock", "scrat"), null);
    assert.deepEqual(s.fake.archived, [wid]);
  } finally {
    s.cleanup();
  }
});

test("MAX_LIVE: oldest idle room agent is archived to make room; all busy = wait with queue intact", async () => {
  const s = setup({ maxLive: 2 });
  try {
    const a = await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take());
    s.advance(1000);
    const b = await s.sessions.deliver(s.fake.paseo, s.target("scrat"), s.take());
    const wid = a.kind === "started" ? a.agentId : "";
    const sid = b.kind === "started" ? b.agentId : "";
    const before = s.takes();
    assert.equal((await s.sessions.deliver(s.fake.paseo, s.target("peggy"), s.take())).kind, "wait");
    assert.equal(s.takes(), before, "wait: queue not drained");
    // Both end their turns; scrat is the more recent one.
    s.fake.idle(wid);
    s.sessions.turnEnded("alarm-clock", "wallace");
    s.advance(1000);
    s.fake.idle(sid);
    s.sessions.turnEnded("alarm-clock", "scrat");
    assert.equal((await s.sessions.deliver(s.fake.paseo, s.target("peggy"), s.take())).kind, "started");
    assert.deepEqual(s.fake.archived, [wid]);
    assert.equal(s.sessions.entry("alarm-clock", "wallace"), null);
    assert.equal((await s.sessions.live(s.fake.paseo)).length, 2);
  } finally {
    s.cleanup();
  }
});

test("MAX_LIVE counts room agents across groups", async () => {
  const s = setup({ maxLive: 1 });
  try {
    await s.sessions.deliver(s.fake.paseo, s.target("wallace", "other"), s.take());
    assert.equal((await s.sessions.deliver(s.fake.paseo, s.target("scrat"), s.take())).kind, "wait");
  } finally {
    s.cleanup();
  }
});

test("low memory refuses a start (queue kept) but still sends to a live agent", async () => {
  let available = 8 * GB;
  const s = setup({ memAvailable: async () => available });
  try {
    const a = await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take());
    const wid = a.kind === "started" ? a.agentId : "";
    s.fake.idle(wid);
    s.sessions.turnEnded("alarm-clock", "wallace");
    available = 1.5 * GB;
    const before = s.takes();
    const out = await s.sessions.deliver(s.fake.paseo, s.target("scrat"), s.take());
    assert.equal(out.kind, "low-memory");
    assert.equal(s.takes(), before);
    assert.equal((await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take())).kind, "sent");
  } finally {
    s.cleanup();
  }
});

test("recycle after 30 turns or a context over 60k tokens", async () => {
  const s = setup();
  try {
    const a = await s.sessions.deliver(s.fake.paseo, s.target("wallace"), s.take());
    const wid = a.kind === "started" ? a.agentId : "";
    s.sessions.turnEnded("alarm-clock", "wallace");
    assert.equal(await s.sessions.recycleIfDue(s.fake.paseo, "alarm-clock", "wallace", { id: wid, lastUsage: { inputTokens: 50_000 } }), false);
    assert.equal(await s.sessions.recycleIfDue(s.fake.paseo, "alarm-clock", "wallace", { id: wid, lastUsage: { inputTokens: 61_000 } }), true);
    assert.deepEqual(s.fake.archived, [wid]);

    const b = await s.sessions.deliver(s.fake.paseo, s.target("scrat"), s.take());
    const sid = b.kind === "started" ? b.agentId : "";
    s.sessions.update("alarm-clock", "scrat", { turns: 29 });
    s.sessions.turnEnded("alarm-clock", "scrat");
    assert.equal(await s.sessions.recycleIfDue(s.fake.paseo, "alarm-clock", "scrat"), true);
    assert.deepEqual(s.fake.archived, [wid, sid]);
  } finally {
    s.cleanup();
  }
});

test("procMemAvailable parses /proc/meminfo, null when unreadable", async () => {
  const value = await procMemAvailable();
  assert.ok(value === null || value > 0);
  assert.equal(await procMemAvailable("/nonexistent/meminfo"), null);
});

test("room env names the settings file pi-optchat reads rooms.fullTools from (option settingsFile, else the bots root's)", () => {
  const s = setup({ settingsFile: "/x/settings.json" });
  try {
    assert.equal(s.sessions.roomEnv("alarm-clock", "wallace").OPTCHAT_ROOM_SETTINGS, "/x/settings.json");
  } finally {
    s.cleanup();
  }
  const saved = process.env.PASEO_BOTS_SETTINGS;
  delete process.env.PASEO_BOTS_SETTINGS;
  const t = setup();
  try {
    assert.equal(t.sessions.roomEnv("alarm-clock", "wallace").OPTCHAT_ROOM_SETTINGS, join(t.botsRoot, ".settings.json"));
  } finally {
    t.cleanup();
    if (saved !== undefined) process.env.PASEO_BOTS_SETTINGS = saved;
  }
});
