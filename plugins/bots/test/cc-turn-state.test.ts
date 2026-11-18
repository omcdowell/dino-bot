// Bots on Claude Code: how a turn ends and what the chat shows when it does not end cleanly (an API error, a refusal,
// a TUI restart, a daemon restart, Stop while a message is typed), and the model/effort switch.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CcEngine, CcHost } from "../server/cc/engine";
import type { CcDelivery } from "../server/cc/deliver";
import { createCcProvider } from "../server/cc/provider";
// @ts-expect-error plain JS mods, loaded by Claude Code
import { register as registerInbox } from "../claude-code/inbox/hooks/register.js";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

const TMP = mkdtempSync(join(tmpdir(), "cc-turn-state-"));
const open: CcEngine[] = [];
const hosts: CcHost[] = [];
after(async () => {
  for (const e of open) await e.close();
  for (const h of hosts) await h.close();
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

/** The TUI under herdr (as in cc-deliver.test.ts): a typed text starts a turn the inbox mod's hook reports. */
class FakeTui implements CcDelivery {
  st = "idle";
  typed: string[] = [];
  ack = true;
  /** ms from typing to the hook's report (Claude Code's ~1 s typing window). */
  ackDelay = 3;
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
    if (!this.ack) return { ok: true as const };
    setTimeout(() => {
      this.st = "working";
      void this.engine.handle("POST", "/turn", q, { running: true, typed: true, text, origin: "composer" });
    }, this.ackDelay);
    return { ok: true as const };
  }
  async end(body: Record<string, unknown>) {
    this.st = "done";
    await this.engine.handle("POST", "/turn", q, { running: false, ...body });
  }
}

let n = 0;
/** A bot chat on Claude Code: the provider, its engine and a FakeTui. */
async function chat(opts: { models?: any } = {}) {
  const root = join(TMP, `bots-${++n}`);
  mkdirSync(join(root, "kit"), { recursive: true });
  writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
  const host = new CcHost(join(root, ".cc"));
  hosts.push(host);
  const tui = new FakeTui();
  const keys: string[] = [];
  const restarts: string[] = [];
  const launcher = {
    ensure: async () => {},
    restart: async () => void restarts.push("restart"),
    running: async () => true,
    interrupt: async () => {
      keys.push("escape");
      if (tui.st !== "working") return;
      tui.st = "idle";
      await tui.engine.handle("POST", "/turn", q, { running: false, answered: false, reason: "aborted" });
    },
    delivery: () => tui,
  };
  const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(TMP, `oc-${n}`), ...(opts.models ? { models: opts.models } : {}) });
  const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "session.persistence", "session.configure"] });
  const events: ProviderEvent[] = [];
  conn.onEvent((ev) => events.push(ev));
  await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
  await tick(50);
  const engine = host.engines.get("kit")!;
  tui.engine = engine;
  const send = (id: string, text: string) =>
    conn.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } } });
  const turns = () => events.flatMap((ev) => (ev.type === "session.turn" ? [`${ev.turnId}:${ev.state}`] : []));
  const turn = (id: string, state: string) => events.find((ev) => ev.type === "session.turn" && ev.turnId === id && ev.state === state) as any;
  return { conn, host, tui, keys, restarts, engine, send, turns, turn, events, root };
}

describe("H4: a turn Claude Code ended on an API error or a refusal is a failure with its reason, not a cancel", () => {
  it("an API error: failed, with Claude Code's error text", async () => {
    const { tui, send, turns, turn } = await chat();
    await send("c1", "do it");
    await until(() => tui.typed.length === 1);
    await tick(20);
    await tui.end({ answered: false, reason: "error", error: "API Error: 529 overloaded_error" });
    await tick(10);
    assert.deepEqual(turns(), ["c1:started", "c1:failed"]);
    assert.match(turn("c1", "failed").error.message, /529 overloaded/);
  });

  it("an API error with no text: failed, pointing at the bot's terminal", async () => {
    const { tui, send, turn } = await chat();
    await send("c1", "do it");
    await until(() => tui.typed.length === 1);
    await tick(20);
    await tui.end({ answered: false, reason: "error" });
    await tick(10);
    assert.match(turn("c1", "failed").error.message, /API error.*terminal/);
  });

  it("a refusal: failed, with the API's explanation", async () => {
    const { tui, send, turn } = await chat();
    await send("c1", "do it");
    await until(() => tui.typed.length === 1);
    await tick(20);
    await tui.end({ answered: false, reason: "refusal", refusal: { category: "cyber", explanation: "Declined: unsafe request" } });
    await tick(10);
    assert.match(turn("c1", "failed").error.message, /refused.*Declined: unsafe request/);
  });

  it("only an interrupt is a cancel", async () => {
    const { tui, send, turns } = await chat();
    await send("c1", "do it");
    await until(() => tui.typed.length === 1);
    await tick(20);
    await tui.end({ answered: false, reason: "aborted" });
    await tick(10);
    assert.deepEqual(turns(), ["c1:started", "c1:canceled"]);
  });

  it("inbox mod: turn.complete carries the refusal and the error text to the engine", async () => {
    const calls: any[] = [];
    const hooks = new Map<string, Function>();
    (registerInbox as any)((ev: string, fn: Function) => hooks.set(ev, fn));
    const $ = {
      env: { get: async () => "/engine.json" },
      fs: { read: async () => JSON.stringify({ url: "http://engine/b/kit", token: "t" }) },
      http: { fetch: async (_u: string, init: { body?: string }) => (calls.push(JSON.parse(init.body ?? "{}")), { status: 200, text: "{}" }) },
    };
    const done = hooks.get("turn.complete")!;
    const next = async (e: unknown) => e;
    await done($, { reason: "refusal", isAborted: false, answer: "", refusal: { category: null, explanation: "no" } }, next);
    await done($, { reason: "error", isAborted: false, answer: "API Error: 500 boom" }, next);
    await done($, { reason: "answer", isAborted: false, answer: "hi" }, next);
    assert.deepEqual(calls, [
      { running: false, answered: false, reason: "refusal", refusal: { category: null, explanation: "no" } },
      { running: false, answered: false, reason: "error", error: "API Error: 500 boom" },
      { running: false, answered: true, reason: "answer" },
    ]);
  });
});

