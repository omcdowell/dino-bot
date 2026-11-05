// AV4: the options pack on the phone: a newer server pack is fetched once in the background, kept on the
// device, and used from the next open (never swapped mid-session).
import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, dehydrate, hydrate } from "@tanstack/react-query";
import { AVATAR_PACK, AVATAR_PACK_JSON, type AvatarPack } from "../shared/avatar";
import {
  AVATAR_PACK_KEY_ROOT,
  newestPackVersion,
  parsePack,
  sessionPack,
  updateAvatarPack,
  type FetchPack,
} from "../client/avatar-pack-store";

/** A bundled pack one version behind, so the real pack JSON plays the server's newer one. */
const OLD: AvatarPack = { ...AVATAR_PACK, packVersion: 0 };
const serverJson = AVATAR_PACK_JSON; // packVersion 1
const V = AVATAR_PACK.packVersion;

function server(json: string | null = serverJson, version = V) {
  const calls: number[] = [];
  const fetchPack: FetchPack = async ({ have }) => {
    calls.push(have);
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { packVersion: version, json };
  };
  return { calls, fetchPack };
}

test("parsePack: the real pack parses; junk, wrong version and missing lists do not", () => {
  assert.equal(parsePack(AVATAR_PACK_JSON)?.packVersion, V);
  assert.equal(parsePack(AVATAR_PACK_JSON, V + 1), null);
  assert.equal(parsePack("{"), null);
  assert.equal(parsePack(JSON.stringify({ packVersion: 2, characters: [] })), null);
  assert.equal(parsePack(JSON.stringify({ ...AVATAR_PACK, characters: [{ id: "x" }] })), null);
});

test("no fetch when the server's pack is not newer than the phone's", async () => {
  const client = new QueryClient();
  const s = server();
  assert.equal(await updateAvatarPack(client, V, s.fetchPack), null, "same version as bundled");
  assert.equal(await updateAvatarPack(client, undefined, s.fetchPack), null, "older server: no avatarPackVersion");
  assert.equal(s.calls.length, 0);
  assert.equal(sessionPack(client), AVATAR_PACK);
});

test("a newer pack: fetched once (concurrent calls share it), kept persisted, used only from the next open", async () => {
  const client = new QueryClient();
  assert.equal(sessionPack(client, OLD), OLD, "this session draws with the bundled pack");
  const s = server();
  const results = await Promise.all([1, 2, 3].map(() => updateAvatarPack(client, V, s.fetchPack, OLD)));
  assert.deepEqual(results, [V, V, V]);
  assert.deepEqual(s.calls, [0], "one request, saying which version the phone has");
  assert.equal(await updateAvatarPack(client, V, s.fetchPack, OLD), null, "kept: not fetched again");
  assert.equal(s.calls.length, 1);
  assert.equal(sessionPack(client, OLD), OLD, "not swapped in mid-session");
  assert.equal(newestPackVersion(client, OLD), V);

  const query = client.getQueryCache().find({ queryKey: [...AVATAR_PACK_KEY_ROOT, V] });
  assert.deepEqual(query?.meta, { persist: true });

  // Next open: the app installs the persisted queries; the new pack is this session's.
  const next = hydrated(client);
  const pack = sessionPack(next, OLD);
  assert.equal(pack.packVersion, V);
  assert.equal(pack.characters.length, AVATAR_PACK.characters.length);
});

test("a bad answer is not kept and is retried at the next call", async () => {
  const client = new QueryClient();
  const bad = server("{not json");
  assert.equal(await updateAvatarPack(client, V, bad.fetchPack, OLD), null);
  const wrong = server(serverJson, V + 1); // says it is newer than it is
  assert.equal(await updateAvatarPack(client, V, wrong.fetchPack, OLD), null);
  const good = server();
  assert.equal(await updateAvatarPack(client, V, good.fetchPack, OLD), V);
  assert.equal(bad.calls.length + wrong.calls.length + good.calls.length, 3);
  assert.equal(sessionPack(hydrated(client), OLD).packVersion, V);
});

test("a kept pack that no longer parses is ignored: the bundled pack draws", () => {
  const client = new QueryClient();
  client.setQueryData([...AVATAR_PACK_KEY_ROOT, 5], { packVersion: 5, json: "{broken" });
  assert.equal(sessionPack(client, OLD), OLD);
  assert.equal(newestPackVersion(client, OLD), 0);
});

test("an older kept pack is dropped once a newer one is kept", async () => {
  const client = new QueryClient();
  client.setQueryData([...AVATAR_PACK_KEY_ROOT, 0], { packVersion: 0, json: JSON.stringify(OLD) });
  const below = { ...OLD, packVersion: -1 } as AvatarPack;
  await updateAvatarPack(client, V, server().fetchPack, below);
  const kept = client.getQueryCache().findAll({ queryKey: [...AVATAR_PACK_KEY_ROOT] }).map((q) => q.queryKey[2]);
  assert.deepEqual(kept, [V]);
});

function hydrated(from: QueryClient): QueryClient {
  const next = new QueryClient();
  hydrate(next, dehydrate(from, { shouldDehydrateQuery: (q) => q.meta?.persist === true && q.state.status === "success" }));
  return next;
}

