import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DM_ENVELOPE_RE, parseLedgerLine, type DmRecord } from "../shared/dm-schema.ts";
import { run, type Deps } from "../bot-dm/cli.ts";
import type { AgentInfo, PaseoPort, ScheduleInfo } from "../bot-dm/paseo.ts";

export const TEST_SETTINGS = { user: { name: "Sam", aliases: ["sam"] }, escalation: "the-fat-controller" };

const FC = "the-fat-controller";

type Sent = { agentId: string; text: string; options: { messageId: string; activeTurnBehavior: string } };

function world(opts: { fail?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "botdm-"));
  const bots = join(root, "bots");
  // Host settings as on a configured host: the user's name, an alias, the escalation bot.
  mkdirSync(bots, { recursive: true });
  writeFileSync(join(bots, ".settings.json"), JSON.stringify(TEST_SETTINGS));
  const agents: AgentInfo[] = [];
  for (const [i, name] of [FC, "bitzer", "flint"].entries()) {
    mkdirSync(join(bots, name), { recursive: true });
    writeFileSync(join(bots, name, ".optchat-profile"), `${name}\n`);
    agents.push({
      id: `agent-${name}`,
      status: "idle",
      provider: "optchat",
      cwd: join(bots, name),
      labels: { bot: name },
      archivedAt: null,
      updatedAt: `2026-10-08T0${i}:00:00Z`,
    });
  }
  // scrat: a bot with an unlabelled chat (as FC's sub-chats are today)
  mkdirSync(join(bots, "scrat"));
  writeFileSync(join(bots, "scrat", ".optchat-profile"), "scrat\n");
  agents.push({ id: "agent-scrat", status: "running", provider: "optchat", cwd: join(bots, "scrat"), labels: {}, archivedAt: null, updatedAt: null });
  // a tmp test bot living outside the bots root
  const tmpBot = join(root, "tmp-bot");
  mkdirSync(tmpBot);
  writeFileSync(join(tmpBot, ".optchat-profile"), "tmp-bot\n");
  agents.push({ id: "agent-tmp-bot", status: "idle", provider: "optchat", cwd: tmpBot, labels: { bot: "tmp-bot" }, archivedAt: null, updatedAt: null });

  const sent: Sent[] = [];
  /** Paseo schedules by id, as `paseo schedule inspect` returns them (daemon-written run records). */
  const schedules = new Map<string, ScheduleInfo>();
  /** Status agentStatus() reports (the fresh read), when it differs from listAgents(). */
  const fresh = new Map<string, string>();
  const statusCalls: string[] = [];
  let clock = Date.parse("2026-10-08T06:00:00.000Z");
  const paseo: PaseoPort = {
    cli: { version: "0.11.1", pinned: true, dist: "/fake" },
    listAgents: async () => agents,
    agentStatus: async (id) => {
      statusCalls.push(id);
      return fresh.get(id) ?? agents.find((a) => a.id === id)?.status ?? null;
    },
    inspectSchedule: async (id) => schedules.get(id) ?? null,
    send: async (agentId, text, options) => {
      if (opts.fail) throw new Error(opts.fail);
      sent.push({ agentId, text, options });
    },
    close: async () => {},
  };
  const outs: any[] = [];
  const errs: string[] = [];
  // PASEO_APNS_DIR: an empty dir, so a stray `bot-dm sam` can never reach a real paseo-apns.
  const env: NodeJS.ProcessEnv = { PASEO_BOTS_ROOT: bots, XDG_STATE_HOME: join(root, "state"), PASEO_APNS_DIR: join(root, "no-apns") };
  const deps = (extraEnv: NodeJS.ProcessEnv = {}): Deps => ({
    env: { ...env, ...extraEnv },
    connect: async () => paseo,
    now: () => new Date((clock += 1000)),
    readStdin: async () => "from stdin\nsecond line",
    out: (line) => outs.push(JSON.parse(line)),
    err: (line) => errs.push(line),
  });
  const as = (bot: string, argv: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    run(argv, deps({ PASEO_AGENT_ID: `agent-${bot}`, ...extraEnv }));
  const ledger = (bot: string, file: "inbox" | "outbox", base = join(bots, bot)): DmRecord[] => {
    const path = join(base, "dm", `${file}.jsonl`);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => {
      const parsed = parseLedgerLine(l);
      assert.ok(parsed.ok, `invalid ledger line in ${path}: ${l}`);
      return parsed.record;
    });
  };
  return { root, bots, agents, schedules, fresh, statusCalls, sent, outs, errs, deps, as, ledger, tmpBot, setClock: (t: number) => (clock = t) };
}

test("FC -> PM request: steer send, envelope first, stamped sender, both ledgers written", async () => {
  const w = world();
  const r = await w.as(FC, ["bitzer", "--kind", "request", "--text", "/compact please\nscope AGENTS.md"]);
  assert.equal(r.exit, 0, w.errs.join("\n"));
  assert.equal(w.sent.length, 1);
  const s = w.sent[0];
  assert.equal(s.agentId, "agent-bitzer");
  assert.equal(s.options.activeTurnBehavior, "steer");
  const out = w.outs[0];
  assert.equal(s.options.messageId, out.id);
  assert.ok(s.text.startsWith("[dm "), "text must start with the envelope, never a slash");
  const env = DM_ENVELOPE_RE.exec(s.text)!;
  assert.deepEqual(env.slice(1, 7), [out.id, FC, "bitzer", "request", "1", "-"]);
  assert.ok(s.text.split("\n")[0].endsWith(" expects-reply]"));
  assert.equal(out.status, "started"); // bitzer was idle

  const outbox = w.ledger(FC, "outbox");
  const inbox = w.ledger("bitzer", "inbox");
  assert.deepEqual(outbox.map((x) => x.type === "status" ? x.status : x.type), ["message", "queued", "started"]);
  assert.deepEqual(inbox, [outbox[0]]);
  const m = outbox[0];
  assert.ok(m.type === "message");
  assert.equal(m.thread, m.id);
  assert.equal(m.from_agent_id, "agent-the-fat-controller");
  assert.equal(m.to_agent_id, "agent-bitzer");
  assert.equal(m.subject, "/compact please");
  assert.equal(m.expects_reply, true);
  assert.equal(statSync(join(w.bots, FC, "dm")).mode & 0o777, 0o700);
  assert.equal(statSync(join(w.bots, "bitzer", "dm", "inbox.jsonl")).mode & 0o777, 0o600);
});

