/**
 * DA1 default avatars: a new bot gets one of the pack's characters at random in its default look (own colours, own
 * accessory; colour and accessories never randomised), saved as a phone save is; a bot without an avatar shows a
 * stable default picked from its id, rendered in memory (no files written).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AVATAR_PACK,
  autoPlaceAccessory,
  canonicalAvatarJson,
  defaultAvatarCharacters,
  defaultAvatarFor,
  parseAvatar,
  randomDefaultAvatar,
  stableDefaultAvatar,
} from "../shared/avatar";
import { defaultLook } from "../client/avatar-designer-state";
import { BotFiles } from "../server/manage";
import { AvatarsService, DEFAULT_AVATAR_REF, avatarAnswer, withAvatarHashes } from "../server/avatars";
import { AVATAR_SIZES, avatarJsonHash, renderFileName, type AvatarRenderer } from "../server/avatar-store";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A fake renderer: a PNG-signed buffer naming the size, and a count of calls. */
function fakeRenderer() {
  const calls: number[] = [];
  const renderer = async (): Promise<AvatarRenderer> => (_svg, size) => {
    calls.push(size);
    return Buffer.concat([PNG_SIG, Buffer.from(`fake-${size}`)]);
  };
  return { renderer, calls };
}

function tempRoot() {
  const base = mkdtempSync(join(process.env.BM_TEST_TMP ?? tmpdir(), "default-avatar-"));
  const root = join(base, "bots");
  mkdirSync(root, { recursive: true });
  return { base, root, optchatHome: join(base, "optchat"), done: () => rmSync(base, { recursive: true, force: true }) };
}

test("the default pool is every character in the pack (27: 9 bot + 18 reef)", () => {
  const ids = defaultAvatarCharacters(AVATAR_PACK);
  assert.equal(ids.length, 27);
  assert.deepEqual(ids, AVATAR_PACK.characters.map((c) => c.id));
  for (const id of ["emmet-boxfish", "fc-jellyfish", "octopus", "shrimp"]) assert.ok(ids.includes(id), id);
});

test("defaultAvatarFor: own colours, eyes original, own accessory only (as the designer's defaultLook); valid", () => {
  for (const c of AVATAR_PACK.characters) {
    const a = defaultAvatarFor(AVATAR_PACK, c.id);
    assert.equal(a.character, c.id);
    assert.equal(a.eyes, "original");
    assert.equal(a.colour, undefined, "colour is never set: the character's own");
    assert.equal(a.revision, 0);
    assert.equal(a.packVersion, AVATAR_PACK.packVersion);
    const own = AVATAR_PACK.accessories.filter((x) => x.from === c.id).map((x) => x.id);
    assert.deepEqual(a.accessories.map((x) => x.id), own, `${c.id}: its own accessory only`);
    if (own[0]) assert.deepEqual(a.accessories[0], autoPlaceAccessory(AVATAR_PACK, c.id, own[0]), "where it was drawn");
    const look = defaultLook(AVATAR_PACK, c.id);
    assert.deepEqual({ character: a.character, eyes: a.eyes, accessories: a.accessories }, look, "same as the designer's default look");
    assert.ok(parseAvatar(a, AVATAR_PACK).ok);
  }
  // Bare characters stay bare.
  assert.deepEqual(defaultAvatarFor(AVATAR_PACK, "bitzer-seal").accessories, []);
  assert.throws(() => defaultAvatarFor(AVATAR_PACK, "nope"), /unknown character/);
});

test("randomDefaultAvatar: the rng picks the character, nothing else varies; covers the whole pool", () => {
  const ids = defaultAvatarCharacters(AVATAR_PACK);
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    const a = randomDefaultAvatar(AVATAR_PACK, () => (i + 0.5) / ids.length);
    assert.equal(a.character, ids[i]);
    assert.equal(canonicalAvatarJson(a), canonicalAvatarJson(defaultAvatarFor(AVATAR_PACK, ids[i]!)));
    seen.add(a.character);
  }
  assert.equal(seen.size, 27);
  assert.equal(randomDefaultAvatar(AVATAR_PACK, () => 0).character, ids[0]);
  assert.equal(randomDefaultAvatar(AVATAR_PACK, () => 0.999999).character, ids[26]);
  assert.equal(randomDefaultAvatar(AVATAR_PACK, () => 1).character, ids[26], "clamped");
  for (let i = 0; i < 50; i++) assert.ok(ids.includes(randomDefaultAvatar(AVATAR_PACK).character));
});

test("stableDefaultAvatar: same id same avatar; ids spread over the pool", () => {
  assert.deepEqual(stableDefaultAvatar(AVATAR_PACK, "yoda"), stableDefaultAvatar(AVATAR_PACK, "yoda"));
  const chars = new Set(Array.from({ length: 200 }, (_, i) => stableDefaultAvatar(AVATAR_PACK, `bot-${i}`).character));
  assert.ok(chars.size > 20, `${chars.size} characters from 200 ids`);
});

