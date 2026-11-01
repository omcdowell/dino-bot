import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BUSY_CHECK_MS, BusyFeed, IDLE_CHECK_MS, WEEKLY_CACHE_MS, WeeklyGate, busyBots, weeklyFull, type BusyBot, type BusyInput } from "../server/live-activity";
import type { UsageReport } from "@getpaseo/plugin/server/usage";
import { postLiveActivity } from "../server/live-activity-port";
import type { BotsPaseo } from "../server/bots";
import type { WorkerView } from "../server/workers";

const T0 = Date.parse("2026-10-11T07:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const view = (state: WorkerView["state"], since: number | null = T0 - 600_000): WorkerView => ({
  worker: `w-${state}`,
  pane: "w1:p1",
  since: since === null ? null : iso(since),
  state,
  herdr: "working",
  source: "registry",
});

function input(over: { chats?: Record<string, string>; workers?: Record<string, WorkerView[]> } = {}): BusyInput {
  const bots = [
    { id: "emmet", name: "Emmet", agentId: "a-emmet" },
    { id: "flint", name: "Flint", agentId: "a-flint" },
    { id: "tweety", name: "Tweety", agentId: null },
  ];
  const chats = new Map(Object.entries(over.chats ?? {}).map(([id, status]) => [id, { id, status }]));
  const workers = Object.entries(over.workers ?? {}).map(([botId, w]) => ({ botId, workers: w }));
  return { bots, chats, workers };
}

test("busyBots: working chat, outstanding or stalled workers; finished/unknown workers and idle chats are not busy", () => {
  const since = new Map<string, number>();
  const out = busyBots(
    input({
      chats: { "a-emmet": "running", "a-flint": "idle" },
      workers: { flint: [view("running"), view("stalled"), view("finished"), view("unknown")], tweety: [view("finished")] },
    }),
    since,
    new Map(),
    T0,
  );
  assert.deepEqual(out, [
    { id: "emmet", name: "Emmet", working: true, workers: 0, since: T0 / 1000 },
    { id: "flint", name: "Flint", working: false, workers: 2, since: (T0 - 600_000) / 1000, stalledWorkers: 1 },
  ]);
  assert.equal(busyBots(input({ chats: { "a-emmet": "initializing" } }), new Map(), new Map(), T0)[0]!.working, true);
  assert.deepEqual(busyBots(input({ chats: { "a-emmet": "error", "a-flint": "idle" }, workers: { flint: [view("blocked")] } }), new Map(), new Map(), T0).map((b) => b.id), ["flint"]);
});

test("busyBots: carries the bot's Lucide icon name (the widget draws its tile without the app's copy)", () => {
  const base = input({ chats: { "a-emmet": "running", "a-flint": "running" } });
  base.bots[0] = { ...base.bots[0]!, icon: "Brain" };
  const out = busyBots(base, new Map(), new Map(), T0);
  assert.equal(out[0]!.icon, "Brain");
  assert.equal("icon" in out[1]!, false);
});

test("busyBots: since = hook's turn start, kept while busy (working → waiting), reset after idle", () => {
  const since = new Map<string, number>();
  const turns = new Map([["a-emmet", T0 - 30_000]]);
  assert.equal(busyBots(input({ chats: { "a-emmet": "running" } }), since, turns, T0)[0]!.since, (T0 - 30_000) / 1000);
  // turn ends, workers still out (launched later than the turn start): same clock
  const waiting = busyBots(input({ chats: { "a-emmet": "idle" }, workers: { emmet: [view("running", T0 - 10_000)] } }), since, turns, T0 + 60_000);
  assert.deepEqual(waiting[0], { id: "emmet", name: "Emmet", working: false, workers: 1, since: (T0 - 30_000) / 1000 });
  // idle: forgotten; busy again later starts a new clock
  assert.deepEqual(busyBots(input({ chats: { "a-emmet": "idle" } }), since, new Map(), T0 + 120_000), []);
  assert.equal(busyBots(input({ chats: { "a-emmet": "running" } }), since, new Map(), T0 + 180_000)[0]!.since, (T0 + 180_000) / 1000);
});

