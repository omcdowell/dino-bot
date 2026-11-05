import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AVATAR_MAX_BYTES, AvatarsService, avatarPath, withAvatarHashes } from "../server/avatars";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);

test("avatarPath resolves ~, absolute and bot-relative paths", () => {
  assert.equal(avatarPath("~/icons/a.png", "/b/flint", "/home/x"), "/home/x/icons/a.png");
  assert.equal(avatarPath("/abs/a.png", "/b/flint", "/home/x"), "/abs/a.png");
  assert.equal(avatarPath("avatar.png", "/b/flint", "/home/x"), "/b/flint/avatar.png");
  assert.equal(avatarPath("../shared/a.png", "/b/flint", "/home/x"), "/b/shared/a.png");
});

test("AvatarsService returns a PNG data URI, rejects non-PNG, oversize and missing files, and rereads on change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avatars-"));
  const service = new AvatarsService();
  const png = join(dir, "a.png");
  writeFileSync(png, PNG);
  assert.equal(await service.dataUri(png), `data:image/png;base64,${PNG.toString("base64")}`);
  const text = join(dir, "b.png");
  writeFileSync(text, "not a png");
  assert.equal(await service.dataUri(text), null);
  const big = join(dir, "c.png");
  writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]));
  assert.equal(await service.dataUri(big), null);
  assert.equal(await service.dataUri(join(dir, "missing.png")), null);
  writeFileSync(png, "changed");
  utimesSync(png, new Date(), new Date(Date.now() + 5000));
  assert.equal(await service.dataUri(png), null, "a changed file is read again");
});

test("AvatarsService.read gives a content hash: same bytes same hash (even after a touch), new bytes a new one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avatars-"));
  const service = new AvatarsService();
  const png = join(dir, "a.png");
  writeFileSync(png, PNG);
  const first = await service.read(png);
  assert.equal(first.dataUri, `data:image/png;base64,${PNG.toString("base64")}`);
  assert.match(first.hash ?? "", /^[A-Za-z0-9_-]{16}$/);
  assert.equal(await service.hash(png), first.hash);
  utimesSync(png, new Date(), new Date(Date.now() + 5000));
  assert.equal(await service.hash(png), first.hash, "a touch alone keeps the hash");
  const other = Buffer.concat([PNG, Buffer.from("more")]);
  writeFileSync(png, other);
  utimesSync(png, new Date(), new Date(Date.now() + 10_000));
  const changed = await service.read(png);
  assert.notEqual(changed.hash, first.hash);
  assert.equal(changed.dataUri, `data:image/png;base64,${other.toString("base64")}`);
  assert.deepEqual(await service.read(join(dir, "missing.png")), { dataUri: null, hash: null });
});

test("withAvatarHashes adds each bot's avatar hash for bots.list; null without a usable avatar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avatars-"));
  writeFileSync(join(dir, "avatar.png"), PNG);
  const service = new AvatarsService();
  const bots = await withAvatarHashes(
    [
      { id: "flint", cwd: dir, avatar: "avatar.png" },
      { id: "scrat", cwd: dir, avatar: null },
      { id: "peggy", cwd: dir, avatar: "missing.png" },
    ],
    service,
  );
  assert.deepEqual(
    bots.map((bot) => [bot.id, bot.avatarHash]),
    [
      ["flint", (await service.read(join(dir, "avatar.png"))).hash],
      ["scrat", null],
      ["peggy", null],
    ],
  );
  assert.ok(bots[0]?.avatarHash);
});
