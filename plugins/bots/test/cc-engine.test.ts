// Bots on Claude Code: the engine (OptChat memory, inbox, compaction jobs) the TUI's mods talk to, its loopback host,
// and the Paseo provider that turns the mods' reports into the chat's timeline. The TUI is played by the tests.
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CcEngine, CcHost, compactorModel, type CcJob } from "../server/cc/engine";
import { CcLauncher, ccModsDir, ccProxyFor, envScript } from "../server/cc/launch";
import { createCcProvider, promptText, resolveBot } from "../server/cc/provider";
import { requireProviderCapabilities, type ProviderEvent } from "@getpaseo/plugin/server/provider";

const TMP = mkdtempSync(join(tmpdir(), "cc-engine-"));
const open: CcEngine[] = [];
after(async () => {
  for (const e of open) await e.close();
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** herdr's side of the TUI for these tests: always idle; what is typed is kept (test/cc-deliver.test.ts has more). */
function typing() {
  const typed: string[] = [];
  return { typed, state: async () => "idle", sessionFile: async () => null, clear: async () => {}, prompt: async (t: string) => (typed.push(t), { ok: true as const }) };
}
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(5);
  }
}

/** Plays the inbox mod's compactor: answers every job with a short line naming its task. */
async function answerJobs(engine: CcEngine, line = (j: CcJob) => `summary of ${j.prompt.at(-1)!.text.slice(0, 40)}`) {
  for (let k = 0; k < 200; k++) {
    const jobs = engine.takeJobs(8);
    for (const j of jobs) engine.finishJob(j.id, { text: line(j) });
    if (!engine.pendingJobs && !engine.memory.pending) return;
    await tick(10);
  }
}

