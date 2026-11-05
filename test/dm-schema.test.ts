import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DM_KINDS,
  DM_STATUSES,
  DmMessageSchema,
  DmStatusSchema,
  formatEnvelope,
  parseEnvelope,
  parseLedgerLine,
  type DmMessage,
} from "../shared/dm-schema";

const FIXTURES = join(__dirname, "fixtures", "dm");
const lines = (rel: string) => readFileSync(join(FIXTURES, rel), "utf8").split("\n").filter(Boolean);
const tally = (rel: string) => {
  const t = { ok: 0, unknown: 0, invalid: 0 };
  for (const l of lines(rel)) {
    const r = parseLedgerLine(l);
    t[r.ok ? "ok" : r.reason]++;
  }
  return t;
};

const base: DmMessage = {
  v: 1,
  type: "message",
  id: "01K6ZQ5V8M0000000000000001",
  ts: "2026-10-08T05:12:03.481Z",
  from: "the-fat-controller",
  to: "bitzer",
  kind: "request",
  thread: "01K6ZQ5V8M0000000000000001",
  re: null,
  hop: 1,
  subject: "Hello",
  body: "Hello",
  attachments: [],
  expects_reply: true,
  from_agent_id: "48505ff1-3f61-4b36-b6d3-c2d2a037f4ad",
  to_agent_id: "11ba726e-deca-4ba6-8658-396fae9c3ac2",
  origin: "bot-dm/1",
};

test("kinds and statuses are exactly the v1 sets (resume added 2026-10-08 for system nudges, pushed 2026-10-10 for DMs to Sam)", () => {
  assert.deepEqual([...DM_KINDS], ["request", "reply", "info", "escalate", "report", "resume"]);
  assert.deepEqual([...DM_STATUSES], ["queued", "steered", "started", "pushed", "failed", "refused"]);
});

test("fixture files parse to the documented counts", () => {
  assert.deepEqual(tally("bitzer/dm/inbox.jsonl"), { ok: 3, unknown: 1, invalid: 2 });
  assert.deepEqual(tally("bitzer/dm/outbox.jsonl"), { ok: 4, unknown: 0, invalid: 0 });
  assert.deepEqual(tally("the-fat-controller/dm/inbox.jsonl"), { ok: 1, unknown: 0, invalid: 0 });
  assert.deepEqual(tally("the-fat-controller/dm/outbox.jsonl"), { ok: 2, unknown: 0, invalid: 0 });
});

test("the same message record appears in sender outbox and recipient inbox", () => {
  const out = parseLedgerLine(lines("the-fat-controller/dm/outbox.jsonl")[0]);
  const inb = parseLedgerLine(lines("bitzer/dm/inbox.jsonl")[0]);
  assert.ok(out.ok && inb.ok);
  assert.deepEqual(out.record, inb.record);
});

test("message record accepts the report 07 example shape and every kind", () => {
  for (const kind of DM_KINDS) assert.ok(DmMessageSchema.safeParse({ ...base, kind }).success, kind);
  assert.ok(DmMessageSchema.safeParse({ ...base, from: "worker:wp1-bot-dm", from_agent_id: null }).success);
  assert.ok(DmMessageSchema.safeParse({ ...base, from: "user" }).success);
});

test("message record rejects bad values", () => {
  const bad: Array<[string, Partial<Record<keyof DmMessage, unknown>>]> = [
    ["kind", { kind: "gossip" }],
    ["id not ULID", { id: "01DEDUPETEST0000000000000A" }],
    ["hop 0", { hop: 0 }],
    ["hop fractional", { hop: 1.5 }],
    ["body too long", { body: "x".repeat(4001) }],
    ["body empty", { body: "" }],
    ["subject too long", { subject: "x".repeat(81) }],
    ["relative attachment", { attachments: ["dm/files/x.md"] }],
    ["bad party", { from: "Bitzer" }],
    ["bad worker", { from: "worker:" }],
    ["ts with offset", { ts: "2026-10-08T06:12:03+01:00" }],
    ["v2", { v: 2 }],
  ];
  for (const [why, patch] of bad) assert.equal(DmMessageSchema.safeParse({ ...base, ...patch }).success, false, why);
  const { origin: _o, ...missing } = base;
  assert.equal(DmMessageSchema.safeParse(missing).success, false, "missing origin");
});

test("status record", () => {
  const s = { v: 1, type: "status", id: base.id, ts: base.ts, status: "refused", detail: "hop_cap" };
  assert.ok(DmStatusSchema.safeParse(s).success);
  for (const status of DM_STATUSES) assert.ok(DmStatusSchema.safeParse({ ...s, status, detail: null }).success);
  assert.equal(DmStatusSchema.safeParse({ ...s, status: "delivered" }).success, false);
});

test("parseLedgerLine skips unknown types and versions, flags broken lines", () => {
  assert.deepEqual(parseLedgerLine('{"v":1,"type":"reaction"}'), { ok: false, reason: "unknown" });
  assert.deepEqual(parseLedgerLine('{"v":2,"type":"message"}'), { ok: false, reason: "unknown" });
  assert.equal(parseLedgerLine("{").ok, false);
  assert.equal(parseLedgerLine("[]").ok, false);
  const r = parseLedgerLine(JSON.stringify({ ...base, kind: "gossip" }));
  assert.ok(!r.ok && r.reason === "invalid" && /kind/.test(r.error));
});

test("envelope round-trips and never starts with a slash", () => {
  const e = { id: base.id, from: "a", to: "b", kind: "request" as const, hop: 2, re: "01K6ZQ5V8M0000000000000002", expects_reply: true };
  const s = formatEnvelope(e);
  assert.equal(s, "[dm 01K6ZQ5V8M0000000000000001 from a to b kind=request hop=2 re=01K6ZQ5V8M0000000000000002 expects-reply]");
  assert.deepEqual(parseEnvelope(`${s}\nbody`), e);
  const root = { ...e, re: null, expects_reply: false };
  assert.equal(formatEnvelope(root), "[dm 01K6ZQ5V8M0000000000000001 from a to b kind=request hop=2 re=-]");
  assert.deepEqual(parseEnvelope(formatEnvelope(root)), root);
  assert.equal(parseEnvelope("/compact [dm x from a to b kind=info hop=1 re=-]"), null);
  assert.equal(parseEnvelope("[dm x from a to b kind=gossip hop=1 re=-]"), null);
});
