// One scenario suite for both engines a bot runs on: pi (pi-optchat's SessionController, driven with pi's extension
// events) and Claude Code (the optchat-cc provider, its engine and a fake TUI, driven as the mods drive it). Every
// scenario runs on both. One Claude Code does not do is in CC_UNSUPPORTED with its reason; any other scenario must pass
// on both. A feature merges when it passes here on both engines or joins that list (README: "Engine parity").
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { CcHost, type CcEngine } from "../server/cc/engine";
import type { CcDelivery } from "../server/cc/deliver";
import { createCcProvider } from "../server/cc/provider";
import { FIXTURE, OWN_ID } from "../../../optchat/test/restart-guard-cases.ts";

const TMP = mkdtempSync(join(tmpdir(), "engines-"));
process.env.OPTCHAT_HOME = join(TMP, "optchat"); // pi-optchat's profiles (read at each call)
const cleanup: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => {});
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(5);
  }
}

type Outcome = "completed" | "canceled" | "failed";
type Image = { data: string; mimeType: string };
/** What a scenario does to a bot, and what it reads back, the same on both engines. */
interface Driver {
  /** The person's message starts a turn. */
  say(text: string, image?: Image): Promise<void>;
  /** The answer streams (each part the answer so far), then is whole. */
  stream(parts: string[]): Promise<void>;
  reply(text: string): Promise<void>;
  tool(name: string, input: unknown, output: string): Promise<void>;
  /** The turn ends: done, stopped by the person (Stop), or on a provider error. */
  end(how: "done" | "stop" | "error", detail?: string): Promise<void>;
  /** A message sent while the turn runs. */
  steer(text: string): Promise<void>;
  /** Whatever turns are still due run, each answered "ok". */
  drain(): Promise<void>;
  /** How the last turn ended, as the chat shows it. */
  outcome(): Outcome | undefined;
  /** The bot's OptChat log: [kind, text]. */
  log(): Array<[string, string]>;
  /** Inputs journaled and not yet logged (pending-inputs.json). */
  pending(): number;
  /** The engine dies mid-turn and comes back. */
  crash(): Promise<void>;
  /** The turn's model usage is reported; returns the chat's output tokens and cost so far. */
  usage(output: number, costUsd: number): Promise<{ output: number; costUsd: number }>;
  /** Compactions answered so far (each with "SUMMARY <n>"). */
  compactions(): number;
  memory(): CcEngine["memory"];
  /** The bot's OptChat profile folder. */
  dir(): string;
  /** Whether the bot's restart guard refuses this shell command. */
  guard(command: string): Promise<boolean>;
}

/** What Claude Code bots do not do, each with why. A scenario here is not run on Claude Code. */
export const CC_UNSUPPORTED: Record<string, string> = {
  "steer into the running turn":
    "the TUI cannot take input mid-turn without Claude Code queueing it into the turn unseen; a steered message is typed after the turn and runs as its own turn",
  "stop leaves a stop line in the log": "Claude Code's transcript has no entry for an interrupt; pi logs `Agent aborted` from its aborted reply",
  "a provider error is logged": "Claude Code does not put a failed API call into its transcript, so the view mod has nothing to log; the chat shows the error",
};

// ------------------------------------------------------------------ pi (pi-optchat's controller)

