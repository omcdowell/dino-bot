import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_HOME_STATE,
  MAX_PINS,
  PIN_FULL_MESSAGE,
  botIdFor,
  groupIdFor,
  parseKey,
  pinProblem,
  setArchived,
  setPinned,
} from "../shared/manage";
import { BotFiles, HOME_FILE, HomeStateFile, ManageError, decodePng, normaliseHomeState } from "../server/manage";
import { GroupEditError, GroupsFile, createGroup, renameGroup } from "../server/rooms/groups";
import { discoverBots } from "../server/bots";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`;

/** Temp bots root + OptChat home, never the real ~/bots. */
function tempHost(bots: string[] = []) {
  const base = mkdtempSync(join(process.env.BM_TEST_TMP ?? tmpdir(), "bot-manage-"));
  const root = join(base, "bots");
  const optchatHome = join(base, "optchat");
  mkdirSync(root, { recursive: true });
  for (const bot of bots) {
    mkdirSync(join(root, bot), { recursive: true });
    writeFileSync(join(root, bot, ".optchat-profile"), `${bot}\n`);
    mkdirSync(join(optchatHome, "profiles", bot), { recursive: true });
    writeFileSync(join(optchatHome, "profiles", bot, "AGENTS.md"), `# ${bot}\n`);
  }
  return { base, root, optchatHome, done: () => rmSync(base, { recursive: true, force: true }) };
}

const noProjects = { projects: { list: async () => ({ projects: [] }) } };

test("pin cap: a fourth pin is refused with Sam's message, re-pinning is a no-op", () => {
  let s = EMPTY_HOME_STATE;
  for (const k of ["bot:a", "bot:b", "group:g"]) s = setPinned(s, k, true);
  assert.equal(s.pins.length, MAX_PINS);
  assert.equal(pinProblem(s, "bot:d"), PIN_FULL_MESSAGE);
  assert.equal(PIN_FULL_MESSAGE, "You have 3 bots pinned already.");
  assert.throws(() => setPinned(s, "bot:d", true), { message: PIN_FULL_MESSAGE });
  assert.equal(setPinned(s, "bot:a", true), s);
  assert.equal(pinProblem(s, "bot:a"), null);
  s = setPinned(s, "bot:b", false);
  assert.deepEqual(s.pins, ["bot:a", "group:g"]);
  assert.deepEqual(setPinned(s, "bot:d", true).pins, ["bot:a", "group:g", "bot:d"]);
});

test("archive unpins and keeps the first archive time; unarchive removes it", () => {
  let s = setPinned(EMPTY_HOME_STATE, "bot:fc", true);
  s = setArchived(s, "bot:fc", true, "2026-10-13T00:00:00.000Z");
  assert.deepEqual(s.pins, []);
  assert.deepEqual(s.archived, { "bot:fc": "2026-10-13T00:00:00.000Z" });
  assert.equal(setArchived(s, "bot:fc", true, "later").archived["bot:fc"], "2026-10-13T00:00:00.000Z");
  assert.deepEqual(setArchived(s, "bot:fc", false, "x").archived, {});
  assert.equal(setArchived(EMPTY_HOME_STATE, "bot:x", false, "x"), EMPTY_HOME_STATE);
});

test("normaliseHomeState drops bad keys, duplicate and archived pins, and pins past the cap", () => {
  assert.equal(normaliseHomeState({ v: 2 }), null);
  const s = normaliseHomeState({
    v: 1,
    pins: ["bot:a", "bot:a", "nope", "bot:z", "bot:b", "bot:c", "bot:d"],
    archived: { "bot:z": "t", "../x": "t" },
  });
  assert.deepEqual(s, { v: 1, pins: ["bot:a", "bot:b", "bot:c"], archived: { "bot:z": "t" } });
});

test("keys and ids", () => {
  assert.deepEqual(parseKey("group:alarm-clock"), { kind: "group", id: "alarm-clock" });
  assert.equal(parseKey("bot:../etc"), null);
  assert.equal(botIdFor("Tweety Bird"), "tweety-bird");
  assert.equal(botIdFor("  Zoë's  Bot!! "), "zoe-s-bot");
  assert.equal(botIdFor("!!!"), "");
  assert.ok(groupIdFor("x".repeat(80)).length <= 41);
});

test("home state file: featured bot pinned when there is no file; writes back up the old file", async () => {
  const host = tempHost();
  try {
    const file = new HomeStateFile(host.root);
    assert.deepEqual(await file.read("the-fat-controller"), { v: 1, pins: ["bot:the-fat-controller"], archived: {} });
    let s = await file.pin("the-fat-controller", "bot:emmet", true);
    assert.deepEqual(s.pins, ["bot:the-fat-controller", "bot:emmet"]);
    assert.ok(!existsSync(join(host.root, `${HOME_FILE}.bak`)), "nothing to back up on the first write");
    assert.equal(statSync(join(host.root, HOME_FILE)).mode & 0o777, 0o600);
    s = await file.archive("the-fat-controller", "bot:the-fat-controller", true, new Date("2026-10-13T08:00:00Z"));
    assert.deepEqual(s.pins, ["bot:emmet"]);
    const bak = JSON.parse(readFileSync(join(host.root, `${HOME_FILE}.bak`), "utf8"));
    assert.deepEqual(bak.pins, ["bot:the-fat-controller", "bot:emmet"]);
    // Once the file exists, the featured bot is no longer pinned by default.
    assert.deepEqual((await file.read("the-fat-controller")).pins, ["bot:emmet"]);
    await file.pin(null, "bot:a", true);
    await file.pin(null, "bot:b", true);
    await assert.rejects(file.pin(null, "bot:c", true), { message: PIN_FULL_MESSAGE });
    // Concurrent writes are serialised: none is lost.
    await Promise.all([file.pin(null, "bot:a", false), file.archive(null, "group:g", true)]);
    const final = await file.read(null);
    assert.deepEqual(final.pins, ["bot:emmet", "bot:b"]);
    assert.ok("group:g" in final.archived);
  } finally {
    host.done();
  }
});

