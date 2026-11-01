import { test } from "node:test";
import assert from "node:assert/strict";
import type { DmMessage, DmStatus } from "../shared/dm-schema.ts";
import {
  HOP_CAP,
  PAIR_CAP,
  SYSTEM_SENDERS,
  UsageError,
  checkAllowed,
  checkRate,
  checkReply,
  checkSize,
  clampBody,
  countRecent,
  defaultExpectsReply,
  deriveSubject,
  isScheduleSender,
  scheduleOwner,
  scheduleSender,
} from "../bot-dm/policy.ts";
import { DmMessageSchema } from "../shared/dm-schema.ts";
import { setUserName } from "../shared/party";

// Prompts and notices name the user from the settings; these tests use a configured name.
setUserName("Sam");

const FC = "the-fat-controller";

const msg = (patch: Partial<DmMessage>): DmMessage => ({
  v: 1,
  type: "message",
  id: "01K6ZQ5V8M0000000000000001",
  ts: "2026-10-08T05:00:00.000Z",
  from: FC,
  to: "bitzer",
  kind: "request",
  thread: "01K6ZQ5V8M0000000000000001",
  re: null,
  hop: 1,
  subject: "s",
  body: "b",
  attachments: [],
  expects_reply: true,
  from_agent_id: null,
  to_agent_id: null,
  origin: "bot-dm/1",
  ...patch,
});

test("allow-list: FC <-> PM free, escalate only to FC", () => {
  for (const kind of ["request", "reply", "info"] as const) {
    assert.equal(checkAllowed(FC, "bitzer", kind, FC), null, `FC->PM ${kind}`);
    assert.equal(checkAllowed("bitzer", FC, kind, FC), null, `PM->FC ${kind}`);
  }
  assert.equal(checkAllowed("bitzer", FC, "escalate", FC), null);
  assert.equal(checkAllowed(FC, "bitzer", "escalate", FC)?.code, "not_allowed");
});

test("allow-list: PM <-> PM request/info/reply only", () => {
  assert.equal(checkAllowed("bitzer", "flint", "request", FC), null);
  assert.equal(checkAllowed("bitzer", "flint", "info", FC), null);
  assert.equal(checkAllowed("bitzer", "flint", "reply", FC), null);
  assert.equal(checkAllowed("bitzer", "flint", "escalate", FC)?.code, "not_allowed");
});

test("allow-list: report is for workers only, workers send only report", () => {
  assert.equal(checkAllowed("worker:wp1", "bitzer", "report", FC), null);
  assert.equal(checkAllowed("worker:wp1", "bitzer", "info", FC)?.code, "not_allowed");
  assert.equal(checkAllowed("bitzer", FC, "report", FC)?.code, "not_allowed");
});

test("allow-list: resume only from SYSTEM_SENDERS, to any bot", () => {
  assert.deepEqual([...SYSTEM_SENDERS], ["worker:ratelimit-watchdog", "worker:stall-watch", "worker:push-slot"]);
  for (const to of ["bitzer", FC, "tmp-bot"]) assert.equal(checkAllowed("worker:ratelimit-watchdog", to, "resume", FC), null);
  assert.equal(checkAllowed("worker:ratelimit-watchdog", "bitzer", "report", FC), null);
  // system senders may also send info (a system notice, e.g. a worker stopped on an error); other workers may not
  assert.equal(checkAllowed("worker:ratelimit-watchdog", "bitzer", "info", FC), null);
  assert.equal(checkAllowed("worker:stall-watch", "bitzer", "info", FC), null);
  assert.equal(checkAllowed("worker:stall-watch", FC, "resume", FC), null);
  assert.equal(checkAllowed("worker:stall-watch", "bitzer", "request", FC)?.code, "not_allowed");
  assert.equal(checkAllowed("worker:wp1", "bitzer", "info", FC)?.code, "not_allowed");
  assert.equal(checkAllowed("worker:wp1", "bitzer", "resume", FC)?.code, "not_allowed");
  assert.equal(checkAllowed(FC, "bitzer", "resume", FC)?.code, "not_allowed");
  assert.equal(checkAllowed("bitzer", "flint", "resume", FC)?.code, "not_allowed");
  assert.equal(defaultExpectsReply("resume"), false);
});

test("expects_reply defaults", () => {
  assert.equal(defaultExpectsReply("request"), true);
  assert.equal(defaultExpectsReply("escalate"), true);
  assert.equal(defaultExpectsReply("info"), false);
  assert.equal(defaultExpectsReply("reply"), false);
});

test("reply threading increments hop and keeps thread", () => {
  const parent = msg({ hop: 1 });
  assert.deepEqual(checkReply({ parent, from: "bitzer", to: FC, kind: "reply" }, FC), { thread: parent.thread, hop: 2, refusal: null });
});

test("hop cap: hop 7 is refused with advice to escalate to FC; hop 6 is fine", () => {
  assert.equal(HOP_CAP, 6);
  assert.equal(PAIR_CAP, 10);
  const parent = msg({ from: "flint", to: "bitzer", hop: 6, kind: "request" });
  const r = checkReply({ parent, from: "bitzer", to: "flint", kind: "reply" }, FC);
  assert.equal(r.refusal?.code, "hop_cap");
  assert.equal(r.hop, 7);
  assert.match(r.refusal!.advice, /bot-dm the-fat-controller --kind escalate/);
  const ok = checkReply({ parent: { ...parent, hop: 5 }, from: "bitzer", to: "flint", kind: "reply" }, FC);
  assert.deepEqual(ok, { thread: parent.thread, hop: 6, refusal: null });
});

