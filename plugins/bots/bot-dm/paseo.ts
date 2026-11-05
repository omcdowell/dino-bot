/**
 * The Paseo CLI internals bot-dm depends on, loaded from the installed `@getpaseo/cli`.
 *
 * We reuse the CLI's own `connectToDaemon` + `selectDaemonTarget` so bot-dm talks to the same
 * daemon, with the same local credential and E2EE handling, as `paseo send`. These are not a public
 * API, so they are pinned: PINNED_CLI_VERSIONS lists the versions `bin/bot-dm-smoke.mjs` has passed
 * on. Any other version still runs (DMs must not stop working on an upgrade), but bot-dm warns on
 * stderr and reports `paseoCli.pinned: false` until the smoke test is re-run and the list updated.
 *
 * Imported surface (all checked at load):
 *   dist/utils/client.js         connectToDaemon({ target }) -> DaemonClient
 *   dist/utils/daemon-target.js  selectDaemonTarget({})      -> DaemonTarget
 *   DaemonClient.fetchAgents({ filter, page })               -> { entries[{agent}], pageInfo }
 *   DaemonClient.fetchAgent(id)                              -> { agent } | null   (--only-if-idle)
 *   DaemonClient.scheduleInspect({ id })                     -> { schedule | null, error } (--from schedule:)
 *   DaemonClient.sendAgentMessage(id, text, { messageId, activeTurnBehavior })
 *   DaemonClient.close()
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_CLI_VERSIONS = ["0.11.1", "0.11.2"];

export type AgentInfo = {
  id: string;
  status: string;
  provider: string;
  cwd: string;
  /** Paseo workspace of the agent, when the daemon reports one (push tap routing). */
  workspaceId?: string | null;
  labels: Record<string, string>;
  archivedAt: string | null;
  updatedAt: string | null;
};

/** A Paseo schedule as bot-dm needs it: who owns it (cwd) and which agents its runs launched. */
export type ScheduleInfo = {
  id: string;
  name: string | null;
  /** "new-agent" (each run launches a fresh agent) or "agent" (runs prompt an existing agent). */
  targetType: string;
  /** target.config.cwd for new-agent schedules; null otherwise. */
  cwd: string | null;
  /** The daemon's run records: a run is "running" from just before its agent starts until it ends. */
  runs: Array<{ id: string; status: string; agentId: string | null }>;
};

export type ActiveTurnBehavior = "steer" | "interrupt";

/** What bot-dm needs from Paseo; tests substitute a fake. */
export interface PaseoPort {
  listAgents(): Promise<AgentInfo[]>;
  /** One agent's current status, fetched afresh; null if the agent is gone. */
  agentStatus(agentId: string): Promise<string | null>;
  /** The schedule with this id, as the daemon records it; null if there is none. */
  inspectSchedule(scheduleId: string): Promise<ScheduleInfo | null>;
  send(agentId: string, text: string, options: { messageId: string; activeTurnBehavior: ActiveTurnBehavior }): Promise<void>;
  close(): Promise<void>;
  cli: { version: string; pinned: boolean; dist: string };
}

/** The bots package root (this file is <root>/bot-dm/paseo.ts). */
const BOTS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Where the Paseo CLI's dist is, first match wins:
 *   1. PASEO_CLI_DIST (explicit);
 *   2. a DinoBot install: the bots plugin is <app>/bots and the daemon (the @getpaseo/cli package)
 *      is <app>/daemon, so <app>/daemon/dist next to us; then $DINOBOT_HOME/app/daemon/dist;
 *   3. the global npm install, ~/.local/lib/node_modules/@getpaseo/cli/dist (dev hosts).
 * Candidates 2 only count when they hold the CLI internals; 3 is the fallback either way, so the
 * load error names a path.
 */
export function cliDist(env: NodeJS.ProcessEnv = process.env, botsRoot: string = BOTS_ROOT): string {
  if (env.PASEO_CLI_DIST) return env.PASEO_CLI_DIST;
  const candidates = [join(botsRoot, "..", "daemon", "dist")];
  if (env.DINOBOT_HOME) candidates.push(join(env.DINOBOT_HOME, "app", "daemon", "dist"));
  for (const dist of candidates) {
    if (existsSync(join(dist, "utils", "client.js"))) return resolve(dist);
  }
  return join(env.HOME || homedir(), ".local/lib/node_modules/@getpaseo/cli/dist");
}