describe("H5: the TUI restarts mid-turn (a crash, a closed tab started again)", () => {
  it("the running turn fails with the reason, so the chat is not left working", async () => {
    const { tui, engine, send, turns, turn } = await chat();
    await send("c1", "long job");
    await until(() => tui.typed.length === 1);
    await until(() => engine.running);
    await engine.handle("POST", "/hello", q, {});
    await tick(10);
    assert.deepEqual(turns(), ["c1:started", "c1:failed"]);
    assert.match(turn("c1", "failed").error.message, /Claude Code restarted/);
  });

  it("a restart with no turn running changes nothing", async () => {
    const { engine, turns } = await chat();
    await engine.handle("POST", "/hello", q, {});
    await tick(10);
    assert.deepEqual(turns(), []);
  });
});

describe("M3: the daemon restarts mid-turn (the TUI goes on)", () => {
  it("the message in its turn is not typed again: the new engine keeps it submitted, the turn's log receipts it", async () => {
    const dir = join(TMP, `m3-${++n}`);
    const tui = new FakeTui();
    const a = await CcEngine.open("m3", dir, { delivery: tui, tickMs: 5 });
    tui.engine = a;
    a.enqueue("long job", "m1");
    await until(() => a.running);
    await a.close(); // the daemon stops; the TUI's turn runs on
    const tui2 = new FakeTui();
    tui2.st = "working";
    const b = await CcEngine.open("m3", dir, { delivery: tui2, tickMs: 5 });
    open.push(b);
    tui2.engine = b;
    await tick(60);
    await tui2.end({ answered: true, reason: "answer" });
    await b.handle("POST", "/append", q, { messages: [{ kind: "user", text: "long job" }, { kind: "talk", text: "done" }] });
    tui2.st = "idle";
    await tick(60);
    assert.deepEqual(tui2.typed, []);
    assert.equal(b.queued, 0);
    assert.equal(b.memory.root.find((e) => e.kind === "user")!.receipt, "m1");
  });

  it("a new TUI (hello): the message whose turn died is kept in memory as unanswered (as pi recovers it), not typed again", async () => {
    const dir = join(TMP, `m3-${++n}`);
    const tui = new FakeTui();
    const e = await CcEngine.open("m3b", dir, { delivery: tui, tickMs: 5 });
    open.push(e);
    tui.engine = e;
    e.enqueue("long job", "m1");
    await until(() => e.running);
    tui.st = "idle";
    await e.handle("POST", "/hello", q, {});
    await tick(60);
    assert.deepEqual(tui.typed, ["long job"]);
    assert.equal(e.queued, 0);
    const logged = e.memory.root.filter((x) => x.kind === "user");
    assert.deepEqual(logged.map((x) => [x.text, x.receipt]), [["long job", "m1"]]);
  });
});

describe("L5: Stop pressed while the message is being typed", () => {
  it("the turn it starts gets Esc as soon as Claude Code takes it, and shows as canceled", async () => {
    const { conn, tui, keys, send, turns } = await chat();
    tui.ackDelay = 150; // Claude Code's typing window
    await send("c1", "never mind");
    await until(() => tui.typed.length === 1);
    await conn.send({ type: "session.interrupt", requestId: "r2", sessionId: "s1" });
    await until(() => turns().includes("c1:canceled"), 2000);
    assert.deepEqual(keys, ["escape"]);
    assert.deepEqual(turns(), ["c1:started", "c1:canceled"]);
  });

  it("a bot DM being typed still goes (as after a Stop on pi)", async () => {
    const { conn, tui, keys, send, turns } = await chat();
    tui.ackDelay = 150;
    await send("d1", "[dm 01J from ada] ping");
    await until(() => tui.typed.length === 1);
    await conn.send({ type: "session.interrupt", requestId: "r2", sessionId: "s1" });
    await tick(250);
    assert.deepEqual(keys, []);
    assert.ok(!turns().includes("d1:canceled"));
  });
});

