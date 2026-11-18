/**
 * bot-restart: the one route for restarting the DinoBot daemon, reloading a plugin or reloading bots' agents. Refused
 * from a bot's own session; waits until no bot is mid-turn (two idle checks apart), acts once, checks DinoBot is back,
 * prints one JSON line and logs it. Run it from a herdr worker or a terminal.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const USAGE = `Usage: bot-restart <action> [options]

The only way to restart or reload DinoBot. Run it in a herdr worker or a terminal, never in a bot's own
session (refused there). It waits until no bot is mid-turn (two idle checks --gap seconds apart), acts
once, checks DinoBot is back, prints one JSON line and appends it to the log.

  bot-restart daemon                 restart the daemon (systemd user unit paseo.service or dinobot.service;
                                     macOS: launchd app.dinobot.daemon)
  bot-restart plugin [bots|apns]     reload a plugin (default bots)
  bot-restart agents all|<bot>...    reload bots' agents: all OptChat bots, or named ones (name, id or short id);
                                     named: waits only for those bots, all: for every bot

Options:
  --dry-run          say what it would do and who is busy now; do nothing
  --now              named agents only: no idle wait, to repair a bot stuck mid-turn (logged as forced)
  --timeout <s|Nm>   give up (exit 5, nothing done) if bots stay busy this long (default 20m)
  --gap <s>          seconds between the two idle checks, and between polls (default 15)
  --service <unit>   systemd unit to restart (default: whichever of paseo.service, dinobot.service is active)

Log: $XDG_STATE_HOME/bot-restart/log.jsonl (default ~/.local/state/bot-restart/log.jsonl).
Exit 0 done, 1 action or check failed, 2 usage, 3 refused (bot session), 4 another run holds the lock,
5 timed out waiting for idle.`;

export type Exec = (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string };

export type Deps = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  pid: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
  exec: Exec;
  /** Why this process runs inside a bot's own session, or null. */
  botSession: () => string | null;
  /** Whether a pid is alive (stale lock check). */
  alive: (pid: number) => boolean;
};

type Agent = { id: string; shortId?: string; name?: string; provider?: string; status?: string; cwd?: string };
type HerdrAgent = { name?: string; agent_status?: string; tab_id?: string; pane_id?: string };
/** A Claude Code TUI closed by `agents`: its herdr name and the pane it had (null: it was not running). */
type CcClosed = { bot: string; herdr: string; tab: string | null; pane: string | null };