let piN = 0;
async function piBot(): Promise<Driver> {
  // pi's side runs pi's packages (pi-optchat's own node_modules); loaded by name so this plugin's tsc does not
  // type-check pi's sources under the plugin's settings.
  const controller = "pi-optchat/src/controller.ts";
  const profiles = "pi-optchat/src/profiles.ts";
  const { SessionController } = await import(controller);
  const { createProfile } = await import(profiles);
  const { restartGuard, restartReason, fixtureIo } = await import("pi-optchat/src/restart-guard.ts");
  const name = `pi-${++piN}`;
  createProfile(name);
  const boundaries: any[] = [];
  const entries: any[] = [];
  const pi = { appendEntry: (_t: string, data: unknown) => void boundaries.push(data) } as any;
  let aborted = false;
  const ctx: any = {
    cwd: TMP,
    hasUI: false,
    signal: undefined,
    abort: () => void (aborted = true),
    ui: { notify() {}, setStatus() {}, setTitle() {}, setWorkingMessage() {} },
    sessionManager: { getSessionId: () => "s1", getEntries: () => entries, getBranch: () => entries },
    modelRegistry: {},
  };
  let c = new SessionController(pi);
  let summaries = 0;
  const open = async () => {
    await c.open(name, ctx);
    // The compactor model is pi's; here it answers as a fake one.
    (c.active!.memory as any).compress = async () => `SUMMARY ${++summaries}`;
  };
  await open();
  cleanup.push(() => c.close());
  let t = 0;
  const end = (m: any) => (entries.push({ type: "message", id: `e${entries.length}`, timestamp: new Date().toISOString(), message: m }), c.messageEnd(m, ctx));
  let running = false;
  let lastStop: string | undefined;
  const start = async (text: string, image?: Image) => {
    assert.equal(c.input(text, "interactive", ctx), "continue");
    const event = { systemPrompt: "", systemPromptOptions: { contextFiles: [], skills: [], sections: {} } } as any;
    c.beforeAgentStart(event, ctx);
    c.agentStart(ctx);
    await c.context({ messages: [] } as any, ctx);
    end({ role: "user", content: [{ type: "text", text }, ...(image ? [{ type: "image", ...image }] : [])], timestamp: ++t });
    running = true;
  };
  const assistant = (content: unknown[], stopReason = "stop", extra: object = {}) =>
    end({ role: "assistant", content, stopReason, timestamp: ++t, api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", ...extra });
  const d: Driver = {
    say: (text, image) => start(text, image),
    async stream(parts) {
      // pi streams through Paseo's own pi provider; the controller sees the whole message at its end.
      await d.reply(parts.at(-1)!);
    },
    async reply(text) {
      assistant([{ type: "text", text }]);
      lastStop = "stop";
    },
    async tool(name, input, output) {
      assistant([{ type: "toolCall", id: `call-${t}`, name, arguments: input }], "toolUse");
      end({ role: "toolResult", toolCallId: `call-${t - 1}`, toolName: name, content: [{ type: "text", text: output }], isError: false, timestamp: ++t });
    },
    async end(how, detail) {
      if (how === "stop") assistant([], "aborted", { errorMessage: "Request was aborted" });
      if (how === "error") assistant([], "error", { errorMessage: detail ?? "API error" });
      lastStop = how === "done" ? "stop" : how === "stop" ? "aborted" : "error";
      await c.agentSettled(ctx);
      running = false;
    },
    async steer(text) {
      assert.ok(running, "steer needs a running turn");
      assert.equal(c.input(text, "interactive", ctx), "continue");
      end({ role: "user", content: [{ type: "text", text }], timestamp: ++t });
    },
    async drain() {},
    outcome: () => (lastStop === undefined ? undefined : lastStop === "stop" ? "completed" : lastStop === "aborted" ? "canceled" : "failed"),
    log: () => c.active!.memory.root.map((e: any) => [e.kind, e.text] as [string, string]),
    pending: () => JSON.parse(readFileSync(join(c.active!.dir, "pending-inputs.json"), "utf8")).length,
    async crash() {
      // The process dies: nothing is closed or flushed; the lock goes with it.
      const a = c.active!;
      await a.memory.close();
      await (a.turns as any).unlock();
      c = new SessionController(pi);
      running = false;
      lastStop = undefined;
      await open();
    },
    async usage(output, costUsd) {
      const usage = { input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output, cost: { input: 0, output: costUsd, cacheRead: 0, cacheWrite: 0, total: costUsd } };
      entries.push({ type: "message", id: `u${entries.length}`, timestamp: new Date().toISOString(), message: { role: "assistant", content: [], usage, timestamp: ++t, provider: "anthropic", model: "claude-opus-5-5", stopReason: "stop" } });
      c.collectUsage(ctx);
      const all = c.active!.usage.entries;
      return { output: all.reduce((n: number, e: any) => n + e.usage.output, 0), costUsd: all.reduce((n: number, e: any) => n + e.usage.cost.total, 0) };
    },
    compactions: () => summaries,
    memory: () => c.active!.memory as any,
    dir: () => c.active!.dir,
    async guard(command) {
      // The pi hook (restartGuard), on the shared cases' fixture.
      let handler: ((e: any, ctx: any) => any) | undefined;
      restartGuard({ on: (_e, h) => void (handler = h) }, { PASEO_AGENT_ID: OWN_ID });
      assert.ok(handler);
      // The hook reads the live system; the matcher it calls is checked on the fixture, as the CC hook is.
      assert.equal(handler!({ toolName: "read", input: {} }, { cwd: "/bot" }), undefined);
      return restartReason(command, "/bot", fixtureIo(FIXTURE), OWN_ID) !== null;
    },
  };
  return d;
}

// ------------------------------------------------------------------ Claude Code (optchat-cc provider + engine)

const q = new URLSearchParams();
/** The bot's TUI under herdr: what is typed starts a turn the inbox mod reports. */
class FakeTui implements CcDelivery {
  st = "idle";
  typed: string[] = [];
  engine!: CcEngine;
  async state() {
    return this.st;
  }
  async sessionFile() {
    return null;
  }
  async clear() {}
  async prompt(text: string) {
    this.typed.push(text);
    setTimeout(() => {
      this.st = "working";
      void this.engine.handle("POST", "/turn", q, { running: true, typed: true, text, origin: "composer" });
    }, 3);
    return { ok: true as const };
  }
}

let ccN = 0;
async function ccBot(): Promise<Driver> {
  const root = join(TMP, `bots-${++ccN}`);
  const optchatHome = join(TMP, `cc-optchat-${ccN}`);
  mkdirSync(join(root, "kit"), { recursive: true });
  writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
  // Summaries run in the TUI (the fake answers them), never on the host's pi.
  mkdirSync(join(optchatHome, "profiles", "kit"), { recursive: true });
  writeFileSync(join(optchatHome, "profiles", "kit", "config.json"), JSON.stringify({ compactorRunner: "in-session" }));
  const host = new CcHost(join(root, ".cc"));
  cleanup.push(() => host.close());
  const tui = new FakeTui();
  let entries: Array<Record<string, unknown>> = [];
  let ended: Promise<void> | null = null;
  const finish = async (body: Record<string, unknown>) => {
    tui.st = "done";
    await engine().handle("POST", "/turn", q, { running: false, ...body });
    // The trigger mod's turn-end compaction logs the turn.
    await engine().handle("POST", "/append", q, { messages: entries });
    entries = [];
  };
  const launcher = {
    ensure: async () => {},
    restart: async () => {},
    running: async () => true,
    interrupt: async () => {
      if (tui.st !== "working") return;
      ended = finish({ answered: false, reason: "aborted" });
      await ended;
    },
    delivery: () => tui,
  };
  const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome, models: async () => [] });
  const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "prompt.steer", "session.persistence", "session.configure"] });
  const events: ProviderEvent[] = [];
  conn.onEvent((ev) => events.push(ev));
  await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } } as any);
  await until(() => host.engines.has("kit"));
  const engine = () => host.engines.get("kit")!;
  tui.engine = engine();
  let summaries = 0;
  const jobs = setInterval(() => {
    for (const j of engine().takeJobs()) engine().finishJob(j.id, { text: `SUMMARY ${++summaries}` });
  }, 5);
  cleanup.push(async () => clearInterval(jobs));
  let n = 0;
  const send = async (text: string, delivery: "auto" | "steer", image?: Image) => {
    const id = `c${++n}`;
    const content = [{ type: "text", text }, ...(image ? [{ type: "image", ...image }] : [])];
    await conn.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: id, delivery, input: { type: "message", content } } } as any);
    return id;
  };
  /** Waits for the next typed text to start its turn; returns that text. */
  const started = async (count: number) => {
    await until(() => tui.typed.length >= count);
    await until(() => engine().running);
    const typed = tui.typed[count - 1]!;
    entries.push({ kind: "user", text: typed });
    return typed;
  };
  const turnStates = () => events.flatMap((ev) => (ev.type === "session.turn" ? [ev.state] : []));
  const d: Driver = {
    async say(text, image) {
      await send(text, "auto", image);
      await started(tui.typed.length + 1);
    },
    async stream(parts) {
      for (const p of parts) await engine().handle("POST", "/event", q, { type: "step", answer: p, partial: true });
      await d.reply(parts.at(-1)!);
      const shown = events.flatMap((ev) => (ev.type === "timeline.item" && ev.item.type === "assistant_message" ? [ev.item.text] : []));
      assert.deepEqual(shown, [...parts, parts.at(-1)], "the chat shows the answer as it grows");
    },
    async reply(text) {
      await engine().handle("POST", "/event", q, { type: "step", answer: text });
      entries.push({ kind: "talk", text });
    },
    async tool(name, input, output) {
      const id = `call-${entries.length}`;
      await engine().handle("POST", "/event", q, { type: "tool", phase: "running", id, name, input });
      await engine().handle("POST", "/event", q, { type: "tool", phase: "done", id, name, input, output });
      entries.push({ kind: "tool", text: `${name} ${JSON.stringify(input)}`, name, input, call: id });
      entries.push({ kind: "echo", text: `${name}: ${output}`, name, call: id, result: output });
    },
    async end(how, detail) {
      if (how === "stop") {
        await conn.send({ type: "session.interrupt", sessionId: "s1", requestId: `i${n}` } as any);
        await until(() => ended !== null);
        await ended;
        ended = null;
      } else await finish(how === "done" ? { answered: true, reason: "answer" } : { answered: false, reason: "error", error: detail ?? "API error" });
      await tick(5);
    },
    async steer(text) {
      await send(text, "steer");
    },
    async drain() {
      while (engine().queued > 0) {
        // The engine types only once the turn's compaction is in (compactDue) and the TUI is free.
        tui.st = "idle";
        await started(tui.typed.length + 1);
        await d.reply("ok");
        await d.end("done");
      }
    },
    outcome: () => {
      const s = turnStates().filter((x) => x !== "started").at(-1);
      return s as Outcome | undefined;
    },
    log: () => engine().memory.root.map((e) => [e.kind, e.text] as [string, string]),
    pending: () => JSON.parse(readFileSync(join(optchatHome, "profiles", "kit", "pending-inputs.json"), "utf8")).length,
    async crash() {
      // The TUI dies mid-turn; its next start says hello.
      entries = [];
      tui.st = "idle";
      await engine().handle("POST", "/hello", q, {});
      await tick(5);
    },
    async usage(output, costUsd) {
      await engine().handle("POST", "/usage", q, { run: "run-1", tokens: { input_tokens: 10, output_tokens: output }, costUsd });
      const u = events.filter((ev) => ev.type === "session.usage").at(-1) as any;
      return { output: u.usage.outputTokens, costUsd: u.usage.totalCostUsd };
    },
    compactions: () => summaries,
    memory: () => engine().memory,
    dir: () => join(optchatHome, "profiles", "kit"),
    async guard(command) {
      // The stock PreToolUse hook (claude-code/guard), with hook-shaped JSON on stdin.
      const hook = join(import.meta.dirname, "..", "claude-code", "guard", "hooks", "restart-guard.mjs");
      const child = spawn(process.execPath, [hook], { env: { ...process.env, PASEO_AGENT_ID: OWN_ID, RESTART_GUARD_FIXTURE: JSON.stringify(FIXTURE) } });
      child.stdin.end(JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/bot" }));
      const code = await new Promise<number | null>((r) => child.on("close", r));
      return code === 2;
    },
  };
  return d;
}

