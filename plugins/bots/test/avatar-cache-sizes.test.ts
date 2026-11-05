// AV4 avatar-cache: only the PNG size a slot needs, a bigger copy serves smaller slots, drawn from avatar.json
// when the phone can, and bytes on a 10-bot home refresh (unchanged vs one changed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, dehydrate, hydrate } from "@tanstack/react-query";
import { AVATAR_PACK, composeAvatarSvg, type AvatarPack } from "../shared/avatar";
import { avatarKey, avatarPngSize, resolveAvatarKey, satisfies } from "../client/avatar-cache";
import { FakeHost, fixtureAvatars, refreshHome, tenBots } from "./avatar-sim";

const PNG = { size: 128 as const };
const SVG = { size: 128 as const, pack: AVATAR_PACK };

test("avatarPngSize: the smallest of 64/128/512 for the slot, at up to 2x", () => {
  assert.equal(avatarPngSize(18, 3), 64);
  assert.equal(avatarPngSize(32, 3), 64);
  assert.equal(avatarPngSize(40, 2), 64);
  assert.equal(avatarPngSize(44, 3), 128);
  assert.equal(avatarPngSize(56, 3), 128);
  assert.equal(avatarPngSize(72, 2), 128);
  assert.equal(avatarPngSize(96, 3), 512);
  assert.equal(avatarPngSize(56, 1), 64);
  assert.equal(avatarPngSize(400, 3), 512);
});

test("satisfies: a PNG at least as big, the full image, or SVG when the phone can draw it", () => {
  assert.ok(satisfies({ dataUri: "x", size: 512 }, { size: 64 }));
  assert.ok(!satisfies({ dataUri: "x", size: 64 }, { size: 128 }));
  assert.ok(satisfies({ dataUri: "x" }, { size: 512 }), "full avatar.png");
  assert.ok(!satisfies({ dataUri: "x", size: 128 }, {}), "a sized copy is not the full image");
  assert.ok(satisfies({ dataUri: null, svg: "<svg/>" }, SVG));
  assert.ok(!satisfies({ dataUri: null, svg: "<svg/>" }, PNG), "no SVG drawer");
  assert.ok(!satisfies({ dataUri: null }, SVG));
});

test("PNG path: asks for the slot's size only, then never again for the same hash", async () => {
  const host = new FakeHost(tenBots());
  const client = new QueryClient();
  const drawn = await refreshHome(client, host, PNG);
  assert.equal(host.calls.length, 10);
  for (const call of host.calls) assert.deepEqual(Object.keys(call).sort(), ["botId", "size"]);
  assert.ok(host.calls.every((c) => c.size === 128 && !c.format));
  assert.ok(drawn.every((d) => d?.size === 128 && d.dataUri?.startsWith("data:image/png;base64,")));
  await client.invalidateQueries();
  await refreshHome(client, host, PNG);
  assert.equal(host.calls.length, 10, "unchanged hashes: no avatar request");
});

test("a 512 copy serves a 64 slot with no fetch; a 64 copy does not serve 512", async () => {
  const host = new FakeHost(tenBots().slice(0, 1));
  const client = new QueryClient();
  await refreshHome(client, host, { size: 512 });
  await refreshHome(client, host, { size: 64 });
  assert.deepEqual(host.calls.map((c) => c.size), [512]);

  const other = new QueryClient();
  await refreshHome(other, host, { size: 64 });
  await refreshHome(other, host, { size: 512 });
  assert.deepEqual(host.calls.slice(1).map((c) => c.size), [64, 512]);
  // Both sizes are kept for the same hash; the next 64 slot reads the 64.
  const [bot] = host.list().bots;
  assert.deepEqual(resolveAvatarKey(other, bot!, { size: 64 }), avatarKey(bot!, 64));
});

test("an older server that ignores size: its full image is kept once and serves every size", async () => {
  const host = new FakeHost(tenBots().slice(0, 2), { sizes: false });
  const client = new QueryClient();
  await refreshHome(client, host, { size: 64 });
  await refreshHome(client, host, { size: 512 });
  await refreshHome(client, host, SVG);
  assert.equal(host.calls.length, 2);
  assert.ok(host.calls.every((c) => !c.format), "no avatarPack from that server: never asks for JSON");
});

