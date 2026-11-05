import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, QueryObserver, dehydrate, hydrate } from "@tanstack/react-query";
import type { RoomMessage } from "../shared/rooms/schema";
import {
  cachedThreadOf,
  dedupeMessages,
  EMPTY_THREAD_CACHE,
  headWoken,
  normaliseList,
  normaliseThread,
  normaliseThreadCache,
  putThread,
  rememberThread,
  ROOMS_THREAD_CACHE_KEY,
  THREAD_CACHE_BYTES,
  THREAD_CACHE_GROUP_BYTES,
  THREAD_CACHE_MAX,
  threadQueryOptions,
} from "../client/group-cache";

const msg = (id: string, text = `text ${id}`, extra: Partial<RoomMessage> = {}): RoomMessage => ({
  v: 1,
  id,
  ts: `2026-10-13T05:${String(Number(id.replace(/\D/g, "")) % 60).padStart(2, "0")}:00.000Z`,
  group: "g",
  from: "wallace",
  text,
  hop: 1,
  to: [],
  ...extra,
});

test("old-shape cached thread: partial messages get defaults, junk is dropped, nothing throws", () => {
  const raw = {
    // pre-v1 / partial records: no v, no hop, no to, no group
    messages: [
      { id: "a", ts: "2026-10-13T05:00:00Z", from: "user", text: "hi" },
      { id: "b", ts: "2026-10-13T05:01:00Z", from: "wallace", text: "yo", to: "flint", refused: "nope", assigned: "x" },
      { id: "b", ts: "2026-10-13T05:01:00Z", from: "wallace", text: "yo (edited)" },
      { ts: "no id" },
      null,
      42,
      { id: "c", ts: "2026-10-13T05:02:00Z", from: "flint" }, // no text
    ],
    members: [{ botId: "wallace", state: "typing" }, { botId: "flint", state: "room", queued: -1 }, "junk", { state: "idle" }],
  };
  const thread = normaliseThread(raw, "g");
  assert.deepEqual(
    thread.messages.map((m) => [m.id, m.text, m.hop, m.to, m.group, m.v]),
    [
      ["a", "hi", 0, [], "g", 1],
      ["b", "yo (edited)", 0, [], "g", 1],
    ],
  );
  assert.deepEqual(thread.members, [
    { botId: "wallace", state: "idle", queued: 0 },
    { botId: "flint", state: "room", queued: 0 },
  ]);
  for (const bad of [undefined, null, 7, "x", [], { messages: "x", members: {} }]) {
    assert.deepEqual(normaliseThread(bad), { messages: [], members: [] });
  }
});

test("old-shape cached thread store: unreadable groups are dropped, readable ones survive", () => {
  const raw = {
    groups: {
      "alarm-clock": { messages: [{ id: "a", ts: "t", from: "user", text: "hi" }] }, // no savedAt, no members
      broken: "x",
      empty: { messages: [] },
    },
  };
  const cache = normaliseThreadCache(raw);
  assert.deepEqual(Object.keys(cache.groups), ["alarm-clock"]);
  assert.equal(cache.groups["alarm-clock"]!.savedAt, 0);
  assert.equal(cachedThreadOf(raw, "alarm-clock")!.messages[0]!.text, "hi");
  assert.equal(cachedThreadOf(raw, "broken"), null);
  for (const bad of [undefined, null, "x", [], { groups: [] }, { v: 0 }]) {
    assert.deepEqual(normaliseThreadCache(bad), EMPTY_THREAD_CACHE);
    assert.equal(cachedThreadOf(bad, "g"), null);
  }
});

test("old-shape cached head: never throws, and a cached head draws no working ring", () => {
  const start = 1_000;
  const oldHead = normaliseThread({ members: [{ botId: "wallace", state: "room" }] });
  assert.equal(headWoken(oldHead, start - 1, start), false, "cached from an earlier session");
  assert.equal(headWoken(oldHead, start + 1, start), true, "fetched this session");
  assert.equal(headWoken(normaliseThread({ members: "x" }), start + 1, start), false);
  assert.equal(headWoken(undefined, start + 1, start), false);
});

test("old-shape cached rooms.list: lead string, bot-id members, missing fields", () => {
  const { groups } = normaliseList({
    groups: [
      { id: "alarm-clock", name: "Alarm Clock", lead: "wallace", members: ["wallace", "flint"], lastTs: null },
      { id: "x", members: [{ botId: "peggy" }] },
      { name: "no id" },
      null,
    ],
  });
  assert.deepEqual(groups[0], {
    id: "alarm-clock",
    name: "Alarm Clock",
    leads: ["wallace"],
    members: [
      { botId: "wallace", name: "wallace", icon: "Bot", avatarHash: null },
      { botId: "flint", name: "flint", icon: "Bot", avatarHash: null },
    ],
    lastTs: null,
    lastPreview: null,
  });
  assert.deepEqual(groups[1]!.leads, ["peggy"]);
  assert.equal(groups[1]!.name, "x");
  assert.equal(groups.length, 2);
  assert.deepEqual(normaliseList(undefined), { groups: [] });
  assert.deepEqual(normaliseList({ groups: "x" }), { groups: [] });
});

test("putThread keeps the newest THREAD_CACHE_MAX messages and resets member states", () => {
  const messages = Array.from({ length: 250 }, (_, i) => msg(`m${i}`));
  const cache = putThread(EMPTY_THREAD_CACHE, "g", { messages, members: [{ botId: "wallace", state: "room", queued: 2 }] }, 5);
  const held = cache.groups.g!;
  assert.equal(held.messages.length, THREAD_CACHE_MAX);
  assert.equal(held.messages[0]!.id, "m150");
  assert.equal(held.messages.at(-1)!.id, "m249");
  assert.deepEqual(held.members, [{ botId: "wallace", state: "idle", queued: 0 }]);
  assert.equal(held.savedAt, 5);
});

