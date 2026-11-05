import { test } from "node:test";
import assert from "node:assert/strict";
import { botStatus, quietApplies, rowWorkerCount, showWorkerCount, statusText } from "../client/status";
import { registryWorkerState } from "../server/workers";
import { outstandingCount } from "../shared/workers-rpc";

const idle = { status: "idle" as const, requiresAttention: false, attentionReason: null };
const unread = { status: "idle" as const, requiresAttention: true, attentionReason: "finished" as const };

test("status priority: needs-you > error > working > unread > waiting > read", () => {
  assert.equal(botStatus(null), "none");
  assert.equal(botStatus(null, 3), "none");
  assert.equal(botStatus(idle), "read");
  assert.equal(botStatus(unread), "unread");
  assert.equal(botStatus({ status: "running", requiresAttention: true, attentionReason: "finished" }), "working");
  assert.equal(botStatus({ status: "initializing", requiresAttention: false, attentionReason: null }), "working");
  assert.equal(botStatus({ status: "error", requiresAttention: false, attentionReason: null }), "error");
  assert.equal(botStatus({ status: "idle", requiresAttention: true, attentionReason: "error" }), "error");
  assert.equal(botStatus({ status: "running", requiresAttention: true, attentionReason: "permission" }), "needs-you");
});

test("an open permission prompt is needs-you even without the attention flag (running turn)", () => {
  assert.equal(botStatus({ status: "running", requiresAttention: false, attentionReason: null, pendingPermissionCount: 1 }), "needs-you");
  assert.equal(botStatus({ status: "running", requiresAttention: false, attentionReason: null, pendingPermissionCount: 0 }), "working");
  assert.equal(botStatus({ status: "running", requiresAttention: false, attentionReason: null }), "working");
});

test("waiting: idle and read with workers out; running, unread, needs-you and error still win", () => {
  assert.equal(botStatus(idle, 0), "read");
  assert.equal(botStatus(idle, 2), "waiting");
  assert.equal(botStatus(unread, 2), "unread");
  assert.equal(botStatus({ status: "running", requiresAttention: false, attentionReason: null }, 2), "working");
  assert.equal(botStatus({ status: "idle", requiresAttention: true, attentionReason: "permission" }, 2), "needs-you");
  assert.equal(botStatus({ status: "error", requiresAttention: false, attentionReason: null }, 2), "error");
});

test("worker count shows beside the dot only while the bot is idle (waiting or unread)", () => {
  assert.equal(showWorkerCount("waiting", 2), true);
  assert.equal(showWorkerCount("unread", 1), true);
  assert.equal(showWorkerCount("unread", 0), false);
  assert.equal(showWorkerCount("working", 2), false);
  assert.equal(showWorkerCount("read", 0), false);
  assert.equal(statusText("waiting", 2), "Waiting for workers: 2 running");
  assert.equal(statusText("unread", 1), "New reply, 1 worker running");
  assert.equal(statusText("unread", 0), "New reply");
  assert.equal(statusText("read", 0), "Read");
  assert.equal(statusText("working", 3), "Working");
});

test("DM-only turns: no green dot; Sam's turns, needs-you and error still show", () => {
  // dmOnly hides "New reply" and falls through to waiting or read
  assert.equal(botStatus(unread, 0, true), "read");
  assert.equal(botStatus(unread, 2, true), "waiting");
  // not DM-only (a turn Sam started): shows as before
  assert.equal(botStatus(unread, 0, false), "unread");
  assert.equal(botStatus(unread, 1), "unread");
  // needs-you, error and working are never hidden
  assert.equal(botStatus({ status: "idle", requiresAttention: true, attentionReason: "permission" }, 0, true), "needs-you");
  assert.equal(botStatus({ status: "idle", requiresAttention: true, attentionReason: "error" }, 0, true), "error");
  assert.equal(botStatus({ status: "error", requiresAttention: false, attentionReason: null }, 0, true), "error");
  assert.equal(botStatus({ status: "running", requiresAttention: true, attentionReason: "finished" }, 0, true), "working");
});

test("quietApplies: only a server answer fetched after the flag switched on hides the dot", () => {
  const ids = new Set(["a1"]);
  assert.equal(quietApplies(ids, "a1", 2000, 1000), true);
  assert.equal(quietApplies(ids, "a1", 1000, 2000), false); // stale answer: the dot shows
  assert.equal(quietApplies(ids, "a2", 2000, 1000), false);
  assert.equal(quietApplies(ids, null, 2000, 1000), false);
});

test("stalled: a worker stopped on an error without reporting; red-dot state below working, above unread", () => {
  assert.equal(botStatus(idle, 0, false, 1), "stalled");
  assert.equal(botStatus(idle, 2, false, 1), "stalled");
  assert.equal(botStatus(unread, 1, false, 1), "stalled");
  assert.equal(botStatus(unread, 0, true, 1), "stalled");
  assert.equal(botStatus({ status: "running", requiresAttention: false, attentionReason: null }, 0, false, 1), "working");
  assert.equal(botStatus({ status: "error", requiresAttention: false, attentionReason: null }, 0, false, 1), "error");
  assert.equal(botStatus({ status: "idle", requiresAttention: true, attentionReason: "permission" }, 0, false, 1), "needs-you");
  assert.equal(botStatus(null, 0, false, 1), "none");
  // without stalled workers nothing changes
  assert.equal(botStatus(idle, 2, false, 0), "waiting");
  // the number beside the dot: stalled workers when stalled, else outstanding ones
  assert.equal(rowWorkerCount("stalled", 3, 1), 1);
  assert.equal(rowWorkerCount("waiting", 3, 1), 3);
  assert.equal(showWorkerCount("stalled", 1), true);
  assert.equal(statusText("stalled", 1), "Worker stopped on an error");
  assert.equal(statusText("stalled", 2), "2 workers stopped on an error");
});

test("settings-back incident: the 1 beside an idle bot stays while its reported worker works again", () => {
  const t0 = Date.parse("2026-10-11T15:00:00.000Z");
  const launch = { v: 1 as const, type: "launch" as const, ts: new Date(t0).toISOString(), worker: "settings-back", pane: "w9F:p1" };
  const row = (min: number, herdr: string, reportMin: number) => {
    const view = registryWorkerState(launch, {
      now: t0 + min * 60_000,
      doneAt: null,
      reportAt: t0 + reportMin * 60_000,
      agents: [{ name: "settings-back", pane_id: "w9F:p1", agent_status: herdr }],
    });
    const out = outstandingCount([view]);
    const status = botStatus(idle, out);
    return [status, showWorkerCount(status, out) ? rowWorkerCount(status, out, 0) : 0];
  };
  assert.deepEqual(row(45, "working", 44), ["waiting", 1]); // reported mid-job, prompted again
  assert.deepEqual(row(46, "done", 44), ["read", 0]); // reported and idle: finished
});
