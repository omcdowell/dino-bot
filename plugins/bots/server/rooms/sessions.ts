/**
 * Room sessions (plan U4): one Paseo agent per (group, member), started on its first delivery in the
 * group's state dir, with the room env (§3.3) that switches pi-optchat into room mode. Stopped after
 * a quiet period, recycled after many turns or a large context, capped at MAX_LIVE across all groups
 * and refused while memory is low. `sessions.json` in each group dir maps members to their agents.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { chatConfig, type ChatConfig } from "../bots";
import { settingsPath } from "../settings";
import { KEEP_LIVE_LABEL } from "../../shared/rpc";
import { ensureRoomDir, readJson, roomDir, SESSIONS_FILE, writeJson } from "./ledger";

export const ROOM_LABEL = "room";
export const ROOM_MEMBER_LABEL = "room-member";
export const QUIET_MS = 15 * 60_000;
export const MAX_LIVE = 3;
export const MAX_TURNS = 30;
export const MAX_INPUT_TOKENS = 60_000;
export const MIN_AVAILABLE_BYTES = 2 * 1024 ** 3;
export const CHECK_MS = 60_000;
export const PENDING_GRACE_MS = 2 * 60_000;

export interface RoomAgent {
  id: string;
  cwd?: string | null;
  labels?: Record<string, string> | null;
  /** initializing | idle | running | error | closed */
  status?: string | null;
  archivedAt?: string | null;
  lastActivityAt?: string | null;
  updatedAt?: string | null;
  lastUsage?: { inputTokens?: number; contextWindowUsedTokens?: number } | null;
}

/** The slice of the Paseo SDK the room runner uses, so tests can pass a fake. */
export interface RoomsPaseo {
  agents: {
    list(options?: {
      filter?: { labels?: Record<string, string>; includeArchived?: boolean };
    }): Promise<{ entries: Array<{ agent: RoomAgent }> }>;
    ref(id: string): {
      send(text: string, options?: { messageId?: string; activeTurnBehavior?: "interrupt" | "steer" }): Promise<void>;
      archive(): Promise<unknown>;
    };
  };
  workspaces: {
    open(cwd: string): Promise<{
      agents: {
        create(options: {
          config: ChatConfig;
          title?: string;
          labels?: Record<string, string>;
          env?: Record<string, string>;
          prompt?: string;
        }): Promise<{ id: string }>;
      };
    }>;
  };
  config: { get(): Promise<unknown> };
}

export type SessionEntry = {
  agentId: string;
  startedAt: string;
  turns: number;
  lastTurnEndAt: string | null;
  /** Hop and `re` for the reply to the digest now being answered (U1 replyHop; newest line addressed to the bot). */
  hop?: number;
  re?: string;
};
export type SessionsFile = Record<string, SessionEntry>;

export type DeliverOutcome =
  | { kind: "sent"; agentId: string }
  | { kind: "started"; agentId: string }
  | { kind: "busy" }
  | { kind: "empty" }
  | { kind: "wait" }
  | { kind: "low-memory"; available: number };

export interface SessionsOptions {
  /** State root holding one dir per group (`PASEO_BOTS_ROOMS`). */
  roomsRoot: string;
  /** Bots root (`~/bots`): room cwds must never sit inside a bot folder (adoption guard). */
  botsRoot: string;
  /** OptChat data home (`OPTCHAT_HOME`, else `~/.optchat`). */
  optchatHome?: string;
  /** The plugin's settings file (default: settingsPath for botsRoot); pi-optchat reads `rooms.fullTools` from it. */
  settingsFile?: string;
  /** Bytes of MemAvailable; null when unknown (then no guard). */
  memAvailable?: () => Promise<number | null>;
  now?: () => number;
  quietMs?: number;
  maxLive?: number;
  maxTurns?: number;
  maxInputTokens?: number;
  minAvailableBytes?: number;
  pendingGraceMs?: number;
}

