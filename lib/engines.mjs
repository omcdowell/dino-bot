// Settings › Providers on the phone, "Two engines" (providers redesign, option A): what the bots
// run on. The bots plugin's engines.* RPCs call this inside the daemon (through phone-signin.mjs
// createOnboarding).
//
//   pi           the default. Its sign-ins are pi's own, in DinoBot's pi dir (auth.json, 0600).
//                The phone sees each sign-in's name, whether pi says it is ready, and for an API
//                key only a hint (its public prefix and last 4 characters). The key never leaves
//                this computer. Sign out deletes that provider's entry from auth.json.
//   Claude Code  the user's own Claude Code login (`claude auth login`, Claude Code's own store).
//                DinoBot never reads or holds the token: it asks `claude auth status --json`, runs
//                `claude auth login` with the pasted code handed to it on stdin, and
//                `claude auth logout`.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { readJson, writeJson } from "./util.mjs";

/** The sign-in id the app sends to signin.start for the Claude Code login (not a pi option). */
export const CLAUDE_CODE_OPTION_ID = "claude-code:login";
/** Claude Code's first version with the mods OptChat uses (session.compact). */
export const CLAUDE_CODE_MODS_MIN = "2.1.287";

const PROVIDER_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;

/**
 * What the phone may show of a stored API key: its public prefix (sk-, sk-or-, sk-ant-, …) and its
 * last 4 characters; an env variable's name; "command" for a `!command`. Short keys show nothing.
 */
export function keyHint(key) {
  const k = String(key ?? "").trim();
  if (!k) return null;
  if (k.startsWith("!")) return "from a command";
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(k)) return `$${k}`;
  if (k.length < 16) return "••••";
  const prefix = /^([a-z]{2,4}-(?:[a-z]{2,5}-)?)/i.exec(k)?.[1] ?? "";
  return `${prefix.slice(0, 8)}…${k.slice(-4)}`;
}

/**
 * The pi card: the provider rows (provider-install.mjs ProviderJobs.list) with, for each, the kind
 * of sign-in ("login" or "key"), a key hint, and whether it can be signed out (it has an entry in
 * auth.json; a plugin's provider with no sign-in yet has none).
 */
export function piCard(list, auth = {}) {
  const signins = (list.providers ?? []).map((row) => {
    const cred = auth[row.provider];
    const kind = cred?.type === "api_key" ? "key" : cred ? "login" : null;
    return {
      ...row,
      kind,
      keyHint: kind === "key" ? keyHint(cred.key) : null,
      canSignOut: Boolean(cred),
    };
  });
  const ready = signins.filter((s) => s.ready).length;
  return { ready: ready > 0, readyCount: ready, isDefault: true, signins, packages: list.packages ?? [] };
}

/** Sign out of one pi provider: its entry leaves DinoBot's auth.json (kept 0600). */
export function removePiCredential(L, provider) {
  const p = String(provider ?? "");
  if (!PROVIDER_ID.test(p)) throw new Error("That is not a provider name.");
  const path = join(L.piAgentDir, "auth.json");
  const auth = readJson(path, {}) ?? {};
  if (!Object.prototype.hasOwnProperty.call(auth, p)) throw new Error(`${p} is not signed in on this computer.`);
  delete auth[p];
  writeJson(path, auth, 0o600);
  return { removed: p };
}

// ---------------------------------------------------------------- Claude Code

/** "2.1.323 (Claude Code)" -> "2.1.323". */
export function parseClaudeVersion(text) {
  return /(\d+\.\d+\.\d+)/.exec(String(text ?? ""))?.[1] ?? null;
}