describe("L4: model and effort switch", () => {
  const levels = (...on: string[]) => ({ supported: on.length > 0, ...Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((l) => [l, { supported: on.includes(l) }])) });

  it("each model's effort levels come from the Models API (aliases: the newest of their family); unknown: all", async () => {
    const { pickerModels } = await import("../server/cc/models");
    const list = pickerModels([
      { id: "claude-opus-5-5", capabilities: { effort: levels("low", "medium", "high", "xhigh", "max") } },
      { id: "claude-sonnet-4-6", capabilities: { effort: levels("low", "medium", "high", "max") } },
      { id: "claude-haiku-3", capabilities: { effort: levels() } },
      { id: "claude-x-1" },
    ] as any);
    const ids = (id: string) => list.find((m) => m.id === id)!.thinkingOptions?.map((o) => o.id);
    assert.deepEqual(ids("claude-sonnet-4-6"), ["low", "medium", "high", "max"]);
    assert.deepEqual(ids("sonnet"), ["low", "medium", "high", "max"]);
    assert.deepEqual(ids("opus"), ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(ids("claude-haiku-3"), []);
    assert.equal(ids("claude-x-1"), undefined);
    assert.equal(ids("fable"), undefined);
  });

  it("the session's effort list is its model's, and follows a model switch", async () => {
    const models = async () => [
      { id: "opus", label: "Opus", thinkingOptions: ["low", "high", "xhigh"].map((id) => ({ id, label: id })) },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", thinkingOptions: ["low", "high"].map((id) => ({ id, label: id })) },
      { id: "claude-x-1", label: "X" },
    ];
    const { conn, events } = await chat({ models });
    const config = () => (events.filter((e) => e.type === "session.config").at(-1) as any).config;
    assert.deepEqual(config().thinkingOptions.map((o: any) => o.id), ["low", "medium", "high", "xhigh", "max"]); // no model: all
    await conn.send({ type: "session.configure", requestId: "r2", sessionId: "s1", changes: { model: "claude-sonnet-4-6" } });
    await tick();
    assert.deepEqual(config().thinkingOptions.map((o: any) => o.id), ["low", "high"]);
    await conn.send({ type: "session.configure", requestId: "r3", sessionId: "s1", changes: { model: "claude-x-1" } });
    await tick();
    assert.deepEqual(config().thinkingOptions.map((o: any) => o.id), ["low", "medium", "high", "xhigh", "max"]);
  });

  it("inbox mod: each main-loop step runs on the session's model and effort (/run); a subagent's and an unreachable engine's as they were", async () => {
    let run: any = { model: "opus", effort: "high" };
    const hooks = new Map<string, Function>();
    (registerInbox as any)((ev: string, fn: Function) => hooks.set(ev, fn));
    const $ = {
      env: { get: async () => "/engine.json" },
      fs: { read: async () => JSON.stringify({ url: "http://engine/b/kit", token: "t" }) },
      http: {
        fetch: async (url: string) => {
          if (run === "down") throw new Error("ECONNREFUSED");
          return { status: 200, text: JSON.stringify(url.endsWith("/run") ? run : {}) };
        },
      },
    };
    const step = hooks.get("turn.step")!;
    const sent: any[] = [];
    const next = async function* (e: any) {
      sent.push({ model: e.model, effort: e.effort });
      yield { kind: "text", text: "x" };
      return { answer: "x" };
    };
    const drain = async (e: any) => {
      const it = step($, e, next);
      for (;;) if ((await it.next()).done) return;
    };
    await drain({ turnId: "t", index: 0, model: "claude-sonnet-5-5", effort: "medium", messageCount: 1 });
    await drain({ turnId: "t", index: 1, model: "claude-sonnet-5-5", effort: "medium", messageCount: 1, agentId: "a1" });
    run = {};
    await drain({ turnId: "t", index: 2, model: "claude-sonnet-5-5", effort: "medium", messageCount: 1 });
    run = "down";
    await drain({ turnId: "t", index: 3, model: "claude-sonnet-5-5", messageCount: 1 });
    assert.deepEqual(sent, [
      { model: "opus", effort: "high" },
      { model: "claude-sonnet-5-5", effort: "medium" },
      { model: "claude-sonnet-5-5", effort: "medium" },
      { model: "claude-sonnet-5-5", effort: undefined },
    ]);
  });
});
