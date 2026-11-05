import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, readdirSync, rmSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DmMessageSchema, parseLedgerLine, type DmMessage } from "../shared/dm-schema";
import * as dmRpc from "../shared/dm-rpc";
import { replyText } from "../shared/dm-rpc";
import { DmsService, defaultWorkersRoot, latestStatuses, subjectOf, ulid, type DmsPaseo } from "../server/dms";
import { LedgerCache, readLedger, readTailLines } from "../server/ledger";
import { appendLedgerRecord } from "../server/ledger-write";

const FIXTURES = join(__dirname, "fixtures", "dm");
const WORKER_FIXTURES = join(__dirname, "fixtures", "dm-workers");
const T1 = "01K6ZQ5V8M0000000000000001";
const T3 = "01K6ZQ5V8M0000000000000003";
const TR = "01K6ZQ5V8M000000000000000R";

function fixtureRoot() {
  const dir = mkdtempSync(join(tmpdir(), "dms-"));
  const root = join(dir, "bots");
  cpSync(FIXTURES, root, { recursive: true });
  return { root, dir };
}

function message(over: Partial<DmMessage>): DmMessage {
  return DmMessageSchema.parse({
    v: 1,
    type: "message",
    id: "01K6ZQ5V8M00000000000000AA",
    ts: "2026-10-08T08:00:00.000Z",
    from: "scrat",
    to: "bitzer",
    kind: "info",
    thread: "01K6ZQ5V8M00000000000000AA",
    re: null,
    hop: 1,
    subject: "",
    body: "hello",
    attachments: [],
    expects_reply: false,
    from_agent_id: null,
    to_agent_id: null,
    origin: "bot-dm/1",
    ...over,
  });
}

function fakePaseo(opts: { fail?: boolean } = {}) {
  const sent: Array<{ agentId: string; text: string; options: unknown }> = [];
  const paseo: DmsPaseo = {
    agents: {
      ref: (agentId) => ({
        send: async (text, options) => {
          if (opts.fail) throw new Error("daemon said no");
          sent.push({ agentId, text, options });
        },
      }),
    },
  };
  return { paseo, sent };
}

function service(root: string, extra: Partial<ConstructorParameters<typeof DmsService>[0]> = {}) {
  const opened: string[] = [];
  const dms = new DmsService({
    root,
    openChat: async (botId) => {
      opened.push(botId);
      return { agentId: `agent-${botId}` };
    },
    workersRoot: WORKER_FIXTURES,
    now: () => Date.parse("2026-10-08T09:00:00.000Z"),
    newId: () => "01K6ZQ5V8M00000000000000ZZ",
    ...extra,
  });
  return { dms, opened };
}

// --- tail reader ------------------------------------------------------------------------------

test("tail read drops a line cut by the window and a trailing half-written line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const path = join(dir, "inbox.jsonl");
  const a = JSON.stringify(message({ id: "01K6ZQ5V8M00000000000000A1", thread: "01K6ZQ5V8M00000000000000A1" }));
  const b = JSON.stringify(message({ id: "01K6ZQ5V8M00000000000000B1", thread: "01K6ZQ5V8M00000000000000B1" }));
  writeFileSync(path, `${a}\n${b}\n{"v":1,"type":"mess`);
  const whole = await readTailLines(path, 1 << 20);
  assert.deepEqual(whole.lines, [a, b]);
  assert.equal(whole.cut, false);
  // A window that starts inside line a keeps only b.
  const cut = await readTailLines(path, b.length + 30);
  assert.deepEqual(cut.lines, [b]);
  assert.equal(cut.cut, true);
});

test("a last line without a newline is kept when it is a whole record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const path = join(dir, "inbox.jsonl");
  const a = JSON.stringify(message({}));
  writeFileSync(path, a);
  assert.deepEqual((await readTailLines(path, 1 << 20)).lines, [a]);
});

test("a missing ledger reads as empty", async () => {
  const read = await readLedger(join(tmpdir(), "no-such-dm-dir"), "inbox");
  assert.deepEqual(read, { messages: [], statuses: [], invalid: 0, unknown: 0, truncated: false });
});

test("fixture ledgers: valid / unknown / invalid counts match the fixture README", async () => {
  const counts = async (bot: string, name: "inbox" | "outbox") => {
    const r = await readLedger(join(FIXTURES, bot, "dm"), name);
    return [r.messages.length + r.statuses.length, r.unknown, r.invalid];
  };
  assert.deepEqual(await counts("bitzer", "inbox"), [3, 1, 2]);
  assert.deepEqual(await counts("bitzer", "outbox"), [4, 0, 0]);
  assert.deepEqual(await counts("the-fat-controller", "inbox"), [1, 0, 0]);
  assert.deepEqual(await counts("the-fat-controller", "outbox"), [2, 0, 0]);
});

