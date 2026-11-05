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
