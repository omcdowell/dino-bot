import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { AVATAR_PACK, AVATAR_PACK_JSON, type AvatarJson } from "../shared/avatar";
import { BotFiles } from "../server/manage";
import { AvatarsService, withAvatarHashes } from "../server/avatars";
import {
  AVATAR_SIZES,
  avatarJsonHash,
  packGzip,
  pruneRenders,
  renderAvatar,
  renderFileName,
  resvgRenderer,
  type AvatarRenderer,
} from "../server/avatar-store";
import { SaveAvatarResultSchema, botsAvatarPackRpc } from "../shared/avatar-rpc";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UPLOAD = Buffer.concat([PNG_SIG, Buffer.from("uploaded")]);
const UPLOAD_URI = `data:image/png;base64,${UPLOAD.toString("base64")}`;

function tempHost(bots: string[] = ["peggy"]) {
  const base = mkdtempSync(join(process.env.BM_TEST_TMP ?? tmpdir(), "avatar-server-"));
  const root = join(base, "bots");
  const optchatHome = join(base, "optchat");
  for (const bot of bots) {
    mkdirSync(join(root, bot), { recursive: true });
    writeFileSync(join(root, bot, ".optchat-profile"), `${bot}\n`);
    writeFileSync(join(root, bot, ".bot.json"), `${JSON.stringify({ name: "Peggy", order: 3, icon: "Fish" })}\n`);
    mkdirSync(join(optchatHome, "profiles", bot), { recursive: true });
  }
  mkdirSync(root, { recursive: true });
  return { root, optchatHome, done: () => rmSync(base, { recursive: true, force: true }) };
}

function avatar(over: Partial<AvatarJson> = {}): AvatarJson {
  return {
    v: 1,
    packVersion: 1,
    character: "octopus",
    eyes: "closed",
    colour: "#FECB3E",
    accessories: [
      { id: "sun-hat", x: 0.401, y: 0.3693, scale: 0.6083, rotation: -20 },
      { id: "glasses", x: 0.5002, y: 0.5018, scale: 0.4549 },
    ],
    revision: 1,
    ...over,
  };
}

const dims = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });
const renders = (dir: string) => (existsSync(join(dir, "avatars")) ? readdirSync(join(dir, "avatars")).sort() : []);

test("save: renders 64/128/512 named by the JSON hash, avatar.png = the 512 (+ .bak), .bot.json keeps its keys", async () => {
  const host = tempHost();
  try {
    const dir = join(host.root, "peggy");
    writeFileSync(join(dir, "avatar.png"), UPLOAD);
    const files = new BotFiles(host);
    const a = avatar();
    const saved = await files.saveAvatarJson("peggy", a);
    assert.equal(saved.ok, true);
    assert.ok(SaveAvatarResultSchema.safeParse(saved).success, "result matches the RPC contract");
    if (!saved.ok) return;
    const hash = avatarJsonHash(a);
    assert.equal(saved.hash, hash);
    assert.equal(saved.revision, 1);
    assert.equal(saved.unchanged, false);
    assert.deepEqual(renders(dir), AVATAR_SIZES.map((s) => renderFileName(hash, s)).sort());
    for (const size of AVATAR_SIZES) {
      const png = readFileSync(join(dir, "avatars", renderFileName(hash, size)));
      assert.ok(png.subarray(0, 8).equals(PNG_SIG));
      assert.deepEqual(dims(png), { w: size, h: size });
      assert.ok(png.length < { 64: 8_000, 128: 16_000, 512: 64_000 }[size], `${size}px is ${png.length} B`);
    }
    assert.ok(readFileSync(join(dir, "avatar.png")).equals(readFileSync(join(dir, "avatars", renderFileName(hash, 512)))));
    assert.ok(readFileSync(join(dir, "avatar.png.bak")).equals(UPLOAD));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".bot.json"), "utf8")), { name: "Peggy", order: 3, icon: "Fish", avatar: "avatar.png" });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "avatar.json"), "utf8")), a);
    assert.deepEqual(await files.avatarJson("peggy"), a);
    assert.equal(readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0);
  } finally {
    host.done();
  }
});

