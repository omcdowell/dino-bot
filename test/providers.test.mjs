// Provider plugins, Claude extra-usage confirm, bot-only extensions, user skills kept out.
// node --test test/providers.test.mjs  (temp dirs under ./.test-tmp-prov, never /tmp)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { addProvider, gitTokenEnv, listProviders, parseProviderLink, parseSource, providerLink, readTokens, removeProvider, updateProviders } from "../lib/providers.mjs";
import { applyProviderDefaults, botOnlyExtensionArgs, scheduledProviders, botSkillArgs, DISABLED_PASEO_PROVIDERS, LOAD_USER_AGENTS_SKILLS, refreshOptchatCommand, writeDaemonConfig, writePiSetup } from "../lib/config.mjs";
import { defaultOption, signIn } from "../lib/signin.mjs";
import { layout, LINK_SCHEME, Prompter } from "../lib/util.mjs";

const TMP = join(import.meta.dirname, "..", ".test-tmp-prov");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
const tmp = () => mkdtempSync(join(TMP, "h-"));
const TOKEN = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";

describe("provider sources", () => {
  it("normalises git sources to https and keys tokens by repo", () => {
    for (const s of ["git:github.com/o/repo@v1.2", "git:https://github.com/o/repo@v1.2", "https://github.com/o/repo.git@v1.2"]) {
      const p = parseSource(s);
      assert.equal(p.source, "git:https://github.com/o/repo@v1.2");
      assert.equal(p.repoKey, "github.com/o/repo");
      assert.equal(p.pinned, true);
    }
    assert.equal(parseSource("npm:pi-web-access@0.45.0").kind, "npm");
    assert.equal(parseSource("npm:@scope/pkg").kind, "npm");
    assert.equal(parseSource("./pkg").kind, "local");
  });
  it("refuses junk, spaces, shell and ../ refs", () => {
    for (const s of ["", "rm -rf /", "npm:a b", "git:github.com/o/r@../x", "ftp://x/y", "github.com/o/r", "npm:$(id)"]) assert.throws(() => parseSource(s), s);
  });
});

