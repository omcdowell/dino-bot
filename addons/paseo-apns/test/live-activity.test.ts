import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ApnsService } from "../server/service.ts";
import { parseLiveActivity } from "../server/endpoint.ts";
import { liveActivitySyncRpc } from "../shared/rpc.ts";
import { HEARTBEAT_MS, MAX_AGE_MS, MAX_ROWS, MIN_INTERVAL_MS, STALE_AFTER_S, buildLaPayload, normaliseState, type LaBot, type Timers } from "../server/live-activity.ts";
import { fakeApns, settings, tempDir, throwawayKey, TOKEN_A, TOKEN_B, type Responder, type Seen } from "./helpers.ts";

type T = Parameters<typeof tempDir>[0] & { after(fn: () => unknown): void };

const START = "c".repeat(64);
const ACT = "d".repeat(64);
const T0 = Date.parse("2026-10-11T07:00:00Z");

/** Manual timers on the test clock. */
function manualTimers(clock: { now: number }) {
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => {
      const id = ++seq;
      due.set(id, { at: clock.now + Math.max(0, ms), fn });
      return id;
    },
    clear: (h) => void due.delete(h as number),
  };
  return {
    timers,
    pending: () => [...due.values()].map((d) => d.at - clock.now).sort((a, b) => a - b),
    /** Moves the clock and fires what came due, in order. */
    advance(ms: number) {
      const end = clock.now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]);
        clock.now = Math.max(clock.now, next[1].at);
        next[1].fn();
      }
      clock.now = end;
    },
  };
}

async function service(t: T, responder?: Responder) {
  const dir = tempDir(t);
  const { keyPath } = throwawayKey(dir);
  const fake = await fakeApns(t, responder);
  const clock = { now: T0 };
  const timers = manualTimers(clock);
  const svc = new ApnsService({ settings: settings(join(dir, "state"), keyPath), transport: fake.transport, now: () => clock.now, retryDelayMs: () => 1, timers: timers.timers });
  t.after(() => svc.stop());
  const la = svc.liveActivity;
  const step = async (ms: number) => {
    timers.advance(ms);
    await new Promise((r) => setImmediate(r));
    await la.whenIdle();
  };
  return { svc, la, clock, timers, step, dir: join(dir, "state"), ...fake };
}

const bot = (id: string, over: Partial<LaBot> = {}): LaBot => ({ id, name: id.toUpperCase(), working: true, workers: 0, since: T0 / 1000 - 60, ...over });
const sync = (s: { svc: ApnsService }, activities: Array<{ id: string; token: string | null }> = [], startToken: string | null = START) =>
  s.svc.liveActivitySync({ installId: "install-1", environment: "development", topic: "com.example.app", startToken, activities });
