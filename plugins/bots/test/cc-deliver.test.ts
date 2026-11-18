// Bots on Claude Code: every message is typed into the bot's TUI with `herdr agent prompt` (server/cc/deliver.ts),
// behind an idle gate, with an ack from the inbox mod's prompt.submit hook. The TUI and herdr are played by FakeTui.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CcEngine, CcHost, type CcEvent } from "../server/cc/engine";
import { guardLeading, isBotTraffic, MAX_TYPED_BYTES, normalise, sameText, transcriptHas, typedText, type CcDelivery } from "../server/cc/deliver";
import { CcLauncher, clearKeys } from "../server/cc/launch";
import { createCcProvider } from "../server/cc/provider";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

const TMP = mkdtempSync(join(tmpdir(), "cc-deliver-"));
const open: CcEngine[] = [];
after(async () => {
  for (const e of open) await e.close();
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(5);
  }
}
const q = new URLSearchParams();

/**
 * Claude Code's TUI under herdr: `state` as herdr reports it; a typed text starts a turn and, unless `ack` is off,
 * the inbox mod's hook reports it (POST /turn typed). herdr refuses a blocked agent before typing.
 */
class FakeTui implements CcDelivery {
  st = "idle";
  typed: string[] = [];
  cleared = 0;
  refuse: string[] = [];
  ack = true;
  transcript: string | null = null;
  /** What the TUI makes of a typed text (Claude Code keeps it; a test may change it). */
  shown = (t: string) => t;
  engine!: CcEngine;
  async state() {
    return this.st;
  }
  async sessionFile() {
    return this.transcript;
  }
  async clear() {
    this.cleared++;
  }
  async prompt(text: string) {
    const code = this.refuse.shift() ?? (this.st === "blocked" ? "agent_blocked" : this.st === "gone" ? "agent_not_found" : "");
    if (code) return { ok: false as const, code };
    this.typed.push(text);
    // Not acked: as if the Enter was lost (the text sits in the composer, the TUI idle).
    if (!this.ack) return { ok: true as const };
    this.st = "working";
    setTimeout(() => void this.engine.handle("POST", "/turn", q, { running: true, typed: true, text: this.shown(text), origin: "composer" }), 3);
    return { ok: true as const };
  }
  /** The turn ends (answered: the view mod logs it at the compaction that follows). */
  async finish(answered = true) {
    this.st = "done";
    await this.engine.handle("POST", "/turn", q, { running: false, answered, reason: answered ? "answer" : "aborted" });
  }
  /** The view mod's compaction: logs the turn's user text (as Claude Code kept it) and an answer. */
  async compact(user: string) {
    await this.engine.handle("POST", "/append", q, { messages: [{ kind: "user", text: user.trim() }, { kind: "talk", text: "ok" }] });
  }
}

let n = 0;
async function setup(opts: { ackMs?: number; maxTyped?: number } = {}) {
  const tui = new FakeTui();
  const e = await CcEngine.open(`b${++n}`, join(TMP, `p${n}`), { delivery: tui, tickMs: 5, ackMs: opts.ackMs ?? 150, maxTyped: opts.maxTyped });
  tui.engine = e;
  open.push(e);
  const events: CcEvent[] = [];
  e.onEvent((ev) => events.push(ev));
  const started = () => events.flatMap((ev) => (ev.type === "started" ? [ev.id] : []));
  return { e, tui, events, started, dir: join(TMP, `p${n}`) };
}