// ------------------------------------------------------------------ the scenarios

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex").toString("base64");
const kinds = (log: Array<[string, string]>) => log.map(([k]) => k);

const SCENARIOS: Record<string, (b: Driver) => Promise<void>> = {
  async message(b) {
    await b.say("hello there");
    await b.reply("Hi!");
    await b.end("done");
    assert.deepEqual(b.log(), [["user", "hello there"], ["talk", "Hi!"]]);
    assert.equal(b.outcome(), "completed");
    assert.equal(b.pending(), 0, "the input left the journal once logged");
  },
  async stream(b) {
    await b.say("count");
    await b.stream(["One", "One, two", "One, two, three."]);
    await b.end("done");
    assert.deepEqual(b.log(), [["user", "count"], ["talk", "One, two, three."]], "only the whole answer is logged");
  },
  async tool(b) {
    await b.say("list it");
    await b.tool("bash", { command: "ls" }, "a.txt");
    await b.reply("One file.");
    await b.end("done");
    assert.deepEqual(kinds(b.log()), ["user", "tool", "echo", "talk"]);
    assert.match(b.log()[1]![1], /^bash .*"ls"/);
    assert.match(b.log()[2]![1], /a\.txt/);
  },
  async stop(b) {
    await b.say("long job");
    await b.reply("Starting.");
    await b.end("stop");
    assert.equal(b.outcome(), "canceled");
    assert.deepEqual(b.log().slice(0, 2), [["user", "long job"], ["talk", "Starting."]]);
    assert.equal(b.pending(), 0);
    // The next message runs as a turn of its own.
    await b.say("again");
    await b.reply("ok");
    await b.end("done");
    assert.equal(b.outcome(), "completed");
  },
  async "stop leaves a stop line in the log"(b) {
    await b.say("long job");
    await b.end("stop");
    assert.match(b.log().at(-1)![1], /aborted/);
  },
  async steer(b) {
    await b.say("first");
    await b.steer("second");
    await b.reply("ok");
    await b.end("done");
    await b.drain();
    const users = b.log().filter(([k]) => k === "user").map(([, t]) => t);
    assert.deepEqual(users, ["first", "second"], "both logged once, in order");
    assert.equal(b.pending(), 0);
  },
  async "steer into the running turn"(b) {
    await b.say("first");
    await b.steer("second");
    await b.reply("both done");
    await b.end("done");
    assert.deepEqual(b.log(), [["user", "first"], ["user", "second"], ["talk", "both done"]]);
  },
  async crash(b) {
    await b.say("are you there");
    await b.crash();
    const users = b.log().filter(([k]) => k === "user").map(([, t]) => t);
    assert.deepEqual(users, ["are you there"], "the input is in memory once, not lost and not answered twice");
    assert.equal(b.pending(), 0);
    await b.say("still there?");
    await b.reply("Yes.");
    await b.end("done");
    assert.equal(b.outcome(), "completed");
  },
  async "error ends the turn as failed"(b) {
    await b.say("do it");
    await b.end("error", "529 overloaded_error");
    assert.equal(b.outcome(), "failed");
    assert.equal(b.log()[0]![1], "do it");
    assert.equal(b.pending(), 0);
  },
  async "a provider error is logged"(b) {
    await b.say("do it");
    await b.end("error", "529 overloaded_error");
    assert.match(b.log().at(-1)![1], /529 overloaded/);
  },
  async "room talk and checkpoint after the turn"(b) {
    await b.say("hi");
    await b.reply("hello");
    // A group chat hands talk over while the turn runs: it goes in after the turn, never into it.
    const blocks = join(b.dir(), "memory", "room-blocks");
    mkdirSync(blocks, { recursive: true });
    const text = "[room crew block b1 msgs 1-2] ada: ship it";
    writeFileSync(join(blocks, "b1.json"), JSON.stringify({ id: "b1", group: "crew", from: "2026-11-18T10:00:00Z", to: "2026-11-18T10:01:00Z", text }));
    await b.end("done");
    assert.deepEqual(b.log(), [["user", "hi"], ["talk", "hello"], ["user", text]]);
    // The profile is committed after the turn (git checkpoint).
    await until(() => {
      try {
        return execFileSync("git", ["-C", b.dir(), "log", "--oneline"], { stdio: "pipe" }).toString().includes("Save OptChat memory");
      } catch {
        return false;
      }
    }, 5000);
  },
  async compaction(b) {
    await b.say("tell me a long story");
    await b.reply(`Once upon a time. ${"And then more happened. ".repeat(60)}`);
    await b.end("done");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    await b.memory().settle(ac.signal, true);
    clearTimeout(timer);
    assert.ok(b.compactions() >= 1, "the long answer was summarised");
    assert.match(b.memory().render(), /SUMMARY \d/, "the next turn's view holds the summary");
  },
  async usage(b) {
    await b.say("hi");
    await b.reply("hello");
    const u = await b.usage(42, 0.5);
    await b.end("done");
    assert.equal(u.output, 42);
    assert.equal(u.costUsd, 0.5);
  },
  async images(b) {
    await b.say("what is this?", { data: PNG, mimeType: "image/png" });
    await b.reply("A pixel.");
    await b.end("done");
    const [kind, text] = b.log()[0]!;
    assert.equal(kind, "user");
    assert.match(text, /^what is this\?/);
    assert.match(text, /\[image/, "memory notes the image");
  },
  async guard(b) {
    assert.equal(await b.guard("systemctl --user restart paseo"), true);
    assert.equal(await b.guard("ls -la"), false);
  },
};

describe("engine parity: every scenario on pi and on Claude Code", () => {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    it(`pi: ${name}`, async () => run(await piBot()));
    // Listed as unsupported: it must still fail on Claude Code, so the list shrinks when Claude Code gains it.
    if (name in CC_UNSUPPORTED) it(`claude code: ${name} (unsupported: still fails)`, async () => assert.rejects(async () => run(await ccBot())));
    else it(`claude code: ${name}`, async () => run(await ccBot()));
  }
  it("CC_UNSUPPORTED names only scenarios, each with a reason", () => {
    for (const [name, why] of Object.entries(CC_UNSUPPORTED)) {
      assert.ok(name in SCENARIOS, `${name} is a scenario`);
      assert.ok(why.trim().length > 10, `${name} has a reason`);
    }
  });
});
