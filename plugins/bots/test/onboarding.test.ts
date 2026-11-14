import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatConfig, setDefaultChatModel } from "../server/bots";
import { BotFiles } from "../server/manage";
import { Onboarding } from "../server/onboarding";
import { parseSettings } from "../server/settings";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("setup.apply: bots, compaction and workers models go to settings, default-following bots, their OptChat config and pi's defaults; no fixed model anywhere", async () => {
  const home = mkdtempSync(join(tmpdir(), "onb-"));
  try {
    const root = join(home, "bots");
    const optchat = join(home, ".optchat");
    const pi = join(home, ".dinobot", "pi");
    // A starter bot without a model (installer, phone flow) and a bot whose user picked one.
    for (const [id, chat] of [["juniper", null], ["picky", { provider: "optchat/openrouter/x/y" }]] as const) {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(join(root, id, ".optchat-profile"), `${id}\n`);
      writeFileSync(join(root, id, ".bot.json"), JSON.stringify({ name: id, ...(chat ? { chat } : {}) }));
      mkdirSync(join(optchat, "profiles", id), { recursive: true });
    }
    writeFileSync(join(optchat, "profiles", "picky", "config.json"), JSON.stringify({ compactor: { provider: "a", model: "b", thinking: "low" } }));
    mkdirSync(pi, { recursive: true });
    writeFileSync(join(pi, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }));
    const env = { HOME: home, PASEO_BOTS_ROOT: root, OPTCHAT_HOME: optchat, PI_CODING_AGENT_DIR: pi };
    const settings = parseSettings({});
    const ob = new Onboarding(settings, root, env);
    assert.equal((await ob.options()).available, false); // no DinoBot host module here
    const models = {
      bots: { provider: "openai-codex", model: "gpt-6-sol", thinking: "medium" },
      compaction: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "low" },
      workers: { provider: "openai-codex", model: "gpt-6-sol", thinking: "high" },
    };
    const r = await ob.apply({ models });
    assert.ok(r.ok);
    assert.deepEqual(read(join(root, ".settings.json")).models, models);
    assert.equal(read(join(root, ".settings.json")).defaultModel, "openai-codex/gpt-6-sol");
    assert.deepEqual(read(join(root, "juniper", ".bot.json")).chat, { provider: "optchat/openai-codex/gpt-6-sol", thinkingOptionId: "medium", setup: true });
    assert.deepEqual(read(join(root, "picky", ".bot.json")).chat, { provider: "optchat/openrouter/x/y" }); // the user's own pick stays
    const cfg = read(join(optchat, "profiles", "juniper", "config.json"));
    assert.deepEqual(cfg.compactor, models.compaction);
    assert.deepEqual(cfg.subagent, models.workers);
    assert.equal(read(join(optchat, "profiles", "picky", "config.json")).compactor.provider, "a");
    const piSettings = read(join(pi, "settings.json"));
    assert.deepEqual([piSettings.defaultProvider, piSettings.defaultModel, piSettings.defaultThinkingLevel], ["openai-codex", "gpt-6-sol", "high"]);
    assert.deepEqual(piSettings.packages, ["npm:pi-web-access"]);
    // New chats and new bots follow the choice; nothing falls back to a fixed Anthropic model.
    assert.deepEqual(await chatConfig({ config: { get: async () => ({}) } } as never), { provider: "optchat/openai-codex/gpt-6-sol", thinkingOptionId: "medium" });
    const files = new BotFiles({ root, optchatHome: optchat });
    const made = await files.create({ name: "Newbie" });
    assert.deepEqual(read(join(optchat, "profiles", made.botId, "config.json")).compactor, models.compaction);
    assert.deepEqual(await files.compactor("juniper"), { ...models.compaction, isDefault: false });
    // A model without effort: no thinking anywhere (pi's own default applies).
    await ob.apply({ models: { ...models, workers: { provider: "local", model: "llama-3", thinking: null } } });
    assert.equal(read(join(pi, "settings.json")).defaultThinkingLevel, undefined);
    // A bot made after setup copied the host's models; a later "Choose models" moves it along too
    // (luna-demo: a Mac test bot kept its old compactor after the host moved to another model).
    assert.deepEqual(read(join(optchat, "profiles", made.botId, "config.json")).subagent, read(join(optchat, "profiles", "juniper", "config.json")).subagent);
    assert.equal(read(join(optchat, "profiles", made.botId, "config.json")).subagent.model, "llama-3");
  } finally {
    setDefaultChatModel(null);
    rmSync(home, { recursive: true, force: true });
  }
});

test("onboarding RPC names are valid plugin method names (Paseo: /^[a-z][a-z0-9._-]*$/)", async () => {
  const rpcs = await import("../shared/onboarding-rpc");
  for (const r of Object.values(rpcs)) if (r && typeof r === "object" && "name" in r) assert.match(String((r as { name: string }).name), /^[a-z][a-z0-9._-]*$/);
});

test("provider RPC names are valid plugin method names, and none returns a token field", async () => {
  const rpcs = await import("../shared/provider-rpc");
  const names = (Object.values(rpcs) as unknown[])
    .filter((r): r is { name: string; output: { shape?: Record<string, unknown> } } => Boolean(r && typeof r === "object" && "name" in r))
    .map((r) => {
      assert.ok(!("token" in (r.output.shape ?? {})), r.name);
      return r.name;
    });
  for (const n of names) assert.match(n, /^[a-z][a-z0-9._-]*$/);
  assert.deepEqual(names.sort(), ["provider.install", "provider.install-status", "provider.list", "provider.remove"]);
});