describe("typed text: normalised and guarded", () => {
  it("normalises as the TUI would: CR/CRLF to LF, tab to 4 spaces, NFC, no control characters", () => {
    assert.equal(normalise("a\r\nb\rc"), "a\nb\nc");
    assert.equal(normalise("x\ty"), "x    y");
    assert.equal(normalise("cafe\u0301"), "caf\u00e9");
    assert.equal(normalise("red \u001b[31mtext\u001b[0m ^C\u0003 \u0015x\u007f\u0085"), "red [31mtext[0m ^C x");
    const kept = "emoji 🦖, 中文, עברית, “quotes”, trailing \\\n\n  indented";
    assert.equal(normalise(kept), kept);
  });

  it("a leading / (command), ! (bash mode), - (herdr option) or other punctuation gets a space; labels and words do not", () => {
    assert.equal(guardLeading("/compact now"), " /compact now");
    assert.equal(guardLeading("!rm -rf x"), " !rm -rf x");
    assert.equal(guardLeading("--wait"), " --wait");
    for (const c of ["#", "&", "@", "?", "*", ">", "~", "$", "%", ":", "\\", "^", "|", "{", "]"]) assert.equal(guardLeading(`${c}x`), ` ${c}x`, c);
    assert.equal(guardLeading("\n  /help"), " /help"); // trimmed first
    for (const t of ["[dm 01J from ada] hi", "[room g to kit msgs=1 hop=0]", "(aside)", '"quoted"', "hello", "Ünïcode", "42"]) assert.equal(guardLeading(t), t);
  });

  it("the label prefix survives typing, the body is normalised; bot traffic is told by its label", () => {
    const dm = "[dm 01JABC from ada re 01JXYZ hop=1]\nsubject: x\n\tindented\r\nbody";
    const t = typedText(dm, "i1", join(TMP, "spill"));
    assert.ok(t.startsWith("[dm 01JABC from ada re 01JXYZ hop=1]\n"));
    assert.equal(t, "[dm 01JABC from ada re 01JXYZ hop=1]\nsubject: x\n    indented\nbody");
    const room = "[room alarm-clock task from user msg 01M0001]\ntask: write";
    assert.equal(typedText(room, "i2", join(TMP, "spill")), room);
    assert.ok(isBotTraffic(dm) && isBotTraffic(room));
    assert.ok(!isBotTraffic("hi there") && !isBotTraffic("about [dm 1 from x]"));
  });

  it("a text over the limit goes in a file; the typed pointer keeps the label", () => {
    const body = "[dm 01J from ada]\n" + "x".repeat(MAX_TYPED_BYTES + 10);
    const t = typedText(body, "big/1", join(TMP, "spill"));
    assert.ok(Buffer.byteLength(t) < 1000);
    const file = /it is in (\S+)\. Read/.exec(t)![1]!;
    assert.match(t, /^\[dm 01J from ada\]\n\(This message is \d+ bytes, too long to type/);
    assert.equal(readFileSync(file, "utf8"), body);
  });

  it("an ack matches the typed text (also behind a new session's view); the transcript is searched from the typing", () => {
    assert.ok(sameText(" /compact now", " /compact now"));
    assert.ok(sameText("<chat>\nview\n</chat>\n\nhello", "hello"));
    assert.ok(!sameText("hello there", "hello"));
    const f = join(TMP, "t.jsonl");
    const at = (ms: number) => new Date(ms).toISOString();
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "user", timestamp: at(1000), message: { role: "user", content: "old hello" } }),
        JSON.stringify({ type: "user", timestamp: at(60_000), message: { role: "user", content: [{ type: "text", text: "[dm 1 from a]\n    hi" }] } }),
        // As Claude Code 2.1.323 writes a message typed into a running turn.
        JSON.stringify({ type: "attachment", timestamp: at(61_000), attachment: { type: "queued_command", prompt: "[dm 2 from a] mid", commandMode: "prompt", origin: { kind: "human" } } }),
        "not json",
      ].join("\n"),
    );
    assert.equal(transcriptHas(f, "[dm 1 from a]\n\thi", 59_000), "user");
    assert.equal(transcriptHas(f, "[dm 2 from a] mid", 59_000), "queued");
    assert.equal(transcriptHas(f, "old hello", 59_000), null); // before the typing
    assert.equal(transcriptHas(join(TMP, "none.jsonl"), "x", 0), null);
  });
});

