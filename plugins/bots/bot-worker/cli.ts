/**
 * bot-worker: record which bot launched which herdr worker, so the Bots sidebar can show
 * "waiting for workers". Writes the launch registry read by server/workers.ts.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  WORKER_RE,
  appendRegistry,
  defaultRegistryPath,
  defaultWorkersRoot,
  herdrCli,
  lastReportAt,
  latestLaunches,
  readRegistry,
  resolveWorker,
  type HerdrAgent,
} from "../server/workers.ts";
import { herdrErrorReader, sessionErrorReader, type ErrorReader } from "../server/worker-errors.ts";

export const USAGE = `Usage: bot-worker <command> [options]

Record herdr workers a bot launches, so its sidebar row shows "waiting for workers" while each
worker is busy in herdr and until it reports (bot-dm --kind report) and goes idle, goes idle
without reporting, or its pane closes. A worker that reported mid-job and works again counts again.

  bot-worker add <name> [--pane <id>] [--bot <bot>]
      Run by the bot right after \`herdr agent start <name> …\` and the first prompt. The launcher
      is the caller's PASEO_AGENT_ID; outside a Paseo agent, give --bot. --pane defaults to the
      pane herdr reports for <name>.
  bot-worker done <name>      stop counting <name> (e.g. the bot no longer waits on it); also
                              clears a "stalled" worker (stopped on an error without reporting)
  bot-worker list [--all]     workers in the registry and their state: running, blocked, stalled
                              (with the error), unknown (--all: include finished)

Registry: $XDG_STATE_HOME/bot-dm/launches.jsonl (default ~/.local/state/bot-dm/launches.jsonl).
Prints one JSON line. Exit 0 ok, 2 usage error.`;

export type Deps = {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Pane of a live herdr agent, or null. */
  paneOf: (name: string) => string | null;
  listHerdr: () => Promise<HerdrAgent[]>;
  /** The error an idle worker stopped on (default: its pi session only; main() adds the pane). */
  readError?: ErrorReader;
};

const BOT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Herdr pane id, e.g. `w5:p2` or `w73:pA`: herdr goes on to letters after p9. */
export const PANE_RE = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/;

class UsageError extends Error {}

export async function run(argv: string[], deps: Deps): Promise<number> {
  try {
    return await runInner(argv, deps);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`bot-worker: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

async function runInner(argv: string[], deps: Deps): Promise<number> {
  const { values: opt, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      pane: { type: "string" },
      bot: { type: "string" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (opt.help) {
    deps.out(USAGE);
    return 0;
  }
  const [command, name, ...extra] = positionals;
  const registry = defaultRegistryPath(deps.env);
  const ts = deps.now().toISOString();

  if (command === "add" || command === "done") {
    if (!name || extra.length) throw new UsageError(`${command} takes one worker name`);
    if (!WORKER_RE.test(name)) throw new UsageError(`bad worker name: ${name}`);
  }

  if (command === "add") {
    const agent = deps.env.PASEO_AGENT_ID || null;
    const bot = opt.bot ?? null;
    if (bot !== null && !BOT_RE.test(bot)) throw new UsageError(`bad bot name: ${bot}`);
    if (!agent && !bot) throw new UsageError("not inside a Paseo agent: say which bot launched the worker with --bot <bot>");
    const pane = opt.pane ?? deps.paneOf(name);
    if (pane !== null && !PANE_RE.test(pane)) throw new UsageError(`bad pane id: ${pane}`);
    const record = { v: 1 as const, type: "launch" as const, ts, worker: name, pane, agent, bot };
    appendRegistry(registry, record);
    deps.out(JSON.stringify({ ok: true, ...record, ...(pane ? {} : { warning: "no herdr pane found; matched by name only" }) }));
    return 0;
  }

  if (command === "done") {
    appendRegistry(registry, { v: 1, type: "done", ts, worker: name! });
    deps.out(JSON.stringify({ ok: true, type: "done", worker: name, ts }));
    return 0;
  }

  if (command === "list") {
    const agents = await deps.listHerdr().catch(() => null);
    const now = deps.now().getTime();
    const workersRoot = defaultWorkersRoot(deps.env);
    const readError = deps.readError ?? sessionErrorReader;
    const rows = [];
    for (const { launch, doneAt } of latestLaunches(await readRegistry(registry))) {
      const reportAt = await lastReportAt(workersRoot, launch.worker).catch(() => null);
      const view = await resolveWorker(launch, { now, doneAt, reportAt, agents, readError });
      if (opt.all || view.state !== "finished") rows.push({ ...view, agent: launch.agent ?? null, bot: launch.bot ?? null });
    }
    deps.out(JSON.stringify({ ok: true, herdr: agents ? "ok" : "unavailable", workers: rows }));
    return 0;
  }

  throw new UsageError(command ? `unknown command: ${command}` : "missing command");
}

/** Real process wiring, used by bin/bot-worker.mjs. */
export async function main(): Promise<never> {
  const env = process.env;
  const exit = await run(process.argv.slice(2), {
    env,
    now: () => new Date(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    paneOf: (name) => {
      try {
        const out = execFileSync(env.PASEO_BOTS_HERDR || "herdr", ["agent", "get", name], {
          encoding: "utf8",
          env,
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return JSON.parse(out)?.result?.agent?.pane_id ?? null;
      } catch {
        return null;
      }
    },
    listHerdr: herdrCli(env),
    readError: herdrErrorReader(env),
  });
  process.exit(exit);
}
