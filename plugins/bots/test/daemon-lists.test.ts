import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotsService, DaemonLists, LISTS_RESYNC_MS, LISTS_SETTLE_MS, type AgentLike, type BotsPaseo } from "../server/bots";

function botsRoot(ids: string[]) {
  const root = mkdtempSync(join(tmpdir(), "bots-lists-"));
  for (const id of ids) {
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, ".optchat-profile"), id);
  }
  return root;
}

/** A daemon that counts its list calls; `projectsFail` makes project.list throw (a busy daemon). */
function daemon(root: string) {
  const state = {
    agents: [] as AgentLike[],
    projects: [] as Array<{ projectRootPath: string; projectDisplayName: string }>,
    projectsFail: false,
    calls: { projects: 0, agents: 0 },
    created: 0,
  };
  const paseo: BotsPaseo = {
    projects: {
      list: async () => {
        state.calls.projects += 1;
        if (state.projectsFail) throw new Error("busy");
        return { projects: state.projects.map((p) => ({ ...p })) };
      },
    },
    agents: {
      list: async () => {
        state.calls.agents += 1;
        return { entries: state.agents.filter((a) => !a.archivedAt).map((agent) => ({ agent: { ...agent } })) };
      },
      ref: () => ({ archive: async () => ({}) }),
    },
    workspaces: {
      open: async (cwd) => ({
        agents: {
          create: async (options) => {
            const id = `new-${++state.created}`;
            state.agents.push({ id, cwd, provider: "optchat", labels: options.labels ?? {} });
            return { id };
          },
        },
      }),
    },
    config: { get: async () => ({}) },
  };
  const named = (id: string, name: string) => ({ projectRootPath: join(root, id), projectDisplayName: name });
  return { paseo, state, named };
}

function clock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("before watch() every read lists (a host without lifecycle hooks behaves as before)", async () => {
  const root = botsRoot(["scrat"]);
  const d = daemon(root);
  const service = new BotsService(root, new DaemonLists());
  await service.list(d.paseo);
  await service.chats(d.paseo);
  assert.deepEqual(d.state.calls, { projects: 2, agents: 2 });
});

test("watching: reads share one listing until a change event", async () => {
  const root = botsRoot(["scrat"]);
  const d = daemon(root);
  const c = clock();
  const lists = new DaemonLists({ now: c.now });
  lists.watch();
  const service = new BotsService(root, lists);
  await service.list(d.paseo);
  c.advance(1_000);
  await service.chats(d.paseo);
  await service.botChats(d.paseo);
  await service.listWithOwners(d.paseo);
  assert.deepEqual(d.state.calls, { projects: 1, agents: 1 }, "one listing serves every read");

  // A chat starts a turn: the hook marks the lists changed.
  d.state.agents.push({ id: "a1", cwd: join(root, "scrat"), provider: "optchat", status: "running" });
  lists.changed();
  const during = await service.list(d.paseo);
  assert.equal(during[0]!.agentId, "a1", "the read after the event lists again");
  c.advance(LISTS_SETTLE_MS);
  await service.list(d.paseo);
  const calls = { ...d.state.calls };
  c.advance(1_000);
  await service.list(d.paseo);
  assert.deepEqual(d.state.calls, calls, "settled: cached again");
});

test("a missed event is recovered by the periodic resync", async () => {
  const root = botsRoot(["scrat"]);
  const d = daemon(root);
  const c = clock();
  const lists = new DaemonLists({ now: c.now });
  lists.watch();
  const service = new BotsService(root, lists);
  assert.equal((await service.list(d.paseo))[0]!.agentId, null);

  // A chat appears with no event reaching the plugin (dropped hook, plugin busy, an unhooked change).
  d.state.agents.push({ id: "a1", cwd: join(root, "scrat"), provider: "optchat" });
  c.advance(LISTS_RESYNC_MS - 1);
  assert.equal((await service.list(d.paseo))[0]!.agentId, null, "within the resync window the cache stands");
  c.advance(1);
  assert.equal((await service.list(d.paseo))[0]!.agentId, "a1", "the resync lists again and sees it");
});

test("attention cleared elsewhere (no hook for it) shows after the resync", async () => {
  const root = botsRoot(["scrat"]);
  const d = daemon(root);
  const c = clock();
  const lists = new DaemonLists({ now: c.now });
  lists.watch();
  const service = new BotsService(root, lists);
  d.state.agents.push({ id: "a1", cwd: join(root, "scrat"), provider: "optchat", requiresAttention: true });
  assert.equal((await service.chats(d.paseo))[0]!.requiresAttention, true);
  d.state.agents[0]!.requiresAttention = false;
  c.advance(LISTS_RESYNC_MS);
  assert.equal((await service.chats(d.paseo))[0]!.requiresAttention, false);
});

