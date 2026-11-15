/**
 * A Claude Code bot's TUI in the bots' herdr session (herdr agent `cc-<bot>`), started by ../../claude-code/start-bot.sh,
 * which uses the cc workers' launch-cc.sh: one launch path for workers and bots.
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync, writeFileSync, chmodSync, renameSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { configuredPluginDir, installedPluginDir } from "../plugin-dir";
import type { CcDelivery } from "./deliver";

/**
 * The Claude Code mods and start-bot.sh: PASEO_BOTS_CC_DIR; else claude-code/ in the bots plugin's folder as Paseo's
 * config names it (`plugins.bots.path` in $PASEO_HOME/config.json: a source checkout as well as an install); else the
 * installed plugin's (~/.dinobot/app/bots/claude-code).
 */
export function ccModsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PASEO_BOTS_CC_DIR) return env.PASEO_BOTS_CC_DIR;
  const path = configuredPluginDir(env);
  try {
    if (path && statSync(join(path, "claude-code", "start-bot.sh")).isFile()) return join(path, "claude-code");
  } catch {}
  return join(installedPluginDir(env), "claude-code");
}

export interface CcLaunchDeps {
  /** Env for herdr CLI calls (server/herdr-instance.ts herdrEnv). */
  herdrEnv: () => NodeJS.ProcessEnv;
  herdrBin?: string;
  /** claude-code/start-bot.sh */
  script: string;
  run?: (bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function runFile(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** The `claude` binary: DINOBOT_CLAUDE_BIN, PATH, or the usual install places (lib/engines.mjs findClaude). */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DINOBOT_CLAUDE_BIN) return env.DINOBOT_CLAUDE_BIN;
  const home = env.HOME ?? "";
  const dirs = [...String(env.PATH ?? "").split(delimiter), join(home, ".local", "bin"), join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) {
    if (!d) continue;
    try {
      if (statSync(join(d, "claude")).isFile()) return join(d, "claude");
    } catch {}
  }
  return null;
}

const DROP = /^(ANTHROPIC_|PASEO_HOST$|CLAUDE_CONFIG_DIR$|CLAUDE_CODE_USE_|HERDR_(PANE|TAB|WORKSPACE|CLIENT)_|HERDR_ENV$|PWD$|OLDPWD$|SHLVL$|_$)/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** An Anthropic API proxy for a bot's Claude Code (one that holds the login itself), chosen by the owner. */
export interface CcProxy {
  baseUrl: string;
  authToken: string;
}

/**
 * The proxy a bot's TUI goes through, if any (opt-in; none by default, so the TUI runs on the Claude Code login):
 * `cc.baseUrl` (and `cc.authToken`) in the bot's .bot.json, else DINOBOT_CC_BASE_URL (and DINOBOT_CC_AUTH_TOKEN)
 * from the daemon's env. The token defaults to "proxy", as for cc workers (CC_WORKER_AUTH_TOKEN).
 */
export function ccProxyFor(cwd: string, env: Record<string, string | undefined> = process.env): CcProxy | null {
  let cc: { baseUrl?: unknown; authToken?: unknown } = {};
  if (cwd)
    try {
      const meta = JSON.parse(readFileSync(join(cwd, ".bot.json"), "utf8")) as { cc?: unknown };
      if (meta.cc && typeof meta.cc === "object") cc = meta.cc as typeof cc;
    } catch {}
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const baseUrl = str(cc.baseUrl) || str(env.DINOBOT_CC_BASE_URL);
  if (!/^https?:\/\/\S+$/.test(baseUrl)) return null;
  return { baseUrl, authToken: str(cc.authToken) || str(env.DINOBOT_CC_AUTH_TOKEN) || "proxy" };
}

/**
 * The bot's env as a shell file for its pane (0600): what a pi bot gets from the daemon, less any Claude API route.
 * With a proxy (ccProxyFor), only that route goes back in: ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN.
 * PASEO_HOST goes, also when the pane's shell set it (~/.bashrc): with PASEO_HOME set the Paseo CLI (bot-dm) refuses
 * to pick one, and Paseo's own agents get no PASEO_HOST either (daemonLaunchEnvironment).
 */
export function envScript(env: Record<string, string | undefined>, proxy: CcProxy | null = null): string {
  const lines = ["# Written by the DinoBot bots plugin for this bot's Claude Code pane.", "unset PASEO_HOST"];
  for (const [k, v] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    if (v === undefined || !NAME.test(k) || DROP.test(k)) continue;
    lines.push(`export ${k}=${quote(v)}`);
  }
  if (proxy) lines.push(`export ANTHROPIC_BASE_URL=${quote(proxy.baseUrl)}`, `export ANTHROPIC_AUTH_TOKEN=${quote(proxy.authToken)}`);
  return lines.join("\n") + "\n";
}

export class CcLauncher {
  private readonly run;
  private readonly starting = new Map<string, Promise<void>>();
  constructor(private readonly deps: CcLaunchDeps) {
    this.run = deps.run ?? runFile;
  }
  private herdr(args: string[], timeoutMs = 15_000) {
    return this.run(this.deps.herdrBin ?? "herdr", args, this.deps.herdrEnv(), timeoutMs);
  }

