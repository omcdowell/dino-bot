import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotFiles, CHATGPT_COMPACTOR, CLAUDE_COMPACTOR, DEFAULT_COMPACTOR, ManageError, piSignIns, signInCompactor } from "../server/manage";
import { compactorModelId, compactorFromModelId, compactorLabel, runnerNote, runnerPreview } from "../shared/compactor";

/** A bot not on Claude Code with the default (Claude) compactor: automatic, which is in-session. */
const PI_BOT = { runner: "auto", effectiveRunner: "in-session", ccBot: false, hostRunner: null } as const;

function host() {
  const base = mkdtempSync(join(process.env.BM_TEST_TMP ?? tmpdir(), "compactor-"));
  const root = join(base, "bots");
  const optchatHome = join(base, "optchat");
  for (const bot of ["alpha", "beta"]) {
    mkdirSync(join(root, bot), { recursive: true });
    writeFileSync(join(root, bot, ".optchat-profile"), `${bot}\n`);
    mkdirSync(join(optchatHome, "profiles", bot), { recursive: true });
  }
  const pi = join(base, "pi"); // no auth.json: nothing signed in, whatever this computer has
  return { base, root, optchatHome, pi, files: new BotFiles({ root, optchatHome, piAgentDir: pi }), profile: (b: string) => join(optchatHome, "profiles", b), done: () => rmSync(base, { recursive: true, force: true }) };
}