describe("cc engine", () => {
  it("delivers an inbox item once, logs the turn with its receipt, and summarises it through jobs", async () => {
    const dir = join(TMP, "p1");
    const tui = typing();
    const e = await CcEngine.open("kit", dir, { delivery: tui, tickMs: 5 });
    open.push(e);
    const events: string[] = [];
    e.onEvent((ev) => events.push(ev.type === "started" ? `started:${ev.id}` : ev.type));
    e.enqueue("hello there", "m1");
    e.enqueue("hello there", "m1"); // the same id again: once
    assert.equal(e.queued, 1);
    await until(() => tui.typed.length === 1);
    assert.deepEqual(tui.typed, ["hello there"]);
    // The inbox mod's hook sees the typed prompt: the ack.
    await e.handle("POST", "/turn", new URLSearchParams(), { running: true, typed: true, text: "hello there", origin: "composer" });
    assert.deepEqual(events, ["started:m1"]);
    // Busy while the turn runs: nothing else is typed.
    e.enqueue("second", "m2");
    await tick(50);
    assert.equal(tui.typed.length, 1);
    await e.handle("POST", "/turn", new URLSearchParams(), { running: false, answered: true });
    const a = await e.handle("POST", "/append", new URLSearchParams(), {
      messages: [
        { kind: "user", text: "hello there" },
        { kind: "talk", text: `Hi! How can I help? ${"Long answer. ".repeat(60)}` },
      ],
    });
    assert.deepEqual((a.json as any).ids, [0, 1]);
    assert.equal(e.memory.root[0]!.receipt, "m1");
    assert.equal(e.queued, 1); // m2 left
    const pending = JSON.parse(readFileSync(join(dir, "pending-inputs.json"), "utf8"));
    assert.deepEqual(pending.map((i: any) => i.id), ["m2"]);
    // The view waits for its summaries: jobs carry the compactor prompt and the task.
    const viewP = e.handle("GET", "/view", new URLSearchParams("settle=5000"), {});
    await tick(50);
    const jobs = e.takeJobs(8);
    assert.ok(jobs.length >= 1);
    assert.match(jobs[0]!.system, /Compaction/);
    assert.match(jobs[0]!.prompt.at(-1)!.text, /^Compaction: compress message 1/);
    for (const j of jobs) e.finishJob(j.id, { text: "user greets" });
    await answerJobs(e);
    const v = await viewP;
    assert.equal(v.status, 200);
    assert.match((v.json as any).view, /user greets/);
    // Memory tools.
    const z = await e.handle("POST", "/tool", new URLSearchParams(), { name: "zoom", arguments: { id: 1, n: 1 } });
    assert.match((z.json as any).text, /How can I help/);
    const s = await e.handle("POST", "/tool", new URLSearchParams(), { name: "search_memory", arguments: { query: "hello" } });
    assert.match((s.json as any).text, /hello there/);
  });

  it("a restarted TUI (hello): the message its turn died with is logged as unanswered, not typed again; a busy profile is refused", async () => {
    const dir = join(TMP, "p2");
    const tui = typing();
    const e = await CcEngine.open("kit2", dir, { delivery: tui, tickMs: 5 });
    open.push(e);
    e.enqueue("do it", "x1");
    await until(() => tui.typed.length === 1);
    await e.handle("POST", "/turn", new URLSearchParams(), { running: true, typed: true, text: "do it" });
    assert.equal(e.cancel("x1"), false); // in its turn: not dropped
    e.setDelivery(undefined);
    await e.handle("POST", "/hello", new URLSearchParams(), {});
    assert.equal(((await e.handle("GET", "/status", new URLSearchParams(), {})).json as any).inbox, 0);
    assert.equal(e.memory.root.at(-1)!.receipt, "x1");
    await assert.rejects(CcEngine.open("kit2", dir), /already running/);
    assert.equal(e.cancel("x1"), false);
    assert.equal(e.queued, 0);
  });

  it("a line over the limit is asked for again, quoting it", async () => {
    const dir = join(TMP, "p3");
    const e = await CcEngine.open("kit3", dir);
    open.push(e);
    e.memory.append("user", "x".repeat(3000));
    let asked = "";
    await answerJobs(e, (j) => {
      const t = j.prompt.at(-1)!.text;
      if (/Too long/.test(t)) return ((asked = t), "short line");
      return "y".repeat(900);
    });
    assert.match(asked, /Your line was:\ny{900}\nToo long: it is 900 bytes/);
    assert.match(e.memory.render(), /short line/);
  });

  it("an API error from the TUI is the compactor's error (status kept for Memory's retry rules)", async () => {
    const dir = join(TMP, "p4");
    const e = await CcEngine.open("kit4", dir);
    open.push(e);
    e.memory.append("user", "hi ".repeat(400));
    await tick(30);
    const [j] = e.takeJobs(1);
    e.finishJob(j!.id, { error: "api-error rate_limit", status: 429 });
    await tick(30);
    assert.match(readFileSync(join(dir, "compactor-errors.jsonl"), "utf8"), /429/);
  });

  it("compactor model: the family of the profile's Anthropic one, else haiku", () => {
    const d = join(TMP, "m");
    mkdirSync(d, { recursive: true });
    assert.deepEqual(compactorModel(d), { model: "sonnet", effort: "medium" });
    writeFileSync(join(d, "config.json"), JSON.stringify({ compactor: { provider: "openai-codex", model: "gpt-6", thinking: "low" } }));
    assert.deepEqual(compactorModel(d), { model: "haiku" });
    writeFileSync(join(d, "config.json"), JSON.stringify({ compactor: { provider: "anthropic", model: "claude-haiku-5-5", thinking: "off" } }));
    assert.deepEqual(compactorModel(d), { model: "haiku" });
  });
});

describe("cc host", () => {
  it("serves each bot on loopback with its own token; engine.json is 0600", async () => {
    const host = new CcHost(join(TMP, "state"));
    const e = await host.engine("hb", join(TMP, "hb"));
    const info = JSON.parse(readFileSync(join(TMP, "state", "hb", "engine.json"), "utf8"));
    assert.equal(statSync(join(TMP, "state", "hb", "engine.json")).mode & 0o777, 0o600);
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/b\/hb$/);
    const bad = await fetch(`${info.url}/status`, { headers: { authorization: "Bearer nope" } });
    assert.equal(bad.status, 401);
    const good = await fetch(`${info.url}/status`, { headers: { authorization: `Bearer ${info.token}` } });
    assert.equal(good.status, 200);
    assert.equal(((await good.json()) as any).total, 0);
    assert.equal(await host.engine("hb", join(TMP, "hb")), e);
    await host.close();
  });
});