  async running(bot: string): Promise<boolean> {
    const r = await this.herdr(["agent", "get", `cc-${bot}`]);
    return r.code === 0;
  }

  /** Starts the TUI unless it runs; one start per bot at a time. */
  ensure(bot: string, opts: { cwd: string; stateDir: string; env: Record<string, string | undefined>; model?: string; effort?: string }): Promise<void> {
    const pending = this.starting.get(bot);
    if (pending) return pending;
    const work = (async () => {
      if (await this.running(bot)) return;
      const claude = findClaude(opts.env as NodeJS.ProcessEnv) ?? findClaude();
      if (!claude) throw new Error("Claude Code is not installed on this computer (claude.com/download), so this bot cannot start.");
      mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
      const file = join(opts.stateDir, "env.sh");
      const env: Record<string, string | undefined> = { ...opts.env, OPTCHAT_ENGINE_FILE: join(opts.stateDir, "engine.json"), OPTCHAT_MOD_LOG: join(opts.stateDir, "mod.jsonl") };
      env.PATH = [dirname(claude), env.PATH ?? process.env.PATH ?? ""].filter(Boolean).join(delimiter);
      const proxy = ccProxyFor(opts.cwd, opts.env);
      // Through a proxy the TUI needs no Claude login: its own config folder (settings, sessions; no login in it), so
      // a plan login can never be preferred over the proxy.
      const configDir = proxy ? join(opts.stateDir, "claude-config") : opts.env.DINOBOT_CLAUDE_CONFIG_DIR;
      writeFileSync(`${file}.tmp`, envScript(env, proxy), { mode: 0o600 });
      chmodSync(`${file}.tmp`, 0o600);
      renameSync(`${file}.tmp`, file);
      const r = await this.run(
        "sh",
        [this.deps.script],
        {
          ...this.deps.herdrEnv(),
          PATH: env.PATH,
          BOT: bot,
          CWD: opts.cwd,
          CCDIR: opts.stateDir,
          CLAUDE_DIR: dirname(claude),
          ...(configDir ? { DINOBOT_CLAUDE_CONFIG_DIR: configDir } : {}),
          ...(proxy ? { CC_PROXY: "1" } : {}),
          ...(opts.model ? { CC_WORKER_MODEL: opts.model } : {}),
          ...(opts.effort ? { CC_WORKER_EFFORT: opts.effort } : {}),
        },
        120_000,
      );
      if (r.code !== 0) throw new Error(`The bot's Claude Code did not start: ${(r.stderr || r.stdout).trim().split("\n").pop() ?? `exit ${r.code}`}`);
    })();
    this.starting.set(bot, work);
    return work.finally(() => this.starting.delete(bot));
  }

  /**
   * Starts the TUI again (for a new model or effort: claude takes them as --model/--effort at start): closes its herdr
   * tab if it runs, then starts it as ensure does. The chat's memory is OptChat's, so nothing is lost but the TUI's
   * own session (a start always opens a fresh one).
   */
  restart(bot: string, opts: { cwd: string; stateDir: string; env: Record<string, string | undefined>; model?: string; effort?: string }): Promise<void> {
    const pending = this.starting.get(bot);
    const work = (async () => {
      await pending?.catch(() => {});
      const r = await this.herdr(["agent", "get", `cc-${bot}`]);
      if (r.code === 0) {
        let tab = "";
        try {
          const j = JSON.parse(r.stdout) as { result?: { agent?: { tab_id?: unknown } } };
          tab = typeof j.result?.agent?.tab_id === "string" ? j.result.agent.tab_id : "";
        } catch {}
        if (!tab) throw new Error(`cannot find the herdr tab of cc-${bot} to start it again`);
        await this.herdr(["tab", "close", tab]);
        for (let i = 0; i < 50 && (await this.running(bot)); i++) await new Promise((res) => setTimeout(res, 100));
      }
    })();
    this.starting.set(bot, work);
    return work.finally(() => this.starting.delete(bot)).then(() => this.ensure(bot, opts));
  }

  /** Esc in the TUI: stops the running turn. */
  async interrupt(bot: string): Promise<void> {
    await this.herdr(["agent", "send-keys", `cc-${bot}`, "escape"]);
  }