test("create bot: files only, shows up in discovery, refuses a taken id", async () => {
  const host = tempHost(["peggy"]);
  try {
    const files = new BotFiles({ root: host.root, optchatHome: host.optchatHome });
    const made = await files.create({ name: "Tweety Bird", agentsMd: "# Tweety", avatar: PNG_URI });
    assert.equal(made.botId, "tweety-bird");
    assert.deepEqual(made.missing, []); // release/app: no host steps left
    const dir = join(host.root, "tweety-bird");
    assert.equal(readFileSync(join(dir, ".optchat-profile"), "utf8").trim(), "tweety-bird");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".bot.json"), "utf8")), {
      name: "Tweety Bird",
      order: 10,
      icon: "Bot",
      avatar: "avatar.png",
    });
    assert.ok(readFileSync(join(dir, "avatar.png")).equals(PNG));
    assert.ok(existsSync(join(dir, "dm")));
    assert.equal(readFileSync(join(host.optchatHome, "profiles", "tweety-bird", "AGENTS.md"), "utf8"), "# Tweety\n"); // only the bot's own text
    const bots = await discoverBots(host.root, noProjects);
    assert.deepEqual(bots.map((b) => [b.id, b.name]).sort(), [["peggy", "Peggy"], ["tweety-bird", "Tweety Bird"]]);
    await assert.rejects(files.create({ name: "peggy", agentsMd: "" }), ManageError);
    await assert.rejects(files.create({ name: "???", agentsMd: "" }), ManageError);
  } finally {
    host.done();
  }
});

test("edit bot: rename keeps other .bot.json keys; avatar; AGENTS.md refused when changed on the host", async () => {
  const host = tempHost(["peggy"]);
  try {
    const dir = join(host.root, "peggy");
    writeFileSync(join(dir, ".bot.json"), JSON.stringify({ order: 10, icon: "Megaphone", custom: 1 }));
    const files = new BotFiles({ root: host.root, optchatHome: host.optchatHome });
    await files.rename("peggy", "  Peggy Olson ");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".bot.json"), "utf8")), {
      order: 10,
      icon: "Megaphone",
      custom: 1,
      name: "Peggy Olson",
    });
    assert.ok(existsSync(join(dir, ".bot.json.bak")));
    await assert.rejects(files.rename("nobody", "X"), ManageError);

    await files.setAvatar("peggy", PNG_URI);
    assert.equal(JSON.parse(readFileSync(join(dir, ".bot.json"), "utf8")).avatar, "avatar.png");
    assert.throws(() => decodePng("data:image/png;base64,AAAA"), ManageError);
    assert.throws(() => decodePng("data:image/jpeg;base64,AAAA"), ManageError);

    const loaded = await files.agentsMd("peggy");
    assert.equal(loaded.text, "# peggy\n");
    await files.writeAgentsMd("peggy", "# Peggy Olson\n", loaded.mtimeMs);
    const again = await files.agentsMd("peggy");
    assert.equal(again.text, "# Peggy Olson\n");
    // The bot edits its own file after the sheet loaded: the save is refused.
    const path = join(host.optchatHome, "profiles", "peggy", "AGENTS.md");
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    await assert.rejects(files.writeAgentsMd("peggy", "mine", again.mtimeMs), /changed on the host/);
    assert.equal(readFileSync(path, "utf8"), "# Peggy Olson\n");
  } finally {
    host.done();
  }
});

test("create and rename groups in .groups.json (backup kept, other groups untouched)", () => {
  const host = tempHost(["wallace", "scrat", "peggy"]);
  try {
    const file = new GroupsFile(host.root);
    const g = createGroup(file, host.root, { id: groupIdFor("Launch week"), name: "Launch week", members: ["wallace", "peggy"], leads: ["peggy"] });
    assert.deepEqual(g, { id: "launch-week", name: "Launch week", members: ["wallace", "peggy"], leads: ["peggy"] });
    assert.equal(file.list().length, 1);
    assert.ok(!existsSync(join(host.root, ".groups.json.bak")));
    const g2 = createGroup(file, host.root, { id: "launch-week", name: "Launch week", members: ["scrat", "peggy"], leads: ["scrat"] });
    assert.equal(g2.id, "launch-week-2");
    assert.ok(existsSync(join(host.root, ".groups.json.bak")));
    assert.throws(
      () => createGroup(file, host.root, { id: "solo", name: "Solo", members: ["scrat"], leads: ["scrat"] }),
      GroupEditError,
    );
    assert.throws(
      () => createGroup(file, host.root, { id: "nolead", name: "No lead", members: ["scrat", "peggy"], leads: [] }),
      GroupEditError,
    );
    renameGroup(file, "launch-week", "Launch");
    assert.deepEqual(file.list().map((x) => x.name), ["Launch", "Launch week"]);
    assert.throws(() => renameGroup(file, "nope", "X"), GroupEditError);
  } finally {
    host.done();
  }
});
