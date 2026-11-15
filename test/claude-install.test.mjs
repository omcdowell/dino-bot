// "Install Claude Code" (FR1 addendum): Anthropic's native installer, then the login by itself.
// node --test test/claude-install.test.mjs  (temp dirs under ./.test-tmp-claude-install, never /tmp)
// The installer is a local file:// script, fetched by the same `curl -fsSL <url> | bash` pipe.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { CLAUDE_CODE_INSTALL_ID, CLAUDE_INSTALL_URL, claudeCodeCheck, cleanLines, installClaudeCli, installClaudeCliCommand, installCommand, startClaudeCodeSetup } from "../lib/claude-install.mjs";
import { claudeCodeStatus, findClaude } from "../lib/engines.mjs";
import { PhoneSignIn } from "../lib/phone-signin.mjs";
import { layout } from "../lib/util.mjs";

const TMP = join(import.meta.dirname, "..", ".test-tmp-claude-install");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

/** A fake `claude` (as in engines.test.mjs): version, auth status, auth login reading a code. */
const FAKE_CLAUDE = (state) => `#!/bin/sh
S="${state}"
mkdir -p "$S"
case "$1 $2" in
  "--version ") echo "2.1.323 (Claude Code)";;
  "auth status")
    if [ -f "$S/in" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'; exit 0; fi
    echo '{"loggedIn":false,"authMethod":"none"}'; exit 1;;
  "auth login")
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x"
    printf "Paste code here if prompted > "
    read code
    if [ "$code" = good ]; then touch "$S/in"; exit 0; fi
    echo "Login failed: bad code"; exit 1;;
  *) exit 2;;
esac
`;

/** A temp HOME (no claude) and an installer script at a file:// URL. */
function setup(script) {
  const h = mkdtempSync(join(TMP, "h-"));
  const file = join(h, "install.sh");
  writeFileSync(file, script(h));
  const env = { HOME: h, PATH: "/usr/bin:/bin" };
  return { h, env, url: pathToFileURL(file).href, bin: join(h, ".local", "bin", "claude") };
}
/** Like Anthropic's: prints progress (with colours), puts the launcher in ~/.local/bin. */
const GOOD = (h) => `#!/bin/bash
set -e
printf '\\033[1;32mSetting up Claude Code...\\033[0m\\n'
echo "Downloading 2.1.323" >&2
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/claude" <<'CLAUDE'
${FAKE_CLAUDE(join(h, "cc-state"))}CLAUDE
chmod +x "$HOME/.local/bin/claude"
echo "✔ Claude Code successfully installed!"
`;

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("installClaudeCli", () => {
  it("is Anthropic's documented native installer, piped to bash with pipefail", () => {
    assert.equal(CLAUDE_INSTALL_URL, "https://claude.ai/install.sh");
    assert.equal(installCommand(), "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash");
    assert.deepEqual(cleanLines("\x1b[1;32mSetting up\x1b[0m\r\n\nDone \n"), ["Setting up", "Done"]);
  });

  it("success: streams the installer's lines and finds ~/.local/bin/claude without a PATH change", async () => {
    const t = setup(GOOD);
    assert.equal(findClaude(t.env), null);
    const seen = [];
    const job = installClaudeCli(t.env, { url: t.url, onLine: (l) => seen.push(l) });
    const r = await job.promise;
    assert.deepEqual(r, { ok: true, bin: t.bin, skipped: false, error: null });
    assert.ok(seen.includes("Setting up Claude Code..."), seen.join("|"));
    assert.ok(seen.includes("Downloading 2.1.323"));
    assert.equal(findClaude(t.env), t.bin);
    assert.equal((await claudeCodeStatus(t.env)).installed, true);
  });

  it("already installed: skips the installer", async () => {
    let spawned = false;
    const job = installClaudeCli({ HOME: "/nowhere" }, { find: () => "/x/claude", spawnFn: () => ((spawned = true), null) });
    assert.deepEqual(await job.promise, { ok: true, bin: "/x/claude", skipped: true, error: null });
    assert.equal(spawned, false);
  });

  it("installer fails: its exit code and last line, plainly", async () => {
    const t = setup(() => "#!/bin/bash\necho 'Unsupported platform: sparc' >&2\nexit 3\n");
    const r = await installClaudeCli(t.env, { url: t.url }).promise;
    assert.equal(r.ok, false);
    assert.match(r.error, /stopped \(exit 3\): Unsupported platform: sparc\. Try again\./);
  });

  it("download fails (pipefail): an error, not an empty success", async () => {
    const t = setup(GOOD);
    const r = await installClaudeCli(t.env, { url: `${t.url}.missing` }).promise;
    assert.equal(r.ok, false);
    assert.match(r.error, /installer stopped \(exit \d+\)/);
    assert.equal(existsSync(t.bin), false);
  });

  it("exit 0 but no claude afterwards: says so", async () => {
    const t = setup(() => "#!/bin/bash\necho done\n");
    const r = await installClaudeCli(t.env, { url: t.url }).promise;
    assert.equal(r.ok, false);
    assert.match(r.error, /claude is not in ~\/\.local\/bin/);
  });

  it("timeout: stopped, with a clear message", async () => {
    const t = setup(() => "#!/bin/bash\necho starting\nsleep 30\n");
    const started = Date.now();
    const r = await installClaudeCli(t.env, { url: t.url, timeoutMs: 300 }).promise;
    assert.equal(r.ok, false);
    assert.match(r.error, /took longer than 1 minutes and was stopped/);
    assert.ok(Date.now() - started < 5000);
  });
});