test("provider.*: not available on a plain Paseo host or with an installer that predates them; passed through to DinoBot's installer otherwise", async () => {
  const home = mkdtempSync(join(tmpdir(), "onb-prov-"));
  try {
    const plain = new Onboarding(parseSettings({}), join(home, "bots"), { HOME: home });
    assert.deepEqual(await plain.providerList(), { available: false, packages: [], providers: [], error: null });
    await assert.rejects(plain.needProviders(), /DINOBOT_HOME/);

    const lib = (name: string) => join(home, name, "app", "installer", "lib");
    // An installer from before provider.* (sign-in only).
    mkdirSync(lib("old"), { recursive: true });
    writeFileSync(join(lib("old"), "phone-signin.mjs"), "export function createOnboarding() { return { options: async () => ({ options: [], signedIn: [] }) }; }\n");
    const old = new Onboarding(parseSettings({}), join(home, "bots"), { HOME: home, DINOBOT_HOME: join(home, "old") });
    assert.equal((await old.providerList()).available, false);
    assert.equal((await old.options()).available, true); // sign-in still works

    mkdirSync(lib("new"), { recursive: true });
    writeFileSync(
      join(lib("new"), "phone-signin.mjs"),
      `const calls = [];
export function createOnboarding() {
  return {
    calls,
    providerList: async () => ({ packages: [{ source: "npm:x", bundled: false }], providers: [] }),
    providerInstall: (i) => (calls.push(i), { jobId: "j1", source: i.source, name: null, state: "running", step: "installing", error: null, providers: [] }),
    providerInstallStatus: ({ jobId }) => ({ jobId, source: "npm:x", name: null, state: "done", step: "done", error: null, providers: [] }),
    providerRemove: async ({ source }) => ({ removed: source }),
  };
}
`,
    );
    const ob = new Onboarding(parseSettings({}), join(home, "bots"), { HOME: home, DINOBOT_HOME: join(home, "new") });
    assert.deepEqual(await ob.providerList(), { available: true, packages: [{ source: "npm:x", bundled: false }], providers: [], error: null });
    const h = await ob.needProviders();
    const started = h.providerInstall({ source: "npm:x", token: null }) as { jobId: string };
    assert.equal(started.jobId, "j1");
    assert.equal((h.providerInstallStatus({ jobId: "j1" }) as { state: string }).state, "done");
    assert.deepEqual(await h.providerRemove({ source: "npm:x" }), { removed: "npm:x" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("engines RPC names are valid plugin method names, and no output has a key or token field", async () => {
  const rpcs = await import("../shared/engines-rpc");
  const names = (Object.values(rpcs) as unknown[])
    .filter((r): r is { name: string; output: unknown } => Boolean(r && typeof r === "object" && "name" in r))
    .map((r) => {
      assert.doesNotMatch(JSON.stringify(r.output), /"(key|token|accessToken|refreshToken)"/, r.name);
      return r.name;
    });
  for (const n of names) assert.match(n, /^[a-z][a-z0-9._-]*$/);
  assert.deepEqual(names.sort(), ["engines.claude-logout", "engines.pi-sign-out", "engines.status"]);
});

test("engines.*: not available on a plain Paseo host or an older installer; passed through to DinoBot's installer otherwise", async () => {
  const home = mkdtempSync(join(tmpdir(), "onb-eng-"));
  try {
    const plain = new Onboarding(parseSettings({}), join(home, "bots"), { HOME: home });
    assert.deepEqual(await plain.engines(), { available: false, pi: null, claudeCode: null, error: null });
    await assert.rejects(plain.needEngines(), /DINOBOT_HOME/);

    const lib = (name: string) => join(home, name, "app", "installer", "lib");
    mkdirSync(lib("old"), { recursive: true });
    writeFileSync(join(lib("old"), "phone-signin.mjs"), "export function createOnboarding() { return { providerList: async () => ({ packages: [], providers: [] }) }; }\n");
    const old = new Onboarding(parseSettings({}), join(home, "bots"), { HOME: home, DINOBOT_HOME: join(home, "old") });
    assert.equal((await old.engines()).available, false);

    mkdirSync(lib("new"), { recursive: true });
    writeFileSync(
      join(lib("new"), "phone-signin.mjs"),
      `export function createOnboarding() {
  let n = 0;
  return {
    enginesStatus: async () => {
      if (n++ === 1) throw new Error("pi broke");
      return { pi: { ready: true, readyCount: 1, isDefault: true, signins: [], packages: [] }, claudeCode: { installed: false } };
    },
    piSignOut: ({ provider }) => ({ removed: provider }),
    claudeLogout: async () => ({ ok: true }),
  };
}
`,
    );
    const ob = new Onboarding(parseSettings({}), join(home, "bots"), { HOME: home, DINOBOT_HOME: join(home, "new") });
    const r = await ob.engines();
    assert.equal(r.available, true);
    assert.equal((r.pi as unknown as { ready: boolean }).ready, true);
    assert.deepEqual(await ob.engines(), { available: true, pi: null, claudeCode: null, error: "pi broke" });
    const h = await ob.needEngines();
    assert.deepEqual(h.piSignOut({ provider: "openrouter" }), { removed: "openrouter" });
    assert.deepEqual(await h.claudeLogout(), { ok: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