export async function procMemAvailable(path = "/proc/meminfo"): Promise<number | null> {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(await readFile(path, "utf8"));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

const BUSY = new Set(["running", "initializing"]);
export const agentBusy = (agent: RoomAgent | undefined) => !!agent && BUSY.has(agent.status ?? "");

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** Serialises async work per key. */
export class KeyLocks {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    const tail: Promise<unknown> = next
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    this.tails.set(key, tail);
    return next;
  }
}

export class RoomSessions {
  private readonly files = new Map<string, SessionsFile>();
  /** Agents sent a delivery whose turn has not ended yet (status may still read idle). */
  /** Agent id -> ms when the delivery went out. */
  private readonly pending = new Map<string, number>();
  private readonly starts = new KeyLocks();
  private readonly now: () => number;

  constructor(private readonly options: SessionsOptions) {
    this.now = options.now ?? Date.now;
  }

  private get optchatHome() {
    return resolve(this.options.optchatHome ?? process.env.OPTCHAT_HOME ?? join(homedir(), ".optchat"));
  }

  dir(group: string) {
    return roomDir(this.options.roomsRoot, group);
  }

  /** §3.3 env. The main profile is named by the bot folder's `.optchat-profile` (fallback: the bot id). */
  roomEnv(group: string, bot: string): Record<string, string> {
    return {
      OPTCHAT_ROOM: group,
      OPTCHAT_ROOM_MEMBER: bot,
      OPTCHAT_ROOM_DIR: this.dir(group),
      OPTCHAT_ROOM_MAIN: this.profileDir(bot),
      // pi-optchat lets room file lookups read only the room dir and this bots root (rel-security B2).
      OPTCHAT_ROOM_BOTS: this.options.botsRoot,
      // Group chat tool mode (settings `rooms.fullTools`), read by pi-optchat on every room turn: no restart needed.
      OPTCHAT_ROOM_SETTINGS: this.options.settingsFile ?? settingsPath({ ...process.env, PASEO_BOTS_ROOT: this.options.botsRoot }),
    };
  }

  /** The bot's main OptChat profile dir (room env, U2 handover). */
  profileDir(bot: string): string {
    let profile = bot;
    try {
      profile = readFileSync(join(this.options.botsRoot, bot, ".optchat-profile"), "utf8").trim() || bot;
    } catch {
      // fallback
    }
    return join(this.optchatHome, "profiles", profile);
  }

  file(group: string): SessionsFile {
    let held = this.files.get(group);
    if (!held) {
      held = readJson<SessionsFile>(join(this.dir(group), SESSIONS_FILE), {});
      this.files.set(group, held);
    }
    return held;
  }

  private save(group: string) {
    ensureRoomDir(this.dir(group));
    writeJson(join(this.dir(group), SESSIONS_FILE), this.file(group));
  }

  entry(group: string, bot: string): SessionEntry | null {
    return this.file(group)[bot] ?? null;
  }

  update(group: string, bot: string, patch: Partial<SessionEntry>) {
    const held = this.file(group)[bot];
    if (!held) return;
    this.file(group)[bot] = { ...held, ...patch };
    this.save(group);
  }

  private drop(group: string, bot: string) {
    const held = this.file(group)[bot];
    if (!held) return;
    this.pending.delete(held.agentId);
    delete this.file(group)[bot];
    this.save(group);
  }

  /**
   * (group, bot) of a room agent. Looks in memory, then in every group dir on disk (a daemon restart
   * resumes agents before any RPC has loaded them).
   */
  owner(agentId: string, groups: string[]): { group: string; bot: string } | null {
    for (const group of new Set([...this.files.keys(), ...groups])) {
      for (const [bot, entry] of Object.entries(this.file(group))) {
        if (entry.agentId === agentId) return { group, bot };
      }
    }
    return null;
  }