test("busyBots: a bot not working with only stalled workers is stalled (stays on, flagged, stalled count)", () => {
  const out = busyBots(input({ chats: { "a-emmet": "idle" }, workers: { emmet: [view("stalled"), view("stalled")] } }), new Map(), new Map(), T0);
  assert.deepEqual(out, [{ id: "emmet", name: "Emmet", working: false, workers: 2, since: (T0 - 600_000) / 1000, stalled: true, stalledWorkers: 2 }]);
  // working chat + stalled workers: busy, not stalled; its stalled workers still counted (grey bars)
  const working = busyBots(input({ chats: { "a-emmet": "running" }, workers: { emmet: [view("stalled")] } }), new Map(), new Map(), T0);
  assert.equal(working[0]!.stalled, undefined);
  assert.equal(working[0]!.stalledWorkers, 1);
});

test("busyBots: a mixed bot (running + stalled workers) stays busy; its stalled workers are counted", () => {
  const out = busyBots(
    input({ chats: { "a-flint": "idle" }, workers: { flint: [view("running"), view("blocked"), view("stalled")] } }),
    new Map(),
    new Map(),
    T0,
  );
  assert.deepEqual(out, [{ id: "flint", name: "Flint", working: false, workers: 3, since: (T0 - 600_000) / 1000, stalledWorkers: 1 }]);
  assert.equal("stalled" in out[0]!, false);
});

const win = (id: string, label: string, usedPct: number, blocked: boolean, resetsAt: string | null = null) => ({
  id,
  label: blocked ? `${label} (blocked)` : label,
  shortLabel: id,
  usedPct,
  remainingPct: Math.max(0, 100 - usedPct),
  resetsAt,
  tone: "default" as const,
});
const usage = (seven_day: { fillPct: number; blocked: boolean }): UsageReport => ({
  status: "available",
  windows: [win("five_hour", "5-hour", 100, true), win("weekly", "Weekly", seven_day.fillPct, seven_day.blocked)],
});

test("weeklyFull: the weekly window at 100% or blocked; the 5-hour window and errors do not count", () => {
  assert.equal(weeklyFull(usage({ fillPct: 100, blocked: false })), true);
  assert.equal(weeklyFull(usage({ fillPct: 40, blocked: true })), true);
  assert.equal(weeklyFull(usage({ fillPct: 99.9, blocked: false })), false, "5-hour full and blocked, weekly not");
  assert.equal(weeklyFull({ status: "error", error: "down" }), false);
});

test("WeeklyGate: one read per 60 s; a failed read is 'not full' and cached too", async () => {
  const clock = { now: T0 };
  let reads = 0;
  let next: () => Promise<any> = async () => usage({ fillPct: 100, blocked: false });
  const gate = new WeeklyGate(() => (reads++, next()), () => clock.now);
  assert.equal(await gate.full(), true);
  clock.now += WEEKLY_CACHE_MS - 1;
  assert.equal(await gate.full(), true);
  assert.equal(reads, 1, "cached");
  clock.now += 1;
  next = async () => {
    throw new Error("ECONNREFUSED");
  };
  assert.equal(await gate.full(), false, "read failed: keep showing stalled bots");
  assert.equal(await gate.full(), false);
  assert.equal(reads, 2, "failure cached");
});

function harness(states: BusyInput[], postOk: boolean[] = [], weeklyFull?: () => Promise<boolean>) {
  const clock = { now: T0 };
  const posts: BusyBot[][] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let reads = 0;
  const feed = new BusyFeed({
    read: async () => states[Math.min(reads++, states.length - 1)]!,
    weeklyFull,
    port: { post: async (bots) => (posts.push(bots), postOk.shift() ?? true) },
    now: () => clock.now,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length - 1),
    clearTimer: () => {},
  });
  const api = {} as BotsPaseo;
  const fire = async () => {
    const t = timers.pop()!;
    clock.now += t.ms;
    t.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return { feed, posts, timers, api, fire, clock, reads: () => reads };
}

test("BusyFeed: posts only on change, checks every 2 s while busy and every 60 s while idle", async () => {
  const busy = input({ chats: { "a-emmet": "running" } });
  const idle = input();
  const h = harness([idle, busy, busy, idle, idle]);
  h.feed.touch(h.api);
  assert.equal(h.timers.at(-1)!.ms, 0);
  await h.fire(); // idle at start: [] is posted once so a stale set on the add-on is cleared
  assert.deepEqual(h.posts, [[]]);
  assert.equal(h.timers.at(-1)!.ms, IDLE_CHECK_MS);
  await h.fire(); // busy
  assert.equal(h.posts.length, 2);
  assert.equal((h.posts[1] as BusyBot[])[0]!.id, "emmet");
  assert.equal(h.timers.at(-1)!.ms, BUSY_CHECK_MS);
  await h.fire(); // unchanged: no post
  assert.equal(h.posts.length, 2);
  await h.fire(); // idle again
  assert.deepEqual(h.posts[2], []);
  assert.equal(h.timers.at(-1)!.ms, IDLE_CHECK_MS);
  await h.fire();
  assert.equal(h.posts.length, 3);
});