test("an event during a listing is not lost: that listing is not trusted", async () => {
  const root = botsRoot(["scrat"]);
  const d = daemon(root);
  const c = clock();
  const lists = new DaemonLists({ now: c.now, settleMs: 0 });
  lists.watch();
  const service = new BotsService(root, lists);
  const slow = service.list(d.paseo); // listing in flight, sees no agent
  c.advance(10);
  d.state.agents.push({ id: "a1", cwd: join(root, "scrat"), provider: "optchat" });
  lists.changed();
  await slow;
  assert.equal((await service.list(d.paseo))[0]!.agentId, "a1");
});

test("concurrent reads share one daemon call", async () => {
  const root = botsRoot(["scrat"]);
  const d = daemon(root);
  const lists = new DaemonLists();
  lists.watch();
  const service = new BotsService(root, lists);
  await Promise.all([service.list(d.paseo), service.chats(d.paseo), service.snapshot(d.paseo)]);
  assert.deepEqual(d.state.calls, { projects: 1, agents: 1 });
});

test("a busy daemon does not break discovery: names fall back to the last good list, and it asks again", async () => {
  const root = botsRoot(["scrat"]);
  const d = daemon(root);
  d.state.projects = [d.named("scrat", "Scrat the Squirrel")];
  const c = clock();
  const lists = new DaemonLists({ now: c.now });
  lists.watch();
  const service = new BotsService(root, lists);
  assert.equal((await service.list(d.paseo))[0]!.name, "Scrat the Squirrel");

  c.advance(LISTS_RESYNC_MS);
  d.state.projectsFail = true;
  assert.equal((await service.list(d.paseo))[0]!.name, "Scrat the Squirrel", "last good names");
  const before = d.state.calls.projects;
  await service.list(d.paseo);
  assert.equal(d.state.calls.projects, before + 1, "a failed listing is not cached");

  // No good list ever: the folder name, as discoverBots always did.
  const fresh = new DaemonLists({ now: c.now });
  fresh.watch();
  assert.equal((await new BotsService(root, fresh).list(d.paseo))[0]!.name, "Scrat");
});

test("the plugin's own writes (open creating a chat) mark the lists changed", async () => {
  const root = botsRoot(["scrat"]);
  const d = daemon(root);
  const c = clock();
  const lists = new DaemonLists({ now: c.now });
  lists.watch();
  const service = new BotsService(root, lists);
  assert.equal((await service.list(d.paseo))[0]!.agentId, null);
  const { agentId, created } = await service.open("scrat", d.paseo);
  assert.equal(created, true);
  c.advance(LISTS_SETTLE_MS);
  assert.equal((await service.list(d.paseo))[0]!.agentId, agentId);
});

test("bot folders are read fresh on every call; only daemon lists are cached", async () => {
  const root = botsRoot(["scrat"]);
  const d = daemon(root);
  const lists = new DaemonLists();
  lists.watch();
  const service = new BotsService(root, lists);
  assert.equal((await service.list(d.paseo)).length, 1);
  mkdirSync(join(root, "bitzer"));
  writeFileSync(join(root, "bitzer", ".optchat-profile"), "bitzer");
  assert.deepEqual((await service.list(d.paseo)).map((b) => b.id), ["bitzer", "scrat"]);
  assert.deepEqual(d.state.calls, { projects: 1, agents: 1 });
});

/**
 * The idle host's read rate (local count, the measurement for this change): the Live Activity loop
 * (server/live-activity.ts) reads a snapshot every IDLE_CHECK_MS, the push loop (server/push.ts)
 * recomputes previews, workers and quiet every PUSH_CHECK_MS while an app holds the lease. Ten
 * simulated minutes, no change events.
 */
test("idle host: daemon list reads per second, listing every time vs list-then-watch", async () => {
  const { IDLE_CHECK_MS } = await import("../server/live-activity");
  const { PUSH_CHECK_MS } = await import("../shared/push-rpc");
  const root = botsRoot(["scrat", "bitzer"]);
  const rate = async (watch: boolean) => {
    const d = daemon(root);
    const c = clock();
    const lists = new DaemonLists({ now: c.now });
    if (watch) lists.watch();
    const service = new BotsService(root, lists);
    const seconds = 600;
    for (let t = 0; t < seconds * 1000; t += IDLE_CHECK_MS) {
      await service.snapshot(d.paseo);
      if (t % PUSH_CHECK_MS === 0) {
        await service.botChats(d.paseo); // previews
        await service.listWithOwners(d.paseo); // workers
        await service.chats(d.paseo); // quiet
      }
      c.advance(IDLE_CHECK_MS);
    }
    return (d.state.calls.projects + d.state.calls.agents) / seconds;
  };
  const before = await rate(false);
  const after = await rate(true);
  // 2 lists per snapshot every 2 s (1.0/s) + 3 × 2 per 10 s (0.6/s) = 1.6/s; watched: 2 per 30 s.
  assert.equal(before, 1.6);
  assert.ok(after <= 2 / (LISTS_RESYNC_MS / 1000) + 0.01, `after ${after}/s`);
  console.log(`# daemon list reads/s on an idle host: ${before} before, ${after.toFixed(3)} after`);
});