test("a short live file is topped up from the newest rotated file; older rotations mark truncation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rot-"));
  const line = (id: string) => `${JSON.stringify(message({ id, thread: id }))}\n`;
  writeFileSync(join(dir, "inbox-2026-08.jsonl"), line("01K6ZQ5V8M00000000000000R8"));
  writeFileSync(join(dir, "inbox-2026-09.jsonl"), line("01K6ZQ5V8M00000000000000R9"));
  writeFileSync(join(dir, "inbox.jsonl"), line("01K6ZQ5V8M00000000000000K1"));
  const read = await readLedger(dir, "inbox");
  assert.deepEqual(read.messages.map((m) => m.id), ["01K6ZQ5V8M00000000000000R9", "01K6ZQ5V8M00000000000000K1"]);
  assert.equal(read.truncated, true);
  // With the live file filling the window, the rotated file is not read.
  const small = await readLedger(dir, "inbox", line("01K6ZQ5V8M00000000000000K1").length);
  assert.deepEqual(small.messages.map((m) => m.id), ["01K6ZQ5V8M00000000000000K1"]);
});

test("the ledger cache re-reads a file only after it changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-"));
  const path = join(dir, "outbox.jsonl");
  writeFileSync(path, `${JSON.stringify(message({ from: "bitzer", to: "scrat" }))}\n`);
  const cache = new LedgerCache();
  const first = await cache.read(dir, "outbox");
  assert.equal(await cache.read(dir, "outbox"), first);
  appendFileSync(path, `${JSON.stringify(message({ id: "01K6ZQ5V8M00000000000000AB", from: "bitzer", to: "scrat" }))}\n`);
  const second = await cache.read(dir, "outbox");
  assert.notEqual(second, first);
  assert.equal(second.messages.length, 2);
});

// --- joining and threading --------------------------------------------------------------------

test("statuses: the latest by time wins, ties go to the later line", () => {
  const s = (status: "queued" | "steered" | "failed", ts: string) => ({ v: 1 as const, type: "status" as const, id: T1, ts, status, detail: null });
  const latest = latestStatuses([s("queued", "2026-10-08T05:00:00Z"), s("failed", "2026-10-08T05:00:01.5Z"), s("steered", "2026-10-08T05:00:01.500Z")]);
  assert.equal(latest.get(T1)!.status, "steered");
});

test("threads for bitzer: grouped, statuses joined across bots and worker outboxes", async () => {
  const { root } = fixtureRoot();
  const { dms } = service(root);
  const { threads, skipped } = await dms.threads("bitzer");
  assert.deepEqual(skipped, { invalid: 2, unknown: 1, truncated: false });
  assert.deepEqual(threads.map((t) => t.thread), [TR, T1, T3]);
  const [refused, main, report] = threads;
  assert.deepEqual(
    { parties: main!.parties, count: main!.count, kind: main!.kind, max_hop: main!.max_hop, awaiting: main!.awaiting_reply, subject: main!.subject },
    { parties: ["the-fat-controller", "user"], count: 3, kind: "request", max_hop: 2, awaiting: false, subject: "Scope AGENTS.md to terminal sessions" },
  );
  assert.equal(main!.last_from, "user");
  assert.deepEqual([refused!.has_problem, refused!.has_escalate, refused!.last_status], [true, true, "refused"]);
  assert.deepEqual([report!.parties, report!.kind], [["worker:wp1-bot-dm"], "report"]);
  // The worker's status comes from bot-dm's worker outbox (fixtures/dm-workers), not a bot ledger.
  assert.equal(report!.last_status, "started");

  const { messages } = await dms.thread("bitzer", { threadId: T1 });
  assert.deepEqual(
    messages.map((m) => [m.id.slice(-4), m.direction, m.status]),
    [
      ["0001", "in", "steered"], // status from the-fat-controller's outbox
      ["0002", "out", "started"],
      ["0004", "in", null], // Sam's own reply
    ],
  );
});

test("a thread opens by the id of any message in it (timeline cards know only the message)", async () => {
  const { root } = fixtureRoot();
  const { dms } = service(root);
  const byMessage = await dms.thread("bitzer", { messageId: "01K6ZQ5V8M0000000000000002" });
  assert.equal(byMessage.thread!.thread, T1);
  assert.equal(byMessage.messages.length, 3);
  const none = await dms.thread("bitzer", { messageId: "01K6ZQ5V8M00000000000000QQ" });
  assert.deepEqual(none, { thread: null, messages: [] });
});