test("revision ordering: older or equal-but-different saves are stale (with the stored revision), newer win", async () => {
  const host = tempHost();
  try {
    const files = new BotFiles(host);
    assert.equal((await files.saveAvatarJson("peggy", avatar({ revision: 5 }))).ok, true);
    const older = await files.saveAvatarJson("peggy", avatar({ revision: 4, character: "emmet-boxfish", eyes: "original" }));
    assert.deepEqual(older, { ok: false, reason: "stale", revision: 5, hash: avatarJsonHash(avatar()) });
    const sameRevOther = await files.saveAvatarJson("peggy", avatar({ revision: 5, eyes: "dot" }));
    assert.equal(sameRevOther.ok, false);
    assert.equal(sameRevOther.reason, "stale");
    assert.equal((await files.avatarJson("peggy"))?.eyes, "closed", "stale saves change nothing");
    const newer = await files.saveAvatarJson("peggy", avatar({ revision: 6, eyes: "dot" }));
    assert.equal(newer.ok, true);
    assert.equal((await files.avatarJson("peggy"))?.revision, 6);
    assert.equal(JSON.parse(readFileSync(join(host.root, "peggy", "avatar.json.bak"), "utf8")).revision, 5);
  } finally {
    host.done();
  }
});

test("revision ordering holds for saves sent at once (serialised per bot): the highest revision is kept", async () => {
  const host = tempHost();
  try {
    const files = new BotFiles(host);
    const results = await Promise.all(
      [3, 7, 5, 6, 1].map((revision, i) => files.saveAvatarJson("peggy", avatar({ revision, accessories: [{ id: "glasses", x: 0.5, y: 0.5, scale: 0.3 + i / 50 }] }))),
    );
    assert.deepEqual(results.map((r) => r.ok), [true, true, false, false, false]);
    assert.equal((await files.avatarJson("peggy"))?.revision, 7);
    assert.ok(results.slice(2).every((r) => !r.ok && r.reason === "stale" && r.revision === 7));
  } finally {
    host.done();
  }
});

test("resend idempotence: the stored save sent again answers ok/unchanged and writes nothing", async () => {
  const host = tempHost();
  try {
    const dir = join(host.root, "peggy");
    const files = new BotFiles(host);
    const a = avatar({ revision: 2 });
    await files.saveAvatarJson("peggy", a);
    const before = ["avatar.json", "avatar.png", ".bot.json"].map((n) => statSync(join(dir, n)).mtimeMs);
    const listing = renders(dir);
    for (let i = 0; i < 3; i++) {
      const again = await files.saveAvatarJson("peggy", JSON.parse(JSON.stringify(a)));
      assert.deepEqual(again, { ok: true, reason: "saved", revision: 2, hash: avatarJsonHash(a), unchanged: true, renderMs: null });
    }
    // Same picture written differently (rotation 0, lower-case colour, other key order) is the same save.
    const same = { revision: 2, accessories: a.accessories.map((x) => ({ rotation: 0, ...x })), colour: "#fecb3e", eyes: a.eyes, character: a.character, packVersion: 1, v: 1 };
    assert.equal((await files.saveAvatarJson("peggy", same)).ok, true);
    assert.deepEqual(["avatar.json", "avatar.png", ".bot.json"].map((n) => statSync(join(dir, n)).mtimeMs), before);
    assert.deepEqual(renders(dir), listing);
    assert.equal(existsSync(join(dir, "avatar.json.bak")), false);
  } finally {
    host.done();
  }
});

test("bad ids: unknown character, eyes, accessory, colour or a newer pack are `invalid`; bad or unknown bots throw", async () => {
  const host = tempHost();
  try {
    const files = new BotFiles(host);
    const bad: Array<[Partial<AvatarJson>, RegExp]> = [
      [{ character: "nobody" }, /character/],
      [{ eyes: "oval" }, /eyes/],
      [{ colour: "#123456" }, /colour/],
      [{ accessories: [{ id: "jetpack", x: 0.5, y: 0.5, scale: 0.4 }] }, /accessories\.0\.id/],
      [{ packVersion: 99 }, /packVersion/],
      [{ accessories: [{ id: "glasses", x: 1.5, y: 0.5, scale: 0.4 }] }, /accessories\.0\.x/],
    ];
    for (const [over, re] of bad) {
      const r = await files.saveAvatarJson("peggy", avatar(over));
      assert.equal(r.ok, false);
      if (r.ok || r.reason !== "invalid") throw new Error(`expected invalid for ${JSON.stringify(over)}`);
      assert.match(r.error, re);
      assert.equal(r.packVersion, AVATAR_PACK.packVersion);
    }
    assert.equal((await files.saveAvatarJson("peggy", { v: 2 })).ok, false);
    assert.equal(existsSync(join(host.root, "peggy", "avatar.json")), false);
    assert.equal(existsSync(join(host.root, "peggy", "avatars")), false);
    await assert.rejects(files.saveAvatarJson("../etc", avatar()), /Not a bot id/);
    await assert.rejects(files.saveAvatarJson("ghost", avatar()), /Unknown bot/);
    await assert.rejects(files.avatarJson("ghost"), /Unknown bot/);
  } finally {
    host.done();
  }
});

