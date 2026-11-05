import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run, type Deps } from "../bot-worker/cli";
import type { HerdrAgent } from "../server/workers";

function harness(env: NodeJS.ProcessEnv = {}, agents: HerdrAgent[] | null = []) {
  const state = mkdtempSync(join(tmpdir(), "bw-"));
  const out: string[] = [];
  const err: string[] = [];
  let now = Date.parse("2026-10-08T07:00:00.000Z");
  const deps: Deps = {
    env: { XDG_STATE_HOME: state, ...env },
    now: () => new Date(now),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    paneOf: (name) => agents?.find((a) => a.name === name)?.pane_id ?? null,
    listHerdr: async () => {
      if (!agents) throw new Error("down");
      return agents;
    },
  };
  return {
    deps,
    out,
    /** A delivered report from <worker> now (bot-dm worker outbox). */
    report: (worker: string) => {
      const dir = join(state, "bot-dm", "workers", worker);
      mkdirSync(dir, { recursive: true });
      const line = { v: 1, type: "status", id: "01M4D46C2MZ78GQQJFNTJEPM1D", ts: new Date(now).toISOString(), status: "started", detail: null };
      writeFileSync(join(dir, "outbox.jsonl"), `${JSON.stringify(line)}\n`, { flag: "a" });
    },
    err,
    tick: (ms: number) => (now += ms),
    registry: () =>
      readFileSync(join(state, "bot-dm", "launches.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
  };
}

test("add: launcher from PASEO_AGENT_ID, pane from herdr", async () => {
  const h = harness({ PASEO_AGENT_ID: "agent-1" }, [{ name: "wp-x", pane_id: "w5:p2", agent_status: "working" }]);
  assert.equal(await run(["add", "wp-x"], h.deps), 0);
  assert.deepEqual(h.registry(), [
    { v: 1, type: "launch", ts: "2026-10-08T07:00:00.000Z", worker: "wp-x", pane: "w5:p2", agent: "agent-1", bot: null },
  ]);
  assert.equal(JSON.parse(h.out[0]!).ok, true);
});

test("add: outside Paseo needs --bot; explicit --pane; bad names refused", async () => {
  const h = harness({}, []);
  assert.equal(await run(["add", "wp-y"], h.deps), 2);
  assert.match(h.err[0]!, /--bot/);
  assert.equal(await run(["add", "wp-y", "--bot", "emmet-brickowski", "--pane", "w1:p9"], h.deps), 0);
  assert.equal(h.registry()[0].bot, "emmet-brickowski");
  assert.equal(h.registry()[0].pane, "w1:p9");
  assert.equal(await run(["add", "../etc", "--bot", "x"], h.deps), 2);
  assert.equal(await run(["add", "ok", "--bot", "Bad Bot"], h.deps), 2);
  assert.equal(await run(["add", "ok", "--bot", "x", "--pane", "rm -rf"], h.deps), 2);
  assert.equal(await run(["add"], h.deps), 2);
  assert.equal(await run(["nope"], h.deps), 2);
});

test("add: herdr pane ids with letters after p9 (w73:pA) are accepted; malformed ones refused", async () => {
  const h = harness({}, [{ name: "wp-l", pane_id: "w73:pA", agent_status: "working" }]);
  assert.equal(await run(["add", "wp-l", "--bot", "emmet-brickowski"], h.deps), 0);
  assert.equal(h.registry()[0].pane, "w73:pA");
  assert.equal(await run(["add", "wp-m", "--bot", "emmet-brickowski", "--pane", "w7B:pZ3"], h.deps), 0);
  assert.equal(h.registry()[1].pane, "w7B:pZ3");
  for (const bad of ["w73:p", "w73:A", "w73pA", ":pA", "w73:p-A", "w73:pA;x"]) {
    assert.equal(await run(["add", "wp-n", "--bot", "emmet-brickowski", "--pane", bad], h.deps), 2, bad);
  }
});

test("add without a herdr pane warns but records; list and done", async () => {
  const agents: HerdrAgent[] = [{ name: "wp-z", pane_id: "w5:p3", agent_status: "working" }];
  const h = harness({ PASEO_AGENT_ID: "agent-1" }, agents);
  assert.equal(await run(["add", "ghost"], h.deps), 0);
  assert.match(JSON.parse(h.out[0]!).warning, /no herdr pane/);
  assert.equal(await run(["add", "wp-z"], h.deps), 0);
  h.out.length = 0;
  assert.equal(await run(["list"], h.deps), 0);
  // ghost has no herdr agent, so it is gone (finished) and hidden without --all.
  assert.deepEqual(JSON.parse(h.out[0]!).workers.map((w: any) => [w.worker, w.state]), [["wp-z", "running"]]);
  h.tick(1000);
  assert.equal(await run(["done", "wp-z"], h.deps), 0);
  h.out.length = 0;
  assert.equal(await run(["list", "--all"], h.deps), 0);
  assert.deepEqual(
    JSON.parse(h.out[0]!).workers.map((w: any) => [w.worker, w.state, w.reason]),
    [
      ["ghost", "finished", "gone"],
      ["wp-z", "finished", "done"],
    ],
  );
});

test("list shows a worker that stopped on an error as stalled (with the error); done clears it", async () => {
  const agents: HerdrAgent[] = [{ name: "wp-e", pane_id: "w85:p1", agent_status: "done" }];
  const h = harness({ PASEO_AGENT_ID: "agent-1" }, agents);
  const error = { message: "Request timed out.", at: "2026-10-08T07:10:00.000Z", source: "session" as const };
  h.deps.readError = async (agent) => (agent.pane_id === "w85:p1" ? error : null);
  assert.equal(await run(["add", "wp-e"], h.deps), 0);
  h.tick(15 * 60_000);
  h.out.length = 0;
  assert.equal(await run(["list"], h.deps), 0);
  const [row] = JSON.parse(h.out[0]!).workers;
  assert.equal(row.state, "stalled");
  assert.deepEqual(row.error, error);
  assert.equal(await run(["done", "wp-e"], h.deps), 0);
  h.out.length = 0;
  assert.equal(await run(["list"], h.deps), 0);
  assert.deepEqual(JSON.parse(h.out[0]!).workers, []);
  h.out.length = 0;
  assert.equal(await run(["list", "--all"], h.deps), 0);
  assert.deepEqual(JSON.parse(h.out[0]!).workers.map((w: any) => [w.state, w.reason]), [["finished", "done"]]);
});

test("list: a worker that reported is still listed while herdr shows it working (settings-back)", async () => {
  const agents: HerdrAgent[] = [{ name: "settings-back", pane_id: "w9F:p1", agent_status: "working" }];
  const h = harness({ PASEO_AGENT_ID: "agent-1" }, agents);
  assert.equal(await run(["add", "settings-back"], h.deps), 0);
  const list = async () => {
    h.out.length = 0;
    assert.equal(await run(["list", "--all"], h.deps), 0);
    return JSON.parse(h.out[0]!).workers.map((w: any) => [w.state, w.reason ?? null]);
  };
  h.tick(40 * 60_000);
  h.report("settings-back"); // mid-job report
  assert.deepEqual(await list(), [["running", null]]);
  agents[0]!.agent_status = "done";
  h.tick(60_000);
  assert.deepEqual(await list(), [["finished", "reported"]]);
  agents[0]!.agent_status = "working"; // prompted again
  h.tick(3 * 60_000);
  assert.deepEqual(await list(), [["running", null]]);
  h.out.length = 0;
  assert.equal(await run(["list"], h.deps), 0);
  assert.equal(JSON.parse(h.out[0]!).workers.length, 1);
  agents[0]!.agent_status = "idle";
  h.report("settings-back"); // final report
  assert.deepEqual(await list(), [["finished", "reported"]]);
});