test("an unanswered expects_reply message shows as awaiting a reply", async () => {
  const { root } = fixtureRoot();
  mkdirSync(join(root, "scrat", "dm"), { recursive: true });
  writeFileSync(
    join(root, "scrat", "dm", "inbox.jsonl"),
    `${JSON.stringify(message({ to: "scrat", from: "the-fat-controller", kind: "request", expects_reply: true, subject: "", body: "\n  What is the status?\nMore." }))}\n`,
  );
  const { dms } = service(root);
  const [thread] = (await dms.threads("scrat")).threads;
  assert.equal(thread!.awaiting_reply, true);
  assert.equal(thread!.subject, "What is the status?");
  // Sam's note to scrat does not answer the controller's question; scrat's own reply does.
  await dms.reply("scrat", thread!.thread, "I'll check.", fakePaseo().paseo);
  assert.equal((await dms.threads("scrat")).threads[0]!.awaiting_reply, true);
  appendFileSync(
    join(root, "scrat", "dm", "outbox.jsonl"),
    `${JSON.stringify(message({ id: "01K6ZQ5V8M00000000000000AC", thread: thread!.thread, re: "01K6ZQ5V8M00000000000000AA", from: "scrat", to: "the-fat-controller", kind: "reply", hop: 2 }))}\n`,
  );
  assert.equal((await dms.threads("scrat")).threads[0]!.awaiting_reply, false);
});

test("summary: per bot totals and last time; bots without a dm folder are absent", async () => {
  const { root } = fixtureRoot();
  mkdirSync(join(root, "flint"));
  const { dms } = service(root);
  assert.deepEqual(await dms.summary(), [
    { botId: "bitzer", total: 5, last_ts: "2026-10-08T07:00:00.000Z" },
    { botId: "the-fat-controller", total: 2, last_ts: "2026-10-08T05:20:11.002Z" },
  ]);
});

test("an outbound DM whose latest status is failed flags its thread as a problem; a delivered one does not", async () => {
  const { root } = fixtureRoot();
  const dir = join(root, "scrat", "dm");
  mkdirSync(dir, { recursive: true });
  const sent = (id: string, ts: string) => message({ id, thread: id, ts, from: "scrat", to: "flint", kind: "info" });
  const st = (id: string, status: string, ts: string) => JSON.stringify({ v: 1, type: "status", id, ts, status, detail: null });
  const A = "01K6ZQ5V8M00000000000000F1";
  const B = "01K6ZQ5V8M00000000000000F2";
  writeFileSync(
    join(dir, "outbox.jsonl"),
    [JSON.stringify(sent(A, "2026-10-08T08:00:00.000Z")), st(A, "queued", "2026-10-08T08:00:00.000Z"), st(A, "failed", "2026-10-08T08:00:01.000Z"),
     JSON.stringify(sent(B, "2026-10-08T08:01:00.000Z")), st(B, "queued", "2026-10-08T08:01:00.000Z"), st(B, "steered", "2026-10-08T08:01:01.000Z")].join("\n") + "\n",
  );
  const { dms } = service(root);
  const threads = (await dms.threads("scrat")).threads;
  assert.deepEqual(threads.map((t) => [t.thread, t.has_problem, t.last_status]), [[B, false, "steered"], [A, true, "failed"]]);
});

test("the workers root defaults to bot-dm's state dir", () => {
  assert.match(defaultWorkersRoot({}), /\/\.local\/state\/bot-dm\/workers$/);
  assert.equal(defaultWorkersRoot({ XDG_STATE_HOME: "/x" }), "/x/bot-dm/workers");
});

// --- no read tracking -------------------------------------------------------------------------

test("the DMs view is read-only: no unread counts, no read markers, no mark-seen RPC", async () => {
  const { root, dir } = fixtureRoot();
  const { dms } = service(root);
  const summary = await dms.summary();
  const { threads } = await dms.threads("bitzer");
  const { messages } = await dms.thread("bitzer", { threadId: T1 });
  for (const record of [...summary, ...threads, ...messages]) assert.ok(!("unread" in record), JSON.stringify(record));
  assert.ok(!("markSeen" in dms));
  assert.ok(!Object.values(dmRpc).some((v) => typeof v === "object" && v !== null && "name" in v && /seen/i.test(String(v.name))));
  // Reading and replying write nothing but Sam's ledger line: no state file beside the bots root.
  await dms.reply("bitzer", T1, "ok", fakePaseo().paseo);
  assert.deepEqual(readdirSync(dir), ["bots"]);
});