test("JSON path: one ~300 B answer per hash, composed on the phone, drawn at every size", async () => {
  const host = new FakeHost(tenBots());
  const client = new QueryClient();
  const drawn = await refreshHome(client, host, SVG);
  assert.equal(host.calls.length, 10);
  assert.ok(host.calls.every((c) => c.format === "json"));
  for (const [i, d] of drawn.entries()) {
    assert.equal(d?.dataUri, null);
    assert.equal(d?.svg, composeAvatarSvg(host.bots[i]!.json!, AVATAR_PACK), "same picture as the server renders");
    assert.equal(d?.packVersion, AVATAR_PACK.packVersion);
  }
  await refreshHome(client, host, { size: 64, pack: AVATAR_PACK });
  await refreshHome(client, host, { size: 512, pack: AVATAR_PACK });
  assert.equal(host.calls.length, 10, "the SVG serves every slot size");
});

test("JSON path: a bot without avatar.json gets the PNG of the slot's size, not again as JSON", async () => {
  const [one] = tenBots();
  const host = new FakeHost([{ id: "upload", json: null, png: Buffer.from("not-really-a-png") }, one!]);
  const client = new QueryClient();
  await refreshHome(client, host, SVG);
  assert.deepEqual(host.calls.map((c) => c.format ?? "png"), ["png", "json"], "avatarPack null: PNG asked directly");

  // A server that lists avatarPack but has no JSON for it answers a PNG; a bigger slot then asks by size.
  const odd = new FakeHost([{ id: "odd", json: null, png: Buffer.from("png") }]);
  const listed = odd.list().bots[0]!;
  const bot = { ...listed, avatarPack: 1 };
  const c2 = new QueryClient();
  assert.deepEqual(resolveAvatarKey(c2, bot, SVG), avatarKey(bot, "json"));
  c2.setQueryData(avatarKey(bot, "json"), { dataUri: "data:image/png;base64,AA", hash: listed.avatarHash, size: 64 });
  assert.deepEqual(resolveAvatarKey(c2, bot, { ...SVG, size: 512 }), avatarKey(bot, 512));
});

test("JSON from a newer pack than the phone's: the PNG instead", async () => {
  const host = new FakeHost(tenBots().slice(0, 1));
  const client = new QueryClient();
  const oldPack: AvatarPack = { ...AVATAR_PACK, packVersion: 0 };
  await refreshHome(client, host, { size: 128, pack: oldPack });
  assert.deepEqual(host.calls, [{ botId: "bot0", size: 128 }]);
});

test("the device copy (with the composed SVG) survives a cold start", async () => {
  const host = new FakeHost(tenBots());
  const before = new QueryClient();
  await refreshHome(before, host, SVG);
  const client = new QueryClient();
  hydrate(client, dehydrate(before));
  const drawn = await refreshHome(client, host, SVG);
  assert.equal(host.calls.length, 10, "no avatar request after the cold start");
  assert.ok(drawn.every((d) => d?.svg?.startsWith("<svg")));
});

/** Bytes of the avatar requests and answers of one refresh (bots.list counted separately). */
async function refreshBytes(need: { size?: 64 | 128 | 512; pack?: AvatarPack | null }) {
  const host = new FakeHost(tenBots());
  const client = new QueryClient();
  await refreshHome(client, host, need);
  host.bytes = 0;
  host.listBytes = 0;
  host.calls = [];
  await client.invalidateQueries();
  await refreshHome(client, host, need);
  const unchanged = { avatar: host.bytes, calls: host.calls.length };
  const listBytes = host.listBytes;
  host.bots[3] = { ...host.bots[3]!, json: { ...fixtureAvatars()[9]!, revision: 7 } };
  host.bytes = 0;
  host.calls = [];
  await refreshHome(client, host, need);
  const changed = { avatar: host.bytes, calls: host.calls.length };
  return { unchanged, changed, listBytes };
}

test("bytes, 10 bots: an unchanged refresh sends no avatar bytes; one change costs one small answer", async () => {
  const png = await refreshBytes(PNG);
  assert.deepEqual(png.unchanged, { avatar: 0, calls: 0 });
  assert.equal(png.changed.calls, 1);
  assert.ok(png.changed.avatar < 12_000, `128 px PNG answer ${png.changed.avatar} B`);
  const svg = await refreshBytes(SVG);
  assert.deepEqual(svg.unchanged, { avatar: 0, calls: 0 });
  assert.equal(svg.changed.calls, 1);
  assert.ok(svg.changed.avatar < 500, `avatar.json answer ${svg.changed.avatar} B`);
});