/** The phone holds a synced activity showing a "seed" bot; the clock is past the first window. */
async function withActivity(s: Awaited<ReturnType<typeof service>>) {
  const before = s.seen.length;
  s.la.setBots([bot("seed")]);
  sync(s, [{ id: "act-1", token: ACT }]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(s.seen.length, before, "the app applied the seed state itself");
}
const aps = (seen: Seen) => JSON.parse(seen.body).aps;
const tokenOf = (seen: Seen) => seen.path.split("/").pop();
const logOf = (dir: string) => readFileSync(join(dir, "push-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("normaliseState: only busy bots, working first then longest busy, names trimmed, capped with more", () => {
  const state = normaliseState([
    bot("b", { working: false, workers: 2, since: 100 }),
    bot("idle", { working: false, workers: 0 }),
    bot("a", { working: true, since: 300 }),
    bot("c", { working: false, workers: 1, since: 50, name: "x".repeat(60) }),
  ]);
  assert.deepEqual(state.bots.map((b) => b.id), ["a", "c", "b"]);
  assert.equal(state.bots[1]!.name.length, 40);
  assert.equal(state.more, 0);
  const many = normaliseState(Array.from({ length: MAX_ROWS + 3 }, (_, i) => bot(`bot${i}`)));
  assert.equal(many.bots.length, MAX_ROWS);
  assert.equal(many.more, 3);
});

test("icon names: a valid Lucide name travels in the state (the widget draws the tile); bad ones are dropped", () => {
  const parsed = parseLiveActivity({
    sender: "bots",
    bots: [
      { id: "emmet", name: "Emmet", working: true, workers: 1, since: 100, icon: "Brain" },
      { id: "flint", name: "Flint", working: true, workers: 0, since: 200, icon: "<svg>" },
      { id: "tweety", name: "Tweety", working: true, workers: 0, since: 300 },
    ],
  });
  assert.ok(Array.isArray(parsed));
  const state = normaliseState(parsed as LaBot[]);
  assert.deepEqual(state.bots.map((b) => b.icon), ["Brain", undefined, undefined]);
  assert.equal("icon" in state.bots[1]!, false);
  assert.equal(parseLiveActivity({ sender: "bots", bots: [{ id: "a", name: "A", working: true, workers: 0, since: 1, icon: 5 }] }), "icon must be a string");
});

test("stalled: the flag and stalled worker count pass through to the state; absent when not sent; bad ones refused", () => {
  const parsed = parseLiveActivity({
    sender: "bots",
    bots: [
      { id: "emmet", name: "Emmet", working: true, workers: 2, since: 100, stalledWorkers: 1 },
      { id: "flint", name: "Flint", working: false, workers: 2, since: 200, stalled: true, stalledWorkers: 2 },
      { id: "tweety", name: "Tweety", working: true, workers: 0, since: 300, stalled: false, stalledWorkers: 0 },
    ],
  });
  assert.ok(Array.isArray(parsed));
  const state = normaliseState(parsed as LaBot[]);
  assert.deepEqual(state.bots, [
    { id: "emmet", name: "Emmet", working: true, workers: 2, since: 100, stalledWorkers: 1 },
    { id: "tweety", name: "Tweety", working: true, workers: 0, since: 300 },
    { id: "flint", name: "Flint", working: false, workers: 2, since: 200, stalled: true, stalledWorkers: 2 },
  ]);
  // never more stalled than workers
  assert.equal(normaliseState([{ id: "a", name: "A", working: false, workers: 1, since: 1, stalledWorkers: 5 }]).bots[0]!.stalledWorkers, 1);
  const one = (extra: Record<string, unknown>) => parseLiveActivity({ sender: "bots", bots: [{ id: "a", name: "A", working: true, workers: 1, since: 1, ...extra }] });
  assert.equal(one({ stalled: "yes" }), "stalled must be a boolean");
  assert.equal(one({ stalledWorkers: 1.5 }), "stalledWorkers must be a count");
});

test("stalled: the sync answer keeps the stalled flag and count (the RPC output schema would strip unknown keys)", () => {
  const state = normaliseState([
    { id: "emmet", name: "Emmet", working: false, workers: 3, since: 100, stalledWorkers: 1 },
    { id: "flint", name: "Flint", working: false, workers: 2, since: 200, stalled: true, stalledWorkers: 2 },
  ]);
  const parsed = liveActivitySyncRpc.output.parse({ ok: true, reason: null, state, staleDate: 1 });
  assert.deepEqual(parsed.state, state);
  const old = liveActivitySyncRpc.output.parse({ ok: true, reason: null, state: normaliseState([bot("emmet")]), staleDate: 1 });
  assert.equal("stalled" in old.state!.bots[0]!, false);
});

test("payloads: start has attributes-type, attributes and a silent alert; update has no alert; end dismisses now", () => {
  const state = normaliseState([bot("emmet")]);
  const start = buildLaPayload("start", state, 1000).aps as Record<string, unknown>;
  assert.equal(start.event, "start");
  assert.equal(start["attributes-type"], "PaseoBotsAttributes");
  assert.deepEqual(start.attributes, {});
  assert.deepEqual(start.alert, { title: "Bots busy", body: "EMMET is busy" });
  assert.equal("sound" in start, false);
  assert.equal("sound" in (start.alert as object), false);
  assert.equal("badge" in start, false);
  assert.equal(start["stale-date"], 1000 + STALE_AFTER_S);
  assert.deepEqual(start["content-state"], state);
  const update = buildLaPayload("update", state, 1000).aps as Record<string, unknown>;
  assert.equal(update.event, "update");
  assert.equal("alert" in update || "attributes" in update || "attributes-type" in update, false);
  const end = buildLaPayload("end", { bots: [], more: 0 }, 1000).aps as Record<string, unknown>;
  assert.equal(end.event, "end");
  assert.equal(end["dismissal-date"], 1000);
  assert.equal("stale-date" in end, false);
  // a full payload stays under Apple's 4 KB
  const full = normaliseState(Array.from({ length: 40 }, (_, i) => bot(`a-rather-long-bot-name-${i}`, { name: "N".repeat(200) })));
  assert.ok(Buffer.byteLength(JSON.stringify(buildLaPayload("start", full, 1000))) < 4096);
});

test("start → update → end over the liveactivity channel; headers, topic, tokens", async (t) => {
  const s = await service(t);
  assert.deepEqual(sync(s), { ok: true, reason: null, state: null, staleDate: null, pushes: true });

  assert.equal(s.la.setBots([bot("emmet")]).changed, true);
  await s.step(MIN_INTERVAL_MS - 1);
  assert.equal(s.seen.length, 0, "the window is open");
  await s.step(1);
  assert.equal(s.seen.length, 1, "5 s after the first change");
  assert.equal(tokenOf(s.seen[0]!), START);
  assert.equal(s.seen[0]!.headers["apns-push-type"], "liveactivity");
  assert.equal(s.seen[0]!.headers["apns-topic"], "com.example.app.push-type.liveactivity");
  assert.equal(s.seen[0]!.headers["apns-priority"], "10");
  assert.equal(aps(s.seen[0]!).event, "start");

  // A pending start is not repeated while its activity has not synced.
  s.la.setBots([bot("emmet"), bot("flint", { working: false, workers: 2 })]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(s.seen.length, 1, "no second start while one is pending");

  // iOS woke the app: it syncs the new activity and applies the answer itself (no push needed).
  const answer = sync(s, [{ id: "act-1", token: ACT }]);
  assert.equal(answer.state!.bots.length, 2);
  assert.equal(answer.staleDate, Math.floor(s.clock.now / 1000) + STALE_AFTER_S);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(s.seen.length, 1, "the app already shows this state");

  s.la.setBots([bot("flint", { working: false, workers: 1 })]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(s.seen.length, 2);
  assert.equal(tokenOf(s.seen[1]!), ACT);
  assert.equal(aps(s.seen[1]!).event, "update");
  assert.deepEqual(aps(s.seen[1]!)["content-state"].bots.map((b: LaBot) => b.id), ["flint"]);

  s.la.setBots([]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(s.seen.length, 3);
  assert.equal(tokenOf(s.seen[2]!), ACT);
  assert.equal(aps(s.seen[2]!).event, "end");
  assert.deepEqual(s.la.status().activities, 0);
  assert.deepEqual(s.la.status().pushes, { start: 1, update: 1, end: 1, failed: 0 });

  const events = logOf(s.dir).map((e) => e.event);
  assert.deepEqual(events.filter((e) => e.startsWith("la-") && e !== "la-sync"), ["la-start", "la-update", "la-end"]);
  assert.equal(events.includes("sent"), false, "never logged as an alert");
  assert.equal(readFileSync(join(s.dir, "push-log.jsonl"), "utf8").includes(ACT), false, "only token tails in the log");
  assert.equal(statSync(join(s.dir, "live-activities.json")).mode & 0o777, 0o600);
});

test("rate: changes inside the 5 s window are one push with the latest state; a blip that settles back sends nothing", async (t) => {
  const s = await service(t);
  await withActivity(s);
  s.la.setBots([bot("a")]);
  await s.step(1000);
  s.la.setBots([bot("a"), bot("b")]);
  await s.step(1000);
  s.la.setBots([bot("b")]);
  await s.step(1000);
  s.la.setBots([bot("b"), bot("c")]);
  await s.step(MIN_INTERVAL_MS - 3000 - 1);
  assert.equal(s.seen.length, 0, "nothing inside the window");
  await s.step(1);
  assert.equal(s.seen.length, 1, "one push 5 s after the first change");
  assert.deepEqual(aps(s.seen[0]!)["content-state"].bots.map((b: LaBot) => b.id), ["b", "c"]);
  // Back-to-back changes: the next push is never closer than 5 s to the last.
  s.la.setBots([bot("c")]);
  await s.step(MIN_INTERVAL_MS - 1);
  assert.equal(s.seen.length, 1);
  await s.step(1);
  assert.equal(s.seen.length, 2);
  // A short turn (busy for 2 s, then back) sends nothing.
  s.la.setBots([bot("c"), bot("d")]);
  await s.step(2000);
  s.la.setBots([bot("c")]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(s.seen.length, 2);
  // Unchanged input: no flush scheduled at all.
  assert.equal(s.la.setBots([bot("c")]).changed, false);
  // 60 changes a minute still make at most 12 pushes a minute.
  const before = s.seen.length;
  for (let i = 0; i < 60; i += 1) {
    s.la.setBots([bot("c", { workers: i % 2 ? 1 : 2, working: false })]);
    await s.step(1000);
  }
  assert.ok(s.seen.length - before <= 12, `${s.seen.length - before} pushes in a minute`);
});

test("heartbeat moves the stale date while busy and unchanged; nothing while idle", async (t) => {
  const s = await service(t);
  await withActivity(s);
  s.la.setBots([bot("a")]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(s.seen.length, 1);
  await s.step(HEARTBEAT_MS + MIN_INTERVAL_MS - 1);
  assert.equal(s.seen.length, 1);
  await s.step(1);
  assert.equal(s.seen.length, 2);
  assert.equal(aps(s.seen[1]!).event, "update");
  assert.equal(aps(s.seen[1]!)["stale-date"], Math.floor(s.clock.now / 1000) + STALE_AFTER_S);
  s.la.setBots([]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(aps(s.seen[2]!).event, "end");
  await s.step(HEARTBEAT_MS * 3);
  assert.equal(s.seen.length, 3);
  assert.deepEqual(s.timers.pending(), []);
});

test("an activity near iOS's 8 h limit is ended and a fresh one started", async (t) => {
  const s = await service(t);
  await withActivity(s);
  s.clock.now += MAX_AGE_MS;
  s.la.setBots([bot("a"), bot("b")]);
  await s.step(MIN_INTERVAL_MS);
  assert.deepEqual(s.seen.map((x) => [aps(x).event, tokenOf(x)]), [["end", ACT], ["start", START]]);
});

test("a dead activity token is dropped and the next change starts a new activity; a dead start token is dropped", async (t) => {
  const s = await service(t, (req) => (req.path.endsWith(ACT) ? { status: 410, reason: "Unregistered" } : req.path.endsWith(START) ? { status: 400, reason: "BadDeviceToken" } : { status: 200 }));
  await withActivity(s);
  s.la.setBots([bot("a")]);
  await s.step(MIN_INTERVAL_MS);
  assert.deepEqual(s.seen.map((x) => [aps(x).event, tokenOf(x)]), [["update", ACT], ["start", START]]);
  assert.deepEqual(s.la.status(), { busy: 1, installs: 1, startTokens: 0, activities: 0, pushes: { start: 0, update: 0, end: 0, failed: 2 } });
  assert.deepEqual(logOf(s.dir).filter((e) => e.event === "la-failed").map((e) => e.reason), ["Unregistered", "BadDeviceToken"]);
});

test("separate channel: Live Activity pushes ignore the alert window and do not use it up", async (t) => {
  const s = await service(t);
  s.svc.register({ token: TOKEN_A, environment: "development", topic: "com.example.app" });
  const first = await s.svc.notify({ sender: "emmet", title: "Emmet", body: "hello" });
  assert.equal(first.code, "sent");
  assert.equal((await s.svc.notify({ sender: "emmet", title: "Emmet", body: "again" })).code, "rate_limited");
  await withActivity(s);
  for (let i = 0; i < 5; i += 1) {
    s.la.setBots([bot("a", { workers: i, working: false })].filter((b) => b.workers > 0).concat(bot("z")));
    await s.step(MIN_INTERVAL_MS);
  }
  const laPushes = s.seen.filter((x) => x.headers["apns-push-type"] === "liveactivity").length;
  assert.equal(laPushes, 5, "one per window, alert limit or not");
  // A fresh service restores the alert window from the log: la-* events do not count.
  const restored = new ApnsService({ settings: s.svc.options.settings, transport: s.transport, now: () => s.clock.now + 601_000 });
  t.after(() => restored.stop());
  assert.equal((await restored.notify({ sender: "emmet", title: "Emmet", body: "later" })).code, "sent");
  assert.equal(s.seen.filter((x) => x.headers["apns-push-type"] === "alert").length, 2);
});

test("sync: refuses a foreign topic, keeps tokens across syncs, idle answer clears activities", async (t) => {
  const s = await service(t);
  const foreign = s.svc.liveActivitySync({ installId: "install-1", environment: "development", topic: "com.other", startToken: START, activities: [] });
  assert.equal(foreign.ok, false);
  sync(s, [{ id: "act-1", token: ACT }]);
  sync(s, [{ id: "act-1", token: null }], null); // token not known yet in this launch: kept from before
  assert.equal(s.la.status().startTokens, 1);
  assert.equal(s.la.status().activities, 0, "idle: the app ends them, none kept");
  s.la.setBots([bot("a")]);
  const busy = sync(s, [{ id: "act-1", token: null }], null);
  assert.equal(busy.state!.bots[0]!.id, "a");
  await s.step(MIN_INTERVAL_MS);
  assert.equal(s.seen.length, 0, "the app applied it; nothing to push and no start (it has an activity)");
});

const syncAs = (s: { svc: ApnsService }, appearance: "light" | "dark" | null | undefined, activities: Array<{ id: string; token: string | null }> = [], startToken: string | null = START) =>
  s.svc.liveActivitySync({ installId: "install-1", environment: "development", topic: "com.example.app", startToken, activities, ...(appearance === undefined ? {} : { appearance }) });

test("appearance: the app's light/dark goes into the content state of its pushes (start and update)", async (t) => {
  const s = await service(t);
  syncAs(s, "light");
  s.la.setBots([bot("emmet")]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(aps(s.seen[0]!).event, "start");
  assert.equal(aps(s.seen[0]!)["content-state"].appearance, "light");
  syncAs(s, "light", [{ id: "act-1", token: ACT }]);
  s.la.setBots([bot("flint")]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(aps(s.seen[1]!).event, "update");
  assert.equal(aps(s.seen[1]!)["content-state"].appearance, "light");
  // Switched to dark with the app open: it applies that itself; the next push carries dark.
  syncAs(s, "dark", [{ id: "act-1", token: ACT }]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(s.seen.length, 2, "the app already shows dark");
  s.la.setBots([bot("flint", { workers: 1 })]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(aps(s.seen[2]!)["content-state"].appearance, "dark");
  assert.equal(s.la.state().bots[0]!.id, "flint");
  assert.equal("appearance" in s.la.state(), false, "the shared state stays per-install free");
});

test("appearance: a sync without one keeps the last; an app that never sends one gets no field", async (t) => {
  const s = await service(t);
  syncAs(s, "light", [{ id: "act-1", token: ACT }]);
  syncAs(s, undefined, [{ id: "act-1", token: ACT }]);
  syncAs(s, null, [{ id: "act-1", token: ACT }]);
  s.la.setBots([bot("emmet")]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(aps(s.seen[0]!)["content-state"].appearance, "light");

  const old = await service(t);
  sync(old, [{ id: "act-1", token: ACT }]);
  old.la.setBots([bot("emmet")]);
  await old.step(MIN_INTERVAL_MS);
  assert.equal("appearance" in aps(old.seen[0]!)["content-state"], false, "older apps: payload as before");
});

test("appearance: the sync RPC accepts light/dark/null/absent and refuses anything else", () => {
  const base = { installId: "install-1", environment: "development", topic: "com.example.app", startToken: null, activities: [] };
  for (const appearance of ["light", "dark", null, undefined]) {
    assert.equal(liveActivitySyncRpc.input.safeParse({ ...base, appearance }).success, true, String(appearance));
  }
  assert.equal(liveActivitySyncRpc.input.safeParse({ ...base, appearance: "sepia" }).success, false);
});

const syncDino = (s: { svc: ApnsService }, dinoLayers: 3 | 6 | null | undefined, activities: Array<{ id: string; token: string | null }> = [], extra: { appearance?: "light" | "dark" } = {}) =>
  s.svc.liveActivitySync({ installId: "install-1", environment: "development", topic: "com.example.app", startToken: START, activities, ...extra, ...(dinoLayers === undefined ? {} : { dinoLayers }) });

test("dinoLayers: the app's dino setting goes into the content state of its pushes (start and update)", async (t) => {
  const s = await service(t);
  syncDino(s, 6);
  s.la.setBots([bot("emmet")]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(aps(s.seen[0]!).event, "start");
  assert.equal(aps(s.seen[0]!)["content-state"].dinoLayers, 6);
  syncDino(s, 6, [{ id: "act-1", token: ACT }]);
  s.la.setBots([bot("flint")]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(aps(s.seen[1]!).event, "update");
  assert.equal(aps(s.seen[1]!)["content-state"].dinoLayers, 6);
  // Switched to 3 fps in the app: it redraws the card itself; the next push carries 3.
  syncDino(s, 3, [{ id: "act-1", token: ACT }]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(s.seen.length, 2, "the app already shows 3");
  s.la.setBots([bot("flint", { workers: 1 })]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(aps(s.seen[2]!)["content-state"].dinoLayers, 3);
  assert.equal("dinoLayers" in s.la.state(), false, "the shared state stays per-install free");
});

test("dinoLayers: sits next to appearance; each is kept on its own when a sync leaves it out", async (t) => {
  const s = await service(t);
  syncDino(s, 6, [{ id: "act-1", token: ACT }], { appearance: "light" });
  syncDino(s, undefined, [{ id: "act-1", token: ACT }], { appearance: "dark" });
  s.la.setBots([bot("emmet")]);
  await s.step(MIN_INTERVAL_MS);
  const state = aps(s.seen[0]!)["content-state"];
  assert.equal(state.appearance, "dark");
  assert.equal(state.dinoLayers, 6);
});

test("dinoLayers: a sync without one keeps the last; an app that never sends one gets no field", async (t) => {
  const s = await service(t);
  syncDino(s, 6, [{ id: "act-1", token: ACT }]);
  syncDino(s, undefined, [{ id: "act-1", token: ACT }]);
  syncDino(s, null, [{ id: "act-1", token: ACT }]);
  s.la.setBots([bot("emmet")]);
  await s.step(MIN_INTERVAL_MS);
  assert.equal(aps(s.seen[0]!)["content-state"].dinoLayers, 6);

  const old = await service(t);
  sync(old, [{ id: "act-1", token: ACT }]);
  old.la.setBots([bot("emmet")]);
  await old.step(MIN_INTERVAL_MS);
  assert.equal("dinoLayers" in aps(old.seen[0]!)["content-state"], false, "older apps: payload as before");
});

test("dinoLayers: the sync RPC accepts 3/6/null/absent and refuses anything else", () => {
  const base = { installId: "install-1", environment: "development", topic: "com.example.app", startToken: null, activities: [] };
  for (const dinoLayers of [3, 6, null, undefined]) {
    assert.equal(liveActivitySyncRpc.input.safeParse({ ...base, dinoLayers }).success, true, String(dinoLayers));
  }
  for (const dinoLayers of [0, 4, 6.5, 7, "6", -3]) {
    assert.equal(liveActivitySyncRpc.input.safeParse({ ...base, dinoLayers }).success, false, String(dinoLayers));
  }
});

test("endpoint: POST /live-activity needs the bearer and a valid body", async (t) => {
  const s = await service(t);
  const port = await s.svc.start();
  const token = readFileSync(join(s.dir, "notify-token"), "utf8").trim();
  const post = (body: unknown, auth = token) =>
    fetch(`http://127.0.0.1:${port}/live-activity`, { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ sender: "bots", bots: [] }, "nope")).status, 401);
  assert.equal((await post({ sender: "bots", bots: [{ id: "../x", name: "x", working: true, workers: 0, since: 1 }] })).status, 400);
  assert.equal((await post({ sender: "bots", bots: [{ id: "a", name: "A", working: "yes", workers: 0, since: 1 }] })).status, 400);
  const ok = await post({ sender: "bots", bots: [{ id: "a", name: "A", working: true, workers: 0, since: T0 / 1000 }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, changed: true, flushAt: new Date(T0 + MIN_INTERVAL_MS).toISOString() });
  const again = (await (await post({ sender: "bots", bots: [{ id: "a", name: "A", working: true, workers: 0, since: T0 / 1000 }] })).json()) as { changed: boolean };
  assert.equal(again.changed, false);
  const status = (await (await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${token}` } })).json()) as { liveActivity: { busy: number } };
  assert.equal(status.liveActivity.busy, 1);
});

void TOKEN_B;