describe("cc provider", () => {
  it("a prompt goes to the inbox; the TUI's reports become the chat's timeline", async () => {
    const root = join(TMP, "bots");
    mkdirSync(join(root, "kit"), { recursive: true });
    writeFileSync(join(root, "kit", ".optchat-profile"), "kit\n");
    const host = new CcHost(join(root, ".cc"));
    const ensured: string[] = [];
    const tui = typing();
    const launcher = { ensure: async (bot: string) => void ensured.push(bot), interrupt: async () => {}, running: async () => true, delivery: () => tui };
    const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(TMP, "oc") });
    const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "session.persistence"] });
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "kit"), env: {}, mcpServers: {}, settings: {}, persist: true } });
    await tick(50);
    assert.deepEqual(events.map((e) => e.type), ["session.opened", "session.config", "session.commands", "session.ready"]);
    assert.deepEqual(ensured, ["kit"]);
    await conn.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "c1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hi kit" }] } } });
    await tick(20);
    const engine = host.engines.get("kit")!;
    assert.equal(engine.queued, 1);
    // The engine types it; the TUI's hook acks it and reports back.
    await until(() => tui.typed.length === 1, 3000);
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: true, typed: true, text: "hi kit", origin: "composer" });
    await engine.handle("POST", "/event", new URLSearchParams(), { type: "tool", phase: "running", id: "tu1", name: "Bash", input: { command: "ls" } });
    await engine.handle("POST", "/event", new URLSearchParams(), { type: "tool", phase: "done", id: "tu1", name: "Bash", input: { command: "ls" }, output: "a b", isError: false });
    await engine.handle("POST", "/event", new URLSearchParams(), { type: "step", answer: "Hello!" });
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: false, answered: true });
    // A prompt typed in the TUI shows too, as its own turn.
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: true, typed: true, text: "<chat>\nview\n</chat>\n\ntyped here" });
    const shown = events.slice(4).map((e) =>
      e.type === "timeline.item" ? `${e.item.type}:${(e.item as any).text ?? (e.item as any).status}` : e.type === "session.turn" ? `turn:${e.turnId}:${e.state}` : e.type,
    );
    assert.deepEqual(shown, [
      "user_message:hi kit",
      "session.prompt_result",
      "turn:c1:started",
      "tool_call:running",
      "tool_call:completed",
      "assistant_message:Hello!",
      "turn:c1:completed",
      "user_message:typed here",
      shown.at(-1)!,
    ]);
    assert.match(shown.at(-1)!, /^turn:t-.+:started$/);
    // Both the running and the finished row carry the command, so the app shows it while the tool runs.
    const calls = events.flatMap((e) => (e.type === "timeline.item" && e.item.type === "tool_call" ? [e.item] : []));
    assert.deepEqual(
      calls.map((c) => [c.id, c.status, c.detail]),
      [
        ["c-tu1", "running", { type: "shell", command: "ls" }],
        ["c-tu1", "completed", { type: "shell", command: "ls", output: "a b", exitCode: 0 }],
      ],
    );
    await conn.close();
    await host.close();
  });

  it("a message steered while a turn runs is taken for that turn (prompt.steer), then typed once the TUI is free", async () => {
    const root = join(TMP, "bots-steer");
    mkdirSync(join(root, "nemo"), { recursive: true });
    writeFileSync(join(root, "nemo", ".optchat-profile"), "nemo\n");
    const host = new CcHost(join(root, ".cc"));
    const tui = typing();
    const launcher = { ensure: async () => {}, interrupt: async () => {}, running: async () => true, delivery: () => tui };
    const provider = createCcProvider({ host, launcher: launcher as any, botsRoot: root, optchatHome: join(TMP, "oc") });
    // Paseo offers every capability; the provider must keep prompt.steer, or Paseo refuses a steer before it gets here.
    const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "prompt.steer", "session.persistence", "session.configure"] });
    // Paseo's own check ("Could not send now: Provider does not support prompt.steer" on the app).
    const steer = { clientMessageId: "x", delivery: "steer" as const, input: { type: "message" as const, content: [{ type: "text" as const, text: "x" }] } };
    assert.doesNotThrow(() => requireProviderCapabilities(conn.capabilities, { type: "session.prompt", sessionId: "s1", prompt: steer }));
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));
    await conn.send({ type: "session.open", requestId: "r1", sessionId: "s1", history: "skip", config: { cwd: join(root, "nemo"), env: {}, mcpServers: {}, settings: {}, persist: true } });
    await tick(50);
    const engine = host.engines.get("nemo")!;
    const msg = (id: string, text: string, delivery: "auto" | "steer") =>
      conn.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: id, delivery, input: { type: "message", content: [{ type: "text", text }] } } });
    const result = (id: string) => events.find((e) => e.type === "session.prompt_result" && e.clientMessageId === id) as any;

    // No turn runs: nothing to steer into. Paseo then sends it as a turn of its own.
    await msg("early", "too early", "steer");
    await tick(20);
    assert.equal(result("early").result.type, "failed");
    assert.equal(engine.queued, 0);

    await msg("c1", "long job", "auto");
    await until(() => tui.typed.length === 1);
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: true, typed: true, text: "long job", origin: "composer" });
    const from = events.length;
    // Sent while c1 runs: accepted for c1 (Paseo checks the turn id), not a turn of its own.
    await msg("c2", "also this", "steer");
    await tick(20);
    assert.deepEqual(result("c2").result, { type: "steer", turnId: "c1" });
    assert.equal(engine.itemText("c2"), "also this"); // in the inbox
    assert.equal(tui.typed.length, 1); // never typed into a running turn
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: false, answered: true });
    await engine.handle("POST", "/append", new URLSearchParams(), { messages: [{ kind: "user", text: "long job" }, { kind: "talk", text: "Working on it." }] });
    // The TUI is free: the steered text is typed and runs as the next turn, shown once.
    await until(() => tui.typed.length === 2);
    assert.equal(tui.typed[1], "also this");
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: true, typed: true, text: "also this", origin: "composer" });
    await engine.handle("POST", "/event", new URLSearchParams(), { type: "step", answer: "Done both." });
    await engine.handle("POST", "/turn", new URLSearchParams(), { running: false, answered: true });
    const shown = events.slice(from).map((e) =>
      e.type === "timeline.item" ? `${e.item.type}:${(e.item as any).text}` : e.type === "session.turn" ? `turn:${e.turnId}:${e.state}` : e.type,
    );
    assert.deepEqual(shown, [
      "user_message:also this",
      "session.prompt_result",
      "turn:c1:completed",
      "turn:c2:started",
      "assistant_message:Done both.",
      "turn:c2:completed",
    ]);
    await conn.close();
    await host.close();
  });

  it("finds the bot and its profile from the chat's folder", () => {
    const root = join(TMP, "bots2");
    mkdirSync(join(root, "ada"), { recursive: true });
    writeFileSync(join(root, "ada", ".optchat-profile"), "ada-p\n");
    assert.deepEqual(resolveBot(join(root, "ada"), root, "/oc"), { bot: "ada", profileDir: "/oc/profiles/ada-p" });
    assert.throws(() => resolveBot("/elsewhere/ada", root, "/oc"), /bot folder/);
  });

  it("images are kept in the profile and named by path; the pane env drops any Claude API route", () => {
    const dir = join(TMP, "img");
    const text = promptText([{ type: "text", text: "look" }, { type: "image", data: Buffer.from("png!").toString("base64"), mimeType: "image/png" }], dir);
    assert.match(text, /^look\n\[image: .+\/images\/[0-9a-f]{64}\.png \(read the file to see it\)\]$/);
    const sh = envScript({ PASEO_AGENT_ID: "a1", ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "/c", Q: "it's" });
    assert.doesNotMatch(sh, /ANTHROPIC|CLAUDE_CONFIG_DIR/);
    assert.match(sh, /export PASEO_AGENT_ID='a1'/);
    assert.match(sh, /export Q='it'\\''s'/);
  });
});