test("no answer to reply/info unless it expects one", () => {
  for (const kind of ["reply", "info"] as const) {
    const parent = msg({ from: "bitzer", to: FC, kind, expects_reply: false });
    const r = checkReply({ parent, from: FC, to: "bitzer", kind: "reply" }, FC);
    assert.equal(r.refusal?.code, "not_allowed", kind);
    const ok = checkReply({ parent: { ...parent, expects_reply: true }, from: FC, to: "bitzer", kind: "reply" }, FC);
    assert.equal(ok.refusal, null, `${kind} with expects-reply`);
  }
});

test("following up your own DM is allowed; replying to a stranger's DM is a usage error", () => {
  const own = msg({ kind: "info", expects_reply: false });
  assert.deepEqual(checkReply({ parent: own, from: FC, to: "bitzer", kind: "info" }, FC), { thread: own.thread, hop: 2, refusal: null });
  assert.throws(() => checkReply({ parent: msg({ from: "flint", to: "scrat" }), from: FC, to: "flint", kind: "info" }, FC), UsageError);
  // kind=reply must go back to the parent's sender
  assert.throws(() => checkReply({ parent: msg({ from: FC, to: "bitzer" }), from: "bitzer", to: "flint", kind: "reply" }, FC), UsageError);
});

test("rate: counts non-refused messages to the same recipient in the last hour", () => {
  const now = Date.parse("2026-10-08T06:00:00.000Z");
  const records: Array<DmMessage | DmStatus> = [];
  for (let i = 0; i < 25; i++) {
    const id = `01K6ZQ5V8M00000000000000${String(i).padStart(2, "0")}`;
    const ts = new Date(now - (i < 22 ? 60_000 * i : 2 * 3_600_000)).toISOString();
    records.push(msg({ id, ts, to: i % 2 ? "bitzer" : "flint" }));
    if (i === 3) records.push({ v: 1, type: "status", id, ts, status: "refused", detail: "not_allowed" });
  }
  // bitzer: odd i < 22 -> 11, minus i=3 refused -> 10
  assert.equal(countRecent(records, FC, "bitzer", now), 10);
  assert.equal(checkRate(19, "bitzer"), null);
  assert.equal(checkRate(20, "bitzer")?.code, "rate_limited");
});

test("size, subject and clamped bodies", () => {
  assert.equal(checkSize("x".repeat(4000)), null);
  assert.equal(checkSize("x".repeat(4001))?.code, "too_large");
  assert.equal(deriveSubject("\n  First line  \nsecond"), "First line");
  assert.equal(deriveSubject("y".repeat(100)).length, 80);
  const clamped = clampBody("z".repeat(9000));
  assert.ok(clamped.length <= 4000 && clamped.endsWith("[…cut: 9000 chars]"));
  assert.ok(DmMessageSchema.safeParse(msg({ body: clamped })).success);
});

test("schedule senders: report or info, only to the owning bot; owner from the schedule's folder", () => {
  const S = scheduleSender("b9dc1d26");
  assert.equal(S, "worker:schedule.b9dc1d26");
  assert.ok(isScheduleSender(S));
  assert.ok(!isScheduleSender("worker:schedule-dm"));
  assert.equal(checkAllowed(S, "tweety-bird", "report", FC, "tweety-bird"), null);
  assert.equal(checkAllowed(S, "tweety-bird", "info", FC, "tweety-bird"), null);
  for (const kind of ["request", "reply", "escalate", "resume"] as const) {
    assert.equal(checkAllowed(S, "tweety-bird", kind, FC, "tweety-bird")?.code, "not_allowed", kind);
  }
  const other = checkAllowed(S, FC, "report", FC, "tweety-bird");
  assert.equal(other?.code, "not_allowed");
  assert.match(other!.reason, /belongs to tweety-bird/);
  // no owner given: refused
  assert.equal(checkAllowed(S, "tweety-bird", "report", FC)?.code, "not_allowed");
  const isBot = (name: string) => ["tweety-bird", "matilda"].includes(name);
  assert.equal(scheduleOwner("/b/tweety-bird", "/b", isBot), "tweety-bird");
  assert.equal(scheduleOwner("/b/tweety-bird/", "/b", isBot), "tweety-bird");
  assert.equal(scheduleOwner("/b/matilda-runs/mail-summary", "/b", isBot), "matilda");
  assert.equal(scheduleOwner("/b/matilda-runs", "/b", isBot), "matilda");
  assert.equal(scheduleOwner("/b/tweety-bird/sub", "/b", isBot), null);
  assert.equal(scheduleOwner("/b/nobody", "/b", isBot), null);
  assert.equal(scheduleOwner("/elsewhere/tweety-bird", "/b", isBot), null);
  assert.equal(scheduleOwner("/b/../etc", "/b", isBot), null);
});