describe("delivery: typed behind the idle gate, acked by the hook", () => {
  it("an idle TUI gets the item typed once; the hook's ack starts the turn with the item's id (no second 'typed' row)", async () => {
    const { e, tui, started, dir } = await setup();
    e.enqueue("hello there", "m1");
    await until(() => started().length === 1);
    assert.deepEqual(tui.typed, ["hello there"]);
    assert.deepEqual(started(), ["m1"]);
    await tui.finish();
    await tui.compact("hello there");
    assert.equal(e.memory.root[0]!.receipt, "m1");
    assert.equal(e.queued, 0);
    await tick(50);
    assert.equal(tui.typed.length, 1);
    const log = readFileSync(join(dir, "cc-delivery.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).ev);
    assert.deepEqual(log, ["queued", "typed", "acked"]);
  });

  it("never types mid-turn or before the turn's compaction; one item at a time", async () => {
    const { e, tui, started } = await setup();
    e.enqueue("first", "a");
    e.enqueue("second", "b");
    await until(() => started().length === 1);
    await tick(60);
    assert.deepEqual(tui.typed, ["first"]); // b waits for a's turn
    await tui.finish(true);
    await tick(60);
    assert.deepEqual(tui.typed, ["first"]); // answered: waits for the compaction
    await tui.compact("first");
    await until(() => started().length === 2);
    assert.deepEqual(tui.typed, ["first", "second"]);
  });

  it("a turn the TUI started itself (typed in the terminal, a task notification) holds the inbox; herdr 'working' too", async () => {
    const { e, tui, started } = await setup();
    await e.handle("POST", "/turn", q, { running: true, typed: true, text: "<task-notification>x</task-notification>", origin: "task-notification" });
    e.enqueue("[dm 1 from ada] hi", "d1");
    await tick(60);
    assert.deepEqual(tui.typed, []);
    tui.st = "working"; // the engine thinks the turn ended, herdr still sees it working
    await tui.finish(false);
    await tui.compact("<task-notification>x</task-notification>"); // the trigger mod's compaction, after every turn
    tui.st = "working";
    await tick(60);
    assert.deepEqual(tui.typed, []);
    tui.st = "idle";
    await until(() => started().includes("d1"), 3000);
    assert.deepEqual(tui.typed, ["[dm 1 from ada] hi"]);
  });

  it("never types into a permission prompt or a question: blocked waits (and says so), then the item goes", async () => {
    const { e, tui, events, started } = await setup();
    tui.st = "blocked";
    e.enqueue("do it", "k1");
    await tick(80);
    assert.deepEqual(tui.typed, []);
    assert.equal(events.filter((ev) => ev.type === "blocked").length, 1);
    tui.st = "idle";
    await until(() => started().includes("k1"), 4000);
    assert.deepEqual(tui.typed, ["do it"]);
  });

  it("herdr refusing (not ready, blocked in the race) types nothing: the item waits and goes once", async () => {
    const { e, tui, started } = await setup();
    tui.refuse = ["agent_not_ready", "agent_blocked"];
    e.enqueue("boot msg", "r1");
    await until(() => started().includes("r1"), 6000);
    assert.deepEqual(tui.typed, ["boot msg"]);
  });

  it("a leading / or ! is typed with a space (plain text, never a command or bash); the receipt still matches", async () => {
    const { e, tui, started } = await setup();
    e.enqueue("/compact everything", "s1");
    await until(() => started().length === 1);
    assert.deepEqual(tui.typed, [" /compact everything"]);
    await tui.finish();
    await tui.compact(" /compact everything");
    assert.equal(e.memory.root[0]!.receipt, "s1");
    e.enqueue("!echo pwned", "s2");
    await until(() => started().length === 2);
    assert.equal(tui.typed[1], " !echo pwned");
  });

  it("text the TUI would change is stored as typed, so the logged message is the item's (no duplicate)", async () => {
    const { e, tui, started } = await setup();
    e.enqueue("[dm 7 from ada]\r\n\tcafe\u0301 \u001b[1mbold", "u1");
    await until(() => started().length === 1);
    const typed = tui.typed[0]!;
    assert.equal(typed, "[dm 7 from ada]\n    caf\u00e9 [1mbold");
    await tui.finish();
    await tui.compact(typed);
    assert.equal(e.memory.root[0]!.receipt, "u1");
    assert.equal(e.queued, 0);
  });

  it("a lost ack: the transcript is looked at first, so the item is not typed again", async () => {
    const { e, tui, started } = await setup({ ackMs: 60 });
    tui.ack = false;
    const file = join(TMP, "lost-ack.jsonl");
    writeFileSync(file, "");
    tui.transcript = file;
    e.enqueue("[dm 9 from ada] ping", "l1");
    await until(() => tui.typed.length === 1);
    writeFileSync(file, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "[dm 9 from ada] ping" } }) + "\n");
    await until(() => started().includes("l1"));
    await tick(150);
    assert.equal(tui.typed.length, 1);
    assert.equal(tui.cleared, 0);
  });

  it("not seen at all: while a turn runs it waits; idle, the composer is cleared and it is typed again; then given up", async () => {
    const { e, tui, events, started } = await setup({ ackMs: 40, maxTyped: 2 });
    tui.ack = false;
    e.enqueue("lost", "z1");
    await until(() => tui.typed.length === 1);
    tui.st = "working";
    await tick(150);
    assert.equal(tui.typed.length, 1); // a turn runs: no retype
    tui.st = "idle";
    await until(() => tui.typed.length === 2, 4000);
    assert.equal(tui.cleared, 1);
    tui.st = "idle";
    await until(() => events.some((ev) => ev.type === "undelivered"), 4000);
    assert.deepEqual(events.find((ev) => ev.type === "undelivered"), { type: "undelivered", id: "z1", reason: "typed 2 times into the bot's Claude Code and never seen" });
    assert.equal(e.queued, 0);
    assert.deepEqual(started(), []);
  });

  it("typed just as a turn of the TUI's own started: merged into that turn, logged with its receipt, never typed again", async () => {
    const { e, tui, events, started } = await setup();
    // The race: the engine and herdr see idle; a task notification's turn starts before the Enter lands.
    tui.prompt = async (text: string) => {
      tui.typed.push(text);
      tui.st = "working";
      await e.handle("POST", "/turn", q, { running: true, typed: true, text: "<task-notification>done</task-notification>", origin: "task-notification" });
      setTimeout(() => void e.handle("POST", "/turn", q, { running: true, typed: true, text, origin: "composer" }), 3);
      return { ok: true as const };
    };
    e.enqueue("[dm 5 from ada] mid", "mq1");
    await until(() => events.some((ev) => ev.type === "merged"));
    assert.deepEqual(started(), [null]); // only the notification's own turn
    assert.equal(e.queued, 0);
    const logged = e.memory.root.find((x) => x.receipt === "mq1")!;
    assert.equal(logged.kind, "user");
    assert.equal(logged.text, "[dm 5 from ada] mid");
    await tui.finish();
    tui.st = "idle";
    await tick(60);
    assert.equal(tui.typed.length, 1);
  });

  it("a lost ack found in the transcript as a queued message is merged too", async () => {
    const { e, tui, events } = await setup({ ackMs: 40 });
    tui.ack = false;
    const file = join(TMP, "queued.jsonl");
    writeFileSync(file, "");
    tui.transcript = file;
    e.enqueue("[dm 6 from ada] q", "mq2");
    await until(() => tui.typed.length === 1);
    writeFileSync(file, JSON.stringify({ type: "attachment", timestamp: new Date().toISOString(), attachment: { type: "queued_command", prompt: "[dm 6 from ada] q" } }) + "\n");
    await until(() => events.some((ev) => ev.type === "merged" && ev.id === "mq2"));
    assert.equal(e.memory.root.at(-1)!.receipt, "mq2");
    assert.equal(tui.cleared, 0);
  });

  it("a restarted TUI (hello) gets back what was typed and not seen", async () => {
    const { e, tui, started } = await setup({ ackMs: 5000 });
    tui.ack = false;
    e.enqueue("again", "h1");
    await until(() => tui.typed.length === 1);
    await e.handle("POST", "/hello", q, {});
    tui.ack = true;
    tui.st = "idle";
    await until(() => started().includes("h1"));
    assert.deepEqual(tui.typed, ["again", "again"]);
  });

  it("an inbox mod from before typed delivery gets nothing to submit", async () => {
    const { e } = await setup();
    e.setDelivery(undefined);
    e.enqueue("x", "o1");
    assert.deepEqual((await e.handle("GET", "/inbox/next", q, {})).json, { item: null });
    assert.deepEqual((await e.handle("POST", "/inbox/submitted", q, { id: "o1" })).json, { ok: false });
  });
});