test("bot ids are checked before any path is built", async () => {
  const { root } = fixtureRoot();
  const { dms } = service(root);
  await assert.rejects(dms.threads("../etc"), /Not a bot id/);
  await assert.rejects(dms.threads("user"), /Not a bot id/);
  await assert.rejects(dms.reply("../x", T1, "hi", fakePaseo().paseo), /Not a bot id/);
});

// --- reply ------------------------------------------------------------------------------------

test("reply: sent as Sam in steer mode with the reply id as messageId, then recorded in the bot's inbox", async () => {
  const { root } = fixtureRoot();
  const { dms, opened } = service(root);
  const { paseo, sent } = fakePaseo();
  const result = await dms.reply("bitzer", T1, "  Please also update the README.\nThanks.  ", paseo);
  assert.deepEqual(result, { id: "01K6ZQ5V8M00000000000000ZZ", agentId: "agent-bitzer", recorded: true, warning: null });
  assert.deepEqual(opened, ["bitzer"]);
  assert.deepEqual(sent, [
    {
      agentId: "agent-bitzer",
      text: `Re dm ${T1}: Please also update the README.\nThanks.`,
      options: { messageId: "01K6ZQ5V8M00000000000000ZZ", activeTurnBehavior: "steer" },
    },
  ]);
  const lines = readFileSync(join(root, "bitzer", "dm", "inbox.jsonl"), "utf8").trimEnd().split("\n");
  const parsed = parseLedgerLine(lines[lines.length - 1]!);
  assert.ok(parsed.ok);
  assert.deepEqual(
    parsed.record,
    DmMessageSchema.parse({
      v: 1, type: "message", id: "01K6ZQ5V8M00000000000000ZZ", ts: "2026-10-08T09:00:00.000Z",
      from: "user", to: "bitzer", kind: "info", thread: T1, re: "01K6ZQ5V8M0000000000000004", hop: 2,
      subject: "Please also update the README.", body: "Please also update the README.\nThanks.", attachments: [],
      expects_reply: false, from_agent_id: null, to_agent_id: "agent-bitzer", origin: "paseo-bots/dms-1",
    }),
  );
  // The thread now shows the reply.
  const { messages } = await dms.thread("bitzer", { threadId: T1 });
  assert.equal(messages[messages.length - 1]!.id, "01K6ZQ5V8M00000000000000ZZ");
});

test("reply text never starts with a slash, so Paseo cannot fall back to interrupt", () => {
  assert.ok(!replyText(T1, "/compact").startsWith("/"));
});

test("reply refuses unknown threads, empty and oversized text, and records nothing when the send fails", async () => {
  const { root } = fixtureRoot();
  const { dms } = service(root);
  const inbox = join(root, "bitzer", "dm", "inbox.jsonl");
  const before = readFileSync(inbox, "utf8");
  await assert.rejects(dms.reply("bitzer", "01K6ZQ5V8M00000000000000QQ", "hi", fakePaseo().paseo), /No DM thread/);
  await assert.rejects(dms.reply("bitzer", T1, "   ", fakePaseo().paseo), /Empty reply/);
  await assert.rejects(dms.reply("bitzer", T1, "x".repeat(4001), fakePaseo().paseo), /limit is 4000/);
  await assert.rejects(dms.reply("bitzer", T1, "hi", fakePaseo({ fail: true }).paseo), /daemon said no/);
  assert.equal(readFileSync(inbox, "utf8"), before);
});

test("reply into a bot with a thread but no inbox file yet creates it with private modes", async () => {
  const { root } = fixtureRoot();
  // the-fat-controller's thread T1 is in its outbox; drop its inbox so the reply creates it.
  rmSync(join(root, "the-fat-controller", "dm", "inbox.jsonl"));
  const { dms } = service(root);
  const result = await dms.reply("the-fat-controller", T1, "ok", fakePaseo().paseo);
  assert.equal(result.recorded, true);
  const inbox = join(root, "the-fat-controller", "dm", "inbox.jsonl");
  assert.equal(statSync(inbox).mode & 0o777, 0o600);
  const fresh = mkdtempSync(join(tmpdir(), "fresh-"));
  await appendLedgerRecord(join(fresh, "bot", "dm"), "inbox", message({}));
  assert.equal(statSync(join(fresh, "bot", "dm")).mode & 0o777, 0o700);
});

// --- ledger append ----------------------------------------------------------------------------

test("parallel appends produce whole lines only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "append-"));
  const body = "y".repeat(3900);
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      appendLedgerRecord(dir, "inbox", message({ id: ulid(Date.now() + i), thread: T1, body })),
    ),
  );
  const read = await readLedger(dir, "inbox");
  assert.equal(read.messages.length, 25);
  assert.equal(read.invalid, 0);
});

