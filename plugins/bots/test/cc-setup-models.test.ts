/**
 * The v0.1.11 setup loop (the owner's phone, 15 Nov): a Claude-Code-only computer. The sign-in step says "✓ Already
 * signed in" (Claude Code), but "Choose models" listed pi's models only: none, so "No models yet: sign in" sent the
 * user back to the sign-in step, which sent them on to the empty list again. setup.models now lists Claude Code's
 * models when Claude Code is signed in, suggests some, and setup.apply puts a Claude Code pick where it runs.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatConfig, setDefaultChatModel } from "../server/bots";
import { CC_SETUP_PROVIDER, ccChatProvider, ccCompactorPick } from "../server/cc/setup-models";
import { BotFiles, hostProfileConfig } from "../server/manage";
import { Onboarding } from "../server/onboarding";
import { parseSettings } from "../server/settings";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const CC_LIST = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
];

/** A DinoBot host whose pi has no sign-in: pi lists no models (the CC-only machine). */
function ccOnlyHost(home: string, piModels: unknown[] = []) {
  const lib = join(home, "dinobot", "app", "installer", "lib");
  mkdirSync(lib, { recursive: true });
  writeFileSync(
    join(lib, "phone-signin.mjs"),
    `export function createOnboarding() {
  return {
    options: async () => ({ options: [], signedIn: [] }),
    models: async () => ({ providers: ${JSON.stringify(piModels.length ? ["openai-codex"] : [])}, subscription: null, models: ${JSON.stringify(piModels)}, suggested: { bots: null, compaction: null, workers: null } }),
    recordModels: () => {},
  };
}\n`,
  );
  return join(home, "dinobot");
}