test("a render that fails leaves every file as it was, and the save can be sent again", async () => {
  const host = tempHost();
  try {
    const dir = join(host.root, "peggy");
    let fail = true;
    const real = await resvgRenderer();
    const renderer = async (): Promise<AvatarRenderer> => (svg, size) => {
      if (fail) throw new Error("render failed");
      return real(svg, size);
    };
    const files = new BotFiles({ ...host, renderer });
    await assert.rejects(files.saveAvatarJson("peggy", avatar()), /render failed/);
    assert.equal(existsSync(join(dir, "avatar.json")), false);
    assert.equal(existsSync(join(dir, "avatar.png")), false);
    fail = false;
    assert.equal((await files.saveAvatarJson("peggy", avatar())).ok, true);
  } finally {
    host.done();
  }
});

test("old renders are dropped: only the current and the previous picture stay", async () => {
  const host = tempHost();
  try {
    const dir = join(host.root, "peggy");
    const files = new BotFiles(host);
    const looks = ["original", "dot", "pill", "wide"].map((eyes, i) => avatar({ eyes, revision: i + 1 }));
    for (const a of looks) await files.saveAvatarJson("peggy", a);
    const want = [looks[2]!, looks[3]!].flatMap((a) => AVATAR_SIZES.map((s) => renderFileName(avatarJsonHash(a), s)));
    assert.deepEqual(renders(dir), want.sort());
    // Back to an earlier picture: it renders again under its old name.
    await files.saveAvatarJson("peggy", { ...looks[0]!, revision: 9 });
    assert.deepEqual(renders(dir), [looks[3]!, looks[0]!].flatMap((a) => AVATAR_SIZES.map((s) => renderFileName(avatarJsonHash(a), s))).sort());
    writeFileSync(join(dir, "avatars", "x.png.1.2.tmp"), "");
    writeFileSync(join(dir, "avatars", "keep-me.txt"), "");
    const removed = await pruneRenders(join(dir, "avatars"), [avatarJsonHash(looks[0]!)]);
    assert.ok(removed.includes("x.png.1.2.tmp"));
    assert.ok(renders(dir).includes("keep-me.txt"));
    assert.equal(renders(dir).filter((n) => n.endsWith(".png")).length, 3);
  } finally {
    host.done();
  }
});

test("hash stability: the same picture always hashes the same, any change of picture changes it", async () => {
  const a = avatar();
  const h = avatarJsonHash(a);
  assert.match(h, /^[A-Za-z0-9_-]{16}$/);
  // Golden value: the hash is part of file names and device caches, so it must not drift between releases.
  assert.equal(h, createHash("sha256").update(JSON.stringify({
    v: 1, packVersion: 1, character: "octopus", eyes: "closed", colour: "#FECB3E",
    accessories: [{ id: "sun-hat", x: 0.401, y: 0.3693, scale: 0.6083, rotation: -20 }, { id: "glasses", x: 0.5002, y: 0.5018, scale: 0.4549 }],
  })).digest("base64url").slice(0, 16));
  assert.equal(avatarJsonHash({ ...a, revision: 77 }), h);
  assert.equal(avatarJsonHash({ ...a, colour: "#fecb3e" }), h);
  for (const other of [
    { ...a, eyes: "dot" },
    { ...a, colour: undefined },
    { ...a, accessories: a.accessories.slice().reverse() },
    { ...a, accessories: [{ ...a.accessories[0]!, rotation: -19 }, a.accessories[1]!] },
    { ...a, accessories: [a.accessories[0]!, { ...a.accessories[1]!, x: 0.5003 }] },
  ]) {
    assert.notEqual(avatarJsonHash(other as AvatarJson), h);
  }
  // Rendering is deterministic too: same bytes on every render.
  const render = await resvgRenderer();
  const [r1, r2] = [await renderAvatar(a, render), await renderAvatar(a, render)];
  for (const size of AVATAR_SIZES) assert.ok(r1.pngs[size].equals(r2.pngs[size]), `${size}px renders the same bytes`);
  // Rotation (AV2's optional field) reaches the picture.
  const turned = await renderAvatar({ ...a, accessories: [{ ...a.accessories[0]!, rotation: 30 }, a.accessories[1]!] }, render);
  assert.ok(!turned.pngs[128].equals(r1.pngs[128]));
});