describe("Install Claude Code, then its login (one session)", () => {
  const signinFor = (t) => {
    const L = layout({ HOME: t.h, DINOBOT_HOME: join(t.h, ".dinobot") });
    return new PhoneSignIn(L, t.env, {
      overrides: () => [],
      claudeSetup: (env) => startClaudeCodeSetup(env, { install: (e, o) => installClaudeCli(e, { ...o, url: t.url }) }),
    });
  };

  it("install → login starts by itself → pasted code → done", async () => {
    const t = setup(GOOD);
    const signin = signinFor(t);
    let s = await signin.start({ optionId: CLAUDE_CODE_INSTALL_ID });
    assert.equal(s.provider, "claude-code");
    assert.equal(s.phase, "install");
    assert.equal(s.state, "running");
    s = await until(() => {
      const x = signin.status({ sessionId: s.sessionId });
      return x.state === "needs-input" && x;
    });
    assert.equal(s.phase, "login");
    assert.equal(s.progress, "Claude Code is installed.");
    assert.match(s.url, /oauth\/authorize/);
    signin.submit({ sessionId: s.sessionId, text: "good" });
    s = await until(() => {
      const x = signin.status({ sessionId: s.sessionId });
      return x.state === "done" && x;
    });
    assert.equal(s.phase, "login");
    const st = await claudeCodeStatus(t.env);
    assert.deepEqual([st.installed, st.loggedIn, st.plan, st.canInstall], [true, true, "Max plan", true]);
  });

  it("already installed: straight to the login", async () => {
    const t = setup(() => "#!/bin/bash\nexit 99\n"); // would fail if it ran
    mkdirSync(join(t.h, ".local", "bin"), { recursive: true });
    writeFileSync(t.bin, FAKE_CLAUDE(join(t.h, "cc-state")));
    chmodSync(t.bin, 0o755);
    const signin = signinFor(t);
    const s0 = await signin.start({ optionId: CLAUDE_CODE_INSTALL_ID });
    const s = await until(() => {
      const x = signin.status({ sessionId: s0.sessionId });
      return x.state === "needs-input" && x;
    });
    assert.equal(s.progress, "Claude Code is already installed.");
    signin.cancel({ sessionId: s0.sessionId }); // claude auth login is waiting for a code
  });

  it("install fails: the session ends in that error (the app offers Try again)", async () => {
    const t = setup(() => "#!/bin/bash\necho 'no network' >&2\nexit 7\n");
    const signin = signinFor(t);
    const s0 = await signin.start({ optionId: CLAUDE_CODE_INSTALL_ID });
    const s = await until(() => {
      const x = signin.status({ sessionId: s0.sessionId });
      return x.state === "error" && x;
    });
    assert.equal(s.phase, "install");
    assert.match(s.error, /exit 7\): no network/);
  });

  it("cancel during the install stops it", async () => {
    const t = setup(() => "#!/bin/bash\nsleep 30\n");
    const signin = signinFor(t);
    const s0 = await signin.start({ optionId: CLAUDE_CODE_INSTALL_ID });
    assert.deepEqual(signin.cancel({ sessionId: s0.sessionId }), { ok: true });
    assert.throws(() => signin.status({ sessionId: s0.sessionId }), /Unknown sign-in/);
  });

  it("pi sign-in statuses carry phase/progress null", () => {
    const t = setup(GOOD);
    const signin = signinFor(t);
    signin.sessions.set("x", { id: "x", provider: "openrouter", label: "OpenRouter", state: "running", url: null, code: null, instructions: null, prompt: null, error: null });
    const s = signin.status({ sessionId: "x" });
    assert.equal(s.phase, null);
    assert.equal(s.progress, null);
  });
});

describe("CLI and doctor", () => {
  it("install-cli prints the installer's lines, then the login step", async () => {
    const t = setup(GOOD);
    const out = [];
    const r = await installClaudeCliCommand(t.env, { say: (l) => out.push(l), install: (e, o) => installClaudeCli(e, { ...o, url: t.url }) });
    assert.equal(r.ok, true);
    assert.match(out[0], /claude\.ai\/install\.sh.*no sudo/);
    assert.ok(out.includes("  Setting up Claude Code..."));
    assert.ok(out.includes(`Claude Code installed: ${t.bin}`));
    assert.match(out.at(-1), new RegExp(`Next: log in.*${t.bin} auth login`));
  });

  it("install-cli: already installed, and a failure", async () => {
    const out = [];
    await installClaudeCliCommand({}, { say: (l) => out.push(l), install: () => ({ promise: Promise.resolve({ ok: true, bin: "/b/claude", skipped: true, error: null }) }) });
    assert.ok(out.includes("Claude Code is already installed: /b/claude"));
    const bad = [];
    const r = await installClaudeCliCommand({}, { say: (l) => bad.push(l), install: () => ({ promise: Promise.resolve({ ok: false, error: "boom" }) }) });
    assert.equal(r.ok, false);
    assert.equal(bad.at(-1), "boom");
  });

  it("doctor line: optional (never FAIL), says installed and logged in", () => {
    assert.equal(claudeCodeCheck({ installed: false }).status, "ok");
    assert.match(claudeCodeCheck({ installed: false }).detail, /not installed \(optional.*claude-code install-cli/);
    assert.deepEqual(claudeCodeCheck({ installed: true, version: "2.1.323", loggedIn: false, error: null }), { status: "ok", detail: "installed 2.1.323, not logged in (claude auth login, or Log in from the app)" });
    assert.deepEqual(claudeCodeCheck({ installed: true, version: "2.1.323", loggedIn: true, plan: "Max plan", warning: null, error: null }), { status: "ok", detail: "installed 2.1.323, logged in (Max plan)" });
    assert.equal(claudeCodeCheck({ installed: true, error: "x" }).status, "WARN");
    assert.equal(claudeCodeCheck({ installed: true, loggedIn: true, warning: "Team" }).status, "WARN");
  });
});
