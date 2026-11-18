// The restart guard for bots on Claude Code (claude-code/guard): a stock PreToolUse hook that runs OptChat's matcher.
// Held to the same cases as the pi hook (optchat/test/restart-guard-cases.ts), driven through the hook script with
// hook-shaped JSON on stdin, plus fail-open cases and where the hook is (and is not) installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOW, FIXTURE, OWN_ID, REFUSE } from "../../../optchat/test/restart-guard-cases.ts";
import { fixtureIo, REFUSAL, restartReason } from "../../../optchat/src/restart-guard.ts";

const ROOT = join(import.meta.dirname, "..");
const HOOK = join(ROOT, "claude-code", "guard", "hooks", "restart-guard.mjs");
const FIXTURE_ENV = JSON.stringify(FIXTURE);

type Run = { code: number | null; stderr: string; stdout: string };
function hook(stdin: string | null, env: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const base: Record<string, string | undefined> = { ...process.env, PASEO_AGENT_ID: OWN_ID, RESTART_GUARD_FIXTURE: FIXTURE_ENV, ...env };
    for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
    const child = spawn(process.execPath, [HOOK], { env: base as NodeJS.ProcessEnv });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ code, stderr, stdout }));
    if (stdin !== null) child.stdin.end(stdin);
  });
}
const bash = (command: string, cwd = "/bot") => JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });

async function all<T, R>(items: T[], fn: (t: T) => Promise<R>, width = 8): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

test("CC hook refuses every case the pi hook refuses: exit 2, the same one-line reason on stderr", async () => {
  const runs = await all(REFUSE, (cmd) => hook(bash(cmd)));
  REFUSE.forEach((cmd, i) => {
    assert.equal(runs[i]!.code, 2, cmd);
    assert.equal(runs[i]!.stderr, `${REFUSAL}\n`, cmd);
  });
});

test("CC hook allows every case the pi hook allows: exit 0, nothing on stderr", async () => {
  const runs = await all(ALLOW, (cmd) => hook(bash(cmd)));
  ALLOW.forEach((cmd, i) => {
    assert.equal(runs[i]!.code, 0, cmd);
    assert.equal(runs[i]!.stderr, "", cmd);
  });
});

test("the cases mean the same in process (pi) as through the hook (Claude Code)", () => {
  const io = fixtureIo(FIXTURE);
  for (const cmd of REFUSE) assert.equal(restartReason(cmd, "/bot", io, OWN_ID), REFUSAL, cmd);
  for (const cmd of ALLOW) assert.equal(restartReason(cmd, "/bot", io, OWN_ID), null, cmd);
});

test("its own agent id comes from PASEO_AGENT_ID: reloading another bot is allowed, itself refused", async () => {
  assert.equal((await hook(bash("paseo agent reload 72a13b6"))).code, 0);
  assert.equal((await hook(bash("paseo agent reload 72a13b6"), { PASEO_AGENT_ID: "72a13b62-0000" })).code, 2);
});

test("fails open: no PASEO_AGENT_ID, bad or empty JSON, missing fields, other tools, a matcher that throws", async () => {
  const refused = "systemctl --user try-restart dinobot.service";
  const cases: Array<[string, string | null, Record<string, string | undefined>]> = [
    ["no PASEO_AGENT_ID", bash(refused), { PASEO_AGENT_ID: undefined }],
    ["blank PASEO_AGENT_ID", bash(refused), { PASEO_AGENT_ID: " " }],
    ["bad JSON", "{not json", {}],
    ["empty stdin", "", {}],
    ["JSON null", "null", {}],
    ["no tool_input", JSON.stringify({ tool_name: "Bash" }), {}],
    ["command not a string", JSON.stringify({ tool_name: "Bash", tool_input: { command: 42 } }), {}],
    ["another tool", JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x", content: refused } }), {}],
    ["matcher throws (bad fixture)", bash(refused), { RESTART_GUARD_FIXTURE: "{bad" }],
  ];
  const runs = await all(cases, ([, stdin, env]) => hook(stdin, env));
  cases.forEach(([name], i) => {
    assert.equal(runs[i]!.code, 0, name);
    assert.equal(runs[i]!.stderr, "", name);
  });
});

test("fails open when stdin never closes (gives up after 2 s)", async () => {
  const t = Date.now();
  const r = await hook(null);
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t < 4500);
});

test("installed for bots only: a stock PreToolUse hook on Bash in the bot's plugin dirs, not in workers' settings", () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, "claude-code", "guard", "hooks", "hooks.json"), "utf8"));
  const [entry] = hooks.hooks.PreToolUse;
  assert.equal(entry.matcher, "Bash");
  assert.equal(entry.hooks[0].type, "command");
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/restart-guard\.mjs/);
  assert.ok(entry.hooks[0].timeout <= 10, "short timeout");
  const plugin = JSON.parse(readFileSync(join(ROOT, "claude-code", "guard", ".claude-plugin", "plugin.json"), "utf8"));
  assert.ok(plugin.name);

  const startBot = readFileSync(join(ROOT, "claude-code", "start-bot.sh"), "utf8");
  const dirs = /^CC_PLUGIN_DIRS="([^"]*)"/m.exec(startBot)?.[1] ?? "";
  assert.ok(dirs.split(":").includes("$HERE/guard"), "a bot's TUI loads the guard");
  // Workers: launch.sh / launch-cc.sh never add the guard or any hook to the settings they write.
  for (const f of ["launch.sh", "launch-cc.sh"]) {
    const text = readFileSync(join(ROOT, "skills", "workers", f), "utf8");
    assert.doesNotMatch(text, /claude-code\/guard|restart-guard|PreToolUse/, f);
    assert.doesNotMatch(text, /^\s*hooks\s*:/m, f);
  }
});
