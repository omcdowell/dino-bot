// AM1 end to end, host and phone together with no fakes in between: the designer's save (AV3 outbox ->
// bots.avatar-save, AV1) writes avatar.json and renders 64/128/512; bots.list's avatarHash moves to the new
// picture; the phone's cache (AV4) asks bots.avatar for only the size its slot needs (or the JSON when it can
// draw SVG) and never again for an unchanged hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { AVATAR_PACK, composeAvatarSvg, type AvatarJson } from "../shared/avatar";
import { BotFiles } from "../server/manage";
import { AvatarsService, avatarAnswer, withAvatarHashes } from "../server/avatars";
import { AVATAR_SIZES, avatarJsonHash, renderFileName } from "../server/avatar-store";
import { botsAvatarRpc } from "../shared/home-rpc";
import { botsAvatarSaveRpc } from "../shared/avatar-rpc";
import { useAvatarApiFrom } from "../client/avatar-api";
import { avatarQueryOptions, type AvatarData, type AvatarNeed, type AvatarRequest, type GetAvatar } from "../client/avatar-cache";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UPLOAD = Buffer.concat([PNG_SIG, Buffer.from("uploaded")]);

function avatar(over: Partial<AvatarJson> = {}): AvatarJson {
  return {
    v: 1,
    packVersion: 1,
    character: "octopus",
    eyes: "closed",
    colour: "#FECB3E",
    accessories: [{ id: "sun-hat", x: 0.401, y: 0.3693, scale: 0.6083, rotation: -20 }],
    revision: 1,
    ...over,
  };
}