test("bot list hash: a designed avatar sends its JSON hash and the size asked for; a picture upload or no avatar.json as before", async () => {
  const host = tempHost(["peggy", "scrat"]);
  try {
    const files = new BotFiles(host);
    const peggy = { id: "peggy", cwd: join(host.root, "peggy"), avatar: "avatar.png" };
    const scrat = { id: "scrat", cwd: join(host.root, "scrat"), avatar: "avatar.png" };
    writeFileSync(join(scrat.cwd, "avatar.png"), UPLOAD);
    const a = avatar({ revision: 3 });
    await files.saveAvatarJson("peggy", a);
    const service = new AvatarsService();
    const pngHash = (await service.read(join(scrat.cwd, "avatar.png"))).hash;
    assert.deepEqual(
      (await withAvatarHashes([peggy, scrat, { ...scrat, id: "none", avatar: null }], service)).map((b) => b.avatarHash),
      [avatarJsonHash(a), pngHash, null],
    );
    for (const size of AVATAR_SIZES) {
      const got = await service.forBot(peggy, size);
      assert.equal(got.hash, avatarJsonHash(a));
      assert.equal(got.size, size);
      const bytes = Buffer.from(got.dataUri!.split(",")[1]!, "base64");
      assert.deepEqual(dims(bytes), { w: size, h: size });
    }
    assert.equal((await service.forBot(peggy)).size, 512);
    assert.deepEqual(await service.forBot(scrat, 64), { ...(await service.read(join(scrat.cwd, "avatar.png"))), size: null });
    // A picture upload replaces avatar.png: the design is no longer what shows, so the hash is the PNG's again.
    await files.setAvatar("peggy", UPLOAD_URI);
    const after = await service.forBot(peggy, 128);
    assert.equal(after.size, null);
    assert.equal(after.hash, pngHash);
    assert.equal(after.dataUri, UPLOAD_URI);
    // ...and a queued older design save cannot bring it back; a new one can.
    assert.equal((await files.saveAvatarJson("peggy", avatar({ revision: 2, eyes: "dot" }))).ok, false);
    assert.equal((await files.saveAvatarJson("peggy", avatar({ revision: 4, eyes: "dot" }))).ok, true);
    assert.equal(await service.hashForBot(peggy), avatarJsonHash(avatar({ eyes: "dot" })));
  } finally {
    host.done();
  }
});

test("create accepts avatar.json (rendered, stored, revision kept); refuses a bad one or both kinds of avatar", async () => {
  const host = tempHost([]);
  try {
    const files = new BotFiles(host);
    const a = avatar({ revision: 1 });
    const made = await files.create({ name: "Tweety Bird", agentsMd: "# Tweety", avatarJson: a });
    const dir = join(host.root, made.botId);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "avatar.json"), "utf8")), a);
    assert.equal(JSON.parse(readFileSync(join(dir, ".bot.json"), "utf8")).avatar, "avatar.png");
    assert.deepEqual(dims(readFileSync(join(dir, "avatar.png"))), { w: 512, h: 512 });
    assert.equal(existsSync(join(dir, "avatar.png.bak")), false);
    assert.equal(renders(dir).length, 3);
    assert.equal(await new AvatarsService().hashForBot({ cwd: dir, avatar: "avatar.png" }), avatarJsonHash(a));
    assert.equal((await files.saveAvatarJson(made.botId, a)).ok, true, "the create's save resent is idempotent");
    await assert.rejects(files.create({ name: "Bad Eyes", agentsMd: "", avatarJson: avatar({ eyes: "oval" }) }), /not valid.*eyes/);
    assert.equal(existsSync(join(host.root, "bad-eyes")), false);
    await assert.rejects(files.create({ name: "Both", agentsMd: "", avatar: UPLOAD_URI, avatarJson: a }), /not both/);
    // The PNG upload path is unchanged.
    const plain = await files.create({ name: "Plain", agentsMd: "", avatar: UPLOAD_URI });
    assert.ok(readFileSync(join(host.root, plain.botId, "avatar.png")).equals(UPLOAD));
    assert.equal(existsSync(join(host.root, plain.botId, "avatar.json")), false);
  } finally {
    host.done();
  }
});

test("pack download: gzip of the shipped pack JSON, checked by sha256, under 100 KB", () => {
  const pack = packGzip();
  const json = gunzipSync(Buffer.from(pack.data, "base64")).toString("utf8");
  assert.equal(json, AVATAR_PACK_JSON);
  assert.equal(pack.sha256, createHash("sha256").update(json).digest("hex"));
  assert.equal(pack.packVersion, AVATAR_PACK.packVersion);
  assert.ok(pack.bytes < 100_000, `${pack.bytes} B`);
  assert.equal(packGzip(), pack, "computed once");
  assert.ok(botsAvatarPackRpc.output.safeParse({ ...pack, encoding: "gzip-base64" }).success);
});
