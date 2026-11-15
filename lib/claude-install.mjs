// Installs the `claude` CLI (Claude Code) on this computer with Anthropic's own native installer
// (FR1 addendum, 15 Nov: one "Install Claude Code" button, then the login on its own).
//
// The method is Anthropic's documented one (code.claude.com/docs/en/setup, "Native Install
// (Recommended)"): `curl -fsSL https://claude.ai/install.sh | bash`. It runs as the user, needs no
// sudo, and puts a launcher at ~/.local/bin/claude (a link into ~/.local/share/claude/versions/).
// DinoBot never ships or vendors the binary and does not use npm -g. findClaude (engines.mjs)
// already looks in ~/.local/bin, so no PATH change is needed afterwards.
//
// Then the Claude Code login (engines.mjs startClaudeCodeLogin) starts by itself:
// startClaudeCodeSetup is one signin session, phase "install" then phase "login".
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { findClaude, startClaudeCodeLogin } from "./engines.mjs";

/** signin.start's option id: install Claude Code if it is missing, then its login. */
export const CLAUDE_CODE_INSTALL_ID = "claude-code:install";
export const CLAUDE_INSTALL_URL = "https://claude.ai/install.sh";
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
const KEEP_LINES = 40;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g;

/** The installer's own output, without colours or spinners, as plain lines. */
export function cleanLines(text) {
  return String(text ?? "")
    .replace(ANSI, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The shell command (pipefail: a failed download is an error, not an empty script). */
export function installCommand(url = CLAUDE_INSTALL_URL) {
  return `set -o pipefail; curl -fsSL ${url} | bash`;
}

/** PATH for the installer: the daemon's PATH can be short (launchd, systemd). */
function installEnv(env) {
  const base = String(env.PATH ?? "");
  const extra = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const PATH = [...base.split(":").filter(Boolean), ...extra.filter((d) => !base.split(":").includes(d))].join(":");
  return { ...env, PATH };
}

/**
 * Runs the native installer once. Already installed: does nothing ({skipped: true}).
 * -> {lines, cancel(), promise -> {ok, bin, skipped, error}}. `onLine` gets each output line.
 * `spawnFn`, `find` and `timeoutMs` are injectable (tests).
 */
export function installClaudeCli(env = process.env, { spawnFn = spawn, find = () => findClaude(env), timeoutMs = INSTALL_TIMEOUT_MS, url = CLAUDE_INSTALL_URL, onLine = () => {} } = {}) {
  const lines = [];
  const already = find();
  if (already) return { lines, cancel() {}, promise: Promise.resolve({ ok: true, bin: already, skipped: true, error: null }) };

  let child = null;
  let settle;
  const promise = new Promise((r) => (settle = r));
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    settle(result);
  };
  // The whole group (bash, curl, the installer's own children), not just bash.
  const kill = () => {
    try {
      if (child?.pid) process.kill(-child.pid, "SIGTERM");
      else child?.kill();
    } catch {
      try {
        child?.kill();
      } catch {}
    }
  };
  const timer = setTimeout(() => {
    kill();
    finish({ ok: false, bin: null, skipped: false, error: `Installing Claude Code took longer than ${Math.round(timeoutMs / 60_000) || 1} minutes and was stopped. Check the computer's internet connection, then try again.` });
  }, timeoutMs);
  timer.unref?.();
  const take = (d) => {
    for (const l of cleanLines(d)) {
      lines.push(l);
      if (lines.length > KEEP_LINES) lines.shift();
      onLine(l);
    }
  };
  try {
    child = spawnFn("bash", ["-c", installCommand(url)], { env: installEnv(env), cwd: env.HOME || undefined, stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (e) {
    finish({ ok: false, bin: null, skipped: false, error: `Could not run the Claude Code installer: ${e.message}` });
    return { lines, cancel() {}, promise };
  }
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  child.on("error", (e) => finish({ ok: false, bin: null, skipped: false, error: `Could not run the Claude Code installer: ${e.message}` }));
  child.on("close", (code) => {
    if (done) return;
    if (code !== 0) {
      const last = lines.at(-1);
      return finish({ ok: false, bin: null, skipped: false, error: `The Claude Code installer stopped (exit ${code})${last ? `: ${last.slice(0, 200)}` : ""}. Try again.` });
    }
    const bin = find();
    if (!bin) return finish({ ok: false, bin: null, skipped: false, error: "The installer finished, but claude is not in ~/.local/bin. Try again, or install it from claude.com/download." });
    finish({ ok: true, bin, skipped: false, error: null });
  });
  return {
    lines,
    cancel() {
      kill();
      finish({ ok: false, bin: null, skipped: false, error: "Cancelled." });
    },
    promise,
  };
}

/**
 * One session for the app's "Install Claude Code" button: phase "install" (the native installer,
 * skipped when claude is already there), then phase "login" (`claude auth login`, the code pasted in
 * the app) with no extra tap. Shaped like engines.mjs startClaudeCodeLogin: {session, submit, cancel}.
 * `session` adds `phase` ("install" | "login") and `progress` (the installer's last line).
 */
export function startClaudeCodeSetup(env = process.env, { install = installClaudeCli, login = startClaudeCodeLogin } = {}) {
  const s = { id: randomUUID(), provider: "claude-code", label: "Claude Code", state: "running", phase: "install", progress: "Downloading Claude Code from claude.ai…", url: null, code: null, instructions: null, prompt: null, error: null, startedAt: Date.now() };
  let inner = null;
  let cancelled = false;
  const fail = (message) => {
    s.state = "error";
    s.prompt = null;
    s.error = message;
  };
  const job = install(env, { onLine: (l) => (s.progress = l.slice(0, 200)) });
  job.promise
    .then((r) => {
      if (cancelled) return;
      if (!r.ok) return fail(r.error ?? "Claude Code did not install.");
      s.phase = "login";
      s.progress = r.skipped ? "Claude Code is already installed." : "Claude Code is installed.";
      try {
        inner = login(env, r.bin ? { bin: r.bin } : {});
      } catch (e) {
        fail(e.message);
      }
    })
    .catch((e) => fail(e.message));
  return {
    get session() {
      if (!inner) return s;
      const i = inner.session;
      return { ...i, id: s.id, phase: "login", progress: s.progress, error: i.error ?? s.error, state: s.state === "error" ? "error" : i.state };
    },
    submit(text) {
      if (!inner) throw new Error("Nothing is waiting for input.");
      inner.submit(text);
    },
    cancel() {
      cancelled = true;
      job.cancel?.();
      inner?.cancel();
      fail("Cancelled.");
    },
  };
}

/**
 * `dinobot claude-code install-cli`: the same installer from the terminal, its lines printed as they
 * come, then the login as the next step. -> {ok, bin, skipped, error}
 */
export async function installClaudeCliCommand(env = process.env, { say = (l) => process.stdout.write(`${l}\n`), install = installClaudeCli } = {}) {
  say(`Installing Claude Code with Anthropic's installer (${CLAUDE_INSTALL_URL}); no sudo needed.`);
  const r = await install(env, { onLine: (l) => say(`  ${l}`) }).promise;
  if (!r.ok) {
    say(r.error);
    return r;
  }
  say(r.skipped ? `Claude Code is already installed: ${r.bin}` : `Claude Code installed: ${r.bin}`);
  say(`Next: log in with your Claude plan. In the app: Settings › your computer › Providers › Claude Code › Log in. Or here: ${r.bin} auth login`);
  return r;
}

/** `dinobot doctor`'s Claude Code line (engines.mjs claudeCodeStatus). Optional: never FAIL. */
export function claudeCodeCheck(st, { product = "dinobot" } = {}) {
  if (!st?.installed) return { status: "ok", detail: `not installed (optional; for bots on your Claude plan: ${product} claude-code install-cli, or Install Claude Code in the app)` };
  if (st.error) return { status: "WARN", detail: `installed, but: ${st.error}`, fix: "run claude --version and claude auth status in a terminal" };
  const v = st.version ? ` ${st.version}` : "";
  if (!st.loggedIn) return { status: "ok", detail: `installed${v}, not logged in (claude auth login, or Log in from the app)` };
  return { status: st.warning ? "WARN" : "ok", detail: `installed${v}, logged in${st.plan ? ` (${st.plan})` : ""}`, ...(st.warning ? { fix: st.warning } : {}) };
}
