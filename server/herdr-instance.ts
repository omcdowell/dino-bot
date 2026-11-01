/**
 * The herdr instance bots' workers run in.
 *
 * By default the plugin starts its own herdr server, a named herdr session (`paseo-bots`, setting
 * `herdr.session`), separate from any herdr the user runs: its own panes, socket and state under
 * `<herdr config dir>/sessions/<name>/`. Bots get HERDR_SESSION and HERDR_SOCKET_PATH for it (agent
 * session_open hook), so `herdr agent start …` from a bot lands there, and workers started in its
 * panes inherit the instance's socket, so their own sub-workers stay in it too. The plugin's worker
 * counts and stall checks read the same instance. Setting `herdr.session: null` uses the user's
 * default herdr server instead (opt-in, e.g. a host where the owner watches workers in herdr).
 *
 * How herdr picks the server (herdr 0.9, src/session.rs, src/server/socket_paths.rs):
 *   HERDR_SOCKET_PATH wins over HERDR_SESSION, and herdr sets HERDR_SOCKET_PATH in every pane. So
 *   anything started from inside a herdr pane must drop the inherited HERDR_* pane variables
 *   before naming a session (herdrEnv does this). `herdr server` with HERDR_SESSION=<name> starts
 *   that session's server headless; `herdr session list --json` reports it and its socket path.
 */
import { execFile, spawn } from "node:child_process";
import type { BotsSettings } from "./settings";

/** Variables herdr sets inside its panes; inherited, they point at the parent server. */
const PANE_VARS = [
  "HERDR_SOCKET_PATH",
  "HERDR_CLIENT_SOCKET_PATH",
  "HERDR_SESSION",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
] as const;

export type HerdrSessionInfo = { name: string; running: boolean; socket_path: string; session_dir?: string };

/** Env for herdr CLI calls on the bots' instance. `session` null: the env unchanged (user's server). */
export function herdrEnv(session: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (session === null) return base;
  const env = { ...base };
  for (const name of PANE_VARS) delete env[name];
  env.HERDR_SESSION = session;
  return env;
}

/** Parses `herdr session list --json`. */
export function parseSessionList(stdout: string): HerdrSessionInfo[] {
  const parsed = JSON.parse(stdout) as { sessions?: unknown };
  if (!Array.isArray(parsed.sessions)) throw new Error("herdr session list: no sessions");
  return parsed.sessions.flatMap((s) =>
    s && typeof s === "object" && typeof (s as HerdrSessionInfo).name === "string" && typeof (s as HerdrSessionInfo).socket_path === "string"
      ? [s as HerdrSessionInfo]
      : [],
  );
}

export interface HerdrInstanceDeps {
  bin?: string;
  env?: NodeJS.ProcessEnv;
  /** Runs `herdr <args>` and returns stdout. */
  run?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
  /** Starts `herdr server` detached. */
  start?: (bin: string, env: NodeJS.ProcessEnv) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a started server to show as running. */
  readyMs?: number;
}

const defaultRun = (bin: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) =>
    execFile(bin, args, { env, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );

const defaultStart = (bin: string, env: NodeJS.ProcessEnv) => {
  const child = spawn(bin, ["server"], { env, detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
};

/**
 * The bots' herdr instance: started on first use, never stopped by the plugin (workers outlive a
 * plugin reload; `herdr session stop <name>` stops it). With herdr missing, ready() resolves to
 * null and workers simply do not show.
 */
export class HerdrInstance {
  private pending: Promise<HerdrSessionInfo | null> | null = null;
  readonly env: NodeJS.ProcessEnv;
  private readonly bin: string;

  constructor(
    readonly session: string | null,
    private readonly deps: HerdrInstanceDeps = {},
  ) {
    const base = deps.env ?? process.env;
    this.bin = deps.bin ?? base.PASEO_BOTS_HERDR ?? "herdr";
    this.env = herdrEnv(session, base);
  }

  static fromSettings(settings: Pick<BotsSettings, "herdr">, deps?: HerdrInstanceDeps): HerdrInstance {
    return new HerdrInstance(settings.herdr.session, deps);
  }

  /** Makes sure the instance runs; its session info, or null (herdr missing or not starting). */
  ready(): Promise<HerdrSessionInfo | null> {
    if (this.session === null) return Promise.resolve(null);
    // Not up (herdr missing, or slow to start): ask again on the next call.
    this.pending ??= this.ensure().then((info) => {
      if (!info?.running) this.pending = null;
      return info;
    });
    return this.pending;
  }

  /** Forget the cached state (e.g. after a failed herdr read): the next ready() checks again. */
  reset(): void {
    this.pending = null;
  }

  private async list(): Promise<HerdrSessionInfo | null> {
    const run = this.deps.run ?? defaultRun;
    const sessions = parseSessionList(await run(this.bin, ["session", "list", "--json"], this.env));
    return sessions.find((s) => s.name === this.session) ?? null;
  }

  private async ensure(): Promise<HerdrSessionInfo | null> {
    try {
      const found = await this.list();
      if (found?.running) return found;
      (this.deps.start ?? defaultStart)(this.bin, this.env);
      const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const deadline = this.deps.readyMs ?? 5000;
      for (let waited = 0; waited < deadline; waited += 100) {
        await sleep(100);
        const now = await this.list();
        if (now?.running) return now;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Env for a bot's agent session so its herdr calls reach this instance. Empty when the user's
   * own server is used (session null): the daemon's env decides, as before.
   */
  async agentEnv(): Promise<Record<string, string>> {
    if (this.session === null) return {};
    const info = await this.ready();
    return info ? { HERDR_SESSION: this.session, HERDR_SOCKET_PATH: info.socket_path } : { HERDR_SESSION: this.session };
  }
}