export function versionAtLeast(version, min) {
  if (!version) return false;
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

const PLAN_NAMES = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Free" };

/** Claude Code's `auth status --json` -> what the card shows. */
export function readClaudeAuth(json) {
  const s = json && typeof json === "object" ? json : {};
  const loggedIn = s.loggedIn === true;
  const sub = typeof s.subscriptionType === "string" ? s.subscriptionType.toLowerCase() : null;
  let plan = null;
  if (loggedIn && s.authMethod === "claude.ai") plan = sub ? `${PLAN_NAMES[sub] ?? sub[0].toUpperCase() + sub.slice(1)} plan` : "Claude plan";
  else if (loggedIn && s.authMethod === "api_key") plan = "API key";
  else if (loggedIn && s.apiProvider && s.apiProvider !== "firstParty") plan = String(s.apiProvider);
  // The OptChat mods skip session.compact on Team/Enterprise logins, so OptChat cannot run there.
  const warning =
    loggedIn && (sub === "team" || sub === "enterprise")
      ? "Team and Enterprise logins turn Claude Code mods off, so OptChat memory cannot run on this login."
      : null;
  return { loggedIn, authMethod: typeof s.authMethod === "string" ? s.authMethod : null, plan, warning };
}

/** Which Claude Code config DinoBot uses: DINOBOT_CLAUDE_CONFIG_DIR, else the worker one, else the user's own. */
export function claudeConfigDir(env = process.env) {
  return env.DINOBOT_CLAUDE_CONFIG_DIR || env.CC_WORKER_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || null;
}

/** The `claude` binary: DINOBOT_CLAUDE_BIN, PATH, or the usual install places (the daemon's PATH is short). */
export function findClaude(env = process.env) {
  if (env.DINOBOT_CLAUDE_BIN) return existsSync(env.DINOBOT_CLAUDE_BIN) ? env.DINOBOT_CLAUDE_BIN : null;
  const home = env.HOME ?? "";
  const dirs = [...String(env.PATH ?? "").split(delimiter), join(home, ".local", "bin"), join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) {
    if (!d) continue;
    const f = join(d, "claude");
    try {
      if (statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

function claudeEnv(env) {
  const out = { ...env };
  const dir = claudeConfigDir(env);
  if (dir) out.CLAUDE_CONFIG_DIR = dir;
  else delete out.CLAUDE_CONFIG_DIR;
  return out;
}

/** Runs `claude <args>` -> {code, stdout, stderr}. */
export function runClaude(bin, args, env, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const child = spawn(bin, args, { env: claudeEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => finish(124), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", () => finish(127));
  });
}

/**
 * The bots that run on Claude Code now: the CC-OptChat host's registry
 * (CC_OPTCHAT_AGENTS, else $XDG_STATE_HOME/cc-optchat/agents; one cc-<bot>.json per running host,
 * with the supervisor's pid). Entries whose supervisor is gone are left out.
 */
export function claudeCodeBots(env = process.env) {
  const dir = env.CC_OPTCHAT_AGENTS || join(env.XDG_STATE_HOME || join(env.HOME ?? "", ".local", "state"), "cc-optchat", "agents");
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^cc-.+\.json$/.test(f));
  } catch {
    return [];
  }
  const bots = [];
  for (const f of files) {
    const e = readJson(join(dir, f), null);
    if (!e || typeof e.bot !== "string") continue;
    if (Number.isInteger(e.hostPid)) {
      try {
        process.kill(e.hostPid, 0);
      } catch (err) {
        if (err?.code === "ESRCH") continue;
      }
    }
    bots.push(e.bot);
  }
  return [...new Set(bots)].sort();
}

/** The Claude Code card. `run` is injectable (tests). Never throws: errors go in `error`. */
export async function claudeCodeStatus(env = process.env, { run = runClaude, bin = findClaude(env) } = {}) {
  const base = { installed: false, version: null, modsReady: false, loggedIn: false, authMethod: null, plan: null, warning: null, bots: claudeCodeBots(env), error: null };
  if (!bin) return base;
  const v = await run(bin, ["--version"], env, { timeoutMs: 15_000 });
  const version = parseClaudeVersion(v.stdout);
  if (v.code !== 0 || !version) return { ...base, installed: true, error: `claude --version failed (${(v.stderr || v.stdout).trim().slice(0, 160) || `exit ${v.code}`})` };
  const out = { ...base, installed: true, version, modsReady: versionAtLeast(version, CLAUDE_CODE_MODS_MIN) };
  // Exit 1 just means "not logged in"; the JSON is printed either way.
  const s = await run(bin, ["auth", "status", "--json"], env, { timeoutMs: 20_000 });
  let json = null;
  try {
    json = JSON.parse(s.stdout);
  } catch {
    return { ...out, error: `claude auth status failed (${(s.stderr || s.stdout).trim().slice(0, 160) || `exit ${s.code}`})` };
  }
  return { ...out, ...readClaudeAuth(json) };
}

export async function claudeCodeLogout(env = process.env, { run = runClaude, bin = findClaude(env) } = {}) {
  if (!bin) throw new Error("Claude Code is not installed on this computer.");
  const r = await run(bin, ["auth", "logout"], env, { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`claude auth logout failed: ${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}`);
  return { ok: true };
}

const LOGIN_URL = /https:\/\/\S*oauth\/authorize\?\S+/;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * One `claude auth login` for the phone, in the shape of a PhoneSignIn session (signin.status): the
 * page to open, then a pasted code, which goes to claude's stdin. claude prints the link itself (no
 * browser is needed on the computer); its credentials go to Claude Code's own store.
 * `spawnFn` and `check` are injectable (tests).
 */
export function startClaudeCodeLogin(env = process.env, { spawnFn = spawn, bin = findClaude(env), check = () => claudeCodeStatus(env, { bin }) } = {}) {
  if (!bin) throw new Error("Claude Code is not installed on this computer. Install it first (claude.com/download), then log in here.");
  const s = { id: randomUUID(), provider: "claude-code", label: "Claude Code", state: "running", url: null, code: null, instructions: null, prompt: null, error: null, startedAt: Date.now() };
  let out = "";
  let finished = false;
  let asked = false; // claude asks for the code once

  // BROWSER=true: no browser tab on the computer (the phone opens the link).
  const child = spawnFn(bin, ["auth", "login", "--claudeai"], { env: { ...claudeEnv(env), BROWSER: "true" }, stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => {
    fail("The login timed out. Start it again.");
    kill();
  }, LOGIN_TIMEOUT_MS);
  timer.unref?.();
  const kill = () => {
    try {
      child.kill();
    } catch {}
  };
  const fail = (message) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    s.state = "error";
    s.prompt = null;
    s.error = message;
  };
  const onData = (d) => {
    out += d;
    if (!s.url) {
      const m = LOGIN_URL.exec(out);
      if (m) {
        s.url = m[0];
        s.instructions = "Sign in with your Claude account on the page. It then shows a code: copy it and paste it here.";
      }
    }
    if (s.url && !asked && !finished && /paste code/i.test(out.slice(out.lastIndexOf(s.url)))) {
      asked = true;
      s.state = "needs-input";
      s.prompt = { kind: "code", message: "Paste the code the Claude page shows." };
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (e) => fail(`claude did not start: ${e.message}`));
  child.on("close", async (code) => {
    if (finished) return;
    if (code !== 0) {
      const last = out.trim().split("\n").filter(Boolean).pop() ?? `exit ${code}`;
      return fail(last.replace(/^.*?>\s*/, "").replace(LOGIN_URL, "").slice(0, 240));
    }
    const st = await Promise.resolve(check()).catch((e) => ({ loggedIn: false, error: e.message }));
    if (finished) return;
    if (!st.loggedIn) return fail(`Claude Code says it is not logged in${st.error ? ` (${st.error})` : ""}.`);
    finished = true;
    clearTimeout(timer);
    s.state = "done";
    s.prompt = null;
  });
  return {
    session: s,
    submit(text) {
      if (s.state !== "needs-input") throw new Error("Nothing is waiting for input.");
      const code = String(text ?? "").trim();
      if (!code) throw new Error("Paste the code first.");
      s.state = "running";
      s.prompt = null;
      child.stdin?.write(`${code}\n`);
    },
    cancel() {
      fail("Cancelled.");
      kill();
    },
  };
}