/** A host with one bot (uploaded avatar.png), served by the real BotFiles / AvatarsService, wire-checked. */
function host() {
  const base = mkdtempSync(join(process.env.BM_TEST_TMP ?? tmpdir(), "avatar-e2e-"));
  const root = join(base, "bots");
  const optchatHome = join(base, "optchat");
  const dir = join(root, "peggy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".optchat-profile"), "peggy\n");
  writeFileSync(join(dir, ".bot.json"), `${JSON.stringify({ name: "Peggy", icon: "Fish", avatar: "avatar.png" })}\n`);
  writeFileSync(join(dir, "avatar.png"), UPLOAD);
  mkdirSync(join(optchatHome, "profiles", "peggy"), { recursive: true });
  const files = new BotFiles({ root, optchatHome });
  const avatars = new AvatarsService();
  const bot = () => {
    const meta = JSON.parse(readFileSync(join(dir, ".bot.json"), "utf8")) as { avatar?: string };
    return { id: "peggy", avatar: meta.avatar ?? null, cwd: dir };
  };
  const calls: AvatarRequest[] = [];
  const getAvatar: GetAvatar = async (input) => {
    calls.push(botsAvatarRpc.input.parse(input));
    const answer = await avatarAnswer(avatars, bot(), input);
    return botsAvatarRpc.output.parse(answer);
  };
  const save = async (input: { botId: string; avatar: AvatarJson }) =>
    botsAvatarSaveRpc.output.parse(await files.saveAvatarJson(input.botId, botsAvatarSaveRpc.input.parse(input).avatar));
  const list = async () => (await withAvatarHashes([bot()], avatars))[0]!;
  return { dir, calls, getAvatar, save, list, done: () => rmSync(base, { recursive: true, force: true }) };
}

/** One avatar slot on the phone home: the query BotAvatar runs, resolved once. */
async function slot(client: QueryClient, h: ReturnType<typeof host>, need: AvatarNeed): Promise<AvatarData | undefined> {
  const bot = await h.list();
  const observer = new QueryObserver(client, avatarQueryOptions(client, bot, h.getAvatar, need));
  const result = await observer.refetch();
  return result.data;
}

test("save avatar.json -> host renders 64/128/512 -> list hash changes -> phone fetches only the size it needs", async () => {
  const h = host();
  try {
    const client = new QueryClient();
    const before = await h.list();
    assert.equal(before.avatarPack, null, "an uploaded PNG: nothing to draw from JSON");
    const uploaded = await slot(client, h, { size: 128 });
    assert.equal(uploaded?.size, undefined, "a plain avatar.png is the full image");
    assert.deepEqual(h.calls, [{ botId: "peggy", size: 128 }]);

    // The designer's Save, through the app's adapter (AV3 -> AV1).
    const api = useAvatarApiFrom(h.save, async () => ({ avatar: null }));
    const a = avatar();
    const saved = await api.save({ botId: "peggy", avatar: a });
    const hash = avatarJsonHash(a);
    assert.deepEqual(saved, { ok: true, revision: 1, hash });
    for (const size of AVATAR_SIZES) assert.ok(existsSync(join(h.dir, "avatars", renderFileName(hash, size))), `${size} rendered`);

    const after = await h.list();
    assert.equal(after.avatarHash, hash, "bots.list hash is the new picture's");
    assert.notEqual(after.avatarHash, before.avatarHash);
    assert.equal(after.avatarPack, 1);

    // PNG phone (no SVG drawer): the 128 only, then nothing for smaller slots or a refetch.
    h.calls.length = 0;
    const png = await slot(client, h, { size: 128 });
    assert.equal(png?.size, 128);
    const bytes = Buffer.from(png!.dataUri!.split(",")[1]!, "base64");
    assert.equal(bytes.readUInt32BE(16), 128, "a 128 px PNG");
    await slot(client, h, { size: 64 });
    await client.invalidateQueries();
    await slot(client, h, { size: 128 });
    assert.deepEqual(h.calls, [{ botId: "peggy", size: 128 }], "one request: the size needed");

    // A bigger slot needs the 512, once.
    await slot(client, h, { size: 512 });
    await slot(client, h, { size: 512 });
    assert.deepEqual(h.calls.slice(1), [{ botId: "peggy", size: 512 }]);

    // New app with SvgXml: the JSON (~300 B), composed on the phone, at every size.
    const svgPhone = new QueryClient();
    h.calls.length = 0;
    const drawn = await slot(svgPhone, h, { size: 64, pack: AVATAR_PACK });
    assert.equal(drawn?.svg, composeAvatarSvg(a, AVATAR_PACK));
    assert.equal(drawn?.dataUri, null);
    await slot(svgPhone, h, { size: 512, pack: AVATAR_PACK });
    assert.deepEqual(h.calls, [{ botId: "peggy", format: "json", size: 64 }], "one JSON request serves every size");

    // A resend is unchanged (hash stays); a new revision moves the hash again and refetches once.
    assert.deepEqual(await api.save({ botId: "peggy", avatar: a }), { ok: true, revision: 1, hash });
    assert.deepEqual(await api.save({ botId: "peggy", avatar: { ...a, revision: 0 } }), { ok: false, reason: "stale", currentRevision: 1 });
    const b = avatar({ eyes: "dot", revision: 2 });
    assert.deepEqual(await api.save({ botId: "peggy", avatar: b }), { ok: true, revision: 2, hash: avatarJsonHash(b) });
    assert.equal((await h.list()).avatarHash, avatarJsonHash(b));
    h.calls.length = 0;
    await slot(client, h, { size: 64 });
    assert.deepEqual(h.calls, [{ botId: "peggy", size: 64 }]);

    // avatar.png replaced by an upload: not the design's render any more, so no JSON is offered.
    writeFileSync(join(h.dir, "avatar.png"), UPLOAD);
    const replaced = await h.list();
    assert.equal(replaced.avatarPack, null);
    assert.notEqual(replaced.avatarHash, avatarJsonHash(b));
    const answer = await h.getAvatar({ botId: "peggy", format: "json", size: 64 });
    assert.equal(answer.avatar, undefined);
    assert.ok(answer.dataUri?.startsWith("data:image/png;base64,"));
  } finally {
    h.done();
  }
});