describe("cc pane env: no PASEO_HOST next to PASEO_HOME (bot-dm would refuse: both set)", () => {
  it("env.sh drops PASEO_HOST, keeps PASEO_HOME, and unsets a PASEO_HOST the pane's shell set (~/.bashrc)", () => {
    const sh = envScript({ PASEO_HOME: "/h/.paseo", PASEO_HOST: "100.1.2.3:6767", PASEO_AGENT_ID: "a1" });
    assert.doesNotMatch(sh, /^export PASEO_HOST/m);
    assert.match(sh, /^unset PASEO_HOST$/m);
    assert.match(sh, /^export PASEO_HOME='\/h\/.paseo'$/m);
    const file = join(mkdtempSync(join(TMP, "envsh-")), "env.sh");
    writeFileSync(file, sh);
    const r = spawnSync("bash", ["-c", `export PASEO_HOST=100.1.2.3:6767; . '${file}'; printf '%s|%s' "\${PASEO_HOST-none}" "$PASEO_HOME"`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(r.stdout, "none|/h/.paseo");
  });
});

describe("cc proxy (opt-in Anthropic API route for a bot's TUI)", () => {
  it("unset: no proxy, and the pane env drops every ANTHROPIC_*; set: only the proxy's base URL and token go back", () => {
    const dir = mkdtempSync(join(TMP, "proxy-"));
    const inherited = { PASEO_AGENT_ID: "a1", ANTHROPIC_BASE_URL: "http://daemon", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" };
    // Unset: no .bot.json cc, no DINOBOT_CC_BASE_URL (the daemon's own ANTHROPIC_BASE_URL does not count).
    assert.equal(ccProxyFor(dir, inherited), null);
    assert.doesNotMatch(envScript(inherited, ccProxyFor(dir, inherited)), /ANTHROPIC/);
    // Daemon-wide fallback, token default "proxy".
    const viaEnv = ccProxyFor(dir, { ...inherited, DINOBOT_CC_BASE_URL: "http://gw:8080/a" });
    assert.deepEqual(viaEnv, { baseUrl: "http://gw:8080/a", authToken: "proxy" });
    // Per bot (.bot.json cc) wins over the env; a token may be given.
    writeFileSync(join(dir, ".bot.json"), JSON.stringify({ name: "Ada", chat: { provider: "optchat-cc" }, cc: { baseUrl: "http://gw:8080/team" } }));
    const proxy = ccProxyFor(dir, { DINOBOT_CC_BASE_URL: "http://other", DINOBOT_CC_AUTH_TOKEN: "tok" })!;
    assert.deepEqual(proxy, { baseUrl: "http://gw:8080/team", authToken: "tok" });
    const sh = envScript(inherited, proxy);
    assert.match(sh, /^export ANTHROPIC_BASE_URL='http:\/\/gw:8080\/team'$/m);
    assert.match(sh, /^export ANTHROPIC_AUTH_TOKEN='tok'$/m);
    assert.doesNotMatch(sh, /ANTHROPIC_API_KEY|http:\/\/daemon/);
    // Not a URL: ignored.
    writeFileSync(join(dir, ".bot.json"), JSON.stringify({ cc: { baseUrl: "gw:8080" } }));
    assert.equal(ccProxyFor(dir, {}), null);
  });

  it("the mods folder: PASEO_BOTS_CC_DIR, else the bots plugin's folder from Paseo's config (a checkout), else the install", () => {
    const d = mkdtempSync(join(TMP, "mods-"));
    const plugin = join(d, "checkout", "plugins", "bots");
    mkdirSync(join(plugin, "claude-code"), { recursive: true });
    writeFileSync(join(plugin, "claude-code", "start-bot.sh"), "");
    mkdirSync(join(d, "paseo"));
    writeFileSync(join(d, "paseo", "config.json"), JSON.stringify({ plugins: { bots: { source: "directory", path: plugin } } }));
    assert.equal(ccModsDir({ PASEO_BOTS_CC_DIR: "/x", PASEO_HOME: join(d, "paseo") }), "/x");
    assert.equal(ccModsDir({ PASEO_HOME: join(d, "paseo"), HOME: d }), join(plugin, "claude-code"));
    assert.equal(ccModsDir({ PASEO_HOME: join(d, "none"), HOME: d }), join(d, ".dinobot", "app", "bots", "claude-code"));
  });

  it("the launcher: a proxied bot gets its own Claude config folder and CC_PROXY; an unproxied one keeps the login", async () => {
    const calls: Array<{ bin: string; env: NodeJS.ProcessEnv }> = [];
    const launcher = new CcLauncher({
      herdrEnv: () => ({ PATH: "/usr/bin:/bin" }),
      script: "/x/start-bot.sh",
      run: async (bin, _args, env) => (calls.push({ bin, env }), { code: bin === "herdr" ? 1 : 0, stdout: "", stderr: "" }),
    });
    const fakeClaude = mkdtempSync(join(TMP, "claude-bin-"));
    writeFileSync(join(fakeClaude, "claude"), "");
    const base = { DINOBOT_CLAUDE_BIN: join(fakeClaude, "claude"), DINOBOT_CLAUDE_CONFIG_DIR: "/plan-login", ANTHROPIC_BASE_URL: "http://daemon" };
    const bot = mkdtempSync(join(TMP, "bot-"));
    const state = mkdtempSync(join(TMP, "state-"));
    await launcher.ensure("ada", { cwd: bot, stateDir: state, env: base });
    let sh = calls.at(-1)!;
    assert.equal(sh.env.CC_PROXY, undefined);
    assert.equal(sh.env.DINOBOT_CLAUDE_CONFIG_DIR, "/plan-login");
    assert.doesNotMatch(readFileSync(join(state, "env.sh"), "utf8"), /ANTHROPIC/);
    writeFileSync(join(bot, ".bot.json"), JSON.stringify({ cc: { baseUrl: "http://gw:8080/team" } }));
    await launcher.ensure("ada", { cwd: bot, stateDir: state, env: base });
    sh = calls.at(-1)!;
    assert.equal(sh.env.CC_PROXY, "1");
    assert.equal(sh.env.DINOBOT_CLAUDE_CONFIG_DIR, join(state, "claude-config"));
    const file = readFileSync(join(state, "env.sh"), "utf8");
    assert.match(file, /^export ANTHROPIC_BASE_URL='http:\/\/gw:8080\/team'$/m);
    assert.equal(statSync(join(state, "env.sh")).mode & 0o777, 0o600);
  });
});

describe("start-bot.sh (the cc workers' launch-cc.sh, for a bot)", () => {
  it("starts claude in a new herdr tab with the OptChat mods, the bot's tools, no worker skills, the plan login only", () => {
    const d = mkdtempSync(join(TMP, "launch-"));
    const bin = join(d, "bin");
    mkdirSync(bin);
    const log = join(d, "herdr.log");
    // A fake herdr: logs each call; no agent cc-kit yet, no "bots" workspace.
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh
printf '%s\\n' "$*" >>${JSON.stringify(log)}
case "$1 $2" in
  "agent get") exit 1 ;;
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w1"},"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}' ;;
  "agent start") echo '{"result":{"agent":{"agent_session":{"value":"/s/x.jsonl"}}}}' ;;
esac
exit 0
`,
    );
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "herdr"), 0o755);
    chmodSync(join(bin, "claude"), 0o755);
    const ccdir = join(d, "state", "kit");
    mkdirSync(ccdir, { recursive: true });
    writeFileSync(join(ccdir, "env.sh"), "export X=1\n");
    const cfg = join(d, "claude-cfg");
    const r = spawnSync("sh", [join(__dirname, "..", "claude-code", "start-bot.sh")], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: d, BOT: "kit", CWD: d, CCDIR: ccdir, DINOBOT_CLAUDE_CONFIG_DIR: cfg, CC_WORKER_MODEL: "sonnet", CC_WORKER_EFFORT: "high" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { pane: "w1:p1", tab: "w1:t1", session_file: "/s/x.jsonl" });
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /workspace create --cwd .+ --label bots --no-focus/);
    assert.match(calls, /tab rename w1:t1 cc-kit/);
    assert.match(calls, new RegExp(`pane run w1:p1 \\. '${ccdir}/env.sh'`));
    assert.match(calls, /pane run w1:p1 unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL/);
    assert.match(calls, new RegExp(`export CLAUDE_CONFIG_DIR='${cfg}'`));
    // launch-cc.sh (bots and cc workers): PASEO_HOST from the pane's ~/.bashrc goes when PASEO_HOME is set, before claude.
    const lines = calls.split("\n");
    const clear = lines.findIndex((l) => l.startsWith("pane run w1:p1 ") && l.includes("unset PASEO_HOST"));
    assert.ok(clear >= 0 && clear < lines.findIndex((l) => l.startsWith("agent start")), calls);
    const cmd = lines[clear].slice("pane run w1:p1 ".length);
    const inPane = (pre: string) => spawnSync("bash", ["-c", `${pre}; ${cmd}; printf '%s' "\${PASEO_HOST-none}"`], { encoding: "utf8" }).stdout;
    assert.equal(inPane("export PASEO_HOME=/h/.paseo PASEO_HOST=1.2.3.4:6767"), "none");
    assert.equal(inPane("unset PASEO_HOME; export PASEO_HOST=1.2.3.4:6767"), "1.2.3.4:6767");
    const start = calls.split("\n").find((l) => l.startsWith("agent start"))!;
    assert.match(start, /^agent start cc-kit --kind claude --pane w1:p1 --timeout 60000 -- --model sonnet --effort high /);
    for (const m of ["view", "trigger", "inbox"]) assert.match(start, new RegExp(`--plugin-dir \\S+/claude-code/${m}( |$)`));
    assert.match(start, /--tools Read,Edit,Write,Bash,Grep,Glob,WebSearch,WebFetch,zoom,date,search_memory /);
    assert.match(start, /--disable-slash-commands/);
    // No worker skills in the session plugin; first-run screens marked done.
    assert.equal(spawnSync("ls", [join(ccdir, "plugin", "skills")], { encoding: "utf8" }).stdout.trim(), "");
    const settings = JSON.parse(readFileSync(join(ccdir, "settings.json"), "utf8"));
    assert.ok(!settings.permissions.allow.includes("zoom")); // lowercase rules stop the TUI at a settings warning
    assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(settings.showThinkingSummaries, true); // else Opus 5.x thinking reaches the mods empty
    // The workers' 200k cap is not for a bot (OptChat compacts after each turn, as for a pi bot).
    assert.equal(settings.autoCompactWindow, undefined);
    assert.equal(JSON.parse(readFileSync(join(cfg, ".claude.json"), "utf8")).hasCompletedOnboarding, true);
  });

  it("CC_BOTS_WORKSPACE: a workspace of its own (the release smoke test), never a tab in the bots' workspace", () => {
    const d = mkdtempSync(join(TMP, "launch-ws-"));
    const bin = join(d, "bin");
    mkdirSync(bin);
    const log = join(d, "herdr.log");
    // A "bots" workspace exists (the live bots'): the smoke test's bot must not land in it.
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh
printf '%s\\n' "$*" >>${JSON.stringify(log)}
case "$1 $2" in
  "agent get") exit 1 ;;
  "workspace list") echo '{"result":{"workspaces":[{"label":"bots","workspace_id":"w9"}]}}' ;;
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w2"},"tab":{"tab_id":"w2:t1"},"root_pane":{"pane_id":"w2:p1"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w9:t2"},"root_pane":{"pane_id":"w9:p2"}}}' ;;
  "agent start") echo '{"result":{"agent":{"agent_session":{"value":"/s/z.jsonl"}}}}' ;;
esac
exit 0
`,
    );
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "herdr"), 0o755);
    chmodSync(join(bin, "claude"), 0o755);
    const ccdir = join(d, "state", "smk");
    mkdirSync(ccdir, { recursive: true });
    writeFileSync(join(ccdir, "env.sh"), "export X=1\n");
    const r = spawnSync("sh", [join(__dirname, "..", "claude-code", "start-bot.sh")], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: d, BOT: "smk", CWD: d, CCDIR: ccdir, DINOBOT_CLAUDE_CONFIG_DIR: join(d, "cfg"), CC_BOTS_WORKSPACE: "ccsmoke-smk" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { pane: "w2:p1", tab: "w2:t1", session_file: "/s/z.jsonl" });
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /workspace create --cwd .+ --label ccsmoke-smk --no-focus/);
    assert.doesNotMatch(calls, /tab create/);
  });

  it("through the owner's proxy (CC_PROXY=1): the shell's Claude API route is cleared before env.sh, no plan-login unset after it", () => {
    const d = mkdtempSync(join(TMP, "launch-proxy-"));
    const bin = join(d, "bin");
    mkdirSync(bin);
    const log = join(d, "herdr.log");
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh
printf '%s\\n' "$*" >>${JSON.stringify(log)}
case "$1 $2" in
  "agent get") exit 1 ;;
  "workspace list") echo '{"result":{"workspaces":[{"label":"bots","workspace_id":"w9"}]}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w9:t2"},"root_pane":{"pane_id":"w9:p2"}}}' ;;
  "agent start") echo '{"result":{"agent":{"agent_session":{"value":"/s/y.jsonl"}}}}' ;;