test("append waits for bot-dm's flock on dm/.lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const path = join(dir, ".lock");
  writeFileSync(path, "");
  const holder = spawn("flock", ["-x", path, "sleep", "0.8"]);
  await new Promise((r) => setTimeout(r, 150));
  const started = Date.now();
  await appendLedgerRecord(dir, "inbox", message({}));
  const waited = Date.now() - started;
  holder.kill();
  assert.ok(waited >= 400, `append returned after ${waited} ms while the lock was held`);
});

test("append rotates at 5 MB with bot-dm's names, and the reader picks the newest rotation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rotate-"));
  const now = new Date("2026-10-08T09:00:00Z");
  writeFileSync(join(dir, "inbox-2026-10.jsonl"), `${JSON.stringify(message({ id: "01K6ZQ5V8M00000000000000R1", thread: "01K6ZQ5V8M00000000000000R1" }))}\n`);
  const filler = `${JSON.stringify(message({ id: "01K6ZQ5V8M00000000000000F1", thread: "01K6ZQ5V8M00000000000000F1", body: "f".repeat(3000) }))}\n`;
  writeFileSync(join(dir, "inbox.jsonl"), filler.repeat(Math.ceil((5 * 1024 * 1024) / filler.length)));
  await appendLedgerRecord(dir, "inbox", message({}), now);
  assert.ok(statSync(join(dir, "inbox-2026-10.2.jsonl")).size >= 5 * 1024 * 1024);
  assert.equal(readFileSync(join(dir, "inbox.jsonl"), "utf8").trimEnd().split("\n").length, 1);
  const { newestRotated } = await import("../server/ledger");
  assert.equal(await newestRotated(dir, "inbox"), join(dir, "inbox-2026-10.2.jsonl"));
});

test("append starts a fresh line after a torn last line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "torn-"));
  writeFileSync(join(dir, "inbox.jsonl"), '{"v":1,"type":"mess');
  await appendLedgerRecord(dir, "inbox", message({}));
  const read = await readLedger(dir, "inbox");
  assert.deepEqual([read.messages.length, read.invalid], [1, 1]);
});

test("append refuses records that fail the schema", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bad-"));
  await assert.rejects(appendLedgerRecord(dir, "inbox", { ...message({}), kind: "gossip" } as unknown as DmMessage));
});

test("subjects fall back to the body's first line and are capped at 80 characters", () => {
  assert.equal(subjectOf({ subject: "", body: "\n\nfirst\nsecond" }), "first");
  assert.equal(subjectOf({ subject: "", body: "z".repeat(100) }).length, 80);
});

test("ulids are 26 Crockford characters and sort by time", () => {
  const a = ulid(1_700_000_000_000);
  const b = ulid(1_700_000_000_001);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(a < b);
});

test("latestOutgoing is the bot's newest sent DM; incoming ones and empty ledgers do not count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dms-out-"));
  const root = join(dir, "bots");
  mkdirSync(join(root, "scrat", "dm"), { recursive: true });
  mkdirSync(join(root, "bitzer"), { recursive: true });
  const outbox = join(root, "scrat", "dm", "outbox.jsonl");
  const inbox = join(root, "scrat", "dm", "inbox.jsonl");
  writeFileSync(outbox, [
    message({ id: "01K6ZQ5V8M00000000000000A1", ts: "2026-10-08T08:00:00.000Z", subject: "older" }),
    message({ id: "01K6ZQ5V8M00000000000000A2", ts: "2026-10-08T09:00:00.000Z", to: "flint", subject: "", body: "\nnewest first line\nmore" }),
  ].map((m) => JSON.stringify(m)).join("\n") + "\n");
  writeFileSync(inbox, JSON.stringify(message({ id: "01K6ZQ5V8M00000000000000A3", ts: "2026-10-08T10:00:00.000Z", from: "flint", to: "scrat" })) + "\n");
  const service = new DmsService({ root, openChat: async () => ({ agentId: "x" }) });
  assert.deepEqual(await service.latestOutgoing("scrat"), { ts: "2026-10-08T09:00:00.000Z", to: "flint", subject: "newest first line" });
  assert.equal(await service.latestOutgoing("bitzer"), null);
  await assert.rejects(service.latestOutgoing("user"));
  // Home order: any DM counts, sent or received.
  assert.equal(await service.latestAt("scrat"), "2026-10-08T10:00:00.000Z");
  assert.equal(await service.latestAt("bitzer"), null);
});