describe("invite links", () => {
  it("round-trips through the app scheme", () => {
    const link = providerLink({ source: "git:github.com/o/repo@v1", token: TOKEN, name: "Private provider" });
    assert.ok(link.startsWith(`${LINK_SCHEME}://provider/add?`));
    assert.deepEqual(parseProviderLink(link), { source: "git:https://github.com/o/repo@v1", token: TOKEN, name: "Private provider" });
  });
  it("rejects other schemes, other paths, tokens on npm sources and odd tokens", () => {
    assert.throws(() => parseProviderLink("https://provider/add?source=npm:x"), /dinobot:\/\//);
    assert.throws(() => parseProviderLink(`${LINK_SCHEME}://pair/add?source=npm:x`), /Not a provider link/);
    assert.throws(() => parseProviderLink(`${LINK_SCHEME}://provider/add?source=npm:x&token=${TOKEN}`), /only goes with a git/);
    assert.throws(() => parseProviderLink(`${LINK_SCHEME}://provider/add?source=git:github.com/o/r&token=a;b`), /does not look right/);
  });
});

describe("git token env", () => {
  it("resets inherited helpers for that host only and never puts the token in the helper text", () => {
    const env = gitTokenEnv("github.com", TOKEN);
    assert.equal(env.GIT_CONFIG_COUNT, "2");
    assert.equal(env.GIT_CONFIG_KEY_0, "credential.https://github.com.helper");
    assert.equal(env.GIT_CONFIG_VALUE_0, "");
    assert.doesNotMatch(env.GIT_CONFIG_VALUE_1, new RegExp(TOKEN));
    assert.equal(env.DINOBOT_GIT_TOKEN, TOKEN);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.deepEqual(gitTokenEnv("github.com", null), { GIT_TERMINAL_PROMPT: "0" });
  });
});

describe("provider add / update / remove (pi faked)", () => {
  const fake = (code = 0, out = "") => {
    const calls = [];
    return { calls, run: async (cmd, args, opts) => (calls.push({ cmd, args, env: opts.env }), { code, stdout: out, stderr: code ? out : "" }) };
  };
  it("installs through DinoBot's pi wrapper, keeps the token 0600 for updates, removes it on remove", async () => {
    const L = layout({ HOME: tmp() });
    const f = fake();
    await addProvider(L, { source: "git:github.com/o/repo@v1", token: TOKEN }, f);
    assert.equal(f.calls[0].cmd, join(L.bin, "pi"));
    assert.deepEqual(f.calls[0].args, ["install", "git:https://github.com/o/repo@v1"]);
    assert.equal(f.calls[0].env.DINOBOT_GIT_TOKEN, TOKEN);
    assert.deepEqual(readTokens(L), { "github.com/o/repo": TOKEN });
    assert.equal(statSync(join(L.root, "secrets", "git-tokens.json")).mode & 0o777, 0o600);
    // update: the stored token is offered for that repo path only
    const u = fake();
    await updateProviders(L, u);
    assert.deepEqual(u.calls[0].args, ["update", "--extensions"]);
    const keys = Object.entries(u.calls[0].env).filter(([k]) => k.startsWith("GIT_CONFIG_KEY_")).map(([, v]) => v);
    assert.ok(keys.includes("credential.https://github.com/o/repo.helper"));
    assert.ok(keys.includes("credential.https://github.com.useHttpPath"));
    assert.equal(u.calls[0].env.DINOBOT_GIT_TOKEN_0, TOKEN);
    await removeProvider(L, "git:github.com/o/repo@v1", fake());
    assert.deepEqual(readTokens(L), {});
  });
  it("a failed private clone says what to do; the token is not saved", async () => {
    const L = layout({ HOME: tmp() });
    await assert.rejects(addProvider(L, { source: "git:github.com/o/repo@v1" }, fake(1, "git clone … failed with code 128")), /invite link/);
    await assert.rejects(addProvider(L, { source: "git:github.com/o/repo@v1", token: TOKEN }, fake(1, "fatal: Authentication failed")), /expired or been revoked/);
    assert.deepEqual(readTokens(L), {});
  });
  it("lists settings packages, bundled ones marked", () => {
    const L = layout({ HOME: tmp() });
    writePiSetup(L);
    assert.deepEqual(listProviders(L, ["npm:pi-web-access"]), [{ source: "npm:pi-web-access", bundled: true }]);
  });
});

describe("Claude login: EXTRA USAGE", () => {
  const options = [
    { provider: "openai-codex", method: "device-code", label: "ChatGPT" },
    { provider: "anthropic", method: "paste-code", label: "Claude login (extra usage)", confirm: { title: "Claude login uses EXTRA USAGE", body: "…", ok: "Continue with Claude" } },
  ];
  it("is never the pre-selected option, even when the user's own pi has a Claude login", () => {
    assert.equal(defaultOption(options, { codexCli: false, userOauth: ["anthropic"] }).provider, "openai-codex");
  });
  it("needs an explicit yes; --yes alone does not start it", async () => {
    const out = { text: "", write(s) { this.text += s; } };
    await assert.rejects(signIn(layout({ HOME: tmp() }), options[1], new Prompter({ assumeYes: true }), out), /not confirmed/);
    assert.match(out.text, /EXTRA USAGE/);
  });
});

describe("pi dir contents", () => {
  it("keeps the user's ~/.agents/skills out by default (one constant)", () => {
    const L = layout({ HOME: tmp() });
    const r = writePiSetup(L);
    const s = JSON.parse(readFileSync(r.settingsPath, "utf8"));
    assert.equal(LOAD_USER_AGENTS_SKILLS, false);
    assert.deepEqual(s.skills, [`!${join(L.home, ".agents", "skills")}/**`]);
    writePiSetup(L); // idempotent
    assert.equal(JSON.parse(readFileSync(r.settingsPath, "utf8")).skills.length, 1);
  });
  it("ask_user_question is a bot-only extension (daemon command line), absent when not bundled", () => {
    const L = layout({ HOME: tmp() });
    assert.deepEqual(botOnlyExtensionArgs(L), []);
    const dir = join(L.app, "pi-packages", "node_modules", "@juicesharp", "rpiv-ask-user-question");
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(botOnlyExtensionArgs(L), ["-e", dir]);
    const cfg = JSON.parse(readFileSync(writeDaemonConfig(L, { mainModel: null }), "utf8"));
    assert.deepEqual(cfg.agents.providers.optchat.command.slice(-2), ["-e", dir]);
    // not in settings.json, so herdr workers (plain `pi`) do not load it
    assert.doesNotMatch(readFileSync(writePiSetup(L).settingsPath, "utf8"), /rpiv/);
  });
  it("the bots plugin's bundled skills (workers) reach every bot via --skill, not workers' plain pi", () => {
    const L = layout({ HOME: tmp() });
    assert.deepEqual(botSkillArgs(L), []);
    const skills = join(L.app, "bots", "skills");
    mkdirSync(join(skills, "workers"), { recursive: true });
    assert.deepEqual(botSkillArgs(L), ["--skill", skills]);
    // with the worker shortlist: each non-listed skill folder separately, the listed ones left out
    writeFileSync(join(skills, "workers", "SKILL.md"), "---\nname: workers\n---\n");
    writeFileSync(join(skills, "workers", "worker-skills.txt"), "# comment\ntdd\n\nherdr  # trailing\n");
    for (const n of ["tdd", "herdr", "extra"]) {
      mkdirSync(join(skills, n));
      writeFileSync(join(skills, n, "SKILL.md"), `---\nname: ${n}\n---\n`);
    }
    assert.deepEqual(botSkillArgs(L), ["--skill", join(skills, "extra"), "--skill", join(skills, "workers")]);
    rmSync(join(skills, "workers", "worker-skills.txt"));
    const cfg = JSON.parse(readFileSync(writeDaemonConfig(L, { mainModel: null }), "utf8"));
    assert.deepEqual(cfg.agents.providers.optchat.command.slice(-2), ["--skill", skills]);
    assert.equal(cfg.agents.providers.optchat.command[0], join(L.bin, "pi"));
    // not in DinoBot's pi settings.json, so herdr workers and terminal pi do not list it
    assert.doesNotMatch(readFileSync(writePiSetup(L).settingsPath, "utf8"), /bots[\\/]+skills/);
  });
  it("update refreshes only the OptChat command line (skills bundled later reach existing installs)", () => {
    const L = layout({ HOME: tmp() });
    assert.equal(refreshOptchatCommand(L), null, "no config yet: nothing written");
    const path = writeDaemonConfig(L, { mainModel: "prov/model-x", thinking: "low" });
    const before = JSON.parse(readFileSync(path, "utf8"));
    assert.ok(!before.agents.providers.optchat.command.includes("--skill"));
    mkdirSync(join(L.app, "bots", "skills", "workers"), { recursive: true });
    assert.equal(refreshOptchatCommand(L), path);
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(after.agents.providers.optchat.command.slice(-2), ["--skill", join(L.app, "bots", "skills")]);
    assert.deepEqual(after.daemon.agentProfiles, before.daemon.agentProfiles, "the bot profile's model is kept");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe("stage 0: Paseo's own providers off, only OptChat", () => {
  const OFF = ["claude", "codex", "copilot", "opencode", "omp", "pi", "antigravity", "muse"];
  it("a new config has every built-in Paseo provider disabled and OptChat on", () => {
    const L = layout({ HOME: tmp() });
    const cfg = JSON.parse(readFileSync(writeDaemonConfig(L, { mainModel: null }), "utf8"));
    for (const id of OFF) assert.equal(cfg.agents.providers[id]?.enabled, false, id);
    assert.deepEqual([...DISABLED_PASEO_PROVIDERS].sort(), [...OFF].sort());
    assert.notEqual(cfg.agents.providers.optchat.enabled, false);
    assert.equal(cfg.agents.providers.optchat.extends, "pi");
  });
  it("an existing config: providers switched off on the next write, everything else kept", () => {
    const L = layout({ HOME: tmp() });
    mkdirSync(L.paseoHome, { recursive: true });
    const skills = join(L.app, "bots", "skills");
    mkdirSync(join(skills, "workers"), { recursive: true });
    const existing = {
      version: 1,
      daemon: { listen: "127.0.0.1:6767", terminalProfiles: [{ id: "codex", name: "Codex", command: "codex", args: [] }], auth: { password: "x" } },
      plugins: { apns: { source: "directory", path: "/x/apns", enabled: true } },
      agents: {
        providers: {
          codex: { enabled: true, command: ["codex", "app-server"] },
          claude: { env: { A: "1" } },
          kimi: { extends: "acp", label: "Kimi", command: ["kimi", "acp"] },
          zai: { extends: "claude", label: "Z.AI" },
          mypi: { extends: "pi", label: "My pi" },
          muse: { enabled: false },
          someplugin: { order: 3 },
          optchat: { extends: "pi", label: "OptChat", command: ["old"], options: { rpcTimeoutMs: 1 }, models: [{ id: "m", label: "M" }] },
        },
        metadataGeneration: { providers: [{ provider: "optchat", model: "anthropic/claude-sonnet-5-5" }] },
      },
    };
    writeFileSync(join(L.paseoHome, "config.json"), JSON.stringify(existing));
    const cfg = JSON.parse(readFileSync(writeDaemonConfig(L, { mainModel: null }), "utf8"));
    const p = cfg.agents.providers;
    for (const id of OFF) assert.equal(p[id].enabled, false, id);
    for (const id of ["kimi", "zai", "mypi"]) assert.equal(p[id].enabled, false, `custom ${id}`);
    assert.deepEqual(p.codex.command, ["codex", "app-server"], "settings of a disabled provider kept");
    assert.deepEqual(p.claude.env, { A: "1" });
    assert.deepEqual(p.kimi.command, ["kimi", "acp"]);
    assert.deepEqual(p.muse, { enabled: false });
    assert.deepEqual(p.someplugin, { order: 3 }, "plugin overrides (no extends) untouched");
    assert.notEqual(p.optchat.enabled, false);
    assert.deepEqual(p.optchat.command.slice(-2), ["--skill", skills]);
    assert.deepEqual(p.optchat.models, [{ id: "m", label: "M" }]);
    assert.deepEqual(cfg.agents.metadataGeneration, existing.agents.metadataGeneration);
    assert.deepEqual(cfg.daemon.terminalProfiles, existing.daemon.terminalProfiles, "terminal agents stay");
    assert.equal(cfg.daemon.auth.password, "x");
    assert.deepEqual(cfg.plugins.apns, existing.plugins.apns);
  });
  it("dinobot update (refreshOptchatCommand) switches them off too, and is idempotent", () => {
    const L = layout({ HOME: tmp() });
    const path = writeDaemonConfig(L, { mainModel: "prov/m", thinking: "low" });
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    cfg.agents.providers.codex = { enabled: true };
    delete cfg.agents.providers.pi;
    writeFileSync(path, JSON.stringify(cfg));
    assert.equal(refreshOptchatCommand(L), path);
    const once = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(once.agents.providers.codex.enabled, false);
    assert.equal(once.agents.providers.pi.enabled, false);
    assert.deepEqual(once.daemon.agentProfiles, cfg.daemon.agentProfiles);
    refreshOptchatCommand(L);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), once);
  });
  it("a provider a Paseo schedule still runs on is left as it is (no broken scheduled runs)", () => {
    const L = layout({ HOME: tmp() });
    const dir = join(L.paseoHome, "schedules");
    mkdirSync(dir, { recursive: true });
    const schedule = (id, provider, status) => ({ id, status, target: { type: "new-agent", config: { provider, cwd: "/x" } } });
    writeFileSync(join(dir, "a.json"), JSON.stringify(schedule("a", "pi", "active")));
    writeFileSync(join(dir, "b.json"), JSON.stringify(schedule("b", "codex", "paused")));
    writeFileSync(join(dir, "c.json"), JSON.stringify(schedule("c", "claude", "completed")));
    writeFileSync(join(dir, "d.json"), JSON.stringify({ id: "d", status: "active", target: { type: "agent", agentId: "x" } }));
    writeFileSync(join(dir, "junk.json"), "{");
    assert.deepEqual([...scheduledProviders(L.paseoHome)].sort(), ["codex", "pi"]);
    const cfg = JSON.parse(readFileSync(writeDaemonConfig(L, { mainModel: null }), "utf8"));
    assert.equal(cfg.agents.providers.pi?.enabled, undefined, "pi: an active schedule uses it");
    assert.equal(cfg.agents.providers.codex?.enabled, undefined, "codex: a paused schedule may be resumed");
    assert.equal(cfg.agents.providers.claude.enabled, false, "a finished schedule does not count");
    assert.deepEqual(scheduledProviders(join(L.paseoHome, "nope")), new Set());
  });
  it("applyProviderDefaults works on a bare object (deploy script for a hand-made ~/.paseo)", () => {
    const cfg = applyProviderDefaults({});
    for (const id of OFF) assert.equal(cfg.agents.providers[id].enabled, false);
    assert.equal(cfg.agents.providers.optchat, undefined, "does not invent an OptChat entry");
  });
});

describe("bundled workers skill (plugins/bots/skills/workers)", () => {
  const dir = join(import.meta.dirname, "..", "plugins", "bots", "skills", "workers");
  it("has a SKILL.md pi can load (frontmatter name + description) and a launch.sh that parses", () => {
    const md = readFileSync(join(dir, "SKILL.md"), "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1] ?? "";
    assert.match(fm, /^name: workers$/m);
    assert.match(fm, /^description: \S.{20,1024}$/m);
    assert.match(md, /launch\.sh/);
    assert.equal(spawnSync("sh", ["-n", join(dir, "launch.sh")]).status, 0);
    const usage = spawnSync("sh", [join(dir, "launch.sh")], { encoding: "utf8" });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: launch\.sh <name> <brief-file> <minutes>/);
  });
  it("launch.sh starts the worker's pi with --no-skills and the bundled shortlist; WORKER_SKILLS (colon-separated) adds --skill paths, none drops the shortlist", () => {
    // A stand-in herdr and bot-worker on PATH: herdr logs the `agent start` args and answers like 0.9.
    const d = tmp();
    const bin = join(d, "bin");
    mkdirSync(bin);
    const log = join(d, "herdr.log");
    const herdr = `#!/bin/sh
case "$1 $2" in
  "agent get") exit 1 ;;
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w1"},"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}' ;;
  "agent start") printf '%s\\n' "$@" > "${log}"; echo '{"result":{"agent":{"agent_session":{"value":""}}}}' ;;
  *) echo '{"result":{}}' ;;
esac
`;
    writeFileSync(join(bin, "herdr"), herdr, { mode: 0o755 });
    writeFileSync(join(bin, "bot-worker"), "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
    const brief = join(d, "brief.md");
    writeFileSync(brief, "tiny\n");
    const launch = (extra = {}) => {
      const r = spawnSync("sh", [join(dir, "launch.sh"), "w-one", brief, "1", d], {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH}`, BOT: "testbot", HOME: d, ...extra },
      });
      assert.equal(r.status, 0, r.stderr);
      const args = readFileSync(log, "utf8").trim().split("\n");
      return args.slice(args.indexOf("--") + 1);
    };
    const skillsOf = (args) => args.flatMap((a, i) => (a === "--skill" ? [args[i + 1]] : []));
    const root = join(dir, "..");
    const shortlist = ["diagnose", "tdd", "screenshot-app", "herdr"].map((n) => join(root, n));
    const plain = launch();
    assert.ok(plain.includes("--no-skills"), plain.join(" "));
    assert.deepEqual(skillsOf(plain), shortlist, "the bundled worker shortlist by default");
    const some = launch({ WORKER_SKILLS: "/opt/a::/opt/b c" });
    assert.ok(some.includes("--no-skills"));
    assert.deepEqual(skillsOf(some), [...shortlist, "/opt/a", "/opt/b c"]);
    assert.deepEqual(skillsOf(launch({ WORKER_SKILLS: "none" })), [], "none: no skills at all");
    assert.deepEqual(skillsOf(launch({ WORKER_SKILLS: "none:/opt/a" })), ["/opt/a"]);
  });
  // --engine cc: the same stand-in herdr; the worker is Claude Code (herdr's claude kind) and the pi path is unchanged.
  const standIn = () => {
    const d = tmp();
    const bin = join(d, "bin");
    mkdirSync(bin);
    const log = join(d, "herdr.log");
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh
case "$1 $2" in
  "agent get") exit 1 ;;
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w1"},"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}' ;;
  "agent start") printf '%s\\n' "$@" > "${log}"; echo '{"result":{"agent":{"agent_session":{"value":""}}}}' ;;
  *) echo '{"result":{}}' ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "bot-worker"), "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const brief = join(d, "brief.md");
    writeFileSync(brief, "tiny\nBudget: US$3.50, about 5 min.\n");
    const run = (args, extra = {}) =>
      spawnSync("sh", [join(dir, "launch.sh"), ...args, "w-one", brief, "1", d], {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH}`, BOT: "testbot", HOME: d, ...extra },
      });
    const started = () => readFileSync(log, "utf8").trim().split("\n");
    return { d, brief, run, started };
  };
  it("launch.sh --engine pi (and no --engine) starts pi with exactly the arguments it always had", () => {
    const { d, run, started } = standIn();
    const root = join(dir, "..");
    for (const args of [[], ["--engine", "pi"]]) {
      const r = run(args, { WORKER_MODEL: "anthropic/claude-sonnet-5:high" });
      assert.equal(r.status, 0, r.stderr);
      const a = started();
      const sid = a[a.indexOf("--session-id") + 1];
      assert.match(sid, /^w-one-\d{8}-\d{6}$/);
      assert.deepEqual(a, [
        "agent", "start", "w-one", "--kind", "pi", "--pane", "w1:p1", "--timeout", "60000", "--",
        "--model", "anthropic/claude-sonnet-5:high", "--no-skills", "--session-id", sid, "--name", "w-one",
        ...["diagnose", "tdd", "screenshot-app", "herdr"].flatMap((n) => ["--skill", join(root, n)]),
      ]);
      const info = JSON.parse(r.stdout);
      assert.equal(info.engine, undefined, "no engine field for pi: the launch JSON is as before");
    }
    assert.equal(run(["--engine", "codex"]).status, 2);
    void d;
  });
  it("launch.sh (pi): the worker's pi uses the bots' pi dir (PI_CODING_AGENT_DIR, else DinoBot's own) when it exists; else nothing is set, as before", () => {
    const d = tmp();
    const bin = join(d, "bin");
    mkdirSync(bin);
    const calls = join(d, "calls.log");
    // Stand-in herdr: every call, one line each (args joined by |).
    writeFileSync(
      join(bin, "herdr"),
      `#!/bin/sh
IFS='|'; printf '%s\\n' "$*" >> "${calls}"
case "$1 $2" in
  "agent get") exit 1 ;;
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w1"},"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}' ;;
  "agent start") echo '{"result":{"agent":{"agent_session":{"value":""}}}}' ;;
  *) echo '{"result":{}}' ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "bot-worker"), "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
    const brief = join(d, "brief.md");
    writeFileSync(brief, "tiny\n");
    const launch = (extra) => {
      writeFileSync(calls, "");
      const r = spawnSync("sh", [join(dir, "launch.sh"), "w-one", brief, "1", d], {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH}`, BOT: "testbot", HOME: d, ...extra },
      });
      assert.equal(r.status, 0, r.stderr);
      const lines = readFileSync(calls, "utf8").trim().split("\n");
      const start = lines.findIndex((l) => l.startsWith("agent|start|"));
      const runs = lines.filter((l) => l.startsWith("pane|run|"));
      assert.ok(start >= 0);
      for (const l of runs) assert.ok(lines.indexOf(l) < start, "set before pi starts");
      return runs.map((l) => l.split("|").slice(2));
    };
    const bots = join(d, "dinobot", "pi");
    const odd = join(d, "it's pi");
    mkdirSync(bots, { recursive: true });
    mkdirSync(odd);
    // Fresh DinoBot install: the daemon (so the bot's shell) has PI_CODING_AGENT_DIR = DinoBot's pi dir.
    assert.deepEqual(launch({ PI_CODING_AGENT_DIR: bots, DINOBOT_HOME: join(d, "dinobot") }), [["w1:p1", `export PI_CODING_AGENT_DIR='${bots}'`]]);
    // Only DINOBOT_HOME (or DINOBOT_PI_DIR): the dir the Providers page writes (lib/util.mjs layout).
    assert.deepEqual(launch({ DINOBOT_HOME: join(d, "dinobot") }), [["w1:p1", `export PI_CODING_AGENT_DIR='${bots}'`]]);
    assert.deepEqual(launch({ DINOBOT_HOME: join(d, "nowhere"), DINOBOT_PI_DIR: odd }), [["w1:p1", `export PI_CODING_AGENT_DIR='${d}/it'\\''s pi'`]]);
    assert.deepEqual(launch({ PI_CODING_AGENT_DIR: "~/dinobot/pi" }), [["w1:p1", `export PI_CODING_AGENT_DIR='${bots}'`]], "~ is the home folder");
    // Missing folder, or nothing set (a plain host such as noble's, where bots use ~/.pi/agent): no export.
    assert.deepEqual(launch({ PI_CODING_AGENT_DIR: join(d, "missing") }), []);
    assert.deepEqual(launch({ DINOBOT_HOME: join(d, "nowhere") }), []);
    assert.deepEqual(launch({}), []);
    // cc workers: no pi export; DINOBOT_CLAUDE_CONFIG_DIR (the Claude Code card's login) comes before CC_WORKER_CONFIG_DIR.
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const cc = (extra) => launch({ WORKER_ENGINE: "cc", PI_CODING_AGENT_DIR: bots, ...extra });
    assert.deepEqual(cc({}), []);
    const card = join(d, "card-claude");
    assert.deepEqual(cc({ DINOBOT_CLAUDE_CONFIG_DIR: card, CC_WORKER_CONFIG_DIR: join(d, "w") }), [["w1:p1", `unset -f claude 2>/dev/null; export CLAUDE_CONFIG_DIR='${card}'`]]);
    assert.deepEqual(cc({ CC_WORKER_CONFIG_DIR: join(d, "w") }), [["w1:p1", `unset -f claude 2>/dev/null; export CLAUDE_CONFIG_DIR='${join(d, "w")}'`]]);
  });
  it("launch.sh --engine cc starts claude with a UUID session, the shortlist as a session plugin, the spend status line, no blocking hook, and the model", () => {
    const { d, brief, run, started } = standIn();
    const root = join(dir, "..");
    const r = run(["--engine", "cc"], { BOTS_WORKER_MODEL: "anthropic/claude-sonnet-5:high", WORKER_SKILLS: join(root, "workers") });
    assert.equal(r.status, 0, r.stderr);
    const a = started();
    assert.deepEqual(a.slice(0, 10), ["agent", "start", "w-one", "--kind", "claude", "--pane", "w1:p1", "--timeout", "60000", "--"]);
    const arg = (k) => a[a.indexOf(k) + 1];
    assert.equal(arg("--model"), "claude-sonnet-5");
    assert.equal(arg("--effort"), "high");
    assert.match(arg("--session-id"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(arg("--name"), "w-one");
    assert.equal(arg("--setting-sources"), "project,local");
    assert.ok(!a.includes("--no-skills") && !a.includes("-p") && !a.includes("--print"), "interactive TUI, no pi flags");
    const cc = join(d, "brief.cc");
    assert.equal(arg("--plugin-dir"), join(cc, "plugin"));
    const skills = readdirSync(join(cc, "plugin", "skills")).sort();
    assert.deepEqual(skills, ["diagnose", "herdr", "screenshot-app", "tdd", "workers"]);
    assert.equal(readFileSync(join(cc, "plugin", "skills", "tdd", "SKILL.md"), "utf8"), readFileSync(join(root, "tdd", "SKILL.md"), "utf8"));
    assert.equal(JSON.parse(readFileSync(join(cc, "plugin", ".claude-plugin", "plugin.json"), "utf8")).name, "worker");
    assert.equal(readFileSync(join(cc, "budget"), "utf8").trim(), "3.50", "the budget comes from the brief's US$ figure");
    const settings = JSON.parse(readFileSync(arg("--settings"), "utf8"));
    assert.match(settings.statusLine.command, /cc-status\.mjs' '/);
    assert.equal(settings.hooks, undefined, "no PreToolUse hook: nothing blocks a tool call (advisory budget, as pi)");
    assert.equal(settings.env.DISABLE_AUTOUPDATER, "1");
    assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined, "no proxy unless CC_WORKER_BASE_URL");
    // token trim: worker tool set, no MCP, no side calls, no built-in skills, no home CLAUDE.md, no attribution note
    assert.equal(arg("--tools"), "Bash,Read,Edit,Write,Glob,Grep,Skill");
    assert.ok(a.includes("--strict-mcp-config") && a.includes("--exclude-dynamic-system-prompt-sections"));
    assert.ok(!a.includes("--disable-slash-commands"), "slash commands stay on: they carry the skill shortlist");
    assert.equal(settings.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, "false");
    for (const k of ["CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"])
      assert.equal(settings.env[k], "1", k);
    assert.ok(settings.claudeMdExcludes.includes(join(d, ".claude", "**")), "HOME is d in the stand-in");
    assert.deepEqual(settings.attribution, { commit: "", pr: "" });
    assert.equal(settings.autoMemoryEnabled, false);
    const info = JSON.parse(r.stdout);
    assert.equal(info.engine, "cc");
    assert.equal(info.model, "claude-sonnet-5");
    assert.equal(info.session_file, join(d, ".claude", "projects", d.replace(/[^A-Za-z0-9]/g, "-"), `${arg("--session-id")}.jsonl`));
    // none drops the shortlist; WORKER_BUDGET_USD wins over the brief; a proxy goes in settings env; a non-Claude model is not passed
    const r2 = run(["--engine", "cc"], { WORKER_SKILLS: "none", WORKER_BUDGET_USD: "7", CC_WORKER_BASE_URL: "http://proxy.invalid/x", WORKER_MODEL: "openai/gpt-9" });
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(readdirSync(join(cc, "plugin", "skills")), []);
    assert.equal(readFileSync(join(cc, "budget"), "utf8").trim(), "7");
    assert.deepEqual(JSON.parse(readFileSync(join(cc, "settings.json"), "utf8")).env.ANTHROPIC_BASE_URL, "http://proxy.invalid/x");
    assert.ok(!started().includes("--model"));
    assert.match(r2.stderr, /not a Claude model/);
    // WORKER_ENGINE=cc is the same as --engine cc
    assert.equal(run([], { WORKER_ENGINE: "cc" }).status, 0);
    assert.ok(started().includes("claude"));
    // a proxy token in settings.json: only the owner can read it
    run(["--engine", "cc"], { CC_WORKER_BASE_URL: "http://proxy.invalid/x", CC_WORKER_AUTH_TOKEN: "t0k" });
    assert.equal(statSync(join(cc, "settings.json")).mode & 0o077, 0, "settings.json is 0600");
    // a brief without a budget still launches: the budget is optional, as for pi
    writeFileSync(brief, "tiny, no budget\n");
    const r3 = run(["--engine", "cc"]);
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(readFileSync(join(cc, "budget"), "utf8").trim(), "");
  });
  it("launch.sh --engine cc without claude on PATH: a clear error before any herdr tab is made", (t) => {
    const { d, run } = standIn();
    if (spawnSync("sh", ["-c", "command -v claude"], { env: { PATH: "/usr/bin:/bin" } }).status === 0) return t.skip("claude in /usr/bin");
    const bin = join(d, "bin");
    rmSync(join(bin, "claude"));
    symlinkSync(process.execPath, join(bin, "node"));
    const r = run(["--engine", "cc"], { PATH: `${bin}:/usr/bin:/bin` });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /claude \(Claude Code\) is not on PATH/);
    assert.ok(!statSync(join(d, "herdr.log"), { throwIfNoEntry: false }), "no claude started");
  });
  it("cc-status.mjs: the status line shows the spend (kept across a restart) and the budget when there is one; never blocks", () => {
    const d = tmp();
    const status = (usd) => spawnSync("node", [join(dir, "cc-status.mjs"), d], { encoding: "utf8", input: JSON.stringify({ session_id: "s1", model: { display_name: "Haiku" }, cost: { total_cost_usd: usd } }) });
    assert.equal(status(0.4).stdout, "$0.40 · Haiku", "no budget file: spend only");
    writeFileSync(join(d, "budget"), "\n");
    assert.equal(status(0.5).stdout, "$0.50 · Haiku", "empty budget: spend only");
    writeFileSync(join(d, "budget"), "1\n");
    assert.equal(status(0.8).stdout, "$0.80 / budget $1.00 · Haiku");
    const r = status(0.3);
    assert.equal(r.stdout, "$1.10 / budget $1.00 OVER BUDGET · Haiku", "a restarted process starts at 0: the old figure is banked");
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(readFileSync(join(d, "cost.json"), "utf8")).base, 0.8);
    assert.equal(spawnSync("node", [join(dir, "cc-status.mjs"), d], { encoding: "utf8", input: "not json" }).stdout, "$1.10 / budget $1.00 OVER BUDGET");
    assert.ok(!readdirSync(dir).includes("cc-cap.mjs"), "the blocking cap hook is gone");
  });
  it("bundles the worker shortlist: each listed skill has a SKILL.md pi can load, a LICENSE where it is third-party, no fleet details", () => {
    const root = join(dir, "..");
    const names = readFileSync(join(dir, "worker-skills.txt"), "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
    assert.deepEqual(names, ["diagnose", "tdd", "screenshot-app", "herdr"]);
    for (const n of names) {
      const md = readFileSync(join(root, n, "SKILL.md"), "utf8");
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1] ?? "";
      assert.match(fm, new RegExp(`^name: ${n}$`, "m"), n);
      assert.match(fm, /^description: \S/m, n);
    }
    for (const n of ["diagnose", "tdd", "herdr"]) {
      assert.ok(statSync(join(root, n, "LICENSE")).size > 0, `${n}/LICENSE`);
      assert.ok(statSync(join(root, n, "NOTICE")).size > 0, `${n}/NOTICE`);
    }
    const herdr = readFileSync(join(root, "herdr", "SKILL.md"), "utf8");
    assert.doesNotMatch(herdr, /\/home\/|\bnoble\b|bitzer|emmet|ccflare|100\.\d+\.\d+\.\d+/i);
  });
  it("ships in the release (build archives HEAD:plugins/bots, which keeps skills/)", () => {
    const build = readFileSync(join(import.meta.dirname, "..", "build", "build-tarball.sh"), "utf8");
    assert.match(build, /archive_tree "\$BOTS_REPO" "\$BOTS_REF" "\$STAGE\/bots"/);
    assert.doesNotMatch(build, /rm -rf "\$STAGE\/bots\/skills"/);
  });
});