/** A bot chat on Claude Code: the provider, its engine and a FakeTui; `turns` lists the session.turn events. */
async function chat() {
  const root = join(TMP, `bots-${++n}`);
  mkdirSync(join(root, "kit"), { recursive: true });
  writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
  const host = new CcHost(join(root, ".cc"));
  const tui = new FakeTui();
  const keys: string[] = [];
  const launcher = {
    ensure: async () => {},
    running: async () => true,
    interrupt: async () => {
      keys.push("escape");
      tui.st = "idle"; // Esc stops the turn; the trigger mod's turn.complete (aborted) follows
      await tui.engine.handle("POST", "/turn", q, { running: false, answered: false, reason: "aborted" });
      // The trigger mod compacts the stopped turn too (logged as pi logs every run): the inbox waits for it.
      await tui.engine.handle("POST", "/append", q, { messages: [{ kind: "talk", text: "(stopped)" }] });
    },
    delivery: () => tui,
  };
  const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(TMP, `oc-${n}`) });
  const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "session.persistence"] });
  const events: ProviderEvent[] = [];
  conn.onEvent((ev) => events.push(ev));
  await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
  await tick(50);
  const engine = host.engines.get("kit")!;
  tui.engine = engine;
  // Fast ticks for the test: the engine's pump is also called on enqueue.
  const send = (id: string, text: string) =>
    conn.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } } });
  const turns = () => events.flatMap((ev) => (ev.type === "session.turn" ? [`${ev.turnId}:${ev.state}`] : []));
  return { conn, host, tui, keys, engine, send, turns, events };
}

