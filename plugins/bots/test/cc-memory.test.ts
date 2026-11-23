// A Claude Code bot's memory as a pi bot's (pi-optchat): every turn is logged, stopped and failed ones too.
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { CcEngine, CcHost } from "../server/cc/engine";
import { createCcProvider } from "../server/cc/provider";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { Memory } from "pi-optchat/api";
// @ts-expect-error plain JS mods, loaded by Claude Code
import { register as registerTrigger } from "../claude-code/trigger/hooks/register.js";
// @ts-expect-error plain JS mods, loaded by Claude Code
import { register as registerView } from "../claude-code/view/hooks/register.js";

const TMP = mkdtempSync(join(tmpdir(), "cc-memory-"));
const open: CcEngine[] = [];
after(async () => {
  for (const e of open) await e.close();
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const q = new URLSearchParams();

function triggerMod() {
  const hooks = new Map<string, Function>();
  registerTrigger((event: string, fn: Function) => hooks.set(event, fn));
  let compacts = 0;
  const $ = {
    clock: { after: (_ms: number, fn: () => unknown) => void fn() },
    session: { compact: async () => (compacts++, {}) },
    ui: { log: () => {} },
  };
  const end = (e: object) => hooks.get("turn.complete")!($, e, async (x: unknown) => x);
  return { end, compacts: () => compacts };
}

describe("M4: stopped and failed turns are logged (pi logs every run)", () => {
  it("the trigger mod compacts after every main-loop turn: answered, aborted, error; never a subagent's", async () => {
    const t = triggerMod();
    await t.end({ reason: "answer" });
    await t.end({ reason: "aborted", isAborted: true });
    await t.end({ reason: "error" });
    await t.end({ reason: "refusal" });
    await t.end({ reason: "answer", agentId: "sub1" });
    assert.equal(t.compacts(), 4);
  });

  it("the engine holds the inbox after a stopped turn until its compaction logs it, as after an answered one", async () => {
    const typed: string[] = [];
    const tui = { state: async () => "idle", sessionFile: async () => null, clear: async () => {}, prompt: async (t: string) => (typed.push(t), { ok: true as const }) };
    const e = await CcEngine.open("m4", join(TMP, "m4"), { delivery: tui, tickMs: 5 });
    open.push(e);
    await e.handle("POST", "/turn", q, { running: true, typed: true, text: "typed in the terminal", origin: "composer" });
    e.enqueue("next one", "n1");
    await e.handle("POST", "/turn", q, { running: false, answered: false, reason: "aborted" });
    await tick(60);
    assert.deepEqual(typed, []); // the compaction runs first: nothing is typed into it
    await e.handle("POST", "/append", q, { messages: [{ kind: "user", text: "typed in the terminal" }] });
    await tick(60);
    assert.deepEqual(typed, ["next one"]);
    assert.equal(e.memory.root.at(-1)!.text, "typed in the terminal");
  });
});

describe("M6: an imported memory generation (active-memory.json), as pi-optchat opens it", () => {
  it("the engine opens the generation the pointer names, not the profile's pre-import log", async () => {
    const dir = join(TMP, "m6");
    const gen = "memories/0f0e0d0c-0b0a-4908-8706-050403020100";
    const old = new Memory(dir, async () => "x");
    old.append("user", "before the import");
    await old.close();
    const imported = new Memory(join(dir, gen), async () => "x");
    imported.append("user", "imported history");
    await imported.close();
    writeFileSync(join(dir, "active-memory.json"), JSON.stringify(gen));
    const e = await CcEngine.open("m6", dir);
    open.push(e);
    assert.equal(e.memory.directory, join(dir, gen));
    assert.deepEqual(e.memory.root.map((x) => x.text), ["imported history"]);
  });
});

/** What pi-optchat's Memory hands its escalator for a line the provider refused (memory.ts escalateDue). */
const REFUSED = { node: "1+1", reason: "blocked by the provider", messages: [{ id: 1, kind: "echo", bytes: 900, date: "2026-11-18T09:00:05.000Z" }] };

describe("M7: memory warnings in the chat, refused lines escalated (as pi-optchat's controller)", () => {
  it("a warning of the bot's memory is a notification row in its chat (and still the daemon log)", async () => {
    const root = join(TMP, "bots7");
    mkdirSync(join(root, "kit"), { recursive: true });
    writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
    const host = new CcHost(join(root, ".cc"));
    const logged: string[] = [];
    const launcher = { ensure: async () => {}, interrupt: async () => {}, running: async () => true };
    const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(TMP, "oc7"), warn: (s) => logged.push(s) });
    const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "session.persistence"] });
    const events: ProviderEvent[] = [];
    conn.onEvent((ev) => events.push(ev));
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
    await tick(50);
    const engine = host.engines.get("kit")!;
    (engine.memory as any).warn("Compaction failed: overloaded");
    const rows = events.flatMap((ev) => (ev.type === "timeline.item" && ev.item.type === "notification" ? [ev.item] : []));
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as any).level, "error");
    assert.match((rows[0] as any).message, /Compaction failed: overloaded/);
    assert.ok(logged.some((s) => /Compaction failed: overloaded/.test(s)));
    await conn.close();
    await host.close();
  });

  it("a line the provider refused is escalated with bot-dm, from the bot's own chat (its PASEO_AGENT_ID)", async () => {
    const bin = join(TMP, "bin7");
    mkdirSync(bin, { recursive: true });
    const out = join(TMP, "bot-dm7.txt");
    writeFileSync(join(bin, "bot-dm"), `#!/bin/sh\necho "$PASEO_AGENT_ID $*" >> ${out}\n`);
    chmodSync(join(bin, "bot-dm"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PASEO_AGENT_ID: "agent-7", BOTS_ESCALATE_TO: "fc" };
    const e = await CcEngine.open("m7", join(TMP, "m7"), { env });
    open.push(e);
    // Memory (pi-optchat, tested there) calls its escalator once per refused line; this is the bot's.
    const escalate = (e.memory as any).escalate;
    assert.equal(typeof escalate, "function");
    await escalate(REFUSED);
    const sent = readFileSync(out, "utf8");
    assert.match(sent, /^agent-7 fc --kind escalate --subject OptChat m7: line 1\+1 not summarised --text OptChat compactor: line 1\+1 of profile m7 /);
  });

  it("no escalation outside a bot's chat (no PASEO_AGENT_ID), as pi-optchat", async () => {
    const env = { ...process.env, PASEO_AGENT_ID: "", BOTS_ESCALATE_TO: "fc" };
    const e = await CcEngine.open("m7b", join(TMP, "m7b"), { env });
    open.push(e);
    assert.equal((e.memory as any).escalate, undefined);
  });
});