// rel-demo: phone onboarding helpers (pi is the source; these only read pi's model data).
import { clampEffort, effortLevels, piModelArg } from "../lib/phone-signin.mjs";
import { SETUP_FLOW } from "../lib/flow.mjs";
import * as flow from "../lib/flow.mjs";
import { signInOptions } from "../lib/signin.mjs";
import { subscriptionFor } from "../lib/detect.mjs";

it("effort levels follow pi's thinkingLevelMap (null = unsupported; xhigh/max only when named); none without reasoning", () => {
  assert.deepEqual(effortLevels({ reasoning: false }), []);
  assert.deepEqual(effortLevels({ reasoning: true }), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(effortLevels({ reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" } }), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(clampEffort(["low", "medium", "high"], "max"), "high");
  assert.equal(clampEffort(["low", "medium"], "off"), "low");
  assert.equal(clampEffort([], "medium"), null);
  assert.equal(piModelArg({ provider: "openrouter", model: "z-ai/glm-5", thinking: "low" }), "openrouter/z-ai/glm-5:low");
  assert.equal(piModelArg({ provider: "openai-codex", model: "gpt-5.6-luna", thinking: null }), "openai-codex/gpt-5.6-luna");
});

it("setup order: sign-in and import on the phone by default", () => {
  assert.equal(SETUP_FLOW.signIn, "phone");
  assert.equal(SETUP_FLOW.import, "phone");
});

it("no demo / keyless sign-in row any more (luna-demo, 27 Oct): demos sign in with a real login", async () => {
  assert.equal(flow.DEMO_PROVIDERS, undefined);
  const options = await signInOptions("/nonexistent-app", { DINOBOT_DEMO_PROVIDER: "keyless-demo" });
  assert.ok(options.length > 0);
  assert.ok(options.every((o) => o.method !== "keyless" && o.badge !== "DEMO" && !/demo/i.test(o.label)), JSON.stringify(options.map((o) => o.label)));
  assert.equal(subscriptionFor("keyless-demo", "api_key"), null);
});
