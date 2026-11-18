// BF2 bug 4: a new Claude Code chat opened empty (history "skip") though the bot's OptChat profile had a log.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotsService, setCcChatCreated, type BotsPaseo } from "../server/bots";
import { reloadIfHistory, type Run } from "../server/cc/history-reload";

function host(withLog: boolean) {
  const tmp = mkdtempSync(join(tmpdir(), "cc-reload-"));
  const root = join(tmp, "bots");
  const oc = join(tmp, "oc");
  mkdirSync(join(root, "wallace"), { recursive: true });
  writeFileSync(join(root, "wallace", ".optchat-profile"), "wallace\n");
  writeFileSync(join(root, "wallace", ".bot.json"), JSON.stringify({ chat: { provider: "optchat-cc/claude-opus-5-5" } }));
  mkdirSync(join(oc, "profiles", "wallace", "main"), { recursive: true });
  if (withLog) writeFileSync(join(oc, "profiles", "wallace", "main", "0001.jsonl"), "{}\n");
  return { root, oc, cwd: join(root, "wallace") };
}

test("a new chat for a bot whose profile has a log is reloaded once, with the daemon's paseo CLI, as the host", async () => {
  const { root, oc, cwd } = host(true);
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const run: Run = async (file, args, env) => (calls.push({ file, args, env }), { ok: true, detail: "" });
  const env = { PASEO_CLI_DIST: "/app/daemon/dist", PASEO_AGENT_ID: "x", PASEO_HOST: "h:1", HOME: "/h" };
  assert.equal(await reloadIfHistory(cwd, "agent-1", { botsRoot: root, optchatHome: oc, env, run }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, process.execPath);
  assert.deepEqual(calls[0]!.args.slice(1), ["/app/daemon/bin/paseo", "agent", "reload", "agent-1"]);
  assert.equal(calls[0]!.env.PASEO_AGENT_ID, undefined);
  assert.equal(calls[0]!.env.PASEO_HOST, undefined);
});

test("no log yet (a brand-new bot), or not a bot folder: no reload", async () => {
  const { root, oc, cwd } = host(false);
  let ran = 0;
  const run: Run = async () => (ran++, { ok: true, detail: "" });
  assert.equal(await reloadIfHistory(cwd, "a", { botsRoot: root, optchatHome: oc, run }), false);
  assert.equal(await reloadIfHistory("/elsewhere", "a", { botsRoot: root, optchatHome: oc, run }), false);
  assert.equal(ran, 0);
});

test("a failed reload is logged, not thrown", async () => {
  const { root, oc, cwd } = host(true);
  const warned: string[] = [];
  const run: Run = async () => ({ ok: false, detail: "daemon not reachable" });
  assert.equal(await reloadIfHistory(cwd, "a", { botsRoot: root, optchatHome: oc, run, warn: (s) => warned.push(s) }), false);
  assert.match(warned[0]!, /reload for its history failed: daemon not reachable/);
});

test("New chat on a Claude Code bot calls the hook with the new chat; a pi chat does not", async () => {
  const { root } = host(true);
  mkdirSync(join(root, "flint"));
  writeFileSync(join(root, "flint", ".optchat-profile"), "flint\n");
  writeFileSync(join(root, "flint", ".bot.json"), JSON.stringify({ chat: { provider: "optchat/anthropic/claude-opus-5-5" } }));
  const seen: string[] = [];
  setCcChatCreated((bot, id) => seen.push(`${bot.id} ${id}`));
  let n = 0;
  const paseo = {
    agents: { list: async () => ({ entries: [] }), ref: () => ({ archive: async () => ({}) }) },
    workspaces: { open: async () => ({ agents: { create: async () => ({ id: `new-${++n}` }) } }) },
    config: { get: async () => ({}) },
    projects: { list: async () => ({ projects: [] }) },
  } as unknown as BotsPaseo;
  try {
    const service = new BotsService(root);
    await service.newChat("wallace", paseo);
    await service.newChat("flint", paseo);
  } finally {
    setCcChatCreated(() => {});
  }
  assert.deepEqual(seen, ["wallace new-1"]);
});
