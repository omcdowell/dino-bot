// FF1: a Claude Code bot's summaries can run on the host's pi (any model pi is signed in to) instead of inside the
// bot's own Claude Code session. One summary tree and job queue; only the runner changes. pi is played by fakes.
import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CcEngine, compactorPlan, type CcJob } from "../server/cc/engine";
import { parseRunner, resolveRunner } from "../server/cc/compactor-runner";
import { findPi, parsePiJson, spawnPiRunner, type PiRequest, type PiRunner } from "../server/cc/pi-runner";
import { parseSettings } from "../server/settings";

const TMP = mkdtempSync(join(tmpdir(), "cc-pi-compactor-"));
const open: CcEngine[] = [];
after(async () => {
  for (const e of open) await e.close();
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function profile(name: string, config?: unknown) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  if (config !== undefined) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  return dir;
}
const SOL = { provider: "openai-codex", model: "gpt-6.1-sol", thinking: "low" };
const SONNET = { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" };
const usage = { input: 1200, output: 40, cacheRead: 1000, cacheWrite: 0, totalTokens: 2240, cost: { input: 0.001, output: 0.0004, cacheRead: 0.0001, cacheWrite: 0, total: 0.0015 } };
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Plays the inbox mod: answers every in-session job. */
async function answerJobs(engine: CcEngine, until: () => boolean, line = (_j: CcJob) => "summary line") {
  for (let k = 0; k < 300 && !until(); k++) {
    for (const j of engine.takeJobs(8)) await engine.handle("POST", "/job", new URLSearchParams(), { id: j.id, text: line(j), usage: { input_tokens: 9 }, model: j.model });
    await tick(10);
  }
}
const settled = (e: CcEngine) => () => !e.pendingJobs && !e.memory.pending;

describe("compactor runner setting", () => {
  it("parses in-session (cc, claude-code aliases) and pi; anything else is automatic", () => {
    assert.equal(parseRunner("in-session"), "in-session");
    assert.equal(parseRunner("cc"), "in-session");
    assert.equal(parseRunner("claude-code"), "in-session");
    assert.equal(parseRunner("pi"), "pi");
    assert.equal(parseRunner("auto"), null);
    assert.equal(parseRunner(undefined), null);
    assert.equal(parseRunner(3), null);
  });

  it("per bot wins; a non-Claude model picks pi; then the host default; else in-session", () => {
    assert.deepEqual(resolveRunner({ bot: "pi", compactor: SONNET, host: null }), { runner: "pi", why: "bot" });
    assert.deepEqual(resolveRunner({ bot: "in-session", compactor: SOL, host: "pi" }), { runner: "in-session", why: "bot" });
    assert.deepEqual(resolveRunner({ bot: null, compactor: SOL, host: "in-session" }), { runner: "pi", why: "model" });
    assert.deepEqual(resolveRunner({ bot: null, compactor: SONNET, host: "pi" }), { runner: "pi", why: "host" });
    assert.deepEqual(resolveRunner({ bot: null, compactor: SONNET, host: null }), { runner: "in-session", why: "default" });
    // A Claude model reached through another pi provider is not one Claude Code can run.
    assert.deepEqual(resolveRunner({ bot: null, compactor: { provider: "openrouter", model: "anthropic/claude-sonnet-5-5" }, host: null }), { runner: "pi", why: "model" });
  });

  it("the host default lives in bots settings compactorRunner", () => {
    assert.equal(parseSettings({}).compactorRunner, null);
    assert.equal(parseSettings({ compactorRunner: "pi" }).compactorRunner, "pi");
    assert.equal(parseSettings({ compactorRunner: "cc" }).compactorRunner, "in-session");
    assert.equal(parseSettings({ compactorRunner: "nonsense" }).compactorRunner, null);
  });

  it("compactorPlan reads the profile: runner, the pi model verbatim, the in-session alias", () => {
    const d = profile("plan", { compactor: SOL });
    assert.deepEqual(compactorPlan(d, null), { runner: "pi", why: "model", pi: SOL, inSession: { model: "haiku" } });
    writeFileSync(join(d, "config.json"), JSON.stringify({ compactor: SONNET, compactorRunner: "pi" }));
    assert.deepEqual(compactorPlan(d, null), { runner: "pi", why: "bot", pi: SONNET, inSession: { model: "sonnet", effort: "medium" } });
    writeFileSync(join(d, "config.json"), JSON.stringify({ compactor: SONNET }));
    assert.equal(compactorPlan(d, null).runner, "in-session");
    assert.equal(compactorPlan(d, "pi").runner, "pi");
    // No config.json: pi-optchat's default (Sonnet medium), in-session.
    assert.deepEqual(compactorPlan(profile("plan-none"), null), { runner: "in-session", why: "default", pi: SONNET, inSession: { model: "sonnet", effort: "medium" } });
  });
});

describe("engine with the pi runner", () => {
  it("a non-Claude compactor runs on pi: no in-session job, the line lands, usage logged with runner pi and cost", async () => {
    const dir = profile("e1", { compactor: SOL });
    const calls: PiRequest[] = [];
    const pi: PiRunner = async (req) => {
      calls.push(req);
      return { text: "user greets via pi", usage, model: `${req.provider}/${req.model}` };
    };
    const e = await CcEngine.open("pe1", dir, { pi, hostRunner: () => null });
    open.push(e);
    const seen: any[] = [];
    e.onEvent((ev) => seen.push(ev));
    e.memory.append("user", "hello ".repeat(300));
    for (let k = 0; k < 200 && !settled(e)(); k++) await tick(10);
    assert.equal(e.takeJobs(8).length, 0);
    assert.match(e.memory.render(), /user greets via pi/);
    assert.ok(calls.length >= 1);
    const c = calls[0]!;
    assert.deepEqual([c.provider, c.model, c.thinking, c.cwd], ["openai-codex", "gpt-6.1-sol", "low", dir]);
    assert.match(c.system, /Compaction/);
    assert.match(c.prompt, /Compaction: compress message 0/);
    const u = lines(join(dir, "compactor-usage.jsonl"));
    assert.equal(u[0].runner, "pi");
    assert.equal(u[0].model, "openai-codex/gpt-6.1-sol");
    assert.equal(u[0].usage.cost.total, 0.0015);
    // CU1 merge: a pi-run summary counts in the chat's cost too, at pi's own price.
    const extra = seen.filter((x) => x.type === "extra-usage");
    assert.ok(extra.length >= 1);
    assert.deepEqual([extra[0].costUsd, extra[0].model], [0.0015, "openai-codex/gpt-6.1-sol"]);
    assert.equal(typeof extra[0].tokens.input_tokens, "number");
    const s = (await e.handle("GET", "/status", new URLSearchParams(), {})).json as any;
    assert.equal(s.compactor.runner, "pi");
  });

  it("the too-long retry goes to pi too, quoting the line", async () => {
    const dir = profile("e2", { compactor: SOL });
    const prompts: string[] = [];
    const pi: PiRunner = async (req) => {
      prompts.push(req.prompt);
      return { text: /Too long/.test(req.prompt) ? "short line" : "y".repeat(900), usage, model: "x" };
    };
    const e = await CcEngine.open("pe2", dir, { pi, hostRunner: () => null });
    open.push(e);
    e.memory.append("user", "x".repeat(3000));
    for (let k = 0; k < 200 && !settled(e)(); k++) await tick(10);
    assert.ok(prompts.some((p) => /Your line was:\ny{900}\nToo long: it is 900 bytes/.test(p)));
    assert.match(e.memory.render(), /short line/);
  });

  it("pi failing falls back to in-session (logged), and pi rests for a while before it is tried again", async () => {
    const dir = profile("e3", { compactor: SOL });
    let piCalls = 0;
    const warned: string[] = [];
    const pi: PiRunner = async () => {
      piCalls++;
      return { error: "No API key found for openai-codex." };
    };
    const e = await CcEngine.open("pe3", dir, { pi, hostRunner: () => null, warn: (s) => warned.push(s), piRestMs: 60_000 });
    open.push(e);
    e.memory.append("user", "first ".repeat(300));
    await answerJobs(e, settled(e), () => "summary via claude code");
    assert.match(e.memory.render(), /summary via claude code/);
    assert.equal(piCalls, 1);
    const f = lines(join(dir, "compactor-runner.jsonl"));
    assert.equal(f.length, 1);
    assert.deepEqual([f[0].runner, f[0].fallback, f[0].model], ["pi", "in-session", "openai-codex/gpt-6.1-sol"]);
    assert.match(f[0].error, /No API key/);
    assert.ok(warned.some((w) => /pi compactor failed.*in-session/.test(w)));
    // In-session fallback usage is logged per runner.
    const u = lines(join(dir, "compactor-usage.jsonl"));
    assert.equal(u[0].runner, "in-session");
    assert.equal(u[0].fallbackFrom, "pi");
    assert.equal(u[0].model, "haiku");
    // Resting: the next summary goes in-session without trying pi again.
    e.memory.append("user", "second ".repeat(300));
    await answerJobs(e, settled(e));
    assert.equal(piCalls, 1);
    const s = (await e.handle("GET", "/status", new URLSearchParams(), {})).json as any;
    assert.equal(s.compactor.runner, "pi");
    assert.equal(typeof s.compactor.piRestingUntil, "string");
  });

  it("a thrown pi runner (cannot spawn) also falls back", async () => {
    const dir = profile("e4", { compactor: SOL });
    const pi: PiRunner = async () => {
      throw new Error("spawn pi ENOENT");
    };
    const e = await CcEngine.open("pe4", dir, { pi, hostRunner: () => null });
    open.push(e);
    e.memory.append("user", "third ".repeat(300));
    await answerJobs(e, settled(e), () => "fallback line");
    assert.match(e.memory.render(), /fallback line/);
    assert.match(lines(join(dir, "compactor-runner.jsonl"))[0].error, /ENOENT/);
  });

  it("the host default pi runs a Claude compactor on pi; a Claude one stays in-session by default (usage tagged)", async () => {
    const dir = profile("e5", { compactor: SONNET });
    let runner: "pi" | null = "pi";
    let piCalls = 0;
    const pi: PiRunner = async (req) => (piCalls++, { text: `pi ${req.model}`, usage, model: req.model });
    const e = await CcEngine.open("pe5", dir, { pi, hostRunner: () => runner });
    open.push(e);
    e.memory.append("user", "four ".repeat(300));
    for (let k = 0; k < 200 && !settled(e)(); k++) await tick(10);
    assert.match(e.memory.render(), /pi claude-sonnet-5-5/);
    runner = null;
    e.memory.append("user", "five ".repeat(300));
    const before = piCalls;
    await answerJobs(e, settled(e));
    assert.equal(piCalls, before);
    const u = lines(join(dir, "compactor-usage.jsonl"));
    assert.equal(u.at(-1).runner, "in-session");
    assert.equal(u.at(-1).fallbackFrom, undefined);
  });

  it("an explicit in-session runner with a non-Claude model is honoured (Haiku) but said out loud", async () => {
    const dir = profile("e6", { compactor: SOL, compactorRunner: "in-session" });
    const warned: string[] = [];
    let piCalls = 0;
    const e = await CcEngine.open("pe6", dir, { pi: async () => (piCalls++, { error: "x" }), hostRunner: () => null, warn: (s) => warned.push(s) });
    open.push(e);
    e.memory.append("user", "six ".repeat(300));
    let model = "";
    await answerJobs(e, settled(e), (j) => ((model = j.model), "line"));
    assert.equal(piCalls, 0);
    assert.equal(model, "haiku");
    assert.ok(warned.some((w) => /runs in-session as haiku/.test(w)));
  });
});

describe("pi runner (spawns the pi CLI)", () => {
  const bin = join(TMP, "bin");
  mkdirSync(bin, { recursive: true });
  /** A fake `pi`: records its argv, cwd and stdin, then prints pi's --mode json events. */
  function fakePi(name: string, body: string) {
    const f = join(bin, name);
    writeFileSync(
      f,
      `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input }));
  ${body}
});
`,
    );
    chmodSync(f, 0o755);
    return f;
  }
  const ev = (o: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(o) + "\n")});`;
  const req = (cwd: string): PiRequest => ({ provider: "openai-codex", model: "gpt-6.1-sol", thinking: "low", system: "You compact.", prompt: "VIEW\n\nTASK", cwd });

  it("sends the prompt on stdin, the model, thinking and system prompt as flags, no tools/session/context; reads text and usage", async () => {
    const log = join(TMP, "pi1.json");
    const f = fakePi(
      "pi-ok",
      ev({ type: "session" }) +
        ev({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "VIEW" }] } }) +
        ev({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol", stopReason: "stop", usage, content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: " 0+1| a line " }] } }) +
        ev({ type: "agent_end" }),
    );
    const run = spawnPiRunner({ bin: f, env: { ...process.env, FAKE_PI_LOG: log } });
    const r = await run(req(TMP), new AbortController().signal);
    assert.deepEqual(r, { text: " 0+1| a line ", usage, model: "openai-codex/gpt-6.1-sol" });
    const seen = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(seen.input, "VIEW\n\nTASK");
    assert.equal(seen.cwd, TMP);
    const a: string[] = seen.argv;
    for (const flag of ["-p", "--no-session", "--no-tools", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-mcp"]) assert.ok(a.includes(flag), flag);
    assert.equal(a[a.indexOf("--mode") + 1], "json");
    assert.equal(a[a.indexOf("--model") + 1], "openai-codex/gpt-6.1-sol");
    assert.equal(a[a.indexOf("--thinking") + 1], "low");
    assert.equal(a[a.indexOf("--system-prompt") + 1], "You compact.");
  });

  it("a non-zero exit (not signed in, unknown model) is an error with pi's words", async () => {
    const f = fakePi("pi-nokey", `process.stderr.write("No API key found for openai-codex.\\n"); process.exit(1);`);
    const r = await spawnPiRunner({ bin: f, env: { ...process.env, FAKE_PI_LOG: join(TMP, "pi2.json") } })(req(TMP), new AbortController().signal);
    assert.ok("error" in r);
    assert.match((r as any).error, /No API key found/);
  });

  it("a provider error (stopReason error) is an error with its status", async () => {
    const f = fakePi(
      "pi-429",
      ev({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 rate_limit_error: slow down", usage, content: [] } }) + "process.exit(1);",
    );
    const r = await spawnPiRunner({ bin: f, env: { ...process.env, FAKE_PI_LOG: join(TMP, "pi3.json") } })(req(TMP), new AbortController().signal);
    assert.match((r as any).error, /429/);
    assert.equal((r as any).status, 429);
  });

  it("a missing pi binary is an error, not a crash; an abort kills pi", async () => {
    const r = await spawnPiRunner({ bin: join(TMP, "no-such-pi") })(req(TMP), new AbortController().signal);
    assert.match((r as any).error, /ENOENT|not found/);
    const f = fakePi("pi-slow", "setTimeout(() => {}, 60_000);");
    const ac = new AbortController();
    const p = spawnPiRunner({ bin: f, env: { ...process.env, FAKE_PI_LOG: join(TMP, "pi4.json") } })(req(TMP), ac.signal);
    await tick(200);
    ac.abort();
    await assert.rejects(p, /stop|abort/);
  });

  it("a hung pi times out", async () => {
    const f = fakePi("pi-hang", "setTimeout(() => {}, 60_000);");
    const r = await spawnPiRunner({ bin: f, env: { ...process.env, FAKE_PI_LOG: join(TMP, "pi5.json") }, timeoutMs: 300 })(req(TMP), new AbortController().signal);
    assert.match((r as any).error, /timed out/);
  });

  it("parsePiJson: last assistant message; skips junk lines", () => {
    const out = ["not json", JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", provider: "p", model: "m", usage, content: [{ type: "text", text: "one" }] } })].join("\n");
    assert.deepEqual(parsePiJson(out), { text: "one", usage, model: "p/m" });
    assert.deepEqual(parsePiJson(""), { error: "pi gave no answer" });
  });

  it("findPi: DINOBOT_PI_BIN, else PATH, else ~/.local/bin", () => {
    assert.equal(findPi({ DINOBOT_PI_BIN: "/x/pi" }), "/x/pi");
    const home = join(TMP, "home");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    assert.equal(findPi({ HOME: home, PATH: "" }), null);
    writeFileSync(join(home, ".local", "bin", "pi"), "");
    assert.equal(findPi({ HOME: home, PATH: "" }), join(home, ".local", "bin", "pi"));
    writeFileSync(join(bin, "pi"), "");
    assert.equal(findPi({ HOME: home, PATH: bin }), join(bin, "pi"));
  });
});
