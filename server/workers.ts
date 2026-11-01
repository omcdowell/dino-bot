/**
 * Herdr workers a bot is waiting on.
 *
 * A bot that launches a herdr worker records it in the launch registry,
 * `$XDG_STATE_HOME/bot-dm/launches.jsonl` (default `~/.local/state/bot-dm/launches.jsonl`), with
 * `bot-worker add <name>` (bin/bot-worker.mjs). One JSON record per line, append only:
 *
 *   {"v":1,"type":"launch","ts":"…Z","worker":"dm-wp4","pane":"w73:p4","agent":"<paseo agent id>","bot":"emmet-brickowski"}
 *   {"v":1,"type":"done","ts":"…Z","worker":"dm-wp4"}
 *
 * `agent` is the launching bot's Paseo agent id (its PASEO_AGENT_ID); `bot` is optional and wins
 * when present. A launched worker is outstanding while herdr shows it working or blocked, whatever
 * it has reported, and otherwise until the first of:
 *   - it has reported and herdr shows it idle/done: bot-dm wrote a delivered status
 *     (steered/started) to its worker outbox (`$XDG_STATE_HOME/bot-dm/workers/<name>/outbox.jsonl`)
 *     after the launch. A mid-job report followed by more work puts it back on the list until it
 *     is idle again;
 *   - a later `done` record for the same worker (wins even over working);
 *   - its herdr agent is gone, or idle/done once the start-up grace period has passed;
 *   - the launch is older than MAX_AGE_MS (wins even over working).
 * Exception: an idle/done worker whose pi session (or pane) ends on an error written after its
 * launch and after its last report is "stalled", not finished (server/worker-errors.ts), until it
 * reports again, is marked done, its pane closes or the launch expires. The plugin DMs the bot
 * once per stall (server/stall-notify.ts).
 * If herdr cannot be read, the old rule applies: reported workers are finished, the others count
 * as "unknown" and are not shown as outstanding. Herdr's `unknown` status for an agent is treated
 * the same way (a report finishes it; without one it stays running).
 *
 * Without a registry entry, a herdr agent that is working or blocked counts as an *inferred* worker
 * of a bot when its cwd is inside the bot's folder or its name starts with `<bot>-`.
 *
 * Imports carry `.ts` extensions so bin/bot-worker.mjs can run this file with Node type stripping.
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { tailLines } from "./tail.ts";
import { herdrErrorReader, sessionErrorReader, type ErrorReader, type StallError } from "./worker-errors.ts";

export { tailLines };

export const REGISTRY_VERSION = 1;
/** An idle worker right after launch has probably not been prompted yet. */
export const GRACE_MS = 2 * 60 * 1000;
/** Launches older than this are ignored, whatever herdr says. */
export const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const REGISTRY_TAIL_BYTES = 256 * 1024;
const OUTBOX_TAIL_BYTES = 64 * 1024;

/** Herdr agent names: `[a-z][a-z0-9_-]{0,31}`. Worker names in bot-dm allow a little more. */
export const WORKER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export type LaunchRecord = {
  v: 1;
  type: "launch";
  ts: string;
  worker: string;
  pane?: string | null;
  agent?: string | null;
  bot?: string | null;
  cwd?: string | null;
};
export type DoneRecord = { v: 1; type: "done"; ts: string; worker: string };
export type RegistryRecord = LaunchRecord | DoneRecord;

/** The fields of `herdr agent list` this module uses. */
export type HerdrAgent = {
  name?: string | null;
  pane_id: string;
  agent_status: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  /** The agent's session as herdr knows it; for pi, `kind: "path"` and the session jsonl. */
  agent_session?: { kind?: string | null; value?: string | null } | null;
};

/**
 * stalled: idle/done past the grace period with no report and no `done`, and its session (or pane)
 * ends on an error. Not finished: the bot should resume it. See server/worker-errors.ts.
 */
export type WorkerState = "running" | "blocked" | "stalled" | "finished" | "unknown";

export type WorkerView = {
  worker: string;
  pane: string | null;
  /** Launch time (registry) or null (inferred). */
  since: string | null;
  state: WorkerState;
  /** Herdr's status, or "gone". */
  herdr: string;
  source: "registry" | "inferred";
  /** Why the worker counts as finished, when it does. */
  reason?: "reported" | "done" | "gone" | "idle" | "expired";
  /** The error a stalled worker stopped on. */
  error?: StallError;
};