describe("M8: a git checkpoint of the profile, as pi-optchat's (checkpoint.ts)", () => {
  const commits = (dir: string) => {
    try {
      return execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "0";
    }
  };
  it("after each turn's log (the compaction's /append) and on close", async () => {
    const dir = join(TMP, "m8");
    const e = await CcEngine.open("m8", dir);
    await e.handle("POST", "/append", q, { messages: [{ kind: "user", text: "remember the milk" }] });
    for (let k = 0; k < 100 && commits(dir) === "0"; k++) await tick(20);
    assert.equal(commits(dir), "1");
    assert.match(execFileSync("git", ["-C", dir, "log", "-1", "--format=%s"], { encoding: "utf8" }), /Save OptChat memory/);
    assert.ok(execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" }).includes("main/"));
    e.memory.append("talk", "noted");
    await e.close();
    assert.equal(commits(dir), "2");
  });
});

describe("L9: the profile's Tool digest setting, as pi-optchat's RunLog", () => {
  /** A turn as the view mod sends it (its tool and echo entries carry their call). */
  const turn = [
    { kind: "user", text: "fix it" },
    { kind: "talk", text: "Looking first." },
    { kind: "tool", text: 'Bash {"command":"ls"}', name: "Bash", input: { command: "ls" }, call: "t1" },
    { kind: "tool", text: 'Read {"file_path":"/x"}', name: "Read", input: { file_path: "/x" }, call: "t2" },
    { kind: "echo", text: "Bash: a b", name: "Bash", call: "t1", result: "a b", isError: false },
    { kind: "echo", text: "Read: [error] no such file", name: "Read", call: "t2", result: "no such file", isError: true },
    { kind: "talk", text: "Done." },
  ];
  it("on: a turn's tool steps are one digest entry; the reply after them as said", async () => {
    const dir = join(TMP, "l9");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ toolDigest: true }));
    const e = await CcEngine.open("l9", dir);
    open.push(e);
    const r = await e.handle("POST", "/append", q, { messages: turn });
    assert.deepEqual(
      e.memory.root.map((x) => [x.kind, x.text]),
      [
        ["user", "fix it"],
        ["tool", 'Tool steps (2 calls):\nnote: Looking first.\n- Bash {"command":"ls"}\n  \u2192 ok: a b\n- Read {"file_path":"/x"}\n  \u2192 error: no such file'],
        ["talk", "Done."],
      ],
    );
    assert.deepEqual((r.json as any).ids, [0, 1, 2]);
  });
  it("off (the default): every call and result as its own entry, as before", async () => {
    const e = await CcEngine.open("l9off", join(TMP, "l9off"));
    open.push(e);
    await e.handle("POST", "/append", q, { messages: turn });
    assert.deepEqual(e.memory.root.map((x) => x.kind), ["user", "talk", "tool", "tool", "echo", "echo", "talk"]);
  });
  it("the view mod's entries carry each call's id, name, input and result", async () => {
    const hooks = new Map<string, Function>();
    registerView((event: string, fn: Function) => hooks.set(event, fn));
    let appended: any;
    const $ = {
      env: { get: async (k: string) => (k === "OPTCHAT_ENGINE_FILE" ? "/engine.json" : "") },
      fs: { read: async () => JSON.stringify({ url: "http://engine/b/kit", token: "t" }), write: async () => {} },
      http: {
        fetch: async (url: string, init: { method: string; body?: string }) => {
          if (url.endsWith("/append")) appended = JSON.parse(init.body!);
          return { status: 200, text: JSON.stringify(url.includes("/view") ? { view: "<chat>v</chat>", bytes: 1, total: 1 } : { ids: [] }) };
        },
      },
      ui: { log: () => {} },
    };
    const messages = [
      { role: "user", text: "fix it", handle: "h1" },
      { role: "assistant", text: "Looking first.", handle: "h2", toolUses: [{ tool: "Bash", tool_use_id: "t1", input: { command: "ls" } }] },
      { role: "user", text: "", handle: "h3", toolResults: [{ tool_use_id: "t1", text: "a b" }] },
    ];
    await hooks.get("session.compact")!($, { trigger: "manual", messages }, async (x: unknown) => x);
    assert.deepEqual(appended.messages, [
      { kind: "user", text: "fix it" },
      { kind: "talk", text: "Looking first." },
      { kind: "tool", text: 'Bash {"command":"ls"}', name: "Bash", input: { command: "ls" }, call: "t1" },
      { kind: "echo", text: "Bash: a b", name: "Bash", call: "t1", result: "a b", isError: false },
    ]);
  });
});
