import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { attach, PUSH_KEYS, type BotEvents } from "../client/push";
import { DMS_SUMMARY_KEY, dmsThreadKey, dmsThreadsKey } from "../client/dms-format";

function hub() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const live: Array<(live: boolean) => void> = [];
  const events: BotEvents = {
    live: true,
    on: (name, listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      return () => {};
    },
    onLiveChange: (listener) => {
      live.push(listener);
      return () => {};
    },
  };
  return {
    events,
    send: (name: string, data: unknown) => listeners.get(name)?.forEach((l) => l(data)),
    goLive: () => live.forEach((l) => l(true)),
  };
}

async function cache() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const seed = (key: readonly unknown[], data: unknown) => queryClient.fetchQuery({ queryKey: key, queryFn: async () => data });
  await seed(DMS_SUMMARY_KEY, { bots: [], stamp: "s0" });
  await seed(dmsThreadsKey("bitzer"), { threads: [], skipped: { invalid: 0, unknown: 0, truncated: false } });
  await seed(dmsThreadKey("bitzer", "T1"), { thread: null, messages: [] });
  await seed(PUSH_KEYS.previews, { bots: [] });
  const stale = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated ?? false;
  return { queryClient, stale };
}

test("a DMs push puts the summary in the cache and marks open threads stale, nothing else", async () => {
  const { queryClient, stale } = await cache();
  const h = hub();
  attach(queryClient, h.events);
  const summary = { bots: [{ botId: "bitzer", total: 3, last_ts: "2026-11-20T10:00:00.000Z" }], stamp: "s1" };
  h.send("bots.dms", { rev: 2, data: summary });
  assert.deepEqual(queryClient.getQueryData(DMS_SUMMARY_KEY), summary);
  assert.equal(stale(DMS_SUMMARY_KEY), false, "the pushed summary is not fetched again");
  assert.equal(stale(dmsThreadsKey("bitzer")), true);
  assert.equal(stale(dmsThreadKey("bitzer", "T1")), true);
  assert.equal(stale(PUSH_KEYS.previews), false);
});

test("a malformed DMs push is ignored", async () => {
  const { queryClient, stale } = await cache();
  const h = hub();
  attach(queryClient, h.events);
  h.send("bots.dms", { rev: 2, data: { bots: "nope" } });
  assert.deepEqual(queryClient.getQueryData(DMS_SUMMARY_KEY), { bots: [], stamp: "s0" });
  assert.equal(stale(dmsThreadKey("bitzer", "T1")), false);
});

test("a previews push leaves the DMs alone", async () => {
  const { queryClient, stale } = await cache();
  const h = hub();
  attach(queryClient, h.events);
  h.send("bots.previews", { rev: 5, data: { bots: [] } });
  assert.equal(stale(dmsThreadKey("bitzer", "T1")), false);
  assert.equal(stale(DMS_SUMMARY_KEY), false);
});

test("going live again (pushes may have been missed) refetches the DMs summary and threads", async () => {
  const { queryClient, stale } = await cache();
  const h = hub();
  attach(queryClient, h.events);
  h.goLive();
  assert.equal(stale(DMS_SUMMARY_KEY), true);
  assert.equal(stale(dmsThreadsKey("bitzer")), true);
  assert.equal(stale(dmsThreadKey("bitzer", "T1")), true);
  assert.equal(stale(PUSH_KEYS.previews), true);
});