const CC_PROVIDER = /^optchat-cc/;
/** The herdr agent of a Claude Code bot's TUI: cc-<bot folder> (start-bot.sh), the folder from the agent's cwd. */
export function ccHerdrName(a: Agent): string {
  const folder = a.cwd?.replace(/\/+$/, "").split("/").pop();
  return `cc-${(folder || a.name || a.id).toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
}
function herdrAgent(deps: Deps, name: string): HerdrAgent | null {
  const r = deps.exec("herdr", ["agent", "get", name]);
  if (r.code !== 0) return null;
  try {
    return (JSON.parse(r.stdout) as { result?: { agent?: HerdrAgent } }).result?.agent ?? null;
  } catch {
    return null;
  }
}
type Action = { kind: "daemon"; unit: string; manager: "systemd" | "launchd" } | { kind: "plugin"; name: string } | { kind: "agents"; agents: Agent[]; all: boolean };

class Fail extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const BOT_PROVIDER = /^optchat/;

export function stateDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "bot-restart");
}

/** Bot-session marker: PASEO_AGENT_ID (Paseo sets it on every agent) in our env or any ancestor's, or the daemon's cgroup. */
export function linuxBotSession(env: NodeJS.ProcessEnv, pid = process.pid, read = (p: string) => readFileSync(p, "utf8")): string | null {
  if (env.PASEO_AGENT_ID?.trim()) return "PASEO_AGENT_ID is set";
  try {
    const cg = read(`/proc/${pid}/cgroup`);
    if (/\/(paseo|dinobot)\.service(\/|$)/m.test(cg)) return "this process runs inside the DinoBot daemon's service";
  } catch {}
  let p = pid;
  for (let i = 0; i < 64 && p > 1; i++) {
    let stat: string;
    try {
      stat = read(`/proc/${p}/stat`);
    } catch {
      break;
    }
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!ppid || ppid <= 1) break;
    try {
      const environ = read(`/proc/${ppid}/environ`);
      if (/(^|\0)PASEO_AGENT_ID=[^\0]/.test(environ)) return `ancestor process ${ppid} is a Paseo agent (PASEO_AGENT_ID)`;
    } catch {}
    p = ppid;
  }
  return null;
}

export async function run(argv: string[], deps: Deps): Promise<number> {
  try {
    return await runInner(argv, deps);
  } catch (error) {
    if (error instanceof Fail) {
      deps.err(`bot-restart: ${error.message}${error.code === 2 ? `\n\n${USAGE}` : ""}`);
      return error.code;
    }
    throw error;
  }
}

function seconds(v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const m = /^(\d+(?:\.\d+)?)(s|m)?$/.exec(v);
  if (!m) throw new Fail(2, `bad duration: ${v}`);
  return Number(m[1]) * (m[2] === "m" ? 60 : 1);
}

async function runInner(argv: string[], deps: Deps): Promise<number> {
  const { values: opt, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      now: { type: "boolean" },
      timeout: { type: "string" },
      gap: { type: "string" },
      service: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (opt.help) {
    deps.out(USAGE);
    return 0;
  }
  const [verb, ...rest] = positionals;
  if (!verb || !["daemon", "plugin", "agents"].includes(verb)) throw new Fail(2, verb ? `unknown action: ${verb}` : "no action");
  const timeoutS = seconds(opt.timeout, 20 * 60);
  const gapS = seconds(opt.gap, 15);

  const refused = deps.botSession();
  if (refused) {
    throw new Fail(3, `refused: run from a bot's own session (${refused}). Start a herdr worker that runs bot-restart.`);
  }

  if (opt.now && (verb !== "agents" || rest.includes("all")))
    throw new Fail(2, "--now is only for named agents (repairing a stuck bot), never for all, daemon or plugin");
  const action = resolveAction(verb, rest, opt.service, deps);
  const plan = describe(action, deps);
  if (opt["dry-run"]) {
    const busy = busyNow(action, deps);
    const checks = opt.now ? "none (--now: no idle wait)" : `two idle checks ${gapS}s apart, give up after ${timeoutS}s`;
    deps.out(JSON.stringify({ ok: true, dryRun: true, would: plan, ...(opt.now ? { forced: true } : {}), busyNow: busy.busy, ccState: busy.cc, checks }));
    return 0;
  }

  const lockFile = join(stateDir(deps.env), "lock");
  takeLock(lockFile, deps);
  const started = deps.now().getTime();
  try {
    const forced = opt.now === true;
    const waited = forced ? { ok: true, ...busyNow(action, deps) } : await waitIdle(action, deps, timeoutS * 1000, gapS * 1000);
    if (!waited.ok) {
      const result = { ok: false, action: plan, error: `timed out after ${timeoutS}s; still busy: ${waited.busy.join(", ")}; nothing done` };
      finish(result, deps, started);
      return 5;
    }
    const acted = act(action, deps);
    if (!acted.ok) {
      finish({ ok: false, action: plan, ...(forced ? { forced: true } : {}), error: acted.error }, deps, started);
      return 1;
    }
    const check = await verify(action, acted.before, deps, acted.cc ?? []);
    const cc = acted.cc?.length ? { cc: ccNote(acted.cc) } : {};
    finish({ ok: check.ok, action: plan, ...cc, ...(forced ? { forced: true, busyAtStart: waited.busy } : {}), ccState: waited.cc, verified: check.detail, ...(check.ok ? {} : { error: "not back after the action" }) }, deps, started);
    return check.ok ? 0 : 1;
  } finally {
    try {
      unlinkSync(lockFile);
    } catch {}
  }
}