test("putThread keeps a group within its byte budget (long messages)", () => {
  const long = "x".repeat(8000);
  const messages = Array.from({ length: 100 }, (_, i) => msg(`m${i}`, long));
  const held = putThread(EMPTY_THREAD_CACHE, "g", { messages, members: [] }, 1).groups.g!;
  assert.ok(JSON.stringify(held.messages).length <= THREAD_CACHE_GROUP_BYTES);
  assert.ok(held.messages.length > 0 && held.messages.length < 100);
  assert.equal(held.messages.at(-1)!.id, "m99", "the newest message is kept");
});

test("putThread drops least recently changed groups past the total budget", () => {
  const long = "y".repeat(4000);
  let cache = EMPTY_THREAD_CACHE;
  for (let g = 0; g < 10; g++) {
    const messages = Array.from({ length: 20 }, (_, i) => msg(`m${i}`, long));
    cache = putThread(cache, `g${g}`, { messages, members: [] }, g);
  }
  assert.ok(JSON.stringify(cache).length <= THREAD_CACHE_BYTES + 100);
  assert.ok(cache.groups.g9, "the newest group is kept");
  assert.equal(cache.groups.g0, undefined, "the oldest group is dropped");
  // Reopening an old group keeps it and drops the next oldest instead.
  const reopened = putThread(cache, "g0", { messages: [msg("z1")], members: [] }, 100);
  assert.ok(reopened.groups.g0);
});

test("putThread returns the same cache when nothing changed (polls do not rewrite the device)", () => {
  const thread = { messages: [msg("a"), msg("b")], members: [{ botId: "w", state: "room" as const, queued: 0 }] };
  const cache = putThread(EMPTY_THREAD_CACHE, "g", thread, 1);
  assert.equal(putThread(cache, "g", { ...thread, members: [{ botId: "w", state: "idle", queued: 0 }] }, 2), cache);
  assert.notEqual(putThread(cache, "g", { ...thread, messages: [msg("a"), msg("b", "edited")] }, 3), cache);
  assert.equal(putThread(cache, "g", { messages: [], members: [] }, 4).groups.g, undefined);
});

test("dedupeMessages: one bubble per id, in first position, latest copy", () => {
  const out = dedupeMessages([msg("a"), msg("b"), msg("a", "new a"), msg("c")]);
  assert.deepEqual(out.map((m) => [m.id, m.text]), [["a", "new a"], ["b", "text b"], ["c", "text c"]]);
});

test("rememberThread round-trips through the app's dehydrate/hydrate (persist meta)", () => {
  const live = new QueryClient();
  rememberThread(live, "g", { messages: [msg("a"), msg("b")], members: [] }, 10);
  const before = live.getQueryCache().find({ queryKey: ROOMS_THREAD_CACHE_KEY })!.state.dataUpdatedAt;
  rememberThread(live, "g", { messages: [msg("a"), msg("b")], members: [] }, 20);
  assert.equal(live.getQueryCache().find({ queryKey: ROOMS_THREAD_CACHE_KEY })!.state.dataUpdatedAt, before, "unchanged: no write");
  const restored = new QueryClient();
  hydrate(restored, JSON.parse(JSON.stringify(dehydrate(live))));
  assert.deepEqual(cachedThreadOf(restored.getQueryData(ROOMS_THREAD_CACHE_KEY), "g")!.messages.map((m) => m.id), ["a", "b"]);
  live.clear();
  restored.clear();
});

test("thread opens on the device copy, then the live answer replaces it with no duplicates", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // An old-shape device copy (no hop / to), as restored by the app before the host answers.
  client.setQueryData(ROOMS_THREAD_CACHE_KEY, {
    groups: { g: { messages: [{ id: "a", ts: "2026-10-13T05:00:00Z", from: "user", text: "hi" }] } },
  });
  let answer: () => unknown = () => ({ messages: [msg("a"), msg("a"), msg("b")], members: [{ botId: "w", state: "room", queued: 0 }] });
  const observer = new QueryObserver(client, threadQueryOptions(client, "g", async () => answer()));
  const first = observer.getOptimisticResult(client.defaultQueryOptions(observer.options));
  assert.deepEqual(first.data!.messages.map((m) => m.id), ["a"], "cached copy at once");
  assert.equal(first.isLoading, false, "no spinner over the cached copy");
  assert.equal(first.isStale, true, "the host is asked at once");
  const result = await observer.refetch();
  assert.deepEqual(result.data!.messages.map((m) => m.id), ["a", "b"], "deduped live thread");
  assert.deepEqual(cachedThreadOf(client.getQueryData(ROOMS_THREAD_CACHE_KEY), "g")!.messages.map((m) => m.id), ["a", "b"]);
  // Offline: the error comes with the last data still there.
  answer = () => {
    throw new Error("offline");
  };
  const offline = await observer.refetch();
  assert.equal(offline.isError, true);
  assert.deepEqual(offline.data!.messages.map((m) => m.id), ["a", "b"]);
  client.clear();
});

test("thread with no device copy: loads as before", () => {
  const client = new QueryClient();
  const observer = new QueryObserver(client, threadQueryOptions(client, "g", async () => ({ messages: [], members: [] })));
  const first = observer.getOptimisticResult(client.defaultQueryOptions(observer.options));
  assert.equal(first.data, undefined);
  assert.equal(first.isPending, true);
  client.clear();
});
