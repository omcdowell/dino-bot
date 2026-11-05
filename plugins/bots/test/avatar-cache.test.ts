import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, QueryObserver, dehydrate, hydrate } from "@tanstack/react-query";
import { avatarKey, avatarQueryOptions, cachedAvatar, pruneAvatars, type AvatarBot, type AvatarData } from "../client/avatar-cache";

const flint = (hash: string | null | undefined, avatar: string | null = "avatar.png"): AvatarBot => ({
  id: "flint",
  avatar,
  ...(hash === undefined ? {} : { avatarHash: hash }),
});
const art = (n: number): AvatarData => ({ dataUri: `data:image/png;base64,ART${n}`, hash: `h${n}` });

function fakeServer(answer: () => AvatarData) {
  const calls: string[] = [];
  return {
    calls,
    getAvatar: async ({ botId }: { botId: string }) => {
      calls.push(botId);
      return answer();
    },
  };
}

/** What a mounted BotAvatar sees: the observer's result after it settles. */
async function mount(client: QueryClient, bot: AvatarBot, getAvatar: (input: { botId: string }) => Promise<AvatarData>) {
  const observer = new QueryObserver(client, avatarQueryOptions(client, bot, getAvatar));
  const first = observer.getOptimisticResult(client.defaultQueryOptions(observer.options));
  const unsubscribe = observer.subscribe(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { first, observer, unsubscribe };
}

test("first paint after a cold start comes from the device copy: no RPC, no fallback", async () => {
  const before = new QueryClient();
  await before.fetchQuery(avatarQueryOptions(before, flint("h1"), async () => art(1)));
  const persisted = dehydrate(before);

  const client = new QueryClient();
  hydrate(client, persisted);
  const server = fakeServer(() => art(1));
  const { first, unsubscribe } = await mount(client, flint("h1"), server.getAvatar);
  assert.equal(first.data?.dataUri, art(1).dataUri, "drawn on the first render");
  assert.equal(server.calls.length, 0);
  unsubscribe();
});

test("an unchanged avatar is not fetched again when the app invalidates (host confirms its cache)", async () => {
  const client = new QueryClient();
  const server = fakeServer(() => art(1));
  const { unsubscribe } = await mount(client, flint("h1"), server.getAvatar);
  assert.equal(server.calls.length, 1, "first time: fetched");
  await client.invalidateQueries();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await client.refetchQueries();
  assert.equal(server.calls.length, 1, "no avatar bytes on a reconnect");
  assert.equal(client.getQueryData(avatarKey(flint("h1")))?.toString(), art(1).toString());
  unsubscribe();
});

test("a changed hash fetches once, keeps the old art on screen meanwhile, then drops the old copy", async () => {
  const client = new QueryClient();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const server = fakeServer(() => art(1));
  (await mount(client, flint("h1"), server.getAvatar)).unsubscribe();

  const slow = async () => {
    await gate;
    return art(2);
  };
  const observer = new QueryObserver(client, avatarQueryOptions(client, flint("h2"), slow));
  const unsubscribe = observer.subscribe(() => undefined);
  const loading = observer.getCurrentResult();
  assert.equal(loading.data?.dataUri, art(1).dataUri, "old art while the new one loads");
  assert.equal(loading.isPlaceholderData, true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(observer.getCurrentResult().data?.dataUri, art(2).dataUri);
  pruneAvatars(client, flint("h2"));
  assert.deepEqual(
    client.getQueryCache().findAll({ queryKey: ["bots", "avatar", "flint"] }).map((query) => query.queryKey[3]),
    ["h2"],
  );
  assert.equal(cachedAvatar(client, "flint")?.dataUri, art(2).dataUri);
  unsubscribe();
});

test("older servers (no hash) key by path and refetch on invalidate, as before", async () => {
  const client = new QueryClient();
  const server = fakeServer(() => ({ dataUri: "data:image/png;base64,OLD" }));
  const { unsubscribe } = await mount(client, flint(undefined), server.getAvatar);
  assert.deepEqual(avatarKey(flint(undefined)), ["bots", "avatar", "flint", "avatar.png"]);
  await client.invalidateQueries();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(server.calls.length, 2);
  unsubscribe();
});

test("a bot whose avatar was removed shows no stale art", async () => {
  const client = new QueryClient();
  (await mount(client, flint("h1"), fakeServer(() => art(1)).getAvatar)).unsubscribe();
  const observer = new QueryObserver(client, avatarQueryOptions(client, flint(null, null), async () => art(9)));
  assert.equal(observer.getCurrentResult().data, undefined);
});

test("avatar queries persist and are never garbage-collected", () => {
  const options = avatarQueryOptions(new QueryClient(), flint("h1"), async () => art(1));
  assert.equal(options.gcTime, Infinity);
  assert.equal(options.staleTime, Infinity);
  assert.deepEqual(options.meta, { persist: true });
});