test("create without an avatar: a random default saved as a phone save (avatar.json, renders, avatar.png, .bot.json)", async () => {
  const host = tempRoot();
  try {
    const ids = defaultAvatarCharacters(AVATAR_PACK);
    const { renderer } = fakeRenderer();
    const files = new BotFiles({ root: host.root, optchatHome: host.optchatHome, renderer, random: () => 9.5 / 27 });
    const made = await files.create({ name: "Yoda", agentsMd: "# Yoda" });
    const dir = join(host.root, made.botId);
    const saved = JSON.parse(readFileSync(join(dir, "avatar.json"), "utf8"));
    assert.deepEqual(saved, defaultAvatarFor(AVATAR_PACK, ids[9]!));
    assert.equal(saved.character, "octopus");
    assert.equal(JSON.parse(readFileSync(join(dir, ".bot.json"), "utf8")).avatar, "avatar.png");
    const hash = avatarJsonHash(saved);
    assert.deepEqual(readdirSync(join(dir, "avatars")).sort(), AVATAR_SIZES.map((s) => renderFileName(hash, s)).sort());
    assert.ok(readFileSync(join(dir, "avatar.png")).equals(Buffer.concat([PNG_SIG, Buffer.from("fake-512")])));
    const service = new AvatarsService({ renderer });
    assert.equal(await service.hashForBot({ id: made.botId, cwd: dir, avatar: "avatar.png" }), hash);
    // The app's own save right after create (revision 1) replaces it.
    const next = { ...defaultAvatarFor(AVATAR_PACK, "whale"), revision: 1 };
    assert.equal((await files.saveAvatarJson(made.botId, next)).ok, true);
    assert.equal(JSON.parse(readFileSync(join(dir, "avatar.json"), "utf8")).character, "whale");
    // A picture or a design sent with create wins: no default.
    const own = await files.create({ name: "Designed", agentsMd: "", avatarJson: { ...defaultAvatarFor(AVATAR_PACK, "eel"), revision: 1 } });
    assert.equal(JSON.parse(readFileSync(join(host.root, own.botId, "avatar.json"), "utf8")).character, "eel");
    const upload = `data:image/png;base64,${Buffer.concat([PNG_SIG, Buffer.from("x")]).toString("base64")}`;
    const plain = await files.create({ name: "Plain", agentsMd: "", avatar: upload });
    assert.equal(existsSync(join(host.root, plain.botId, "avatar.json")), false);
  } finally {
    host.done();
  }
});

test("create still works when rendering fails: no avatar files, the list shows a stable default", async () => {
  const host = tempRoot();
  try {
    const renderer = async (): Promise<AvatarRenderer> => {
      throw new Error("no resvg");
    };
    const files = new BotFiles({ root: host.root, optchatHome: host.optchatHome, renderer });
    const made = await files.create({ name: "No Render", agentsMd: "" });
    const dir = join(host.root, made.botId);
    assert.equal(existsSync(join(dir, "avatar.json")), false);
    assert.equal(JSON.parse(readFileSync(join(dir, ".bot.json"), "utf8")).avatar, undefined);
    const [listed] = await withAvatarHashes([{ id: made.botId, cwd: dir, avatar: null }], new AvatarsService({ renderer }));
    assert.equal(listed!.avatarHash, avatarJsonHash(stableDefaultAvatar(AVATAR_PACK, made.botId)));
  } finally {
    host.done();
  }
});

test("a bot without an avatar shows a stable default: list hash + pack, JSON, PNG rendered once in memory, no files", async () => {
  const host = tempRoot();
  try {
    const dir = join(host.root, "yoda");
    mkdirSync(dir);
    const { renderer, calls } = fakeRenderer();
    const service = new AvatarsService({ renderer });
    const bot = { id: "yoda", cwd: dir, avatar: null };
    const want = stableDefaultAvatar(AVATAR_PACK, "yoda");
    const hash = avatarJsonHash(want);
    const [listed] = await withAvatarHashes([bot], service);
    assert.equal(listed!.avatarHash, hash);
    assert.equal(listed!.avatarPack, AVATAR_PACK.packVersion);
    assert.equal(listed!.avatar, DEFAULT_AVATAR_REF, "the app asks only for bots with an avatar");
    const json = await avatarAnswer(service, bot, { format: "json" });
    assert.deepEqual(json.avatar, want);
    assert.equal(json.hash, hash);
    const png = await avatarAnswer(service, bot, { size: 128 });
    assert.equal(png.hash, hash);
    assert.equal(png.size, 128);
    assert.equal(png.dataUri, `data:image/png;base64,${Buffer.concat([PNG_SIG, Buffer.from("fake-128")]).toString("base64")}`);
    await avatarAnswer(service, bot, { size: 128 });
    assert.deepEqual(calls, [128], "rendered once per size");
    assert.equal((await service.forBot(bot)).size, 512);
    assert.deepEqual(readdirSync(dir), [], "nothing written");
    // A .bot.json avatar whose file is missing falls back the same way.
    assert.equal(await service.hashForBot({ id: "yoda", cwd: dir, avatar: "gone.png" }), hash);
  } finally {
    host.done();
  }
});

test("a bot with avatar.json but no render (installer starter bot) shows that avatar.json; own avatar.png is untouched", async () => {
  const host = tempRoot();
  try {
    const dir = join(host.root, "juniper");
    mkdirSync(dir);
    const starter = defaultAvatarFor(AVATAR_PACK, "turtle");
    writeFileSync(join(dir, "avatar.json"), `${JSON.stringify(starter)}\n`);
    const { renderer } = fakeRenderer();
    const service = new AvatarsService({ renderer });
    const bot = { id: "juniper", cwd: dir, avatar: null };
    const [listed] = await withAvatarHashes([bot], service);
    assert.equal(listed!.avatarHash, avatarJsonHash(starter));
    assert.deepEqual((await service.designForBot(bot))?.avatar, starter);
    // A bot with its own PNG keeps it (no default).
    const own = join(host.root, "flint");
    mkdirSync(own);
    const bytes = Buffer.concat([PNG_SIG, Buffer.from("flint")]);
    writeFileSync(join(own, "avatar.png"), bytes);
    const [flint] = await withAvatarHashes([{ id: "flint", cwd: own, avatar: "avatar.png" }], service);
    assert.equal(flint!.avatar, "avatar.png");
    assert.equal(flint!.avatarPack, null);
    assert.equal(flint!.avatarHash, (await service.read(join(own, "avatar.png"))).hash);
  } finally {
    host.done();
  }
});