test("setup loop: a Claude-Code-only computer gets Claude Code's models (and suggestions), not an empty list", async () => {
  const home = mkdtempSync(join(tmpdir(), "ccsm-"));
  try {
    const env = { HOME: home, DINOBOT_HOME: ccOnlyHost(home) };
    // Before the fix: no Claude Code source, the list is empty, and the app's only way on is "Sign in" (the loop).
    const before = await new Onboarding(parseSettings({}), join(home, "bots"), env).models(true);
    assert.equal(before.models.length, 0);

    let refreshed = false;
    const ob = new Onboarding(parseSettings({}), join(home, "bots"), env, {
      claudeCode: async (refresh) => {
        refreshed = refresh;
        return { models: CC_LIST, plan: "max" };
      },
    });
    const a = await ob.models(true);
    assert.equal(refreshed, true, "right after sign-in the Claude login is checked again, not from a minute-old cache");
    assert.equal(a.error, null);
    assert.ok(a.providers.includes(CC_SETUP_PROVIDER));
    assert.deepEqual(
      a.models.map((m) => `${m.provider}/${m.id}`),
      CC_LIST.map((m) => `claude-code/${m.id}`),
    );
    assert.deepEqual(a.models[0]!.levels, ["low", "medium", "high", "xhigh", "max"]);
    // Every role has a suggestion that is in the list, so Continue works without picking by hand.
    for (const role of ["bots", "compaction", "workers"] as const) {
      const s = a.suggested[role];
      assert.ok(s, role);
      assert.ok(a.models.some((m) => m.provider === s.provider && m.id === s.model), role);
    }
    assert.equal(a.suggested.bots!.model, "opus"); // Max plan: Opus for chats (pi-optchat's claude-max row)
    assert.deepEqual(a.suggested.compaction, { provider: "claude-code", model: "sonnet", thinking: "medium" });

    // Claude Code not signed in: nothing from it (the empty list stays honest).
    const out = await new Onboarding(parseSettings({}), join(home, "bots"), env, { claudeCode: async () => null }).models(false);
    assert.equal(out.models.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup.models: pi's models and Claude Code's together; pi's suggestions win; a pi failure does not hide Claude Code", async () => {
  const home = mkdtempSync(join(tmpdir(), "ccsm-"));
  try {
    const pi = [{ provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol", levels: ["low", "medium"] }];
    const lib = ccOnlyHost(home, pi);
    const cc = { claudeCode: async () => ({ models: CC_LIST, plan: "pro" }) };
    const both = await new Onboarding(parseSettings({}), join(home, "bots"), { HOME: home, DINOBOT_HOME: lib }, cc).models(false);
    assert.equal(both.models.length, 1 + CC_LIST.length);
    assert.deepEqual(both.providers, ["openai-codex", "claude-code"]);
    assert.equal(both.suggested.bots!.model, "sonnet"); // pi suggested none here; Pro plan: Sonnet

    // (no installer module there: a plain Paseo host stays "not available")
    const plain = await new Onboarding(parseSettings({}), join(home, "bots"), { HOME: home, DINOBOT_HOME: join(home, "none") }, cc).models(false);
    assert.equal(plain.available, false);
    const brokenLib = join(home, "broken", "app", "installer", "lib");
    mkdirSync(brokenLib, { recursive: true });
    writeFileSync(join(brokenLib, "phone-signin.mjs"), `export function createOnboarding() { return { models: async () => { throw new Error("pi did not list its models"); }, recordModels() {} }; }\n`);
    const piFails = await new Onboarding(parseSettings({}), join(home, "bots"), { HOME: home, DINOBOT_HOME: join(home, "broken") }, cc).models(false);
    assert.equal(piFails.models.length, CC_LIST.length);
    assert.equal(piFails.error, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup.apply with Claude Code picks: bots chat on optchat-cc, compaction runs in-session, workers on Claude Code, pi untouched", async () => {
  const home = mkdtempSync(join(tmpdir(), "ccsm-"));
  try {
    const root = join(home, "bots");
    const optchat = join(home, ".optchat");
    const piDir = join(home, ".dinobot", "pi");
    mkdirSync(join(root, "juniper"), { recursive: true });
    writeFileSync(join(root, "juniper", ".optchat-profile"), "juniper\n");
    writeFileSync(join(root, "juniper", ".bot.json"), JSON.stringify({ name: "Juniper" }));
    mkdirSync(join(optchat, "profiles", "juniper"), { recursive: true });
    const env = { HOME: home, PASEO_BOTS_ROOT: root, OPTCHAT_HOME: optchat, PI_CODING_AGENT_DIR: piDir, DINOBOT_HOME: ccOnlyHost(home) };
    const ob = new Onboarding(parseSettings({}), root, env, { claudeCode: async () => ({ models: CC_LIST, plan: "max" }) });
    const models = {
      bots: { provider: "claude-code", model: "opus", thinking: "high" },
      compaction: { provider: "claude-code", model: "sonnet", thinking: "medium" },
      workers: { provider: "claude-code", model: "claude-sonnet-5-5", thinking: "medium" },
    };
    const r = await ob.apply({ models });
    assert.ok(r.ok);
    assert.deepEqual(read(join(root, ".settings.json")).models, models);
    assert.deepEqual(read(join(root, "juniper", ".bot.json")).chat, { provider: "optchat-cc/opus", thinkingOptionId: "high", setup: true });
    const cfg = read(join(optchat, "profiles", "juniper", "config.json"));
    assert.deepEqual(cfg.compactor, { provider: "anthropic", model: "claude-sonnet", thinking: "medium" });
    assert.deepEqual(cfg.subagent, { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" });
    assert.ok(!r.applied.includes("pi defaults (workers)"), "pi cannot run a Claude Code model: its defaults stay");
    assert.deepEqual(await chatConfig({ config: { get: async () => ({}) } } as never), { provider: "optchat-cc/opus", thinkingOptionId: "high" });
    const files = new BotFiles({ root, optchatHome: optchat });
    const c = await files.compactor("juniper");
    assert.equal(c.effectiveRunner, "in-session");
    // A model Claude Code does not list is refused as before.
    await assert.rejects(ob.apply({ models: { ...models, bots: { provider: "claude-code", model: "nope", thinking: null } } }), /does not offer/);
  } finally {
    setDefaultChatModel(null);
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude Code picks map to where they run", () => {
  assert.equal(ccChatProvider({ provider: "claude-code", model: "sonnet", thinking: null }), "optchat-cc/sonnet");
  assert.equal(ccChatProvider({ provider: "openai-codex", model: "gpt-6-sol", thinking: null }), "optchat/openai-codex/gpt-6-sol");
  assert.deepEqual(ccCompactorPick({ provider: "claude-code", model: "haiku", thinking: null }), { provider: "anthropic", model: "claude-haiku", thinking: null });
  assert.deepEqual(ccCompactorPick({ provider: "claude-code", model: "claude-opus-5-5", thinking: "low" }), { provider: "anthropic", model: "claude-opus-5-5", thinking: "low" });
  assert.deepEqual(ccCompactorPick({ provider: "x", model: "y", thinking: null }), { provider: "x", model: "y", thinking: null });
  assert.deepEqual(hostProfileConfig({ bots: null, compaction: { provider: "claude-code", model: "sonnet", thinking: "medium" }, workers: null })?.compactor, { provider: "anthropic", model: "claude-sonnet", thinking: "medium" });
});