  /** Live (not archived) room agents across all groups, by label. */
  async live(paseo: RoomsPaseo): Promise<RoomAgent[]> {
    const { entries } = await paseo.agents.list();
    return entries.map((e) => e.agent).filter((a) => !a.archivedAt && !!a.labels?.[ROOM_LABEL]);
  }

  /**
   * A delivery went out and its turn_ended has not arrived. Once the agent reads idle for longer
   * than PENDING_GRACE_MS the wait is dropped: a turn that never ran (room mode refusing input on a
   * bad env, a lost event) must not hold the member busy for ever. Its reply, if any, is silence.
   */
  private waiting(agentId: string, agent: RoomAgent | undefined): boolean {
    const since = this.pending.get(agentId);
    if (since === undefined) return false;
    if (agentBusy(agent) || this.now() - since < (this.options.pendingGraceMs ?? PENDING_GRACE_MS)) return true;
    this.pending.delete(agentId);
    return false;
  }

  /** The member's room agent is mid-turn (or was just sent a delivery). */
  busy(group: string, bot: string, live: RoomAgent[]): boolean {
    const entry = this.entry(group, bot);
    if (!entry) return false;
    const agent = live.find((a) => a.id === entry.agentId);
    return agentBusy(agent) || this.waiting(entry.agentId, agent);
  }

  /** A turn of `agentId` ended. Returns the hop/re it was answering. */
  turnEnded(group: string, bot: string): SessionEntry | null {
    const entry = this.entry(group, bot);
    if (!entry) return null;
    this.pending.delete(entry.agentId);
    const ended = { ...entry, turns: entry.turns + 1, lastTurnEndAt: new Date(this.now()).toISOString() };
    this.file(group)[bot] = ended;
    this.save(group);
    return ended;
  }

  /** Archive after MAX_TURNS turns or a context over MAX_INPUT_TOKENS; the next delivery starts fresh. */
  async recycleIfDue(paseo: RoomsPaseo, group: string, bot: string, agent?: RoomAgent): Promise<boolean> {
    const entry = this.entry(group, bot);
    if (!entry) return false;
    const usage = agent?.lastUsage;
    const tokens = Math.max(usage?.inputTokens ?? 0, usage?.contextWindowUsedTokens ?? 0);
    if (entry.turns < (this.options.maxTurns ?? MAX_TURNS) && tokens <= (this.options.maxInputTokens ?? MAX_INPUT_TOKENS)) {
      return false;
    }
    await this.stop(paseo, group, bot);
    return true;
  }

  async stop(paseo: RoomsPaseo, group: string, bot: string): Promise<void> {
    const entry = this.entry(group, bot);
    if (!entry) return;
    try {
      await paseo.agents.ref(entry.agentId).archive();
    } finally {
      this.drop(group, bot);
    }
  }

  /**
   * The 60 s check: forget entries whose agent is gone; archive idle agents quiet for QUIET_MS.
   * Returns the (group, bot) pairs stopped.
   */
  async quietCheck(paseo: RoomsPaseo, groups: string[]): Promise<Array<{ group: string; bot: string }>> {
    const live = await this.live(paseo);
    const stopped: Array<{ group: string; bot: string }> = [];
    const quietMs = this.options.quietMs ?? QUIET_MS;
    for (const group of new Set([...this.files.keys(), ...groups])) {
      for (const [bot, entry] of Object.entries(this.file(group))) {
        const agent = live.find((a) => a.id === entry.agentId);
        if (!agent) {
          this.drop(group, bot);
          continue;
        }
        if (this.busy(group, bot, live)) continue;
        const last = Date.parse(entry.lastTurnEndAt ?? entry.startedAt);
        if (this.now() - last >= quietMs) {
          await this.stop(paseo, group, bot);
          stopped.push({ group, bot });
        }
      }
    }
    return stopped;
  }