describe("delivery after Stop (as for a bot on pi: bot DMs and room tasks still go)", () => {

  it("Stop: Esc for the running turn, the owner's waiting message dropped, a waiting bot DM typed next (the bot wakes)", async () => {
    const { conn, host, tui, keys, send, turns } = await chat();
    await send("c1", "long job please");
    await until(() => turns().includes("c1:started") && tui.typed.length === 1);
    await send("c2", "and then this");
    await send("d1", "[dm 01J from ada] are you there?");
    await tick(60);
    assert.equal(tui.typed.length, 1); // mid-turn: both wait
    await conn.send({ type: "session.interrupt", requestId: "r2", sessionId: "s1" });
    await until(() => keys.length === 1 && tui.typed.length === 2, 4000);
    assert.deepEqual(tui.typed, ["long job please", "[dm 01J from ada] are you there?"]);
    assert.ok(turns().includes("c1:canceled"));
    assert.ok(turns().includes("c2:canceled"));
    assert.ok(!turns().includes("d1:canceled"));
    await tick(30);
    // The DM's own turn runs (started with its id) and completes.
    await tui.finish();
    await until(() => turns().includes("d1:completed"));
    await conn.close();
    await host.close();
  });

  it("a bot DM and a room task sent after Stop are typed at once, no hold", async () => {
    const { conn, host, tui, send, turns } = await chat();
    await send("c1", "work");
    await until(() => tui.typed.length === 1);
    await conn.send({ type: "session.interrupt", requestId: "r2", sessionId: "s1" });
    await until(() => turns().includes("c1:canceled"));
    await send("d2", "[dm 02J from ada] ping");
    await until(() => tui.typed.length === 2);
    await tui.finish();
    await tick(20);
    await tui.engine.handle("POST", "/append", q, { messages: [{ kind: "user", text: "[dm 02J from ada] ping" }] });
    await send("t1", "[room g task from user msg 01M]\ntask: go");
    await until(() => tui.typed.length === 3);
    assert.deepEqual(tui.typed.slice(1), ["[dm 02J from ada] ping", "[room g task from user msg 01M]\ntask: go"]);
    await conn.close();
    await host.close();
  });

  it("a message given up shows as failed with a notice", async () => {
    const { conn, host, tui, engine, send, events } = await chat();
    // The fake TUI never acks; the engine gives up after 3 tries (a short ack wait for the test).
    tui.ack = false;
    (engine as any).opts.ackMs = 30;
    await send("f1", "hello?");
    await until(() => events.some((ev) => ev.type === "session.turn" && ev.turnId === "f1" && ev.state === "failed"), 15_000);
    assert.equal(tui.typed.length, 3);
    assert.ok(events.some((ev) => ev.type === "session.notice" && ev.notice.title === "Message not delivered"));
    await conn.close();
    await host.close();
  });
});