test("BusyFeed: a failed post is retried on the next check", async () => {
  const busy = input({ chats: { "a-emmet": "running" } });
  const h = harness([busy], [false, true]);
  h.feed.touch(h.api);
  await h.fire();
  await h.fire();
  await h.fire();
  assert.equal(h.posts.length, 2, "failed, then taken, then unchanged");
});

test("BusyFeed: turn_started checks at once and uses the hook's time as since", async () => {
  const h = harness([input({ chats: { "a-emmet": "running" } })]);
  h.clock.now = T0 + 5_000;
  h.feed.turnStarted(h.api, "a-emmet");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0]![0]!.since, (T0 + 5_000) / 1000);
  assert.equal(h.timers.at(-1)!.ms, BUSY_CHECK_MS);
});

test("BusyFeed: no Paseo API yet → nothing read; stop() ends the loop", async () => {
  const h = harness([input({ chats: { "a-emmet": "running" } })]);
  await h.feed.check();
  assert.equal(h.reads(), 0);
  h.feed.touch(h.api);
  h.feed.stop();
  await h.fire();
  assert.equal(h.reads(), 0);
});

const mixed = () =>
  input({ chats: { "a-emmet": "running" }, workers: { flint: [view("stalled")], tweety: [view("running"), view("stalled")] } });

test("BusyFeed: weekly at 100% or blocked drops stalled bots; mixed and working bots stay", async () => {
  let asked = 0;
  const h = harness([mixed()], [], async () => (asked++, true));
  h.feed.touch(h.api);
  await h.fire();
  assert.deepEqual(h.posts[0]!.map((b) => b.id), ["emmet", "tweety"]);
  assert.equal(asked, 1);
  // only stalled bots: they drop off and the set is empty (the add-on ends the activity as when idle)
  const alone = harness([input({ workers: { flint: [view("stalled")] } })], [], async () => true);
  alone.feed.touch(alone.api);
  await alone.fire();
  assert.deepEqual(alone.posts, [[]]);
  assert.equal(alone.timers.at(-1)!.ms, IDLE_CHECK_MS);
});

test("BusyFeed: weekly not full, or the usage read fails, keeps stalled bots shown", async () => {
  for (const weekly of [async () => false, async () => Promise.reject(new Error("usage source down"))]) {
    const h = harness([mixed()], [], weekly);
    h.feed.touch(h.api);
    await h.fire();
    assert.deepEqual(h.posts[0]!.map((b) => [b.id, b.stalled ?? false]), [["emmet", false], ["flint", true], ["tweety", false]]);
  }
  // A real gate whose fetch fails: same.
  const gate = new WeeklyGate(async () => {
    throw new Error("HTTP 502");
  });
  const h = harness([mixed()], [], () => gate.full());
  h.feed.touch(h.api);
  await h.fire();
  assert.equal(h.posts[0]!.length, 3);
});

test("BusyFeed: usage is not read while no bot is stalled", async () => {
  let asked = 0;
  const h = harness([input({ chats: { "a-emmet": "running" } })], [], async () => (asked++, true));
  h.feed.touch(h.api);
  await h.fire();
  assert.equal(h.posts[0]!.length, 1);
  assert.equal(asked, 0);
});

test("port: bearer and port from the add-on's dir, body {sender:'bots', bots}; false without setup or on errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "la-port-"));
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: calls.length === 1 ? 200 : 503 });
  }) as unknown as typeof fetch;
  assert.equal(await postLiveActivity({ PASEO_APNS_DIR: dir }, fakeFetch).post([]), false, "no notify-token");
  writeFileSync(join(dir, "notify-token"), "t".repeat(64) + "\n");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 6999 }));
  const port = postLiveActivity({ PASEO_APNS_DIR: dir }, fakeFetch);
  const bots = [{ id: "emmet", name: "Emmet", working: true, workers: 0, since: 1 }];
  assert.equal(await port.post(bots), true);
  assert.equal(calls[0]!.url, "http://127.0.0.1:6999/live-activity");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Bearer ${"t".repeat(64)}`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { sender: "bots", bots });
  assert.equal(await port.post(bots), false, "HTTP 503");
  const down = postLiveActivity({ PASEO_APNS_DIR: dir }, (async () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as unknown as typeof fetch);
  assert.equal(await down.post(bots), false);
});