  /**
   * Delivers one digest to the member's room agent, starting one if needed. `take` drains the router
   * queue and returns the delivery text (null: nothing to send); it is called only once the
   * delivery can go out, so a refused start leaves the queue intact.
   */
  async deliver(
    paseo: RoomsPaseo,
    target: { group: string; groupName: string; bot: string; botName: string },
    take: () => { text: string; hop: number; re?: string } | null,
  ): Promise<DeliverOutcome> {
    const { group, bot } = target;
    // One start decision at a time across all groups, so MAX_LIVE holds.
    return this.starts.run("start", async () => {
      const live = await this.live(paseo);
      if (this.busy(group, bot, live)) return { kind: "busy" };
      const entry = this.entry(group, bot);
      const current = entry && live.find((a) => a.id === entry.agentId);
      if (entry && !current) this.drop(group, bot);
      if (current) {
        const next = take();
        if (!next) return { kind: "empty" };
        this.pending.set(current.id, this.now());
        this.update(group, bot, { hop: next.hop, re: next.re });
        try {
          await paseo.agents.ref(current.id).send(next.text);
        } catch (error) {
          this.pending.delete(current.id);
          throw error;
        }
        return { kind: "sent", agentId: current.id };
      }

      const available = await (this.options.memAvailable ?? procMemAvailable)();
      if (available !== null && available < (this.options.minAvailableBytes ?? MIN_AVAILABLE_BYTES)) {
        return { kind: "low-memory", available };
      }
      // Make room under MAX_LIVE: archive the oldest idle room agent; if all are busy, wait.
      let count = live.length;
      const maxLive = this.options.maxLive ?? MAX_LIVE;
      while (count >= maxLive) {
        const victim = this.oldestIdle(live);
        if (!victim) return { kind: "wait" };
        const owner = this.owner(victim.id, []);
        if (owner) await this.stop(paseo, owner.group, owner.bot);
        else await paseo.agents.ref(victim.id).archive();
        live.splice(live.indexOf(victim), 1);
        count -= 1;
      }

      const next = take();
      if (!next) return { kind: "empty" };
      const cwd = this.dir(group);
      if (inside(join(this.options.botsRoot, bot), cwd)) throw new Error(`room dir ${cwd} is inside a bot folder`);
      ensureRoomDir(cwd);
      const workspace = await paseo.workspaces.open(cwd);
      const agent = await workspace.agents.create({
        config: await chatConfig(paseo),
        title: `${target.botName} · ${target.groupName}`,
        labels: { [ROOM_LABEL]: group, [ROOM_MEMBER_LABEL]: bot, [KEEP_LIVE_LABEL]: "0" },
        env: this.roomEnv(group, bot),
        prompt: next.text,
      });
      this.pending.set(agent.id, this.now());
      this.file(group)[bot] = {
        agentId: agent.id,
        startedAt: new Date(this.now()).toISOString(),
        turns: 0,
        lastTurnEndAt: null,
        hop: next.hop,
        ...(next.re ? { re: next.re } : {}),
      };
      this.save(group);
      return { kind: "started", agentId: agent.id };
    });
  }

  private oldestIdle(live: RoomAgent[]): RoomAgent | null {
    const idle = live.filter((a) => !agentBusy(a) && !this.waiting(a.id, a));
    const at = (a: RoomAgent) => {
      const owner = this.owner(a.id, []);
      const entry = owner && this.entry(owner.group, owner.bot);
      return entry?.lastTurnEndAt ?? entry?.startedAt ?? a.lastActivityAt ?? a.updatedAt ?? "";
    };
    return idle.sort((a, b) => at(a).localeCompare(at(b)))[0] ?? null;
  }

  /** `before("agent.session_open")`: room agents get their env back when Paseo resumes them. */
  sessionOpen<R extends { agentId: string; env: Record<string, string> }>(request: R, groups: string[]): R | undefined {
    const owner = this.owner(request.agentId, groups);
    if (!owner) return undefined;
    return { ...request, env: { ...request.env, ...this.roomEnv(owner.group, owner.bot) } };
  }
}