test("busy recipient is recorded as steered; --interrupt is opt-in and recorded", async () => {
  const w = world();
  w.agents.find((a) => a.id === "agent-bitzer")!.status = "running";
  await w.as(FC, ["bitzer", "--text", "hi"]);
  assert.equal(w.outs[0].status, "steered");
  await w.as(FC, ["bitzer", "--text", "stop now", "--interrupt"]);
  assert.equal(w.sent[1].options.activeTurnBehavior, "interrupt");
  assert.equal(w.outs[1].status, "started");
  assert.equal(w.outs[1].detail, "interrupt");
});

test("request -> reply -> reply chain; reply to a reply needs expects-reply; follow-ups run to hop 6; hop cap at 7", async () => {
  const w = world();
  await w.as("bitzer", ["flint", "--kind", "request", "--text", "Which port does the API use?"]);
  const q = w.outs.at(-1).id;
  let r = await w.as("flint", ["bitzer", "--kind", "reply", "--re", q, "--text", "8080. Do you also need the token?", "--expects-reply"]);
  assert.equal(r.exit, 0, w.errs.join("\n"));
  const a1 = w.outs.at(-1);
  assert.equal(a1.hop, 2);
  assert.equal(a1.thread, q);
  r = await w.as("bitzer", ["flint", "--kind", "reply", "--re", a1.id, "--text", "Yes please."]);
  assert.equal(r.exit, 0, w.errs.join("\n"));
  const a2 = w.outs.at(-1);
  assert.equal(a2.hop, 3);
  // a2 is a reply without expects-reply: answering is refused
  r = await w.as("flint", ["bitzer", "--kind", "reply", "--re", a2.id, "--text", "You're welcome"]);
  assert.equal(r.exit, 3);
  assert.equal(w.outs.at(-1).detail, "not_allowed");
  // follow-ups (info --re) are allowed and stay on the thread, up to hop 6
  let prev = a2.id;
  for (const [hop, from, to] of [[4, "flint", "bitzer"], [5, "bitzer", "flint"], [6, "flint", "bitzer"]] as const) {
    r = await w.as(from, [to, "--kind", "info", "--re", prev, "--text", `follow-up ${hop}`]);
    assert.equal(r.exit, 0, w.errs.join("\n"));
    assert.deepEqual([w.outs.at(-1).thread, w.outs.at(-1).hop], [q, hop]);
    prev = w.outs.at(-1).id;
  }
  // hop 7 is refused
  r = await w.as("bitzer", ["flint", "--kind", "info", "--re", prev, "--text", "Here: abc"]);
  assert.equal(r.exit, 3);
  const refusal = w.outs.at(-1);
  assert.equal(refusal.detail, "hop_cap");
  assert.equal(refusal.hop, 7);
  assert.match(refusal.reason, /the cap is 6/);
  assert.match(refusal.advice, /bot-dm the-fat-controller --kind escalate/);
  // refusals: record + status in sender outbox, nothing in recipient inbox, nothing sent
  const bitzerOut = w.ledger("bitzer", "outbox");
  const last = bitzerOut.at(-1)!;
  assert.ok(last.type === "status" && last.status === "refused" && last.detail === "hop_cap");
  assert.ok(!w.ledger("flint", "inbox").some((x) => x.id === refusal.id));
  assert.equal(w.sent.length, 6);
});