test("compactor: reads config.json, defaults without one", async () => {
  const h = host();
  try {
    assert.deepEqual(await h.files.compactor("alpha"), { ...DEFAULT_COMPACTOR, isDefault: true, ...PI_BOT });
    writeFileSync(join(h.profile("beta"), "config.json"), JSON.stringify({ compactor: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low" } }));
    assert.deepEqual(await h.files.compactor("beta"), { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low", isDefault: false, runner: "auto", effectiveRunner: "pi", ccBot: false, hostRunner: null });
  } finally {
    h.done();
  }
});

test("setCompactor keeps every other key and their order, keeps a .bak and the mode", async () => {
  const h = host();
  try {
    const path = join(h.profile("beta"), "config.json");
    const before = { compactor: { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" }, subagent: { provider: "anthropic", model: "claude-opus-5-5", thinking: "high" }, subagentLevels: 1, previousExchangeKB: 16 };
    writeFileSync(path, `${JSON.stringify(before, null, 2)}\n`, { mode: 0o600 });
    const glm = { provider: "openrouter", model: "z-ai/glm-5.3", thinking: "high" as const };
    assert.deepEqual(await h.files.setCompactor("beta", glm), { ...glm, isDefault: false, runner: "auto", effectiveRunner: "pi", ccBot: false, hostRunner: null });
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(Object.keys(after), Object.keys(before));
    assert.deepEqual(after, { ...before, compactor: glm });
    assert.deepEqual(JSON.parse(readFileSync(`${path}.bak`, "utf8")), before);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    h.done();
  }
});

test("setCompactor: a profile without config.json gets pi-optchat's minimal one; bad input and bad files are refused", async () => {
  const h = host();
  try {
    await h.files.setCompactor("alpha", { provider: "anthropic", model: "claude-haiku-5-5", thinking: "low" });
    const written = JSON.parse(readFileSync(join(h.profile("alpha"), "config.json"), "utf8"));
    assert.deepEqual(written.compactor, { provider: "anthropic", model: "claude-haiku-5-5", thinking: "low" });
    // No fixed Opus: the host workers model, else the compactor itself (upstream needs the key).
    assert.equal(written.subagent.model, "claude-haiku-5-5");

    await assert.rejects(h.files.setCompactor("alpha", { provider: "a", model: "b", thinking: "loud" as never }), ManageError);
    writeFileSync(join(h.profile("beta"), "config.json"), "{ nope");
    await assert.rejects(h.files.setCompactor("beta", { provider: "a", model: "b", thinking: "low" }), /does not parse/);
    assert.equal(readFileSync(join(h.profile("beta"), "config.json"), "utf8"), "{ nope");
    await assert.rejects(h.files.setCompactor("nobody", { provider: "a", model: "b", thinking: "low" }), ManageError);
  } finally {
    h.done();
  }
});

test("compactor runner (FF1): per bot in config.json, automatic by default; ccBot from the Claude Code engine state", async () => {
  const h = host();
  try {
    const path = join(h.profile("beta"), "config.json");
    const sonnet = { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" as const };
    writeFileSync(path, `${JSON.stringify({ compactor: sonnet, subagent: sonnet }, null, 2)}\n`);
    mkdirSync(join(h.root, ".cc", "beta"), { recursive: true });
    writeFileSync(join(h.root, ".cc", "beta", "engine.json"), "{}");
    assert.deepEqual(await h.files.compactor("beta"), { ...sonnet, isDefault: false, runner: "auto", effectiveRunner: "in-session", ccBot: true, hostRunner: null });
    // The host default applies to automatic bots.
    writeFileSync(join(h.root, ".settings.json"), JSON.stringify({ compactorRunner: "pi" }));
    assert.equal((await h.files.compactor("beta")).effectiveRunner, "pi");
    assert.equal((await h.files.compactor("beta")).hostRunner, "pi");
    writeFileSync(join(h.root, ".settings.json"), "{}");
    // Set: pi is written next to compactor; auto removes it; leaving it out keeps it.
    assert.deepEqual(await h.files.setCompactor("beta", sonnet, "pi"), { ...sonnet, isDefault: false, runner: "pi", effectiveRunner: "pi", ccBot: true, hostRunner: null });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).compactorRunner, "pi");
    await h.files.setCompactor("beta", sonnet);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).compactorRunner, "pi");
    await h.files.setCompactor("beta", sonnet, "in-session");
    assert.equal((await h.files.compactor("beta")).runner, "in-session");
    await h.files.setCompactor("beta", sonnet, "auto");
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal("compactorRunner" in after, false);
    assert.deepEqual(Object.keys(after), ["compactor", "subagent"]);
    // A value the host does not know reads as automatic.
    writeFileSync(path, JSON.stringify({ compactor: sonnet, compactorRunner: "gpu" }));
    assert.equal((await h.files.compactor("beta")).runner, "auto");
  } finally {
    h.done();
  }
});

test("compactor <-> Paseo model id", () => {
  assert.equal(compactorModelId({ provider: "openrouter", model: "z-ai/glm-5.3" }), "openrouter/z-ai/glm-5.3");
  assert.deepEqual(compactorFromModelId("openrouter/z-ai/glm-5.3", "high"), { provider: "openrouter", model: "z-ai/glm-5.3", thinking: "high" });
  assert.deepEqual(compactorFromModelId("anthropic/claude-sonnet-5-5", "nonsense"), { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" });
  assert.equal(compactorFromModelId("bare", "low"), null);
  assert.equal(compactorLabel({ provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" }), "anthropic/claude-sonnet-5-5 · medium");
});

test("sign-in compactor (owner, 15 Nov): Claude Sonnet 5.5 medium, ChatGPT GPT-6.1 Sol low, else none", () => {
  assert.deepEqual(CLAUDE_COMPACTOR, { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" });
  assert.deepEqual(CHATGPT_COMPACTOR, { provider: "openai-codex", model: "gpt-6.1-sol", thinking: "low" });
  assert.deepEqual(signInCompactor({ chatProvider: "optchat-cc/opus", piSignIns: [] }), CLAUDE_COMPACTOR);
  assert.deepEqual(signInCompactor({ chatProvider: "optchat-cc", piSignIns: ["openai-codex"] }), CLAUDE_COMPACTOR);
  assert.deepEqual(signInCompactor({ chatProvider: null, piSignIns: ["anthropic", "openai-codex"] }), CLAUDE_COMPACTOR, "Claude first");
  assert.deepEqual(signInCompactor({ chatProvider: "optchat/openai-codex/gpt-6-sol", piSignIns: ["openai-codex"] }), CHATGPT_COMPACTOR);
  assert.equal(signInCompactor({ chatProvider: null, piSignIns: ["google", "openrouter"] }), null);
  assert.equal(signInCompactor({ chatProvider: null, piSignIns: [] }), null);
});

test("create before setup chose models: config.json from the sign-in (or none); the Edit sheet shows the same", async () => {
  const h = host();
  try {
    mkdirSync(h.pi, { recursive: true });
    // Nothing signed in: no config.json, the user picks.
    await h.files.create({ name: "Nobody", agentsMd: "" });
    assert.ok(!existsSync(join(h.profile("nobody"), "config.json")));
    // ChatGPT on pi.
    writeFileSync(join(h.pi, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth" } }));
    assert.deepEqual(piSignIns(h.pi), ["openai-codex"]);
    await h.files.create({ name: "Gpt", agentsMd: "" });
    const gpt = JSON.parse(readFileSync(join(h.profile("gpt"), "config.json"), "utf8"));
    assert.deepEqual(gpt.compactor, CHATGPT_COMPACTOR);
    assert.equal(gpt.setup, true, "a later Choose models moves it");
    assert.deepEqual(await h.files.compactor("nobody"), { ...CHATGPT_COMPACTOR, isDefault: true, ...PI_BOT, effectiveRunner: "pi" }, "a non-Claude compactor runs on pi (FF1)");
    // A Claude Code bot: Sonnet 5.5 medium, and it has its AGENTS.md like any bot.
    await h.files.create({ name: "Cody", agentsMd: "", chat: { provider: "optchat-cc/opus" } });
    assert.deepEqual(JSON.parse(readFileSync(join(h.profile("cody"), "config.json"), "utf8")).compactor, CLAUDE_COMPACTOR);
    assert.match(readFileSync(join(h.profile("cody"), "AGENTS.md"), "utf8"), /^# Cody\n/);
    // Setup's choice wins over the sign-in default.
    writeFileSync(join(h.root, ".settings.json"), JSON.stringify({ models: { compaction: { provider: "openai-codex", model: "gpt-6-luna", thinking: "low" } } }));
    await h.files.create({ name: "Later", agentsMd: "", chat: { provider: "optchat-cc" } });
    assert.equal(JSON.parse(readFileSync(join(h.profile("later"), "config.json"), "utf8")).compactor.model, "gpt-6-luna");
  } finally {
    h.done();
  }
});

test("runner preview and note (Edit sheet, FF1): same rules as the host", () => {
  const sol = { provider: "openai-codex", model: "gpt-6.1-sol", thinking: "low" as const };
  const sonnet = { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" as const };
  assert.equal(runnerPreview("auto", sol, null), "pi");
  assert.equal(runnerPreview("auto", sonnet, null), "in-session");
  assert.equal(runnerPreview("auto", sonnet, "pi"), "pi");
  assert.equal(runnerPreview("in-session", sol, "pi"), "in-session");
  assert.equal(runnerPreview("pi", sonnet, null), "pi");
  assert.match(runnerNote("auto", sol, "pi"), /pi/);
  assert.match(runnerNote("in-session", sol, "in-session"), /Haiku/);
  assert.match(runnerNote("auto", sonnet, "in-session"), /Claude Code/);
});
