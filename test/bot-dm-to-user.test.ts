import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLedgerLine, type DmRecord } from "../shared/dm-schema.ts";
import { run, USAGE, type Deps } from "../bot-dm/cli.ts";
import type { AgentInfo, PaseoPort } from "../bot-dm/paseo.ts";
import { checkToUser, slotText } from "../bot-dm/to-user.ts";
import { httpPush, type PushOutcome, type PushPort, type PushRequest, type PushStatus } from "../bot-dm/push.ts";
import { DmsService } from "../server/dms.ts";

export const TEST_SETTINGS = { user: { name: "Sam", aliases: ["sam"] }, escalation: "the-fat-controller" };

const FC = "the-fat-controller";

function world() {
  const root = mkdtempSync(join(tmpdir(), "botdm-sam-"));
  const bots = join(root, "bots");
  // Host settings as on a configured host: the user's name, an alias, the escalation bot.
  mkdirSync(bots, { recursive: true });
  writeFileSync(join(bots, ".settings.json"), JSON.stringify(TEST_SETTINGS));
  const agents: AgentInfo[] = [];
  for (const name of [FC, "bitzer"]) {
    mkdirSync(join(bots, name), { recursive: true });
    writeFileSync(join(bots, name, ".optchat-profile"), `${name}\n`);
    agents.push({ id: `agent-${name}`, status: "idle", provider: "optchat", cwd: join(bots, name), workspaceId: `ws-${name}`, labels: { bot: name }, archivedAt: null, updatedAt: null });
  }
  writeFileSync(join(bots, "bitzer", ".bot.json"), JSON.stringify({ name: "Bitzer" }));
  const sentToChats: string[] = [];
  const paseo: PaseoPort = {
    cli: { version: "0.11.1", pinned: true, dist: "/fake" },
    listAgents: async () => agents,
    agentStatus: async () => "idle",
    inspectSchedule: async () => null,
    send: async (agentId) => {
      sentToChats.push(agentId);
    },
    close: async () => {},
  };
  const pushes: PushRequest[] = [];
  let next: PushOutcome = { kind: "sent", sent: 1, nextSlotAt: "2026-10-10T08:10:00.000Z" };
  let status: PushStatus = { reachable: true, configured: true, devices: 1, nextSlotAt: null, rateWindowSeconds: 600, perSender: false };
  const statusAsked: Array<string | undefined> = [];
  const push: PushPort = {
    status: async (sender?: string) => {
      statusAsked.push(sender);
      return status;
    },
    notify: async (r) => {
      pushes.push(r);
      return next;
    },
  };
  const outs: any[] = [];
  const errs: string[] = [];
  let clock = Date.parse("2026-10-10T08:00:00.000Z");
  const deps = (env: NodeJS.ProcessEnv = {}): Deps => ({
    env: { PASEO_BOTS_ROOT: bots, XDG_STATE_HOME: join(root, "state"), PASEO_APNS_DIR: join(root, "no-apns"), ...env },
    connect: async () => paseo,
    push: () => push,
    now: () => new Date((clock += 1000)),
    readStdin: async () => "",
    out: (l) => outs.push(JSON.parse(l)),
    err: (l) => errs.push(l),
  });
  const as = (bot: string, argv: string[]) => run(argv, deps({ PASEO_AGENT_ID: `agent-${bot}` }));
  const ledger = (dir: string, file: "inbox" | "outbox"): DmRecord[] => {
    const path = join(dir, `${file}.jsonl`);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => {
      const p = parseLedgerLine(l);
      assert.ok(p.ok, l);
      return p.record;
    });
  };
  return {
    root,
    bots,
    pushes,
    sentToChats,
    outs,
    errs,
    deps,
    as,
    ledger,
    statusAsked,
    slotsPath: join(root, "state", "bot-dm", "push-slots.jsonl"),
    setNext: (o: PushOutcome) => (next = o),
    setStatus: (s: PushStatus) => (status = s),
  };
}