  /** herdr's view of the TUI (`agent get`): its state and transcript, or null when there is no such agent. */
  private async agent(bot: string): Promise<{ status: string; sessionFile: string | null } | null> {
    const r = await this.herdr(["agent", "get", `cc-${bot}`], 10_000);
    try {
      const a = (JSON.parse(r.stdout) as { result?: { agent?: { agent_status?: unknown; agent_session?: { kind?: unknown; value?: unknown } } } }).result?.agent;
      if (r.code !== 0 || !a) return null;
      const s = a.agent_session;
      return {
        status: typeof a.agent_status === "string" ? a.agent_status : "unknown",
        sessionFile: s && s.kind === "path" && typeof s.value === "string" ? s.value : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * The TUI as the engine's delivery (deliver.ts): messages are typed with `herdr agent prompt` (text as one argv
   * item, no shell; herdr refuses a blocked or not-ready agent before it types anything).
   */
  delivery(bot: string): CcDelivery {
    const target = `cc-${bot}`;
    return {
      state: async () => (await this.agent(bot))?.status ?? "gone",
      sessionFile: async () => (await this.agent(bot))?.sessionFile ?? null,
      prompt: async (text) => {
        const r = await this.herdr(["agent", "prompt", target, text], 30_000);
        let j: { result?: unknown; error?: { code?: unknown; message?: unknown } } = {};
        try {
          j = JSON.parse(r.stdout);
        } catch {}
        if (r.code === 0 && j.result) return { ok: true };
        const code = typeof j.error?.code === "string" ? j.error.code : `exit ${r.code}`;
        const message = typeof j.error?.message === "string" ? j.error.message : (r.stderr || r.stdout).trim().slice(0, 300);
        return { ok: false, code, message };
      },
      clear: async (text) => {
        const keys = clearKeys(text);
        for (let i = 0; i < keys.length; i += 400) await this.herdr(["agent", "send-keys", target, ...keys.slice(i, i + 400)]);
      },
    };
  }
}

/**
 * Keys that empty Claude Code's composer of a text typed there: ctrl+u deletes one shown line (a wrapped line too),
 * backspace joins the line before. Enough pairs for the text at 40 columns or wider; more do nothing on an empty
 * composer. No Esc: it would stop a turn that started meanwhile, and twice on an empty composer opens the rewind menu.
 */
export function clearKeys(text: string): string[] {
  const shown = text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 40)), 0);
  const pairs = Math.min(shown + 2, 2000);
  return Array.from({ length: pairs }, () => ["ctrl+u", "backspace"]).flat();
}

type AuthStatus = { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
let authCache: { at: number; status: AuthStatus | null } | null = null;
/** `claude auth status --json` for this host's Claude Code (its login dir: DINOBOT_CLAUDE_CONFIG_DIR), cached a minute. */
async function claudeAuthStatus(env: NodeJS.ProcessEnv, run: typeof runFile) {
  if (authCache && Date.now() - authCache.at < 60_000) return authCache.status;
  const bin = findClaude(env);
  let status: AuthStatus | null = null;
  if (bin) {
    const clean = { ...env };
    for (const k of Object.keys(clean)) if (/^ANTHROPIC_/.test(k)) delete clean[k];
    if (env.DINOBOT_CLAUDE_CONFIG_DIR) clean.CLAUDE_CONFIG_DIR = env.DINOBOT_CLAUDE_CONFIG_DIR;
    const r = await run(bin, ["auth", "status", "--json"], clean, 20_000);
    try {
      const s = JSON.parse(r.stdout) as unknown;
      if (s && typeof s === "object") status = s as AuthStatus;
    } catch {}
  }
  authCache = { at: Date.now(), status };
  return status;
}

/**
 * Whether this host's Claude Code is logged in with a Claude plan. Team and Enterprise logins turn mods off, so
 * OptChat cannot run there: not ready.
 */
export async function claudePlanReady(env: NodeJS.ProcessEnv = process.env, run = runFile): Promise<boolean> {
  const s = await claudeAuthStatus(env, run);
  const sub = typeof s?.subscriptionType === "string" ? s.subscriptionType.toLowerCase() : "";
  return s?.loggedIn === true && s.authMethod === "claude.ai" && sub !== "team" && sub !== "enterprise";
}

/** Whether Claude Code is signed in at all (any login: workers need no mods), as the workers' launch.sh checks it. */
export async function claudeSignedIn(env: NodeJS.ProcessEnv = process.env, run = runFile): Promise<boolean> {
  return (await claudeAuthStatus(env, run))?.loggedIn === true;
}

/** Whether Claude Code is signed in, and its plan (`subscriptionType`, e.g. "max"), for setup's "Choose models". */
export async function claudeLogin(env: NodeJS.ProcessEnv = process.env, run = runFile): Promise<{ loggedIn: boolean; plan: string | null }> {
  const s = await claudeAuthStatus(env, run);
  return { loggedIn: s?.loggedIn === true, plan: typeof s?.subscriptionType === "string" ? s.subscriptionType : null };
}

/** Test hook: forget the cached `claude auth status`. */
export function resetClaudeAuthCache(): void {
  authCache = null;
}