export type BotWorkers = { botId: string; workers: WorkerView[] };

export const isOutstanding = (view: WorkerView) => view.state === "running" || view.state === "blocked";
export const isStalled = (view: WorkerView) => view.state === "stalled";

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "bot-dm");
}
export const defaultRegistryPath = (env: NodeJS.ProcessEnv = process.env) => join(stateRoot(env), "launches.jsonl");
export const defaultWorkersRoot = (env: NodeJS.ProcessEnv = process.env) => join(stateRoot(env), "workers");

export function parseRegistryLine(line: string): RegistryRecord | null {
  let value: any;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || value.v !== REGISTRY_VERSION || typeof value.worker !== "string" || !WORKER_RE.test(value.worker)) return null;
  if (typeof value.ts !== "string" || Number.isNaN(Date.parse(value.ts))) return null;
  if (value.type === "done") return { v: 1, type: "done", ts: value.ts, worker: value.worker };
  if (value.type !== "launch") return null;
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  return {
    v: 1,
    type: "launch",
    ts: value.ts,
    worker: value.worker,
    pane: str(value.pane),
    agent: str(value.agent),
    bot: str(value.bot),
    cwd: str(value.cwd),
  };
}

export async function readRegistry(path: string): Promise<RegistryRecord[]> {
  return (await tailLines(path, REGISTRY_TAIL_BYTES)).map(parseRegistryLine).filter((r): r is RegistryRecord => r !== null);
}

/** Append one record with a single write (O_APPEND), creating the state dir 0700 and the file 0600. */
export function appendRegistry(path: string, record: RegistryRecord): void {
  appendJsonl(path, record);
}

/** Append one JSON line with a single write (O_APPEND); state dir 0700, file 0600. */
export function appendJsonl(path: string, record: object): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Time of the last delivered report in a worker's bot-dm outbox, or null. */
export async function lastReportAt(workersRoot: string, worker: string): Promise<number | null> {
  if (!WORKER_RE.test(worker)) return null;
  const lines = await tailLines(join(workersRoot, worker, "outbox.jsonl"), OUTBOX_TAIL_BYTES);
  let last: number | null = null;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record?.type !== "status" || (record.status !== "steered" && record.status !== "started")) continue;
      const at = Date.parse(record.ts);
      if (!Number.isNaN(at) && (last === null || at > last)) last = at;
    } catch {
      // skip damaged lines
    }
  }
  return last;
}

/** Latest launch per worker name, with done records folded in. */
export function latestLaunches(records: RegistryRecord[]): Array<{ launch: LaunchRecord; doneAt: number | null }> {
  const latest = new Map<string, { launch: LaunchRecord; doneAt: number | null }>();
  for (const record of records) {
    const at = Date.parse(record.ts);
    const current = latest.get(record.worker);
    if (record.type === "launch") {
      if (!current || at >= Date.parse(current.launch.ts)) latest.set(record.worker, { launch: record, doneAt: null });
    } else if (current && at >= Date.parse(current.launch.ts)) {
      current.doneAt = at;
    }
  }
  return [...latest.values()];
}

export function findAgent(launch: LaunchRecord, agents: HerdrAgent[]): HerdrAgent | null {
  const byName = agents.find((a) => a.name === launch.worker);
  if (byName) return byName;
  // A name follows its pane's occupant; an unnamed agent in the recorded pane is still ours.
  return launch.pane ? (agents.find((a) => a.pane_id === launch.pane && !a.name) ?? null) : null;
}

/**
 * State of one registered worker. `agents` null means herdr could not be read.
 *
 * Herdr's status decides, a report alone does not (2026-10-11, "option 1"): a worker that
 * reported mid-job and was then prompted again counts while herdr shows it `working`/`blocked`.
 * Reported and idle/done: finished (no grace period: the report shows it was prompted). Without
 * herdr's status (herdr unreadable, or `unknown` for the agent) the old rule applies: a report
 * means finished. Measured herdr behaviour: research/worker-count/reports/herdr-states.md in the
 * emmet-brickowski bot folder. For pi, `working` comes from pi's own hooks and was steady through
 * long tool calls, API retries and steering, so no debounce.
 */
