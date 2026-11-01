import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GRACE_MS,
  MAX_AGE_MS,
  WorkersService,
  appendRegistry,
  inferBot,
  lastReportAt,
  latestLaunches,
  parseRegistryLine,
  readRegistry,
  registryWorkerState,
  type HerdrAgent,
  type LaunchRecord,
} from "../server/workers";
import { outstandingCount } from "../shared/workers-rpc";

const T0 = Date.parse("2026-10-08T07:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const launch = (worker: string, at: number, extra: Partial<LaunchRecord> = {}): LaunchRecord => ({
  v: 1,
  type: "launch",
  ts: iso(at),
  worker,
  pane: "w9:p1",
  agent: "agent-emmet",
  bot: null,
  ...extra,
});
const herdr = (name: string | null, pane: string, status: string, cwd = "/tmp"): HerdrAgent => ({
  name,
  pane_id: pane,
  agent_status: status,
  cwd,
  foreground_cwd: cwd,
});

function dirs() {
  const base = mkdtempSync(join(tmpdir(), "workers-"));
  return { base, registry: join(base, "bot-dm", "launches.jsonl"), workersRoot: join(base, "bot-dm", "workers") };
}

function writeOutbox(workersRoot: string, worker: string, lines: object[]) {
  mkdirSync(join(workersRoot, worker), { recursive: true });
  writeFileSync(join(workersRoot, worker, "outbox.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const status = (at: number, value: string) => ({ v: 1, type: "status", id: "01M4D46C2MZ78GQQJFNTJEPM1D", ts: iso(at), status: value, detail: null });

test("registry lines: launch and done parse; junk, wrong version and bad names are skipped", () => {
  assert.deepEqual(parseRegistryLine(JSON.stringify(launch("dm-wp4", T0))), { ...launch("dm-wp4", T0), cwd: null });
  assert.deepEqual(parseRegistryLine(JSON.stringify({ v: 1, type: "done", ts: iso(T0), worker: "dm-wp4" })), {
    v: 1,
    type: "done",
    ts: iso(T0),
    worker: "dm-wp4",
  });
  assert.equal(parseRegistryLine("{not json"), null);
  assert.equal(parseRegistryLine(JSON.stringify({ ...launch("x", T0), v: 2 })), null);
  assert.equal(parseRegistryLine(JSON.stringify({ ...launch("x", T0), worker: "../etc" })), null);
  assert.equal(parseRegistryLine(JSON.stringify({ ...launch("x", T0), ts: "yesterday" })), null);
  assert.equal(parseRegistryLine(JSON.stringify({ ...launch("x", T0), type: "other" })), null);
});

test("appendRegistry creates the dir 0700 and file 0600; readRegistry skips a torn last line", async () => {
  const { registry } = dirs();
  appendRegistry(registry, launch("a", T0));
  appendRegistry(registry, { v: 1, type: "done", ts: iso(T0 + 1), worker: "a" });
  writeFileSync(registry, readFileSync(registry, "utf8") + '{"v":1,"type":"lau', { flag: "w" });
  assert.equal(statSync(join(registry, "..")).mode & 0o777, 0o700);
  assert.equal(statSync(registry).mode & 0o777, 0o600);
  const records = await readRegistry(registry);
  assert.deepEqual(records.map((r) => r.type), ["launch", "done"]);
  assert.deepEqual(await readRegistry(join(registry, "..", "missing.jsonl")), []);
});

test("latestLaunches: newest launch per name; done only counts after that launch", () => {
  const rows = latestLaunches([
    launch("a", T0),
    { v: 1, type: "done", ts: iso(T0 + 10), worker: "a" },
    launch("a", T0 + 20, { pane: "w9:p2" }),
    launch("b", T0),
    { v: 1, type: "done", ts: iso(T0 + 5), worker: "b" },
    { v: 1, type: "done", ts: iso(T0), worker: "nobody" },
  ]);
  const a = rows.find((r) => r.launch.worker === "a")!;
  assert.equal(a.launch.pane, "w9:p2");
  assert.equal(a.doneAt, null);
  assert.equal(rows.find((r) => r.launch.worker === "b")!.doneAt, T0 + 5);
  assert.equal(rows.length, 2);
});

test("lastReportAt: latest steered/started status in the worker outbox; failed and refused do not count", async () => {
  const { workersRoot } = dirs();
  writeOutbox(workersRoot, "w1", [status(T0, "queued"), status(T0 + 1, "started"), status(T0 + 9, "failed")]);
  writeOutbox(workersRoot, "w2", [status(T0, "queued"), status(T0 + 2, "refused")]);
  assert.equal(await lastReportAt(workersRoot, "w1"), T0 + 1);
  assert.equal(await lastReportAt(workersRoot, "w2"), null);
  assert.equal(await lastReportAt(workersRoot, "none"), null);
  assert.equal(await lastReportAt(workersRoot, "../x"), null);
});

test("registryWorkerState: running until done, gone, idle (after a report or past grace) or expired", () => {
  const l = launch("dm-wp4", T0);
  const ctx = (over: Partial<Parameters<typeof registryWorkerState>[1]>) => ({
    now: T0 + 10 * 60_000,
    doneAt: null,
    reportAt: null,
    agents: [herdr("dm-wp4", "w9:p1", "working")],
    ...over,
  });
  assert.equal(registryWorkerState(l, ctx({})).state, "running");
  assert.equal(registryWorkerState(l, ctx({ agents: [herdr("dm-wp4", "w9:p1", "blocked")] })).state, "blocked");
  assert.equal(registryWorkerState(l, ctx({ agents: [herdr("dm-wp4", "w9:p1", "unknown")] })).state, "running");
  // A report alone does not finish a worker herdr shows working (Sam 2026-10-11, option 1).
  assert.equal(registryWorkerState(l, ctx({ reportAt: T0 + 1 })).state, "running");
  // Reported and idle/done: finished. Only a report after the launch counts.
  const idleAgents = [herdr("dm-wp4", "w9:p1", "done")];
  assert.deepEqual(
    [registryWorkerState(l, ctx({ reportAt: T0 + 1, agents: idleAgents })).state, registryWorkerState(l, ctx({ reportAt: T0 + 1, agents: idleAgents })).reason],
    ["finished", "reported"],
  );
  assert.equal(registryWorkerState(l, ctx({ reportAt: T0 - 1, now: T0 + GRACE_MS - 1, agents: idleAgents })).state, "running");
  assert.equal(registryWorkerState(l, ctx({ doneAt: T0 + 5 })).reason, "done");
  // Gone: no agent by name, and the pane holds another named agent.
  assert.equal(registryWorkerState(l, ctx({ agents: [herdr("other", "w9:p1", "working")] })).reason, "gone");
  assert.equal(registryWorkerState(l, ctx({ agents: [] })).reason, "gone");
  // Unnamed agent in the recorded pane is still the worker.
  assert.equal(registryWorkerState(l, ctx({ agents: [herdr(null, "w9:p1", "working")] })).state, "running");
  // Moved pane: found by name, reports the new pane.
  assert.equal(registryWorkerState(l, ctx({ agents: [herdr("dm-wp4", "w10:p3", "working")] })).pane, "w10:p3");
  // Idle/done: still running inside the grace period, finished after.
  for (const s of ["idle", "done"]) {
    assert.equal(registryWorkerState(l, ctx({ now: T0 + GRACE_MS - 1, agents: [herdr("dm-wp4", "w9:p1", s)] })).state, "running");
    assert.equal(registryWorkerState(l, ctx({ now: T0 + GRACE_MS + 1, agents: [herdr("dm-wp4", "w9:p1", s)] })).reason, "idle");
  }
  assert.equal(registryWorkerState(l, ctx({ now: T0 + MAX_AGE_MS + 1 })).reason, "expired");
  // herdr unreadable: unknown, not outstanding.
  assert.equal(registryWorkerState(l, ctx({ agents: null })).state, "unknown");
  assert.equal(registryWorkerState(l, ctx({ agents: null, reportAt: T0 + 1 })).state, "finished");
});

/**
 * Herdr status sequences measured on the host (research/worker-count/reports/herdr-states.md), fed to
 * registryWorkerState one poll at a time. Each step: [minutes after launch, herdr status or
 * "gone" / "unreadable", minutes of the last report or null, expected state, expected reason].
 */
type Step = [number, string, number | null, string, string | undefined];
function replay(steps: Step[], name = "settings-back") {
  const l = launch(name, T0, { pane: "w9F:p1" });
  for (const [i, [min, status, reportMin, state, reason]] of steps.entries()) {
    const agents = status === "unreadable" ? null : status === "gone" ? [] : [herdr(name, "w9F:p1", status)];
    const view = registryWorkerState(l, {
      now: T0 + min * 60_000,
      doneAt: null,
      reportAt: reportMin === null ? null : T0 + reportMin * 60_000,
      agents,
    });
    assert.deepEqual([view.state, view.reason], [state, reason], `step ${i}: ${min} min, herdr ${status}, report ${reportMin}`);
  }
}

test("settings-back incident: a mid-job report, then working again, counts; report + idle is finished", () => {
  replay([
    [1, "working", null, "running", undefined],
    [40, "working", 40, "running", undefined], // mid-job report sent from inside the turn
    [41, "done", 40, "finished", "reported"], // turn over: off the list
    [44, "working", 40, "running", undefined], // bot prompts it again: back on the list
    [50, "done", 40, "finished", "reported"], // went idle without a new report
    [52, "working", 40, "running", undefined], // prompted a second time
    [70, "working", 70, "running", undefined], // final report, turn still ending
    [70.1, "done", 70, "finished", "reported"],
    [90, "idle", 70, "finished", "reported"], // Sam looked at the tab: done -> idle, same thing
  ]);
});

test("herdr states seen in the wild: start-up unknown, missed short turns, blocked, unreadable, closed", () => {
  // Start-up: `unknown` for 1-2 s, then idle until prompted (grace), then working.
  replay([
    [0, "unknown", null, "running", undefined],
    [0.05, "idle", null, "running", undefined],
    [0.1, "working", null, "running", undefined],
  ]);
  // A turn too short for any poll to see `working`: idle -> done. Without a report the grace
  // period still decides; with one it is finished.
  replay([
    [1, "done", null, "running", undefined],
    [3, "done", null, "finished", "idle"],
  ]);
  replay([[1, "done", 0.9, "finished", "reported"]]);
  // blocked (approval UI) counts whether or not it reported.
  replay([
    [5, "blocked", null, "blocked", undefined],
    [6, "blocked", 5.5, "blocked", undefined],
  ]);
  // `unknown` for a known agent (start-up, herdr server restore) is unreadable for that worker:
  // today's rule applies, report = finished, else running.
  replay([
    [10, "unknown", null, "running", undefined],
    [10, "unknown", 9, "finished", "reported"],
  ]);
  // herdr itself unreadable: today's rule (report = finished, else unknown).
  replay([
    [10, "unreadable", null, "unknown", undefined],
    [10, "unreadable", 9, "finished", "reported"],
  ]);
  // Agent exited, killed, pane or tab closed: gone from `agent list`.
  replay([
    [10, "gone", null, "finished", "gone"],
    [10, "gone", 9, "finished", "reported"],
  ]);
  // Esc, or an API error after pi's retries: `done` like any other end of turn.
  replay([
    [10, "working", 5, "running", undefined],
    [15, "done", 5, "finished", "reported"],
  ]);
});

test("registryWorkerState: done and expiry win over a working pane, as before", () => {
  const l = launch("dm-wp4", T0);
  const agents = [herdr("dm-wp4", "w9:p1", "working")];
  assert.equal(registryWorkerState(l, { now: T0 + 60_000, doneAt: T0 + 30_000, reportAt: T0 + 1, agents }).reason, "done");
  assert.equal(registryWorkerState(l, { now: T0 + MAX_AGE_MS + 1, doneAt: null, reportAt: T0 + 1, agents }).reason, "expired");
});

test("inferBot: cwd inside the bot folder, else name prefix <bot>-", () => {
  const bots = [
    { id: "matilda", cwd: "/b/matilda" },
    { id: "tmp-a", cwd: "/b/tmp-a" },
    { id: "tmp-a-b", cwd: "/b/tmp-a-b" },
  ];
  assert.equal(inferBot(herdr("x", "w1:p1", "working", "/b/matilda"), bots), "matilda");
  assert.equal(inferBot(herdr("x", "w1:p1", "working", "/b/matilda/sub/dir"), bots), "matilda");
  assert.equal(inferBot(herdr("x", "w1:p1", "working", "/b/matilda-old"), bots), null);
  assert.equal(inferBot(herdr("matilda-email-triage", "w1:p1", "working", "/home/x"), bots), "matilda");
  assert.equal(inferBot(herdr("tmp-a-b-worker", "w1:p1", "working", "/home/x"), bots), "tmp-a-b");
  assert.equal(inferBot(herdr("matilda", "w1:p1", "working", "/home/x"), bots), null);
  assert.equal(inferBot(herdr(null, "w1:p1", "working", "/home/x"), bots), null);
});

test("WorkersService.byBot: registry by agent id or bot, reports, inference, herdr down", async () => {
  const { registry, workersRoot } = dirs();
  const bots = [
    { id: "emmet", cwd: "/b/emmet", agentId: "agent-emmet" },
    { id: "matilda", cwd: "/b/matilda", agentId: "agent-matilda" },
    { id: "flint", cwd: "/b/flint", agentId: null },
  ];
  const owners: Record<string, string> = { "agent-emmet": "emmet", "agent-emmet-old": "emmet", "agent-matilda": "matilda" };
  appendRegistry(registry, launch("wp-a", T0, { pane: "w1:p1" }));
  appendRegistry(registry, launch("wp-b", T0, { pane: "w1:p2", agent: "agent-emmet-old" }));
  appendRegistry(registry, launch("wp-c", T0, { pane: "w1:p3" })); // reported, still working
  appendRegistry(registry, launch("wp-g", T0, { pane: "w1:p7" })); // reported, done
  appendRegistry(registry, launch("wp-d", T0, { pane: "w1:p4", agent: null, bot: "flint" }));
  appendRegistry(registry, launch("wp-e", T0, { pane: "w1:p5", agent: "agent-stranger" })); // unknown owner
  appendRegistry(registry, launch("wp-f", T0, { pane: "w1:p6", bot: "not-a-bot" }));
  writeOutbox(workersRoot, "wp-c", [status(T0 + 60_000, "started")]);
  writeOutbox(workersRoot, "wp-g", [status(T0 + 60_000, "started")]);
  let agents: HerdrAgent[] | null = [
    herdr("wp-a", "w1:p1", "working", "/b/emmet/research"),
    herdr("wp-b", "w1:p2", "blocked", "/elsewhere"),
    herdr("wp-c", "w1:p3", "working", "/b/emmet"),
    herdr("wp-d", "w1:p4", "done", "/b/flint"),
    herdr("wp-e", "w1:p5", "working", "/elsewhere"),
    herdr("wp-g", "w1:p7", "done", "/b/emmet"),
    herdr("matilda-mail", "w2:p1", "working", "/home/email"),
    herdr("by-hand", "w2:p2", "working", "/b/matilda"),
    herdr("idle-one", "w2:p3", "idle", "/b/matilda"),
    herdr("unrelated", "w2:p4", "working", "/home/code"),
  ];
  let calls = 0;
  let now = T0 + 10 * 60_000;
  const service = new WorkersService({
    registryPath: registry,
    workersRoot,
    listHerdr: async () => {
      calls++;
      if (!agents) throw new Error("herdr down");
      return agents;
    },
    now: () => now,
  });
  const result = await service.byBot(bots, (id) => owners[id] ?? null);
  assert.equal(result.herdr, "ok");
  const get = (id: string) => result.bots.find((b) => b.botId === id)!.workers;
  assert.deepEqual(
    get("emmet").map((w) => [w.worker, w.state, w.source]),
    [
      ["wp-a", "running", "registry"],
      ["wp-b", "blocked", "registry"],
      ["wp-c", "running", "registry"],
      ["wp-g", "finished", "registry"],
    ],
  );
  assert.equal(get("emmet").find((w) => w.worker === "wp-g")!.reason, "reported");
  assert.equal(outstandingCount(get("emmet")), 3);
  assert.deepEqual(get("flint").map((w) => [w.worker, w.state, w.reason]), [["wp-d", "finished", "idle"]]);
  assert.deepEqual(
    get("matilda").map((w) => [w.worker, w.state, w.source]),
    [
      ["matilda-mail", "running", "inferred"],
      ["by-hand", "running", "inferred"],
    ],
  );
  assert.equal(result.bots.length, 3);

  // Cached herdr read within cacheMs.
  await service.byBot(bots, (id) => owners[id] ?? null);
  assert.equal(calls, 1);

  // herdr down: registry workers unknown (not outstanding), no inference.
  agents = null;
  now += 10_000;
  const down = await service.byBot(bots, (id) => owners[id] ?? null);
  assert.equal(down.herdr, "unavailable");
  assert.equal(outstandingCount(down.bots.find((b) => b.botId === "emmet")!.workers), 0);
  assert.equal(down.bots.find((b) => b.botId === "matilda")!.workers.length, 0);

  // Inference off.
  agents = [herdr("by-hand", "w2:p2", "working", "/b/matilda")];
  const quiet = new WorkersService({ registryPath: registry, workersRoot, listHerdr: async () => agents!, now: () => now, infer: false });
  assert.equal((await quiet.byBot(bots, () => null)).bots.find((b) => b.botId === "matilda")!.workers.length, 0);
});