describe("a prompt Claude Code puts into the running turn (a background task's notice)", () => {
  // Claude Code 2.1.323, reproduced: a background Bash call that ends while the turn runs raises prompt.submit with
  // the running turn's turnId (a queued_command in the transcript), and that turn ends with one turn.complete.
  const NOTE = "<task-notification>\n<task-id>bh9b1bmn8</task-id>\n<status>completed</status>\n<summary>Background command \"sleep 4\" completed (exit code 0)</summary>\n</task-notification>";

  for (const [name, into] of [
    ["the inbox mod says so (into)", { into: true }],
    ["an older inbox mod (no into): the engine's own running turn says so", {}],
  ] as const)
    it(`${name}: a row in that turn, no turn of its own; the person's turn completes at the turn's end`, async () => {
      const { conn, host, tui, engine, send, turns, events } = await chat();
      await send("c1", "run the build and tell me");
      await until(() => turns().includes("c1:started") && engine.running);
      await engine.handle("POST", "/turn", q, { running: true, typed: true, text: NOTE, origin: "task-notification", ...into });
      await tui.finish();
      await tick(20);
      assert.deepEqual(turns(), ["c1:started", "c1:completed"]);
      assert.ok(events.some((ev) => ev.type === "timeline.item" && ev.item.type === "tool_call" && (ev.item as any).name === "task_notification"));
      assert.equal(engine.running, false);
      await conn.close();
      await host.close();
    });

  it("a notice that starts a turn of its own (the TUI idle, into: false) still runs as its own turn", async () => {
    const { conn, host, tui, engine, turns } = await chat();
    await engine.handle("POST", "/turn", q, { running: true, typed: true, text: NOTE, origin: "task-notification", into: false });
    await tui.finish();
    await tick(20);
    assert.equal(turns().length, 2);
    assert.match(turns()[0]!, /^t-.*:started$/);
    assert.match(turns()[1]!, /^t-.*:completed$/);
    await conn.close();
    await host.close();
  });
});

describe("herdr delivery (launch.ts)", () => {
  it("types with `herdr agent prompt cc-<bot> <text>` as one argv item; reads state, transcript and refusals", async () => {
    const calls: string[][] = [];
    let reply = { code: 0, stdout: JSON.stringify({ result: { agent: { agent_status: "done", agent_session: { kind: "path", value: "/s/t.jsonl" } } } }), stderr: "" };
    const launcher = new CcLauncher({ herdrEnv: () => ({}), script: "/x", run: async (_b, args) => (calls.push(args), reply) });
    const d = launcher.delivery("kit");
    assert.equal(await d.state(), "done");
    assert.equal(await d.sessionFile(), "/s/t.jsonl");
    reply = { code: 0, stdout: JSON.stringify({ result: { type: "agent_prompted" } }), stderr: "" };
    assert.deepEqual(await d.prompt(" /x; rm -rf ~ \n 'q'"), { ok: true });
    assert.deepEqual(calls.at(-1), ["agent", "prompt", "cc-kit", " /x; rm -rf ~ \n 'q'"]);
    reply = { code: 1, stdout: JSON.stringify({ error: { code: "agent_blocked", message: "blocked" } }), stderr: "" };
    assert.deepEqual(await d.prompt("hi"), { ok: false, code: "agent_blocked", message: "blocked" });
    reply = { code: 1, stdout: JSON.stringify({ error: { code: "agent_not_found", message: "no" } }), stderr: "" };
    assert.equal(await d.state(), "gone");
    await d.clear("one line");
    assert.deepEqual(calls.at(-1), ["agent", "send-keys", "cc-kit", "ctrl+u", "backspace", "ctrl+u", "backspace", "ctrl+u", "backspace"]);
    // A wrapped line takes a ctrl+u per shown line (at 40 columns); a long text is cleared in calls of 400 keys.
    assert.equal(clearKeys("a\n" + "x".repeat(200)).length, 2 * (1 + 5 + 2));
    const before = calls.length;
    await d.clear("y\n".repeat(300));
    assert.equal(calls.length - before, 2);
    assert.ok(calls.slice(before).every((c) => c.slice(0, 3).join(" ") === "agent send-keys cc-kit"));
  });
});
