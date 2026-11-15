/** Settings › Host › Agents › Workers: the global default engine for herdr workers (server/worker-default.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings } from "../server/settings";
import { setWorkerDefault, workerDefault } from "../server/worker-default";
import { claudePlanReady, claudeSignedIn, resetClaudeAuthCache } from "../server/cc/launch";

test("settings: workerEngine is cc, pi or null (automatic); anything else is automatic", () => {
  assert.equal(parseSettings({}).workerEngine, null);
  assert.equal(parseSettings({ workerEngine: "cc" }).workerEngine, "cc");
  assert.equal(parseSettings({ workerEngine: "pi" }).workerEngine, "pi");
  assert.equal(parseSettings({ workerEngine: "codex" }).workerEngine, null);
});

test("automatic: Claude Code when signed in (or a cc worker proxy), else pi; a set engine wins; set keeps other keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-default-"));
  try {
    const env = { PASEO_BOTS_ROOT: root };
    let cc = false;
    const deps = { claudeSignedIn: async () => cc, piSignIns: () => ["openai-codex"], env };
    assert.deepEqual(await workerDefault(root, deps), { engine: "auto", effective: "pi", claudeCode: false, pi: true });
    cc = true;
    assert.deepEqual(await workerDefault(root, deps), { engine: "auto", effective: "cc", claudeCode: true, pi: true });
    cc = false;
    assert.equal((await workerDefault(root, { ...deps, env: { ...env, CC_WORKER_BASE_URL: "http://proxy.invalid" } })).effective, "cc");
    assert.equal((await workerDefault(root, { ...deps, claudeSignedIn: async () => Promise.reject(new Error("no claude")) })).effective, "pi");
    writeFileSync(join(root, ".settings.json"), JSON.stringify({ user: { name: "Sam" }, rooms: { fullTools: true } }));
    cc = true;
    assert.deepEqual(await setWorkerDefault(root, "pi", deps), { engine: "pi", effective: "pi", claudeCode: true, pi: true });
    const saved = JSON.parse(readFileSync(join(root, ".settings.json"), "utf8"));
    assert.deepEqual(saved, { user: { name: "Sam" }, rooms: { fullTools: true }, workerEngine: "pi" });
    assert.equal((await setWorkerDefault(root, "auto", deps)).effective, "cc");
    assert.equal("workerEngine" in JSON.parse(readFileSync(join(root, ".settings.json"), "utf8")), false, "automatic removes the key");
    writeFileSync(join(root, ".settings.json"), "[1]");
    await assert.rejects(setWorkerDefault(root, "cc", deps), /not a JSON object/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claudeSignedIn: any login; claudePlanReady: a Claude plan, not Team/Enterprise (one cached auth status)", async () => {
  const env = { DINOBOT_CLAUDE_BIN: "/fake/claude" };
  const answer = (status: unknown) => async () => ({ code: 0, stdout: JSON.stringify(status), stderr: "" });
  resetClaudeAuthCache();
  assert.equal(await claudeSignedIn(env, answer({ loggedIn: true, authMethod: "api_key" })), true);
  assert.equal(await claudePlanReady(env, answer({})), false, "cached: the API-key login is no plan");
  resetClaudeAuthCache();
  assert.equal(await claudePlanReady(env, answer({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })), true);
  resetClaudeAuthCache();
  assert.equal(await claudePlanReady(env, answer({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team" })), false);
  resetClaudeAuthCache();
  assert.equal(await claudeSignedIn(env, async () => ({ code: 1, stdout: "", stderr: "x" })), false);
  resetClaudeAuthCache();
});

test("a Claude Code model from setup (claude-code/<model>): Claude Code workers run it, pi workers fall back to pi's default", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "worker-default-"));
  try {
    writeFileSync(join(root, ".settings.json"), JSON.stringify({ models: { workers: { provider: "claude-code", model: "sonnet", thinking: "high" } } }));
    const script = join(import.meta.dirname, "..", "skills", "workers", "worker-default.mjs");
    const run = (engine: string) => execFileSync(process.execPath, [script], { env: { PATH: process.env.PATH, HOME: root, PASEO_BOTS_ROOT: root, WORKER_ENGINE: engine }, encoding: "utf8" });
    assert.equal(run("cc"), "cc\nclaude-code/sonnet:high\n");
    assert.equal(run("pi"), "pi\n\n");
    // launch-cc.sh's model block: claude-code/<model>:<effort> becomes claude --model <model> --effort <effort>.
    const sh = readFileSync(join(import.meta.dirname, "..", "skills", "workers", "launch-cc.sh"), "utf8");
    const block = sh.slice(sh.indexOf("# Model: CC_WORKER_MODEL"), sh.indexOf("case $EFFORT in"));
    const parse = (model: string) => execFileSync("sh", ["-c", `MODEL='${model}'\n${block}\necho "$MODEL|$EFFORT"`], { encoding: "utf8", env: { PATH: process.env.PATH } }).trim();
    assert.equal(parse("claude-code/sonnet:high"), "sonnet|high");
    assert.equal(parse("claude-code/claude-opus-5-5"), "claude-opus-5-5|");
    assert.equal(parse("anthropic/claude-sonnet-5-5:low"), "claude-sonnet-5-5|low");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