export function registryWorkerState(
  launch: LaunchRecord,
  ctx: { now: number; doneAt: number | null; reportAt: number | null; agents: HerdrAgent[] | null },
): WorkerView {
  const since = Date.parse(launch.ts);
  const base = { worker: launch.worker, pane: launch.pane ?? null, since: launch.ts, source: "registry" as const };
  const finished = (reason: WorkerView["reason"], herdr: string): WorkerView => ({ ...base, state: "finished", herdr, reason });
  const agent = ctx.agents ? findAgent(launch, ctx.agents) : null;
  const herdr = ctx.agents === null ? "unavailable" : agent ? agent.agent_status : "gone";
  const reported = ctx.reportAt !== null && ctx.reportAt >= since;
  if (ctx.now - since > MAX_AGE_MS) return finished("expired", herdr);
  if (ctx.doneAt !== null) return finished("done", herdr);
  if (ctx.agents === null) return reported ? finished("reported", herdr) : { ...base, state: "unknown", herdr };
  if (!agent) return finished(reported ? "reported" : "gone", herdr);
  const status = agent.agent_status;
  if (status === "blocked") return { ...base, pane: agent.pane_id, state: "blocked", herdr };
  if (status === "working") return { ...base, pane: agent.pane_id, state: "running", herdr };
  if (reported) return finished("reported", herdr);
  if (status === "idle" || status === "done") {
    return ctx.now - since < GRACE_MS ? { ...base, pane: agent.pane_id, state: "running", herdr } : finished("idle", herdr);
  }
  // `unknown` (start-up, server restore) or anything new: not proof of completion.
  return { ...base, pane: agent.pane_id, state: "running", herdr };
}

/**
 * registryWorkerState plus the error check: a worker that would count as finished because herdr
 * says idle/done is "stalled" instead when its session ends on an error written after its launch
 * and after its last report (a worker that reported mid-job, was prompted again and then died on
 * an API error is stalled, not finished). Only then is the session (or pane) read.
 */
export async function resolveWorker(
  launch: LaunchRecord,
  ctx: { now: number; doneAt: number | null; reportAt: number | null; agents: HerdrAgent[] | null; readError: ErrorReader },
): Promise<WorkerView> {
  const view = registryWorkerState(launch, ctx);
  if ((view.reason !== "idle" && view.reason !== "reported") || !ctx.agents) return view;
  const agent = findAgent(launch, ctx.agents);
  if (!agent || (agent.agent_status !== "idle" && agent.agent_status !== "done")) return view;
  const error = await ctx.readError(agent).catch(() => null);
  if (!error) return view;
  // An error from before this launch belongs to an earlier task in the same pane.
  if (error.at !== null && Date.parse(error.at) < Date.parse(launch.ts)) return view;
  // Reported: only an error after the report stalls it; one without a time (pane output) does not.
  if (view.reason === "reported" && (error.at === null || Date.parse(error.at) <= ctx.reportAt!)) return view;
  return { worker: view.worker, pane: agent.pane_id, since: view.since, state: "stalled", herdr: view.herdr, source: view.source, error };
}

function inside(path: string | null | undefined, dir: string): boolean {
  return !!path && (path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep));
}

/** Bot a herdr agent belongs to without a registry entry: cwd inside the bot folder, or name `<bot>-…`. */
export function inferBot(agent: HerdrAgent, bots: Array<{ id: string; cwd: string }>): string | null {
  for (const bot of bots) {
    if (inside(agent.cwd, bot.cwd) || inside(agent.foreground_cwd, bot.cwd)) return bot.id;
  }
  const name = agent.name ?? "";
  // Longest id first, so "tmp-a-b-…" is not taken for "tmp-a".
  const byLength = [...bots].sort((a, b) => b.id.length - a.id.length);
  return byLength.find((bot) => name.startsWith(`${bot.id}-`))?.id ?? null;
}

export type WorkersBot = { id: string; cwd: string; agentId: string | null };

export interface WorkersOptions {
  /** Env for the herdr CLI (which herdr instance; server/herdr-instance.ts). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  registryPath?: string;
  workersRoot?: string;
  /** Reads `herdr agent list`; throws or rejects when herdr is not reachable. */
  listHerdr?: () => Promise<HerdrAgent[]>;
  now?: () => number;
  /** Inferred workers (no registry entry). Default on. */
  infer?: boolean;
  /** How long a herdr read is reused. */
  cacheMs?: number;
  /**
   * The error an idle worker stopped on, if any. Default: its pi session, else its pane output;
   * session only when `listHerdr` is injected (tests), so no real herdr is asked.
   */
  readError?: ErrorReader;
}