export function cliVersion(dist: string): string {
  try {
    return String(JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")).version);
  } catch {
    return "unknown";
  }
}

export class PaseoInternalsError extends Error {}

/** Load and shape-check the CLI internals. Throws PaseoInternalsError if anything moved. */
export async function loadCliInternals(dist = cliDist()) {
  const load = async (rel: string) => {
    try {
      return await import(join(dist, rel));
    } catch (error) {
      throw new PaseoInternalsError(
        `cannot load ${join(dist, rel)} (${(error as Error).message}). Paseo CLI internals moved? Set PASEO_CLI_DIST or update bot-dm/paseo.ts.`,
      );
    }
  };
  const client = await load("utils/client.js");
  const target = await load("utils/daemon-target.js");
  for (const [mod, name] of [
    [client, "connectToDaemon"],
    [target, "selectDaemonTarget"],
  ] as const) {
    if (typeof mod[name] !== "function") throw new PaseoInternalsError(`Paseo CLI no longer exports ${name}`);
  }
  return {
    connectToDaemon: client.connectToDaemon as (o: { target: unknown }) => Promise<any>,
    selectDaemonTarget: target.selectDaemonTarget as (o: object) => unknown,
  };
}

export async function connectPaseo(env: NodeJS.ProcessEnv = process.env): Promise<PaseoPort> {
  const dist = cliDist(env);
  const version = cliVersion(dist);
  const pinned = PINNED_CLI_VERSIONS.includes(version);
  if (!pinned) {
    process.stderr.write(
      `bot-dm: warning: Paseo CLI ${version} is not in the tested set (${PINNED_CLI_VERSIONS.join(", ")}); run bin/bot-dm-smoke.mjs\n`,
    );
  }
  const { connectToDaemon, selectDaemonTarget } = await loadCliInternals(dist);
  const client = await connectToDaemon({ target: selectDaemonTarget({}) });
  for (const method of ["fetchAgents", "fetchAgent", "sendAgentMessage", "close"]) {
    if (typeof client[method] !== "function") {
      await client.close?.().catch(() => {});
      throw new PaseoInternalsError(`Paseo DaemonClient has no ${method}()`);
    }
  }
  return {
    cli: { version, pinned, dist },
    async listAgents() {
      const out: AgentInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const res = await client.fetchAgents({
          filter: { includeArchived: false },
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        for (const { agent: a } of res.entries) {
          out.push({
            id: a.id,
            status: a.status,
            provider: a.provider,
            cwd: a.cwd,
            workspaceId: a.workspaceId ?? null,
            labels: a.labels ?? {},
            archivedAt: a.archivedAt ?? null,
            updatedAt: a.updatedAt ?? null,
          });
        }
        if (!res.pageInfo?.hasMore || !res.pageInfo.nextCursor) break;
        cursor = res.pageInfo.nextCursor;
      }
      return out.filter((a) => !a.archivedAt);
    },
    async agentStatus(agentId) {
      const res = await client.fetchAgent(agentId);
      return res?.agent?.status ?? null;
    },
    async inspectSchedule(scheduleId) {
      // Checked here, not at connect: only schedule senders need it, and DMs must not stop if it moves.
      if (typeof client.scheduleInspect !== "function") throw new PaseoInternalsError("Paseo DaemonClient has no scheduleInspect()");
      let payload;
      try {
        payload = await client.scheduleInspect({ id: scheduleId });
      } catch (error) {
        // The daemon answers an unknown id with an RPC error "Schedule not found: <id>".
        if (/not found/i.test((error as Error)?.message ?? "")) return null;
        throw error;
      }
      const s = payload?.schedule;
      if (!s || payload.error) return null;
      return {
        id: String(s.id),
        name: s.name ?? null,
        targetType: String(s.target?.type ?? ""),
        cwd: s.target?.type === "new-agent" ? (s.target.config?.cwd ?? null) : null,
        runs: (s.runs ?? []).map((r: any) => ({ id: String(r.id), status: String(r.status), agentId: r.agentId ?? null })),
      };
    },
    send: (agentId, text, options) => client.sendAgentMessage(agentId, text, options),
    close: () => client.close(),
  };
}