test("bot-dm sam: pushes with the bot's display name, records the DM in the sender's outbox as pushed", async () => {
  const w = world();
  const r = await w.as("bitzer", ["user", "--text", "OAuth for the proxy expires at 10:00.\nRe-login needed."]);
  assert.equal(r.exit, 0, w.errs.join("\n"));
  assert.equal(w.sentToChats.length, 0, "nothing goes into any chat");
  assert.equal(w.pushes.length, 1);
  const p = w.pushes[0]!;
  assert.equal(p.sender, "bitzer");
  assert.equal(p.title, "Bitzer");
  assert.equal(p.body, "OAuth for the proxy expires at 10:00.\nRe-login needed.");
  const out = w.outs.at(-1);
  assert.deepEqual(p.data, { kind: "bot-dm", from: "bitzer", dmId: out.id, threadId: out.id, agentId: "agent-bitzer", workspaceId: "ws-bitzer" });
  assert.equal(out.status, "pushed");
  assert.equal(out.to, "user");
  assert.equal(out.nextSlotAt, "2026-10-10T08:10:00.000Z");
  const outbox = w.ledger(join(w.bots, "bitzer", "dm"), "outbox");
  assert.deepEqual(outbox.map((x) => (x.type === "status" ? x.status : x.type)), ["message", "queued", "pushed"]);
  const m = outbox[0]!;
  assert.ok(m.type === "message");
  assert.equal(m.to, "user");
  assert.equal(m.kind, "info");
  assert.equal(m.thread, m.id);
  assert.equal(m.to_agent_id, null);
  assert.equal(m.subject, "OAuth for the proxy expires at 10:00.");
  assert.equal(existsSync(join(w.bots, "user")), false, "no ledger dir for sam");
});

test("the DM shows in the sender's DMs tab with Sam as the party, status pushed", async () => {
  const w = world();
  await w.as("bitzer", ["user", "--kind", "request", "--text", "Approve the key rotation?"]);
  const dms = new DmsService({ root: w.bots, openChat: async () => ({ agentId: "x" }), workersRoot: join(w.root, "state", "bot-dm", "workers") });
  const { threads } = await dms.threads("bitzer");
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0]!.parties, ["user"]);
  assert.equal(threads[0]!.last_status, "pushed");
  assert.equal(threads[0]!.awaiting_reply, true, "a request to Sam expects his reply");
});

test("rate limited: refused (exit 3) with the next slot, recorded as refused, not queued", async () => {
  const w = world();
  w.setNext({ kind: "rate_limited", retryAt: "2026-10-10T08:07:00.000Z", retryInSeconds: 418, message: "x" });
  const r = await w.as("bitzer", ["user", "--text", "second push"]);
  assert.equal(r.exit, 3);
  const out = w.outs.at(-1);
  assert.equal(out.status, "refused");
  assert.equal(out.detail, "rate_limited");
  assert.equal(out.retryAt, "2026-10-10T08:07:00.000Z");
  assert.match(out.reason, /one push per 10 minutes from each bot/);
  assert.doesNotMatch(out.reason, /across all bots/);
  assert.match(out.reason, /Your next slot opens at 08:07 UTC \(in 7 min\)/);
  assert.match(out.advice, /Not queued/);
  assert.match(out.advice, /one system DM when your slot reopens/);
  assert.match(w.errs.at(-1)!, /^bot-dm: refused \(rate_limited\): .*08:07 UTC/);
  const outbox = w.ledger(join(w.bots, "bitzer", "dm"), "outbox");
  assert.deepEqual(outbox.map((x) => (x.type === "status" ? `${x.status}:${x.detail}` : x.type)), ["message", "queued:null", "refused:rate_limited"]);
});