/**
 * `herdr agent list` through the CLI (about 3 ms). Binary from PASEO_BOTS_HERDR, else PATH. `env`
 * picks the herdr instance (server/herdr-instance.ts herdrEnv) and is the child's whole env.
 */
export function herdrCli(env: NodeJS.ProcessEnv = process.env): () => Promise<HerdrAgent[]> {
  const bin = env.PASEO_BOTS_HERDR || "herdr";
  return () =>
    new Promise((resolve, reject) => {
      execFile(bin, ["agent", "list"], { env, timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error);
        try {
          const agents = JSON.parse(stdout)?.result?.agents;
          if (!Array.isArray(agents)) return reject(new Error("herdr agent list: no result.agents"));
          resolve(agents as HerdrAgent[]);
        } catch (parseError) {
          reject(parseError);
        }
      });
    });
}

export class WorkersService {
  private readonly registryPath: string;
  private readonly workersRoot: string;
  private readonly listHerdr: () => Promise<HerdrAgent[]>;
  private readonly now: () => number;
  private readonly infer: boolean;
  private readonly cacheMs: number;
  private readonly readError: ErrorReader;
  private cached: { at: number; agents: Promise<HerdrAgent[] | null> } | null = null;

  constructor(options: WorkersOptions = {}) {
    this.registryPath = options.registryPath ?? defaultRegistryPath();
    this.workersRoot = options.workersRoot ?? defaultWorkersRoot();
    this.listHerdr = options.listHerdr ?? herdrCli(options.env);
    this.now = options.now ?? Date.now;
    this.infer = options.infer ?? true;
    this.cacheMs = options.cacheMs ?? 4000;
    this.readError = options.readError ?? (options.listHerdr ? sessionErrorReader : herdrErrorReader(options.env));
  }

  private herdrAgents(): Promise<HerdrAgent[] | null> {
    const now = this.now();
    if (!this.cached || now - this.cached.at > this.cacheMs) {
      this.cached = { at: now, agents: this.listHerdr().catch(() => null) };
    }
    return this.cached.agents;
  }

  /**
   * Workers per bot. `ownerOf(agentId)` maps a launching Paseo agent id to its bot (any live chat of
   * the bot, not only the current one). Finished workers are included with state "finished".
   */
  async byBot(
    bots: WorkersBot[],
    ownerOf: (agentId: string) => string | null,
  ): Promise<{ bots: BotWorkers[]; herdr: "ok" | "unavailable" }> {
    const [records, agents] = await Promise.all([readRegistry(this.registryPath).catch(() => []), this.herdrAgents()]);
    const now = this.now();
    const known = new Set(bots.map((b) => b.id));
    const out = new Map<string, WorkerView[]>(bots.map((b) => [b.id, []]));
    const claimed = new Set<string>();
    for (const { launch, doneAt } of latestLaunches(records)) {
      const botId = launch.bot ?? (launch.agent ? ownerOf(launch.agent) : null);
      if (!botId || !known.has(botId)) continue;
      const reportAt = await lastReportAt(this.workersRoot, launch.worker).catch(() => null);
      const view = await resolveWorker(launch, { now, doneAt, reportAt, agents, readError: this.readError });
      out.get(botId)!.push(view);
      // A registered worker is never also inferred, whatever its state.
      if (agents) {
        const agent = findAgent(launch, agents);
        if (agent) claimed.add(agent.pane_id);
      }
    }
    if (this.infer && agents) {
      for (const agent of agents) {
        if (claimed.has(agent.pane_id)) continue;
        if (agent.agent_status !== "working" && agent.agent_status !== "blocked") continue;
        const botId = inferBot(agent, bots);
        if (!botId) continue;
        out.get(botId)!.push({
          worker: agent.name ?? agent.pane_id,
          pane: agent.pane_id,
          since: null,
          state: agent.agent_status === "blocked" ? "blocked" : "running",
          herdr: agent.agent_status,
          source: "inferred",
        });
      }
    }
    return {
      bots: [...out.entries()].map(([botId, workers]) => ({ botId, workers })),
      herdr: agents ? "ok" : "unavailable",
    };
  }
}