esac
exit 0
`,
    );
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "herdr"), 0o755);
    chmodSync(join(bin, "claude"), 0o755);
    const ccdir = join(d, "state", "ada");
    mkdirSync(ccdir, { recursive: true });
    writeFileSync(join(ccdir, "env.sh"), "export ANTHROPIC_BASE_URL='http://gw'\nexport ANTHROPIC_AUTH_TOKEN='proxy'\n");
    const cfg = join(ccdir, "claude-config");
    const r = spawnSync("sh", [join(__dirname, "..", "claude-code", "start-bot.sh")], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: d, BOT: "ada", CWD: d, CCDIR: ccdir, DINOBOT_CLAUDE_CONFIG_DIR: cfg, CC_PROXY: "1", CC_PLAN_LOGIN: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = readFileSync(log, "utf8").split("\n");
    const envLine = calls.findIndex((l) => l.includes(`. '${ccdir}/env.sh'`));
    assert.ok(envLine >= 0);
    assert.match(calls[envLine], /^pane run w9:p2 unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL .*; \. '/);
    // Nothing clears the proxy after env.sh.
    assert.ok(!calls.slice(envLine + 1).some((l) => /unset .*ANTHROPIC/.test(l)), calls.join("\n"));
    assert.ok(calls.some((l) => l.includes(`export CLAUDE_CONFIG_DIR='${cfg}'`)));
    assert.ok(calls.some((l) => l.startsWith("agent start cc-ada --kind claude --pane w9:p2")));
    assert.equal(JSON.parse(readFileSync(join(cfg, ".claude.json"), "utf8")).hasCompletedOnboarding, true);
  });
});

describe("new bot chats on Claude Code", () => {
  it("no pi model chosen and a Claude plan login: optchat-cc; a pi model or no login: OptChat on pi; .bot.json can ask", async () => {
    const { createChat, setClaudeCodeReady, setDefaultChatModel } = await import("../server/bots");
    const made: unknown[] = [];
    const paseo = {
      config: { get: async () => ({}) },
      workspaces: { open: async () => ({ agents: { create: async (o: { config: unknown }) => (made.push(o.config), { id: "a" }) } }) },
    } as any;
    const dir = join(TMP, "bots3", "bo");
    mkdirSync(dir, { recursive: true });
    const bot = { id: "bo", cwd: dir, name: "Bo" } as any;
    setClaudeCodeReady(async () => true);
    setDefaultChatModel(null);
    await createChat(bot, paseo);
    setClaudeCodeReady(async () => false);
    await createChat(bot, paseo);
    setClaudeCodeReady(async () => true);
    setDefaultChatModel("openai-codex/gpt-6");
    await createChat(bot, paseo);
    writeFileSync(join(dir, ".bot.json"), JSON.stringify({ chat: { provider: "optchat-cc/sonnet" } }));
    await createChat(bot, paseo);
    setDefaultChatModel(null);
    setClaudeCodeReady(async () => false);
    assert.deepEqual(made, [{ provider: "optchat-cc" }, { provider: "optchat" }, { provider: "optchat/openai-codex/gpt-6" }, { provider: "optchat-cc/sonnet" }]);
  });
});