function finish(result: Record<string, unknown>, deps: Deps, started: number) {
  const line = { ts: deps.now().toISOString(), ...result, waitedSec: Math.round((deps.now().getTime() - started) / 1000) };
  const text = JSON.stringify(line);
  deps.out(text);
  try {
    const dir = stateDir(deps.env);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log.jsonl"), `${text}\n`);
  } catch (error) {
    deps.err(`bot-restart: could not write the log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function takeLock(file: string, deps: Deps) {
  mkdirSync(join(file, ".."), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, `${deps.pid}\n`);
      closeSync(fd);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder = NaN;
      try {
        holder = Number(readFileSync(file, "utf8").trim());
      } catch {}
      if (holder && deps.alive(holder)) throw new Fail(4, `another bot-restart is running (pid ${holder}); lock ${file}`);
      try {
        unlinkSync(file); // stale
      } catch {}
    }
  }
  throw new Fail(4, `cannot take the lock ${file}`);
}

function json(deps: Deps, cmd: string, args: string[]): unknown {
  const r = deps.exec(cmd, args);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")}: exit ${r.code} ${r.stderr.trim().slice(0, 200)}`);
  return JSON.parse(r.stdout);
}

function agents(deps: Deps): Agent[] {
  const list = json(deps, "paseo", ["ls", "-g", "--json"]);
  if (!Array.isArray(list)) throw new Error("paseo ls: not a list");
  return list as Agent[];
}

function resolveAction(verb: string, rest: string[], service: string | undefined, deps: Deps): Action {
  if (verb === "plugin") {
    if (rest.length > 1) throw new Fail(2, "plugin takes one name");
    const name = rest[0] ?? "bots";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Fail(2, `bad plugin name: ${name}`);
    return { kind: "plugin", name };
  }
  if (verb === "agents") {
    if (!rest.length) throw new Fail(2, "agents needs `all` or bot names");
    let list: Agent[];
    try {
      list = agents(deps);
    } catch (error) {
      throw new Fail(1, `cannot list agents: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (rest.length === 1 && rest[0] === "all") return { kind: "agents", all: true, agents: list.filter((a) => BOT_PROVIDER.test(a.provider ?? "")) };
    const picked: Agent[] = [];
    for (const want of rest) {
      const w = want.toLowerCase();
      const hits = list.filter((a) => a.id === want || a.shortId === want || (w.length >= 6 && a.id.startsWith(w)) || a.name?.toLowerCase() === w);
      if (hits.length !== 1) throw new Fail(2, hits.length ? `${want} matches ${hits.length} agents` : `no agent ${want}`);
      picked.push(hits[0]!);
    }
    return { kind: "agents", all: false, agents: picked };
  }
  // daemon
  if (deps.platform === "linux") {
    const candidates = service ? [service] : ["paseo.service", "dinobot.service"];
    const active = candidates.filter((u) => deps.exec("systemctl", ["--user", "is-active", u]).stdout.trim() === "active");
    if (active.length !== 1)
      throw new Fail(1, active.length ? `both ${active.join(" and ")} are active; give --service` : `no active ${candidates.join(" or ")} (systemd user unit); give --service`);
    return { kind: "daemon", unit: active[0]!, manager: "systemd" };
  }
  if (deps.platform === "darwin") {
    const prefix = deps.env.DINOBOT_LAUNCHD_LABEL || "app.dinobot";
    const label = service ?? `${prefix}.daemon`;
    if (deps.exec("launchctl", ["print", `gui/${deps.uid}/${label}`]).code !== 0) throw new Fail(1, `not supported here: no launchd job gui/${deps.uid}/${label}`);
    return { kind: "daemon", unit: label, manager: "launchd" };
  }
  throw new Fail(1, `not supported here (${deps.platform}): restart DinoBot with \`dinobot stop\` and \`dinobot start\` when no bot is mid-turn`);
}

function describe(a: Action, deps: Deps): string {
  if (a.kind === "daemon") return a.manager === "systemd" ? `systemctl --user restart ${a.unit}` : `launchctl kickstart -k gui/<uid>/${a.unit}`;
  if (a.kind === "plugin") return `paseo plugin reload ${a.name}`;
  return (
    a.agents
      .map((x) => {
        const reload = `paseo agent reload ${x.shortId ?? x.id} (${x.name ?? "?"})`;
        if (!CC_PROVIDER.test(x.provider ?? "")) return reload;
        const tui = herdrAgent(deps, ccHerdrName(x));
        const close = tui?.tab_id ? `herdr tab close ${tui.tab_id} (${ccHerdrName(x)}, its Claude Code TUI)` : `no ${ccHerdrName(x)} TUI running (nothing to close)`;
        return `${close}, then ${reload}`;
      })
      .join("; ") || "nothing (no bot agents)"
  );
}

/**
 * Who is mid-turn: bot agents (OptChat providers, Claude Code bots included) not idle, and cc-* TUIs in herdr not idle;
 * for a daemon restart also any other agent running. For named agents (`agents <bot>…`) only those bots count.
 */
function busyNow(action: Action, deps: Deps): { busy: string[]; cc: string } {
  const named = action.kind === "agents" && !action.all ? action.agents : null;
  const ccNames = named ? new Set(named.map(ccHerdrName)) : null;
  const busy: string[] = [];
  try {
    for (const a of agents(deps)) {
      if (named && !named.some((n) => n.id === a.id)) continue;
      const bot = BOT_PROVIDER.test(a.provider ?? "");
      if ((bot || named) && a.status !== "idle") busy.push(`${a.name ?? a.id}(${a.status})`);
      else if (!bot && action.kind === "daemon" && a.status === "running") busy.push(`${a.name ?? a.id}(${a.status})`);
    }
  } catch (error) {
    busy.push(`paseo ls failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
  }
  let cc = "read";
  try {
    const list = json(deps, "herdr", ["agent", "list"]) as { result?: { agents?: Array<{ name?: string; agent_status?: string }> } };
    for (const a of list.result?.agents ?? []) {
      if (!a.name?.startsWith("cc-") || (ccNames && !ccNames.has(a.name))) continue;
      if (a.agent_status !== "idle" && a.agent_status !== "done") busy.push(`${a.name}(${a.agent_status})`);
    }
  } catch {
    cc = "unknown (herdr not readable; Claude Code bots counted by their Paseo status only)";
  }
  return { busy, cc };
}

async function waitIdle(action: Action, deps: Deps, timeoutMs: number, gapMs: number): Promise<{ ok: boolean; busy: string[]; cc: string }> {
  const deadline = deps.now().getTime() + timeoutMs;
  let last = { busy: [] as string[], cc: "" };
  for (;;) {
    last = busyNow(action, deps);
    if (!last.busy.length) {
      await deps.sleep(gapMs);
      last = busyNow(action, deps);
      if (!last.busy.length) return { ok: true, ...last };
    }
    if (deps.now().getTime() + gapMs > deadline) return { ok: false, ...last };
    await deps.sleep(gapMs);
  }
}

function act(action: Action, deps: Deps): { ok: true; before: string; cc?: CcClosed[] } | { ok: false; error: string } {
  const step = (cmd: string, args: string[]) => {
    const r = deps.exec(cmd, args);
    return r.code === 0 ? null : `${cmd} ${args.join(" ")}: exit ${r.code} ${r.stderr.trim().slice(0, 200)}`;
  };
  if (action.kind === "daemon") {
    if (action.manager === "systemd") {
      const before = deps.exec("systemctl", ["--user", "show", action.unit, "-p", "MainPID", "--value"]).stdout.trim();
      const e = step("systemctl", ["--user", "restart", action.unit]);
      return e ? { ok: false, error: e } : { ok: true, before };
    }
    const e = step("launchctl", ["kickstart", "-k", `gui/${deps.uid}/${action.unit}`]);
    return e ? { ok: false, error: e } : { ok: true, before: "" };
  }
  if (action.kind === "plugin") {
    const e = step("paseo", ["plugin", "reload", action.name]);
    return e ? { ok: false, error: e } : { ok: true, before: "" };
  }
  // A Claude Code bot: close its TUI's herdr tab first, then reload the agent. Paseo's reload alone keeps the running
  // TUI (the provider's launcher only starts one when none runs), so the bot would keep its old mods, hooks and
  // settings. Closed first, the reload's session.open (or the next message) starts a fresh TUI through start-bot.sh.
  const errors: string[] = [];
  const cc: CcClosed[] = [];
  for (const a of action.agents) {
    if (CC_PROVIDER.test(a.provider ?? "")) {
      const name = ccHerdrName(a);
      const tui = herdrAgent(deps, name);
      if (tui?.tab_id) {
        const e = step("herdr", ["tab", "close", tui.tab_id]);
        if (e) {
          errors.push(e);
          continue;
        }
      }
      cc.push({ bot: a.name ?? a.id, herdr: name, tab: tui?.tab_id ?? null, pane: tui?.pane_id ?? null });
    }
    const e = step("paseo", ["agent", "reload", a.id]);
    if (e) errors.push(e);
  }
  return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true, before: "", cc };
}

function ccNote(cc: CcClosed[]): string {
  return cc
    .map((c) => (c.tab ? `${c.bot}: tui closed; a fresh one starts on the reload or the bot's next message` : `${c.bot}: no tui was running; one starts on the bot's next message`))
    .join("; ");
}

async function verify(action: Action, before: string, deps: Deps, cc: CcClosed[] = []): Promise<{ ok: boolean; detail: string }> {
  let detail = "";
  for (let i = 0; i < 30; i++) {
    if (i) await deps.sleep(2000);
    try {
      if (action.kind === "daemon") {
        if (action.manager === "systemd") {
          const state = deps.exec("systemctl", ["--user", "is-active", action.unit]).stdout.trim();
          const pid = deps.exec("systemctl", ["--user", "show", action.unit, "-p", "MainPID", "--value"]).stdout.trim();
          detail = `${action.unit} ${state}, MainPID ${before || "?"} -> ${pid || "?"}`;
          if (state !== "active" || !pid || pid === "0" || pid === before) continue;
        } else {
          const r = deps.exec("launchctl", ["print", `gui/${deps.uid}/${action.unit}`]);
          detail = `${action.unit} ${/state = (\w+)/.exec(r.stdout)?.[1] ?? "unknown"}`;
          if (!/state = running/.test(r.stdout)) continue;
        }
        const n = agents(deps).length;
        return { ok: true, detail: `${detail}; daemon answers (${n} agents)` };
      }
      if (action.kind === "plugin") {
        const list = json(deps, "paseo", ["plugin", "ls", "--json"]) as Array<{ id?: string; status?: string; error?: unknown }>;
        const p = list.find((x) => x.id === action.name);
        detail = p ? `plugin ${action.name} ${p.status}${p.error ? ` (error: ${String(p.error).slice(0, 120)})` : ""}` : `plugin ${action.name} not listed`;
        if (p?.status === "running" && !p.error) return { ok: true, detail };
        continue;
      }
      const now = agents(deps);
      // A Claude Code bot is listed idle (nothing woke it); a pi bot idle or running.
      const missing = action.agents.filter((a) => !now.some((x) => x.id === a.id && (x.status === "idle" || (x.status === "running" && !CC_PROVIDER.test(a.provider ?? "")))));
      // Its old TUI is gone: no herdr agent on the pane it had (a fresh TUI gets a new pane).
      const closed = cc.filter((c) => c.tab);
      const oldTui = closed.filter((c) => c.pane && herdrAgent(deps, c.herdr)?.pane_id === c.pane);
      detail = [
        missing.length ? `not back: ${missing.map((a) => a.name ?? a.id).join(", ")}` : `${action.agents.length} agents back`,
        ...(closed.length ? [oldTui.length ? `old tui still running: ${oldTui.map((c) => c.herdr).join(", ")}` : `old tui gone: ${closed.map((c) => c.herdr).join(", ")}`] : []),
      ].join("; ");
      if (!missing.length && !oldTui.length) return { ok: true, detail };
    } catch (error) {
      detail = `check failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`;
    }
  }
  return { ok: false, detail };
}

/** Runs a command (found on env.PATH) and returns its exit code and output. */
export function makeExec(env: NodeJS.ProcessEnv): Exec {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, env });
    return { code: r.error ? 127 : (r.status ?? 1), stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
  };
}

export function defaultDeps(): Deps {
  return {
    env: process.env,
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    pid: process.pid,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    exec: makeExec(process.env),
    botSession: () => (process.platform === "linux" ? linuxBotSession(process.env) : process.env.PASEO_AGENT_ID?.trim() ? "PASEO_AGENT_ID is set" : null),
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  };
}

export async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2), defaultDeps());
}