test("allow-list refusals: PM -> PM escalate, FC escalate down, PM report", async () => {
  const w = world();
  assert.equal((await w.as("bitzer", ["flint", "--kind", "escalate", "--text", "help"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "not_allowed");
  assert.equal((await w.as(FC, ["bitzer", "--kind", "escalate", "--text", "x"])).exit, 3);
  assert.equal((await w.as("bitzer", [FC, "--kind", "report", "--text", "x"])).exit, 3);
  assert.equal((await w.as("bitzer", [FC, "--kind", "escalate", "--text", "Thread X hit the cap"])).exit, 0);
  assert.equal(w.sent.length, 1);
});

test("BOT_DM_RECIPIENT_PREFIX fences tests away from real bots", async () => {
  const w = world();
  assert.equal((await w.as(FC, ["bitzer", "--text", "x"], { BOT_DM_RECIPIENT_PREFIX: "tmp-" })).exit, 2);
  assert.equal((await w.as(FC, ["tmp-bot", "--text", "x"], { BOT_DM_RECIPIENT_PREFIX: "tmp-" })).exit, 0);
  assert.equal(w.sent.length, 1);
});

test("BOT_DM_FC names the Fat Controller (used for tmp-bot tests)", async () => {
  const w = world();
  assert.equal((await w.as("bitzer", ["flint", "--kind", "escalate", "--text", "x"], { BOT_DM_FC: "flint" })).exit, 0);
});

test("rate limit: the 21st DM to one recipient within an hour is refused; others are unaffected", async () => {
  const w = world();
  const env = { BOT_DM_PAIR_CAP: "100" };
  for (let i = 0; i < 20; i++) assert.equal((await w.as(FC, ["bitzer", "--new-thread", "--text", `n${i}`], env)).exit, 0);
  assert.equal((await w.as(FC, ["bitzer", "--new-thread", "--text", "n20"], env)).exit, 3);
  assert.equal(w.outs.at(-1).detail, "rate_limited");
  assert.equal((await w.as(FC, ["flint", "--text", "other pair"])).exit, 0);
  w.setClock(Date.parse("2026-10-08T07:30:00.000Z"));
  assert.equal((await w.as(FC, ["bitzer", "--new-thread", "--text", "an hour later"], env)).exit, 0);
});

test("too large: refused, and the refusal record holds a clamped, schema-valid body", async () => {
  const w = world();
  assert.equal((await w.as(FC, ["bitzer", "--text", "x".repeat(4001)])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "too_large");
  const m = w.ledger(FC, "outbox")[0];
  assert.ok(m.type === "message" && m.body.length <= 4000);
  assert.equal(w.sent.length, 0);
});

test("unknown recipient: refused and recorded in the sender's outbox only", async () => {
  const w = world();
  assert.equal((await w.as(FC, ["nobody", "--text", "hi"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "unknown_recipient");
  const m = w.ledger(FC, "outbox")[0];
  assert.ok(m.type === "message" && m.to_agent_id === null);
  assert.equal(existsSync(join(w.bots, "nobody")), false);
});

test("unlabelled bot chats resolve by folder, as recipient and as sender", async () => {
  const w = world();
  assert.equal((await w.as(FC, ["scrat", "--text", "hi"])).exit, 0);
  assert.equal(w.sent[0].agentId, "agent-scrat");
  assert.equal(w.outs[0].status, "steered");
  assert.equal((await w.as("scrat", [FC, "--kind", "reply", "--re", w.outs[0].id, "--text", "ok"])).exit, 3); // info w/o expects-reply
  assert.equal((await w.as("scrat", [FC, "--text", "unprompted info"])).exit, 0);
  assert.equal(w.outs.at(-1).from, "scrat");
});

test("tmp bots outside the bots root keep their ledger in their own folder", async () => {
  const w = world();
  assert.equal((await w.as("tmp-bot", ["bitzer", "--text", "hello"])).exit, 0);
  assert.equal(w.ledger("tmp-bot", "outbox", w.tmpBot).length, 3);
});

test("worker reports: only outside Paseo, only kind=report; outbox under XDG state", async () => {
  const w = world();
  let r = await run(["bitzer", "--from", "worker:wp1-bot-dm", "--kind", "report", "--file", "-"], w.deps());
  assert.equal(r.exit, 0, w.errs.join("\n"));
  assert.equal(w.outs.at(-1).from, "worker:wp1-bot-dm");
  const inbox = w.ledger("bitzer", "inbox");
  assert.ok(inbox[0].type === "message" && inbox[0].body === "from stdin\nsecond line" && inbox[0].from_agent_id === null);
  assert.ok(existsSync(join(w.root, "state", "bot-dm", "workers", "wp1-bot-dm", "outbox.jsonl")));
  r = await run(["bitzer", "--from", "worker:x", "--text", "hi"], w.deps());
  assert.equal(r.exit, 2);
  r = await run(["bitzer", "--from", "worker:x", "--kind", "report", "--text", "hi"], w.deps({ PASEO_AGENT_ID: "agent-flint" }));
  assert.equal(r.exit, 2);
});

test("identity: no impersonation", async () => {
  const w = world();
  // inside Paseo, --from must match the caller
  assert.equal((await w.as("bitzer", [FC, "--from", "flint", "--text", "x"])).exit, 2);
  // outside Paseo, a bot name needs BOT_DM_OPERATOR=1
  assert.equal((await run([FC, "--from", "bitzer", "--text", "x"], w.deps())).exit, 2);
  assert.equal((await run([FC, "--from", "bitzer", "--text", "x"], w.deps({ BOT_DM_OPERATOR: "1" }))).exit, 0);
  // no identity at all
  assert.equal((await run([FC, "--text", "x"], w.deps())).exit, 2);
  // a non-bot Paseo agent
  w.agents.push({ id: "agent-x", status: "idle", provider: "claude", cwd: "/tmp", labels: {}, archivedAt: null, updatedAt: null });
  assert.equal((await run([FC, "--text", "x"], w.deps({ PASEO_AGENT_ID: "agent-x" }))).exit, 2);
  // self; sam is a recipient now (a push), refused here because no paseo-apns is set up
  assert.equal((await w.as("bitzer", ["bitzer", "--text", "x"])).exit, 2);
  assert.equal((await w.as("bitzer", ["user", "--text", "x"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "push_unavailable");
});

test("dedupe by id: resend after success is a no-op; after failure it retries without duplicating records", async () => {
  const w = world();
  const id = "01K6ZQ5V8MAAAAAAAAAAAAAAAA";
  assert.equal((await w.as(FC, ["bitzer", "--id", id, "--text", "once"])).exit, 0);
  assert.equal((await w.as(FC, ["bitzer", "--id", id, "--text", "once"])).exit, 0);
  assert.equal(w.outs.at(-1).duplicate, true);
  assert.equal(w.sent.length, 1);
  assert.equal((await w.as(FC, ["bitzer", "--id", id, "--text", "different"])).exit, 2);

  const f = world({ fail: "daemon unreachable" });
  assert.equal((await f.as(FC, ["bitzer", "--id", id, "--text", "once"])).exit, 1);
  assert.equal(f.outs.at(-1).status, "failed");
  assert.match(f.errs.at(-1)!, new RegExp(`--id ${id}`));
  // same world, daemon back
  const ok = world();
  ok.agents.splice(0); // reuse f's bots dir with a working paseo
  const retry = await run([`bitzer`, "--id", id, "--text", "once"], {
    ...f.deps({ PASEO_AGENT_ID: `agent-${FC}` }),
    connect: async () => ({ ...(await f.deps().connect()), send: async (a, t, o) => void ok.sent.push({ agentId: a, text: t, options: o }) }),
  });
  assert.equal(retry.exit, 0);
  assert.equal(ok.sent.length, 1);
  assert.equal(ok.sent[0].options.messageId, id);
  const statuses = f.ledger(FC, "outbox").map((x) => (x.type === "status" ? x.status : "message"));
  assert.deepEqual(statuses, ["message", "queued", "failed", "started"]);
  assert.equal(f.ledger("bitzer", "inbox").length, 1);
});

test("dry run checks everything and writes or sends nothing", async () => {
  const w = world();
  let r = await w.as(FC, ["bitzer", "--text", "hi", "--dry-run"]);
  assert.equal(r.exit, 0);
  assert.ok(w.outs[0].text.startsWith("[dm "));
  r = await w.as("bitzer", ["flint", "--kind", "escalate", "--text", "x", "--dry-run"]);
  assert.equal(r.exit, 3);
  assert.equal(w.sent.length, 0);
  assert.equal(existsSync(join(w.bots, FC, "dm")), false);
  assert.equal(existsSync(join(w.bots, "bitzer", "dm")), false);
});

test("attachments must be absolute existing files and are listed after the body", async () => {
  const w = world();
  const file = join(w.root, "plan.md");
  writeFileSync(file, "# plan");
  assert.equal((await w.as(FC, ["bitzer", "--text", "see file", "--attach", "plan.md"])).exit, 2);
  assert.equal((await w.as(FC, ["bitzer", "--text", "see file", "--attach", join(w.root, "nope.md")])).exit, 2);
  assert.equal((await w.as(FC, ["bitzer", "--text", "see file", "--attach", file])).exit, 0);
  assert.ok(w.sent[0].text.includes(`see file\nAttachments:\n- ${file}\n(No answer needed.`));
  const m = w.ledger("bitzer", "inbox")[0];
  assert.ok(m.type === "message" && m.attachments[0] === file && m.body === "see file");
});

test("usage errors exit 2 without touching Paseo", async () => {
  const w = world();
  let connected = false;
  const d = { ...w.deps({ PASEO_AGENT_ID: "agent-bitzer" }), connect: async () => { connected = true; throw new Error("no"); } };
  for (const argv of [
    [],
    ["a", "b", "--text", "x"],
    ["Bitzer", "--text", "x"],
    ["flint"],
    ["flint", "--text", "x", "--file", "/etc/hostname"],
    ["flint", "--text", "   "],
    ["flint", "--kind", "gossip", "--text", "x"],
    ["flint", "--kind", "reply", "--re", "01K6ZQ5V8M0000000000000000", "--new-thread", "--text", "x"],
    ["flint", "--re", "nope", "--text", "x"],
    ["flint", "--id", "short", "--text", "x"],
    ["flint", "--bogus", "--text", "x"],
  ]) {
    assert.equal((await run(argv, d)).exit, 2, argv.join(" "));
  }
  assert.equal(connected, false);
});

test("bin/bot-dm.mjs runs under plain Node (type stripping) with a clean stderr", async () => {
  const { spawnSync } = await import("node:child_process");
  const bin = join(__dirname, "..", "bin", "bot-dm.mjs");
  const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8", env: { ...process.env, PASEO_AGENT_ID: "" } });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /^Usage: bot-dm <to>/);
  const bad = spawnSync(process.execPath, [bin, "flint"], { encoding: "utf8", env: { ...process.env, PASEO_AGENT_ID: "" } });
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr.trim(), "bot-dm: give exactly one of --text or --file");
});

// ---- threading (dm-replies-threading) -------------------------------------------------------

test("threading: reply to a no-answer info is refused with advice to follow up with --re, not a new thread", async () => {
  const w = world();
  await w.as("bitzer", [FC, "--kind", "info", "--text", "Tasks 1 and 3 done. Shall I also do (b)? Yes/no?"]);
  const info = w.outs.at(-1);
  assert.equal((await w.as(FC, ["bitzer", "--kind", "reply", "--re", info.id, "--text", "Yes."])).exit, 3);
  const refusal = w.outs.at(-1);
  assert.equal(refusal.detail, "not_allowed");
  assert.match(refusal.advice, new RegExp(`--kind info --re ${info.id}`));
  assert.doesNotMatch(refusal.advice, /no --re|new thread \(/);
  assert.equal((await w.as(FC, ["bitzer", "--kind", "info", "--re", info.id, "--text", "Yes."])).exit, 0);
  const follow = w.outs.at(-1);
  assert.equal(follow.thread, info.id);
  assert.equal(follow.hop, 2);
});

test("threading: a DM without --re is threaded onto a DM id quoted in the text (8-char prefix ok)", async () => {
  const w = world();
  await w.as(FC, ["bitzer", "--kind", "request", "--text", "Three tasks; report back."]);
  const req = w.outs.at(-1);
  // a later, unrelated DM from FC so that 'latest' and 'mentioned' differ
  await w.as(FC, ["bitzer", "--new-thread", "--text", "Unrelated heads-up."]);
  assert.equal((await w.as("bitzer", [FC, "--kind", "info", "--text", `Interim on ${req.id.slice(0, 8)}: 1 and 3 done.`])).exit, 0);
  const interim = w.outs.at(-1);
  assert.equal(interim.thread, req.id);
  assert.equal(interim.re, req.id);
  assert.equal(interim.hop, 2);
  assert.equal(interim.inferredBy, "mention");
  assert.match(w.errs.at(-1)!, /threaded onto/);
});

test("threading: without --re or a quoted id, a DM joins the latest DM with that bot in the last 30 minutes", async () => {
  const w = world();
  await w.as("bitzer", ["flint", "--kind", "request", "--text", "Which port?"]);
  const q = w.outs.at(-1);
  await w.as("flint", ["bitzer", "--kind", "reply", "--re", q.id, "--text", "8080"]);
  const a = w.outs.at(-1);
  // bitzer follows up without --re: lands on the thread at hop 3, re = flint's reply
  assert.equal((await w.as("bitzer", ["flint", "--kind", "info", "--text", "Thanks, using 8080. Token too?"])).exit, 0);
  const f = w.outs.at(-1);
  assert.deepEqual([f.thread, f.re, f.hop, f.inferredBy], [q.id, a.id, 3, "recent"]);
  // inference keeps the thread going to hop 6 ...
  for (const [hop, from, to] of [[4, "flint", "bitzer"], [5, "bitzer", "flint"], [6, "flint", "bitzer"]] as const) {
    assert.equal((await w.as(from, [to, "--kind", "info", "--text", `more ${hop}`])).exit, 0, w.errs.join("\n"));
    assert.deepEqual([w.outs.at(-1).thread, w.outs.at(-1).hop, w.outs.at(-1).inferredBy], [q.id, hop, "recent"]);
  }
  // ... and hop 7 by inference is refused, with advice that mentions --new-thread
  assert.equal((await w.as("bitzer", ["flint", "--kind", "info", "--text", "Token is in the vault."])).exit, 3);
  const capped = w.outs.at(-1);
  assert.equal(capped.detail, "hop_cap");
  assert.match(capped.advice, /--new-thread/);
  // --new-thread opts out
  assert.equal((await w.as("bitzer", ["flint", "--new-thread", "--text", "Separate topic: lunch?"])).exit, 0);
  assert.equal(w.outs.at(-1).hop, 1);
  // 31 minutes later, a new DM starts a new thread
  w.setClock(Date.parse("2026-10-08T06:40:00.000Z"));
  assert.equal((await w.as("bitzer", ["flint", "--text", "Fresh topic"])).exit, 0);
  assert.equal(w.outs.at(-1).hop, 1);
  assert.equal(w.outs.at(-1).inferredRe, undefined);
});

test("threading: --kind reply without --re answers the latest DM from that bot; with nothing to answer it is a usage error", async () => {
  const w = world();
  assert.equal((await w.as("bitzer", ["flint", "--kind", "reply", "--text", "x"])).exit, 2);
  await w.as("flint", ["bitzer", "--kind", "request", "--text", "Status?"]);
  const q = w.outs.at(-1);
  await w.as("bitzer", ["flint", "--kind", "info", "--new-thread", "--text", "Unrelated note from me"]);
  assert.equal((await w.as("bitzer", ["flint", "--kind", "reply", "--text", "Green."])).exit, 0);
  assert.deepEqual([w.outs.at(-1).re, w.outs.at(-1).hop], [q.id, 2]);
});

test("threading: escalate and worker reports are never threaded by inference", async () => {
  const w = world();
  await w.as(FC, ["bitzer", "--kind", "request", "--text", "Do X"]);
  assert.equal((await w.as("bitzer", [FC, "--kind", "escalate", "--text", "Thread hit the cap"])).exit, 0);
  assert.equal(w.outs.at(-1).hop, 1);
  assert.equal(w.outs.at(-1).inferredRe, undefined);
});

test("threading: --re to an early message continues from the thread's highest hop", async () => {
  const w = world();
  await w.as("bitzer", ["flint", "--kind", "request", "--text", "Q", "--expects-reply"]);
  const q = w.outs.at(-1);
  await w.as("flint", ["bitzer", "--kind", "reply", "--re", q.id, "--text", "A", "--expects-reply"]);
  await w.as("bitzer", ["flint", "--kind", "reply", "--re", w.outs.at(-1).id, "--text", "B", "--expects-reply"]);
  await w.as("flint", ["bitzer", "--kind", "reply", "--re", w.outs.at(-1).id, "--text", "C", "--expects-reply"]);
  await w.as("bitzer", ["flint", "--kind", "reply", "--re", w.outs.at(-1).id, "--text", "D", "--expects-reply"]);
  await w.as("flint", ["bitzer", "--kind", "reply", "--re", w.outs.at(-1).id, "--text", "E", "--expects-reply"]);
  assert.equal(w.outs.at(-1).hop, 6);
  // bitzer answers its own original request's first reply again: would have been hop 3 before; now hop 7 -> refused
  const a = w.ledger("bitzer", "inbox").find((x) => x.type === "message" && x.hop === 2)!;
  assert.equal((await w.as("bitzer", ["flint", "--kind", "reply", "--re", a.id, "--text", "F"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "hop_cap");
  assert.equal(w.outs.at(-1).hop, 7);
  // flint answers the original request again: would have been hop 2 before; now hop 7 -> refused
  assert.equal((await w.as("flint", ["bitzer", "--kind", "reply", "--re", q.id, "--text", "C"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "hop_cap");
});

test("pair cap: an 11th DM between two bots in 30 minutes is refused across threads; escalate still goes", async () => {
  const w = world();
  for (let i = 0; i < 10; i++) {
    const [a, b] = i % 2 ? ["flint", "bitzer"] : ["bitzer", "flint"];
    assert.equal((await w.as(a, [b, "--new-thread", "--text", `t${i}`])).exit, 0, w.errs.join("\n"));
  }
  assert.equal((await w.as("bitzer", ["flint", "--new-thread", "--text", "t10"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "hop_cap");
  assert.match(w.outs.at(-1).reason, /10 DMs between bitzer and flint/);
  assert.match(w.outs.at(-1).advice, /^Escalate to the-fat-controller \(escalations are exempt/);
  assert.equal((await w.as("bitzer", [FC, "--kind", "escalate", "--text", "bitzer/flint loop"])).exit, 0);
  assert.equal((await w.as(FC, ["bitzer", "--text", "other pair unaffected"])).exit, 0);
});

test("pair cap applies to FC <-> PM pairs too; escalations to the FC are exempt", async () => {
  const w = world();
  for (let i = 0; i < 10; i++) {
    const [a, b] = i % 2 ? ["bitzer", FC] : [FC, "bitzer"];
    assert.equal((await w.as(a, [b, "--new-thread", "--text", `t${i}`])).exit, 0, w.errs.join("\n"));
  }
  // the 11th, from either side, is refused
  assert.equal((await w.as(FC, ["bitzer", "--new-thread", "--text", "t10"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "hop_cap");
  assert.match(w.outs.at(-1).advice, /decide, or ask Sam/);
  assert.equal((await w.as("bitzer", [FC, "--new-thread", "--text", "t10"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "hop_cap");
  assert.match(w.outs.at(-1).advice, new RegExp(`bot-dm ${FC} --kind escalate --text 'Our exchange hit the DM limit`));
  assert.match(w.outs.at(-1).advice, /^Stop this exchange/);
  // an escalation from the PM to the FC still goes
  assert.equal((await w.as("bitzer", [FC, "--kind", "escalate", "--text", "need a decision"])).exit, 0);
  // 31 minutes on, the window has passed
  w.setClock(Date.parse("2026-10-08T06:40:00.000Z"));
  assert.equal((await w.as(FC, ["bitzer", "--new-thread", "--text", "later"])).exit, 0);
});

test("delivered text ends with the exact command to answer or follow up; workers' reports have none", async () => {
  const w = world();
  await w.as("bitzer", ["flint", "--kind", "request", "--text", "Q?"]);
  const q = w.outs.at(-1);
  assert.ok(w.sent.at(-1)!.text.endsWith(`\n(To answer: bot-dm bitzer --kind reply --re ${q.id} --text "...")`));
  await w.as("bitzer", ["flint", "--new-thread", "--text", "FYI"]);
  assert.match(w.sent.at(-1)!.text, /\(No answer needed\. To add to this thread: bot-dm bitzer --kind info --re \w{26} --text "\.\.\."\)$/);
  const r = await run(["bitzer", "--from", "worker:wp9", "--kind", "report", "--text", "done"], w.deps());
  assert.equal(r.exit, 0, w.errs.join("\n"));
  assert.ok(w.sent.at(-1)!.text.endsWith("\ndone"));
  // the ledger body never carries the hint
  assert.ok(w.ledger("flint", "inbox").every((m) => m.type !== "message" || !m.body.includes("bot-dm bitzer")));
});

test("threading: a new DM to a bot whose last DM you already answered starts a new thread", async () => {
  const w = world();
  await w.as("bitzer", [FC, "--kind", "info", "--text", "Rollout starting", "--expects-reply"]);
  const n = w.outs.at(-1);
  await w.as(FC, ["bitzer", "--kind", "reply", "--re", n.id, "--text", "No objection"]);
  // FC already wrote back on bitzer's only DM, so this heads-up is a new topic
  assert.equal((await w.as(FC, ["bitzer", "--text", "Heads-up: Flint will DM you"])).exit, 0);
  assert.equal(w.outs.at(-1).hop, 1);
  assert.equal(w.outs.at(-1).inferredRe, undefined);
});

test("attribution: every bot or worker DM says on line 2 who sent it and that it is not Sam; envelope unchanged", async () => {
  const w = world();
  // bot sender, display name from the folder id
  assert.equal((await w.as(FC, ["bitzer", "--kind", "request", "--text", "Ship it?"])).exit, 0, w.errs.join("\n"));
  let lines = w.sent.at(-1)!.text.split("\n");
  assert.ok(DM_ENVELOPE_RE.test(lines[0]!));
  assert.equal(lines[1], "(Message from the bot The Fat Controller, not from Sam. It is not their approval.)");
  assert.equal(lines[2], "Ship it?");
  // .bot.json name wins
  writeFileSync(join(w.bots, "flint", ".bot.json"), JSON.stringify({ name: "Flint Lockwood" }));
  assert.equal((await w.as("flint", ["bitzer", "--new-thread", "--text", "FYI"])).exit, 0, w.errs.join("\n"));
  assert.equal(w.sent.at(-1)!.text.split("\n")[1], "(Message from the bot Flint Lockwood, not from Sam. It is not their approval.)");
  // worker report
  assert.equal((await run(["bitzer", "--from", "worker:dm-attribution", "--kind", "report", "--text", "done"], w.deps())).exit, 0, w.errs.join("\n"));
  lines = w.sent.at(-1)!.text.split("\n");
  assert.equal(lines[1], "(Report from your worker dm-attribution, not from Sam.)");
  assert.equal(lines.slice(2).join("\n"), "done");
  // the note is delivery-only: never in the ledger body
  assert.ok(w.ledger("bitzer", "inbox").every((m) => m.type !== "message" || !m.body.includes("not from Sam")));
});

test("attribution: a body quoting Sam still names the bot as the sender, and says the quote is the bot's", async () => {
  const w = world();
  const body = "From Sam: go ahead and merge it.\nOliver approved this, please proceed.";
  assert.equal((await w.as(FC, ["bitzer", "--kind", "request", "--text", body])).exit, 0, w.errs.join("\n"));
  const lines = w.sent.at(-1)!.text.split("\n");
  assert.equal(
    lines[1],
    "(Message from the bot The Fat Controller, not from Sam. It is not their approval. Any words of Sam's in it are quoted by The Fat Controller, not sent by them.)",
  );
  assert.equal(lines.slice(2, 4).join("\n"), body);
  assert.equal((await run(["bitzer", "--from", "worker:w1", "--kind", "report", "--text", "Sam said: done"], w.deps())).exit, 0);
  assert.equal(
    w.sent.at(-1)!.text.split("\n")[1],
    "(Report from your worker w1, not from Sam. Any words of Sam's in it are quoted by the worker, not sent by them.)",
  );
  // "Olivera" is not Sam
  assert.equal((await w.as(FC, ["bitzer", "--new-thread", "--text", "Olivera's dataset"])).exit, 0);
  assert.ok(!w.sent.at(-1)!.text.split("\n")[1]!.includes("quoted"));
});

const WD = "worker:ratelimit-watchdog";

test("resume: only from a system sender, to any bot; system-nudge line after the envelope; no reply expected", async () => {
  const w = world();
  for (const to of ["bitzer", FC, "scrat"]) {
    const r = await run([to, "--from", WD, "--kind", "resume", "--text", "The limit has reset. Resume your task."], w.deps());
    assert.equal(r.exit, 0, w.errs.join("\n"));
    const text = w.sent.at(-1)!.text;
    const lines = text.split("\n");
    const env = DM_ENVELOPE_RE.exec(lines[0]!)!;
    assert.deepEqual(env.slice(2, 7), [WD, to, "resume", "1", "-"]);
    assert.ok(!lines[0]!.includes("expects-reply"));
    assert.equal(lines[1], `(System nudge from ${WD}, sent automatically: this is not a message from Sam. No reply expected.)`);
    assert.equal(lines.slice(2).join("\n"), "The limit has reset. Resume your task.", "no reply hint");
    assert.equal(w.outs.at(-1).expectsReply, false);
  }
  // the ledger keeps the body only
  const inbox = w.ledger("bitzer", "inbox");
  assert.ok(inbox[0]!.type === "message" && inbox[0]!.kind === "resume" && inbox[0]!.body === "The limit has reset. Resume your task.");
  // other workers: refused by the rule (exit 3), recorded in their outbox
  let r = await run(["bitzer", "--from", "worker:wp9", "--kind", "resume", "--text", "go"], w.deps());
  assert.equal(r.exit, 3);
  assert.equal(r.output!.detail, "not_allowed");
  assert.match(String(r.output!.reason), /reserved for system senders \(worker:ratelimit-watchdog, worker:stall-watch, worker:push-slot\)/);
  // bots may not send it either
  r = await w.as(FC, ["bitzer", "--kind", "resume", "--text", "go"]);
  assert.equal(r.exit, 3);
  assert.equal(r.output!.detail, "not_allowed");
  // resume never asks for a reply
  r = await run(["bitzer", "--from", WD, "--kind", "resume", "--expects-reply", "--text", "go"], w.deps());
  assert.equal(r.exit, 2);
  // the watchdog may still send reports
  assert.equal((await run(["bitzer", "--from", WD, "--kind", "report", "--text", "fyi"], w.deps())).exit, 0);
});

test("resume: no pair cap (worker sender); the 20/hour per-recipient limit still applies", async () => {
  const w = world();
  for (let i = 0; i < 20; i++) {
    const r = await run(["bitzer", "--from", WD, "--kind", "resume", "--text", `nudge ${i}`], w.deps({ BOT_DM_PAIR_CAP: "2" }));
    assert.equal(r.exit, 0, `#${i}: ${w.errs.join("\n")}`);
  }
  const r = await run(["bitzer", "--from", WD, "--kind", "resume", "--text", "one more"], w.deps({ BOT_DM_PAIR_CAP: "2" }));
  assert.equal(r.exit, 3);
  assert.equal(r.output!.detail, "rate_limited");
  // another recipient is unaffected
  assert.equal((await run(["flint", "--from", WD, "--kind", "resume", "--text", "go"], w.deps())).exit, 0);
});

test("--only-if-idle: busy recipient -> exit 4, nothing written or sent; idle/error recipients get it", async () => {
  const w = world();
  const outbox = () => w.ledger("x", "outbox", join(w.root, "state", "bot-dm", "workers", "ratelimit-watchdog"));
  // scrat is running
  let r = await run(["scrat", "--from", WD, "--kind", "resume", "--only-if-idle", "--text", "go"], w.deps());
  assert.equal(r.exit, 4);
  assert.equal(r.output!.status, "busy");
  assert.equal(r.output!.recipientStatus, "running");
  assert.equal(w.sent.length, 0);
  assert.deepEqual(outbox(), []);
  assert.deepEqual(w.ledger("scrat", "inbox"), []);
  // dry run predicts the same
  r = await run(["scrat", "--from", WD, "--kind", "resume", "--only-if-idle", "--dry-run", "--text", "go"], w.deps());
  assert.equal(r.exit, 4);
  assert.equal(r.output!.dryRun, true);
  // initializing counts as busy
  w.fresh.set("agent-bitzer", "initializing");
  assert.equal((await run(["bitzer", "--from", WD, "--kind", "resume", "--only-if-idle", "--text", "go"], w.deps())).exit, 4);
  // a failed last turn leaves Paseo status "error": not busy, so it is sent
  w.fresh.set("agent-bitzer", "error");
  r = await run(["bitzer", "--from", WD, "--kind", "resume", "--only-if-idle", "--text", "go"], w.deps());
  assert.equal(r.exit, 0, w.errs.join("\n"));
  assert.equal(r.output!.status, "started");
  assert.equal(w.sent.length, 1);
  // works for any kind, e.g. a bot's info
  w.fresh.delete("agent-bitzer");
  assert.equal((await w.as(FC, ["bitzer", "--only-if-idle", "--text", "fyi"])).exit, 0);
  assert.equal((await w.as(FC, ["scrat", "--only-if-idle", "--text", "fyi"])).exit, 4);
  // --only-if-idle and --interrupt contradict
  assert.equal((await w.as(FC, ["bitzer", "--only-if-idle", "--interrupt", "--text", "x"])).exit, 2);
});

test("--only-if-idle: status is read afresh just before sending, not taken from the agent list", async () => {
  const w = world();
  // the list says idle, but a turn has started since
  w.fresh.set("agent-flint", "running");
  const r = await run(["flint", "--from", WD, "--kind", "resume", "--only-if-idle", "--text", "go"], w.deps());
  assert.equal(r.exit, 4);
  assert.deepEqual(w.statusCalls, ["agent-flint"]);
  assert.equal(w.sent.length, 0);
  // without the flag, no fresh read and the DM steers in as before
  assert.equal((await run(["flint", "--from", WD, "--kind", "resume", "--text", "go"], w.deps())).exit, 0);
  assert.deepEqual(w.statusCalls, ["agent-flint"]);
});

test("--only-if-idle: a rule refusal still wins (exit 3, recorded) without reading status", async () => {
  const w = world();
  const r = await run(["scrat", "--from", "worker:wp9", "--kind", "resume", "--only-if-idle", "--text", "go"], w.deps());
  assert.equal(r.exit, 3);
  assert.deepEqual(w.statusCalls, []);
});

test("--help documents resume, --only-if-idle and exit 4", async () => {
  const w = world();
  await run(["--help"], { ...w.deps(), out: (l) => w.errs.push(l) });
  const help = w.errs.join("\n");
  assert.match(help, /--only-if-idle/);
  assert.match(help, /4 recipient busy with --only-if-idle/);
  assert.match(help, /--kind resume .* only\s+from worker:ratelimit-watchdog/s);
  assert.match(help, /pair limit does not apply to them/);
});

// ---- schedule senders: agents Paseo launched for a schedule (new-agent target) -----------------

const SCHED = "b9dc1d26";
const SCHED_SENDER = `worker:schedule.${SCHED}`;

/** A running schedule run in `cwd` (default bitzer's folder): its agent and the daemon's run record. */
function scheduled(w: ReturnType<typeof world>, opts: { id?: string; cwd?: string; runStatus?: string; targetType?: string; name?: string } = {}) {
  const id = opts.id ?? SCHED;
  const cwd = opts.cwd ?? join(w.bots, "bitzer");
  const agentId = `agent-run-${id}`;
  w.agents.push({
    id: agentId,
    status: "running",
    provider: "pi",
    cwd,
    labels: { "paseo.schedule-id": id, "paseo.schedule-run": `run-${id}` },
    archivedAt: null,
    updatedAt: null,
  });
  w.schedules.set(id, {
    id,
    name: opts.name ?? "x-library-daily-refresh",
    targetType: opts.targetType ?? "new-agent",
    cwd,
    runs: [
      { id: "run-old", status: "succeeded", agentId: "agent-old-run" },
      { id: `run-${id}`, status: opts.runStatus ?? "running", agentId },
    ],
  });
  return { PASEO_AGENT_ID: agentId };
}

test("schedule sender: a schedule's run reports to the bot that owns it; verified, labelled, recorded", async () => {
  const w = world();
  const env = scheduled(w);
  let r = await run(["bitzer", "--from", `schedule:${SCHED}`, "--kind", "info", "--file", "-"], w.deps(env));
  assert.equal(r.exit, 0, w.errs.join("\n"));
  const out = w.outs.at(-1);
  assert.equal(out.from, SCHED_SENDER);
  assert.equal(out.agentId, "agent-bitzer");
  const text = w.sent.at(-1)!.text;
  const envelope = DM_ENVELOPE_RE.exec(text)!;
  assert.deepEqual(envelope.slice(1, 7), [out.id, SCHED_SENDER, "bitzer", "info", "1", "-"]);
  // second line: who sent it; no reply hint (a schedule run cannot receive DMs)
  assert.equal(
    text.split("\n")[1],
    `(Report from a run of your Paseo schedule ${SCHED} "x-library-daily-refresh", verified by bot-dm, not from Sam. It cannot receive replies.)`,
  );
  assert.ok(text.endsWith("\nfrom stdin\nsecond line"));
  const inbox = w.ledger("bitzer", "inbox");
  assert.ok(inbox[0].type === "message" && inbox[0].from === SCHED_SENDER && inbox[0].from_agent_id === env.PASEO_AGENT_ID);
  assert.equal(inbox[0].expects_reply, false);
  const outPath = join(w.root, "state", "bot-dm", "workers", `schedule.${SCHED}`, "outbox.jsonl");
  const outbox = readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as DmRecord);
  assert.deepEqual(outbox.map((x) => (x.type === "status" ? x.status : x.type)), ["message", "queued", "started"]);
  // --kind report works too
  r = await run(["bitzer", "--from", `schedule:${SCHED}`, "--kind", "report", "--text", "done"], w.deps(env));
  assert.equal(r.exit, 0, w.errs.join("\n"));
});

test("schedule sender: owner is <root>/<bot> or a folder under <root>/<bot>-runs/; anything else is refused", async () => {
  const w = world();
  mkdirSync(join(w.bots, "flint-runs", "mail-summary"), { recursive: true });
  const env = scheduled(w, { cwd: join(w.bots, "flint-runs", "mail-summary") });
  assert.equal((await run(["flint", "--from", `schedule:${SCHED}`, "--kind", "report", "--text", "ok"], w.deps(env))).exit, 0, w.errs.join("\n"));
  // to a bot that does not own the schedule: refused by rule, recorded in the schedule's outbox
  const r = await run(["bitzer", "--from", `schedule:${SCHED}`, "--kind", "report", "--text", "nope"], w.deps(env));
  assert.equal(r.exit, 3);
  assert.equal(w.outs.at(-1).detail, "not_allowed");
  assert.match(w.outs.at(-1).reason, /schedule b9dc1d26 belongs to flint/);
  assert.equal(w.ledger("bitzer", "inbox").length, 0);
  // a schedule whose folder is not a bot's: no owner, usage error
  const w2 = world();
  const env2 = scheduled(w2, { cwd: "/tmp/elsewhere" });
  assert.equal((await run(["bitzer", "--from", `schedule:${SCHED}`, "--kind", "report", "--text", "x"], w2.deps(env2))).exit, 2);
  assert.match(w2.errs.join("\n"), /no owning bot/);
  // <root>/<x>-runs where <x> is not a bot: no owner either
  const w3 = world();
  const env3 = scheduled(w3, { cwd: join(w3.bots, "nobody-runs", "x") });
  assert.equal((await run(["bitzer", "--from", `schedule:${SCHED}`, "--kind", "report", "--text", "x"], w3.deps(env3))).exit, 2);
});

test("schedule sender: verified against the daemon's run record, never self-declared", async () => {
  const w = world();
  const env = scheduled(w);
  const send = (from: string, extra: NodeJS.ProcessEnv) =>
    run(["bitzer", "--from", from, "--kind", "report", "--text", "x"], w.deps(extra));
  // outside a Paseo agent: cannot be verified
  assert.equal((await send(`schedule:${SCHED}`, {})).exit, 2);
  assert.match(w.errs.at(-1)!, /only inside the Paseo agent a schedule launched/);
  // a bot's own chat claiming the schedule
  assert.equal((await send(`schedule:${SCHED}`, { PASEO_AGENT_ID: "agent-bitzer" })).exit, 2);
  assert.match(w.errs.at(-1)!, /not the running agent of schedule b9dc1d26/);
  // a label is not enough: an agent that only carries the schedule's labels
  w.agents.push({ id: "agent-fake", status: "running", provider: "pi", cwd: join(w.bots, "bitzer"), labels: { "paseo.schedule-id": SCHED }, archivedAt: null, updatedAt: null });
  assert.equal((await send(`schedule:${SCHED}`, { PASEO_AGENT_ID: "agent-fake" })).exit, 2);
  // a past run's agent
  assert.equal((await send(`schedule:${SCHED}`, { PASEO_AGENT_ID: "agent-old-run" })).exit, 2);
  // unknown schedule, malformed id
  assert.equal((await send("schedule:deadbeef", env)).exit, 2);
  assert.match(w.errs.at(-1)!, /no Paseo schedule deadbeef/);
  assert.equal((await send("schedule:../x", env)).exit, 2);
  // herdr workers cannot borrow the schedule namespace
  assert.equal((await send(SCHED_SENDER, {})).exit, 2);
  assert.match(w.errs.at(-1)!, /reserved for schedule runs/);
  assert.equal(w.sent.length, 0);
  // finished run: no longer verified
  const w2 = world();
  const env2 = scheduled(w2, { runStatus: "succeeded" });
  assert.equal((await run(["bitzer", "--from", `schedule:${SCHED}`, "--kind", "report", "--text", "x"], w2.deps(env2))).exit, 2);
  // a schedule that targets an existing agent (a bot's own chat) sends as that bot, not as a schedule
  const w3 = world();
  const env3 = scheduled(w3, { targetType: "agent" });
  assert.equal((await run(["bitzer", "--from", `schedule:${SCHED}`, "--kind", "report", "--text", "x"], w3.deps(env3))).exit, 2);
});

test("schedule sender: only --kind report or info, no reply expected", async () => {
  const w = world();
  const env = scheduled(w);
  for (const kind of ["request", "reply", "escalate", "resume"]) {
    const r = await run(["bitzer", "--from", `schedule:${SCHED}`, "--kind", kind, "--text", "x"], w.deps(env));
    assert.equal(r.exit, 2, kind);
  }
  assert.match(w.errs.at(-1)!, /schedule senders may only send --kind report or --kind info/);
  assert.equal((await run(["bitzer", "--from", `schedule:${SCHED}`, "--kind", "info", "--expects-reply", "--text", "x"], w.deps(env))).exit, 2);
  assert.equal(w.sent.length, 0);
});

test("schedule sender: without --from, a schedule run is told the exact --from to use", async () => {
  const w = world();
  const env = scheduled(w);
  const r = await run(["bitzer", "--kind", "info", "--text", "x"], w.deps(env));
  assert.equal(r.exit, 2);
  assert.match(w.errs.at(-1)!, /--from schedule:b9dc1d26/);
});

test("schedule sender: pair cap (10 per 30 min) and the 20/hour rate apply", async () => {
  const w = world();
  const env = scheduled(w);
  for (let i = 0; i < 10; i++) {
    assert.equal((await run(["bitzer", "--from", `schedule:${SCHED}`, "--kind", "info", "--text", `t${i}`], w.deps(env))).exit, 0, w.errs.join("\n"));
  }
  const r = await run(["bitzer", "--from", `schedule:${SCHED}`, "--kind", "info", "--text", "t10"], w.deps(env));
  assert.equal(r.exit, 3);
  assert.equal(w.outs.at(-1).detail, "hop_cap");
});

test("--help documents --from schedule:<id>", async () => {
  const w = world();
  await run(["--help"], { ...w.deps(), out: (l) => w.errs.push(l) });
  assert.match(w.errs.join("\n"), /--from schedule:<id>/);
});

test("info from a system sender (worker:stall-watch): delivered with the system-nudge line, no reply hint; plain workers still refused", async () => {
  const w = world();
  const SW = "worker:stall-watch";
  const r = await run(["bitzer", "--from", SW, "--kind", "info", "--text", "Your herdr worker x stopped on an error."], w.deps());
  assert.equal(r.exit, 0, w.errs.join("\n"));
  const lines = w.sent.at(-1)!.text.split("\n");
  assert.deepEqual(DM_ENVELOPE_RE.exec(lines[0]!)!.slice(2, 7), [SW, "bitzer", "info", "1", "-"]);
  assert.equal(lines[1], `(System nudge from ${SW}, sent automatically: this is not a message from Sam. No reply expected.)`);
  assert.equal(lines.slice(2).join("\n"), "Your herdr worker x stopped on an error.");
  assert.equal(w.outs.at(-1).expectsReply, false);
  // a retry with the same --id is a duplicate, not a second DM
  const id = w.outs.at(-1).id;
  const sentBefore = w.sent.length;
  const again = await run(["bitzer", "--from", SW, "--kind", "info", "--id", id, "--text", "Your herdr worker x stopped on an error."], w.deps());
  assert.equal(again.exit, 0);
  assert.equal(again.output!.duplicate, true);
  assert.equal(w.sent.length, sentBefore);
  // a system sender's report keeps no nudge line
  assert.equal((await run(["bitzer", "--from", SW, "--kind", "report", "--text", "fyi"], w.deps())).exit, 0);
  assert.ok(!w.sent.at(-1)!.text.includes("System nudge"));
  // plain workers may not send info (usage error before any rule)
  assert.equal((await run(["bitzer", "--from", "worker:wp9", "--kind", "info", "--text", "hi"], w.deps())).exit, 2);
});
