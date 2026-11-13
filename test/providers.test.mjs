// Provider plugins, Claude extra-usage confirm, bot-only extensions, user skills kept out.
// node --test test/providers.test.mjs  (temp dirs under ./.test-tmp-prov, never /tmp)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { addProvider, gitTokenEnv, listProviders, parseProviderLink, parseSource, providerLink, readTokens, removeProvider, updateProviders } from "../lib/providers.mjs";
import { botOnlyExtensionArgs, botSkillArgs, LOAD_USER_AGENTS_SKILLS, refreshOptchatCommand, writeDaemonConfig, writePiSetup } from "../lib/config.mjs";
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
