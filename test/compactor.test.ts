import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotFiles, DEFAULT_COMPACTOR, ManageError } from "../server/manage";
import { compactorModelId, compactorFromModelId, compactorLabel } from "../shared/compactor";

function host() {
  const base = mkdtempSync(join(process.env.BM_TEST_TMP ?? tmpdir(), "compactor-"));
  const root = join(base, "bots");
  const optchatHome = join(base, "optchat");
  for (const bot of ["alpha", "beta"]) {
    mkdirSync(join(root, bot), { recursive: true });
    writeFileSync(join(root, bot, ".optchat-profile"), `${bot}\n`);
    mkdirSync(join(optchatHome, "profiles", bot), { recursive: true });
  }
  return { files: new BotFiles({ root, optchatHome }), profile: (b: string) => join(optchatHome, "profiles", b), done: () => rmSync(base, { recursive: true, force: true }) };
}

test("compactor: reads config.json, defaults without one", async () => {
  const h = host();
  try {
    assert.deepEqual(await h.files.compactor("alpha"), { ...DEFAULT_COMPACTOR, isDefault: true });
    writeFileSync(join(h.profile("beta"), "config.json"), JSON.stringify({ compactor: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low" } }));
    assert.deepEqual(await h.files.compactor("beta"), { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low", isDefault: false });
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
    assert.deepEqual(await h.files.setCompactor("beta", glm), { ...glm, isDefault: false });
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

test("compactor <-> Paseo model id", () => {
  assert.equal(compactorModelId({ provider: "openrouter", model: "z-ai/glm-5.3" }), "openrouter/z-ai/glm-5.3");
  assert.deepEqual(compactorFromModelId("openrouter/z-ai/glm-5.3", "high"), { provider: "openrouter", model: "z-ai/glm-5.3", thinking: "high" });
  assert.deepEqual(compactorFromModelId("anthropic/claude-sonnet-5-5", "nonsense"), { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" });
  assert.equal(compactorFromModelId("bare", "low"), null);
  assert.equal(compactorLabel({ provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" }), "anthropic/claude-sonnet-5-5 · medium");
});