test("no device and add-on missing: clear refusals", async () => {
  const w = world();
  w.setNext({ kind: "no_device", message: "x" });
  assert.equal((await w.as("bitzer", ["user", "--text", "a"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "no_device");
  assert.match(w.outs.at(-1).reason, /no phone is registered/);
  w.setNext({ kind: "unavailable", message: "the paseo-apns add-on is not running (nothing listens on http://127.0.0.1:6790; check `paseo plugin ls`)" });
  assert.equal((await w.as("bitzer", ["user", "--text", "b"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "push_unavailable");
  assert.match(w.outs.at(-1).reason, /not running/);
});

test("APNs failure: exit 1, recorded failed, retry with --id pushes once more without a second message record", async () => {
  const w = world();
  w.setNext({ kind: "failed", message: "apns_failed: …aaaaaaaa failed 503" });
  assert.equal((await w.as("bitzer", ["user", "--text", "hello"])).exit, 1);
  const id = w.outs.at(-1).id;
  w.setNext({ kind: "sent", sent: 1, nextSlotAt: null });
  assert.equal((await w.as("bitzer", ["user", "--id", id, "--text", "hello"])).exit, 0);
  assert.equal(w.outs.at(-1).retry, true);
  assert.equal((await w.as("bitzer", ["user", "--id", id, "--text", "hello"])).exit, 0);
  assert.equal(w.outs.at(-1).duplicate, true);
  assert.equal(w.pushes.length, 2);
  const outbox = w.ledger(join(w.bots, "bitzer", "dm"), "outbox");
  assert.equal(outbox.filter((x) => x.type === "message").length, 1);
});

test("rules: kinds, flags and senders", async () => {
  const w = world();
  for (const kind of ["reply", "escalate", "resume"]) {
    const r = await w.as("bitzer", ["user", "--kind", kind, "--text", "x"]);
    assert.notEqual(r.exit, 0, kind);
  }
  assert.equal((await w.as("bitzer", ["user", "--re", "01K6ZQ5V8MAAAAAAAAAAAAAAAA", "--text", "x"])).exit, 2);
  assert.equal((await w.as("bitzer", ["user", "--interrupt", "--text", "x"])).exit, 2);
  assert.equal((await w.as("bitzer", ["user", "--only-if-idle", "--text", "x"])).exit, 2);
  assert.equal(w.pushes.length, 0);
  // worker report goes; worker info does not; system senders never push
  assert.equal((await run(["user", "--from", "worker:oauth-watch", "--kind", "report", "--text", "[oauth-watch] expired"], w.deps())).exit, 0);
  assert.equal(w.pushes.at(-1)!.title, "oauth-watch (worker)");
  assert.equal(w.pushes.at(-1)!.data!.agentId, undefined);
  assert.equal((await run(["user", "--from", "worker:stall-watch", "--kind", "info", "--text", "x"], w.deps())).exit, 3);
  assert.equal(w.pushes.length, 1);
  assert.deepEqual(checkToUser("bitzer", "info"), null);
  assert.deepEqual(checkToUser("bitzer", "request"), null);
  assert.equal(checkToUser("worker:wp1", "info")?.code, "not_allowed");
});

test("--dry-run: predicts from /status and writes nothing", async () => {
  const w = world();
  let r = await w.as("bitzer", ["user", "--dry-run", "--text", "x"]);
  assert.equal(r.exit, 0);
  assert.equal(w.outs.at(-1).dryRun, true);
  w.setStatus({ reachable: true, configured: true, devices: 1, nextSlotAt: "2026-10-10T08:09:00.000Z", rateWindowSeconds: 600, perSender: false });
  r = await w.as("bitzer", ["user", "--dry-run", "--text", "x"]);
  assert.equal(r.exit, 3);
  assert.equal(w.outs.at(-1).detail, "rate_limited");
  assert.deepEqual(w.statusAsked, ["bitzer", "bitzer"], "dry run asks for the bot's own slot");
  assert.equal(existsSync(w.slotsPath), false, "a dry-run refusal leaves no expiry notice");
  w.setStatus({ reachable: true, configured: true, devices: 0, nextSlotAt: null, rateWindowSeconds: 600, perSender: false });
  assert.equal((await w.as("bitzer", ["user", "--dry-run", "--text", "x"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "no_device");
  w.setStatus({ reachable: false, message: "not running" });
  assert.equal((await w.as("bitzer", ["user", "--dry-run", "--text", "x"])).exit, 3);
  assert.equal(w.outs.at(-1).detail, "push_unavailable");
  assert.equal(w.pushes.length, 0);
  assert.equal(existsSync(join(w.bots, "bitzer", "dm", "outbox.jsonl")), false);
});

test("--help explains sam", () => {
  assert.match(USAGE, /bot-dm user --text/);
  assert.match(USAGE, /One push per 10 minutes from each bot/);
  assert.doesNotMatch(USAGE, /across all bots/);
});

test("slotText", () => {
  assert.equal(slotText("2026-10-10T08:07:00.000Z", new Date("2026-10-10T08:00:30Z")), "08:07 UTC (in 7 min)");
});

// ---- httpPush against a stand-in for the paseo-apns endpoint ---------------------------------

async function fakeAddon(t: { after(fn: () => unknown): void }, reply: (path: string, body: any) => { status: number; body: unknown }) {
  const dir = mkdtempSync(join(tmpdir(), "apns-dir-"));
  writeFileSync(join(dir, "notify-token"), "t0ken".repeat(8) + "\n", { mode: 0o600 });
  const seen: Array<{ path: string; auth: string | undefined; body: any }> = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = data ? JSON.parse(data) : null;
      seen.push({ path: req.url!, auth: req.headers.authorization, body });
      const r = reply(req.url!, body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(dir, "config.json"), JSON.stringify({ port }));
  t.after(() => server.close());
  return { dir, seen, port };
}

test("httpPush: reads port and token from the add-on's dir, maps 200/429/409/503", async (t) => {
  const answers: Array<{ status: number; body: unknown }> = [
    { status: 200, body: { ok: true, code: "sent", sent: 2, failed: 0, nextSlotAt: "2026-10-10T08:10:00.000Z" } },
    { status: 429, body: { ok: false, code: "rate_limited", retryAt: "2026-10-10T08:10:00.000Z", retryInSeconds: 300, message: "m" } },
    { status: 409, body: { ok: false, code: "no_device", message: "none" } },
    { status: 503, body: { ok: false, code: "not_configured", message: "paseo-apns is not configured: config.json missing" } },
    { status: 502, body: { ok: false, code: "apns_failed", message: "APNs accepted it for no device" } },
  ];
  const a = await fakeAddon(t, () => answers.shift()!);
  const push = httpPush({ PASEO_APNS_DIR: a.dir });
  const req = { sender: "bitzer", title: "Bitzer", body: "hi" };
  assert.deepEqual(await push.notify(req), { kind: "sent", sent: 2, nextSlotAt: "2026-10-10T08:10:00.000Z" });
  assert.equal(a.seen[0]!.path, "/notify");
  assert.equal(a.seen[0]!.auth, `Bearer ${"t0ken".repeat(8)}`);
  assert.deepEqual(a.seen[0]!.body, req);
  assert.deepEqual(await push.notify(req), { kind: "rate_limited", retryAt: "2026-10-10T08:10:00.000Z", retryInSeconds: 300, message: "m" });
  assert.equal((await push.notify(req)).kind, "no_device");
  assert.equal((await push.notify(req)).kind, "unavailable");
  assert.deepEqual(await push.notify(req), { kind: "failed", message: "apns_failed: APNs accepted it for no device" });
});

test("httpPush: no token file or nothing listening -> unavailable with a clear reason", async (t) => {
  const empty = mkdtempSync(join(tmpdir(), "apns-none-"));
  const none = await httpPush({ PASEO_APNS_DIR: empty }).notify({ sender: "b", title: "B", body: "x" });
  assert.equal(none.kind, "unavailable");
  assert.match((none as { message: string }).message, /not set up on this machine/);
  const a = await fakeAddon(t, () => ({ status: 200, body: {} }));
  // a port nothing listens on: bind one, then close it
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const closed = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  writeFileSync(join(a.dir, "config.json"), JSON.stringify({ port: closed }));
  const down = await httpPush({ PASEO_APNS_DIR: a.dir }).notify({ sender: "b", title: "B", body: "x" });
  assert.equal(down.kind, "unavailable");
  assert.match((down as { message: string }).message, new RegExp(`not running .*127\\.0\\.0\\.1:${closed}`));
});

test("httpPush.status", async (t) => {
  const a = await fakeAddon(t, () => ({ status: 200, body: { ok: true, configured: true, devices: 1, nextSlotAt: null, rateWindowSeconds: 600, perSender: false } }));
  assert.deepEqual(await httpPush({ PASEO_APNS_DIR: a.dir }).status(), {
    reachable: true,
    configured: true,
    devices: 1,
    nextSlotAt: null,
    rateWindowSeconds: 600,
    perSender: false,
  });
  assert.equal(a.seen[0]!.path, "/status");
  await httpPush({ PASEO_APNS_DIR: a.dir }).status("worker:w1");
  assert.equal(a.seen[1]!.path, "/status?sender=worker%3Aw1");
});

// ---- per-bot limit and the slot-open notice (push-per-bot) -----------------------------------

test("rate limited bot: records one pending slot notice (bot, refusal time, retryAt); other refusals do not", async () => {
  const w = world();
  w.setNext({ kind: "rate_limited", retryAt: "2026-10-10T08:07:00.000Z", retryInSeconds: 418, message: "x" });
  await w.as("bitzer", ["user", "--text", "second push"]);
  const lines = readFileSync(w.slotsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "refused");
  assert.equal(lines[0].bot, "bitzer");
  assert.equal(lines[0].retryAt, "2026-10-10T08:07:00.000Z");
  assert.equal(lines[0].dm, w.outs.at(-1).id);
  w.setNext({ kind: "no_device", message: "x" });
  await w.as("bitzer", ["user", "--text", "third"]);
  w.setNext({ kind: "rate_limited", retryAt: "2026-10-10T08:07:00.000Z", retryInSeconds: 418, message: "x" });
  await run(["user", "--from", "worker:oauth-watch", "--kind", "report", "--text", "r"], w.deps());
  assert.equal(readFileSync(w.slotsPath, "utf8").trim().split("\n").length, 1, "no_device and worker refusals add no notice");
});

test("worker push: charged to its launching bot (launch registry), else its own slot", async () => {
  const w = world();
  const registry = join(w.root, "state", "bot-dm", "launches.jsonl");
  mkdirSync(join(w.root, "state", "bot-dm"), { recursive: true });
  writeFileSync(
    registry,
    [
      { v: 1, type: "launch", ts: "2026-10-10T07:00:00.000Z", worker: "fix-x", pane: "w1:p1", agent: "agent-bitzer", bot: null },
      { v: 1, type: "launch", ts: "2026-10-10T07:01:00.000Z", worker: "fix-y", pane: "w1:p2", agent: null, bot: FC },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  assert.equal((await run(["user", "--from", "worker:fix-x", "--kind", "report", "--text", "r"], w.deps())).exit, 0);
  assert.equal(w.pushes.at(-1)!.sender, "worker:fix-x");
  assert.equal(w.pushes.at(-1)!.limitKey, "bitzer", "launcher found by its agent id");
  await run(["user", "--from", "worker:fix-y", "--kind", "report", "--text", "r"], w.deps());
  assert.equal(w.pushes.at(-1)!.limitKey, FC, "launcher's bot field wins");
  await run(["user", "--from", "worker:loose", "--kind", "report", "--text", "r"], w.deps());
  assert.equal(w.pushes.at(-1)!.limitKey, undefined, "unregistered worker: its own slot");
  await w.as("bitzer", ["user", "--text", "x"]);
  assert.equal(w.pushes.at(-1)!.limitKey, undefined, "a bot uses its own slot");
  w.setNext({ kind: "rate_limited", retryAt: "2026-10-10T08:07:00.000Z", retryInSeconds: 418, message: "x" });
  await run(["user", "--from", "worker:fix-x", "--kind", "report", "--text", "r2"], w.deps());
  assert.match(w.outs.at(-1).reason, /workers count towards the bot that launched them \(bitzer\)/);
  w.statusAsked.length = 0;
  await run(["user", "--dry-run", "--from", "worker:fix-x", "--kind", "report", "--text", "r3"], w.deps());
  assert.deepEqual(w.statusAsked, ["bitzer"]);
});

test("httpPush.notify passes limitKey through", async (t) => {
  const a = await fakeAddon(t, () => ({ status: 200, body: { ok: true, code: "sent", sent: 1 } }));
  await httpPush({ PASEO_APNS_DIR: a.dir }).notify({ sender: "worker:w", limitKey: "bitzer", title: "w", body: "x" });
  assert.equal(a.seen[0]!.body.limitKey, "bitzer");
});

test("alias: `bot-dm sam` on a host whose settings list that alias reaches the user; recorded as user", async () => {
  const w = world();
  const r = await w.as("bitzer", ["sam", "--text", "Done."]);
  assert.equal(r.exit, 0, w.errs.join("\n"));
  assert.equal(w.outs.at(-1).to, "user");
  assert.equal(w.pushes.length, 1);
});

test("no settings file: `bot-dm sam` is just an unknown bot; `bot-dm user` still pushes", async () => {
  const w = world();
  rmSync(join(w.bots, ".settings.json"));
  const r = await w.as("bitzer", ["sam", "--text", "Done."]);
  assert.notEqual(r.exit, 0);
  assert.equal(w.pushes.length, 0);
  const ok = await w.as("bitzer", ["user", "--text", "Done."]);
  assert.equal(ok.exit, 0, w.errs.join("\n"));
  assert.equal(w.pushes.length, 1);
});
