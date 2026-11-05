/**
 * Busy bots for the iPhone Live Activity (sent by the paseo-apns add-on, ~/code/paseo-apns).
 *
 * A bot is busy when its current chat is running a turn ("working") or it has herdr workers out:
 * running, blocked or stalled, the bots-home "waiting" / "stalled" states (server/workers.ts).
 *
 * BusyFeed keeps the set fresh without any app connected:
 *   - `agent.turn_started` (a daemon lifecycle hook) kicks a check at once and hands over a Paseo API;
 *   - while anything is busy it re-checks every BUSY_CHECK_MS, so a bot going idle is seen fast;
 *   - while nothing is busy it checks every IDLE_CHECK_MS (a worker launched outside a turn).
 * Each check reads herdr fresh (its own WorkersService, no 4 s cache), so detection is ~1-2 s.
 * Every check is local work. The set goes to paseo-apns (POST /live-activity) only when it changed.
 * paseo-apns owns the 5 s window: changes inside it are one push, a blip that settles back is none.
 *
 * Stalled (decision 19 Oct: "showing stalled unless we are at 100% weekly in which case it drops off"):
 * a bot whose chat is not running a turn and whose only outstanding workers are stalled is sent with
 * `stalled: true`; the phone greys its row ("stalled", no running timer, no dino walk for it). Any
 * bot with stalled workers carries `stalledWorkers` (of `workers`), drawn as grey bars. When the
 * weekly window of the host's usage source (an add-on, server/extensions.ts; none by default) is at
 * 100% or blocked, stalled bots are left out, so after a rate limit they do not hold the activity open looking busy. That read is
 * made only while a stalled bot exists, cached WEEKLY_CACHE_MS; a failed read counts as not full.
 *
 * "since" is when the bot became busy: the turn start seen by the hook, else the earliest
 * outstanding worker's launch, else the first check that saw it busy. It holds while the bot stays
 * busy (working → waiting on workers keeps the same clock).
 */
import type { AgentLike, BotsPaseo } from "./bots";
import { isOutstanding, isStalled, type BotWorkers, type WorkersBot } from "./workers";
import { postLiveActivity, type LiveActivityPort } from "./live-activity-port";
import { quotaFromReport } from "./quota";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

// A check is local and cheap (herdr agent list ~3 ms, launch registry, the daemon's agent list; ~4 ms
// p50 on the host), so a change is seen within a second or two; paseo-apns then adds its 5 s window.
export const BUSY_CHECK_MS = 1_000;
export const IDLE_CHECK_MS = 2_000;

/**
 * `icon`: the bot's Lucide icon name (`.bot.json` "icon"); the phone draws its tile from it.
 * `stalled`: not working and every outstanding worker is stalled (absent otherwise).
 * `stalledWorkers`: how many of `workers` are stalled (absent when none). Both optional, so older
 * add-ons and builds see the rows as before.
 */
export type BusyBot = {
  id: string;
  name: string;
  working: boolean;
  workers: number;
  since: number;
  icon?: string;
  stalled?: true;
  stalledWorkers?: number;
};

/** Cache of the weekly usage read (one usage-source GET per minute at most, only while a bot is stalled). */
export const WEEKLY_CACHE_MS = 60_000;

export type BusyInput = {
  bots: Array<{ id: string; name: string; agentId: string | null; icon?: string }>;
  /** Each bot's current chat (status included), by agent id. */
  chats: Map<string, Pick<AgentLike, "id"> & { status?: string | null }>;
  workers: BotWorkers[];
};

const isRunning = (status: string | null | undefined) => status === "running" || status === "initializing";

/**
 * The busy set. `sinceOf` remembers when each bot became busy (and forgets bots that are not);
 * `turnStarts` holds turn starts seen by the hook, by agent id.
 */
export function busyBots(input: BusyInput, sinceOf: Map<string, number>, turnStarts: Map<string, number>, now: number): BusyBot[] {
  const workersOf = new Map(input.workers.map((w) => [w.botId, w.workers]));
  const out: BusyBot[] = [];
  for (const bot of input.bots) {
    const chat = bot.agentId ? input.chats.get(bot.agentId) : undefined;
    const working = isRunning(chat?.status);
    const views = workersOf.get(bot.id) ?? [];
    const out_ = views.filter((v) => isOutstanding(v) || isStalled(v));
    const stalledWorkers = out_.filter(isStalled).length;
    const stalled = !working && out_.length > 0 && stalledWorkers === out_.length;
    if (!working && !out_.length) {
      sinceOf.delete(bot.id);
      continue;
    }
    let since = sinceOf.get(bot.id);
    if (since === undefined) {
      const candidates = [now];
      const turn = bot.agentId ? turnStarts.get(bot.agentId) : undefined;
      if (working && turn !== undefined) candidates.push(turn);
      for (const v of out_) if (v.since) candidates.push(Date.parse(v.since));
      since = Math.min(...candidates.filter(Number.isFinite));
      sinceOf.set(bot.id, since);
    }
    const row: BusyBot = { id: bot.id, name: bot.name, working, workers: out_.length, since: Math.floor(since / 1000) };
    if (bot.icon) row.icon = bot.icon;
    if (stalled) row.stalled = true;
    if (stalledWorkers) row.stalledWorkers = stalledWorkers;
    out.push(row);
  }
  return out;
}

/** The usage report's "weekly" window is used up: at 100% or blocked. */
export function weeklyFull(report: UsageReport): boolean {
  const weekly = quotaFromReport(report).windows.find((w) => w.id === "weekly");
  return !!weekly && (weekly.blocked || (weekly.usedPct ?? 0) >= 100);
}

/**
 * Whether the weekly window is full, read at most once per `ttlMs` (callers in between get the
 * cached answer; one read at a time). A failed read is "not full" (stalled bots stay shown) and is
 * cached too, so a usage-source outage is not retried every second.
 */
export class WeeklyGate {
  private value = false;
  private at = -Infinity;
  private pending: Promise<boolean> | null = null;

  constructor(
    private readonly fetchReport: () => Promise<UsageReport>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = WEEKLY_CACHE_MS,
  ) {}

  full(): Promise<boolean> {
    if (this.now() - this.at < this.ttlMs) return Promise.resolve(this.value);
    this.pending ??= this.fetchReport()
      .then(weeklyFull, () => false)
      .then((value) => {
        this.value = value;
        this.at = this.now();
        this.pending = null;
        return value;
      });
    return this.pending;
  }
}

export interface BusyFeedDeps {
  /** One check's inputs (bots, chats, workers) from a Paseo API. */
  read(api: BotsPaseo): Promise<BusyInput>;
  /** Weekly window used up (WeeklyGate.full); asked only while a bot is stalled. Absent: never. */
  weeklyFull?: () => Promise<boolean>;
  port?: LiveActivityPort;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

export class BusyFeed {
  private api: BotsPaseo | null = null;
  private readonly sinceOf = new Map<string, number>();
  private readonly turnStarts = new Map<string, number>();
  private lastSent: string | null = null;
  private last: BusyBot[] = [];
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly port: LiveActivityPort;

  constructor(private readonly deps: BusyFeedDeps) {
    this.now = deps.now ?? Date.now;
    this.port = deps.port ?? postLiveActivity(process.env);
  }

  get busy(): BusyBot[] {
    return this.last;
  }

  /** Any call or hook that brings a Paseo API: remember it, start the loop if it is not running. */
  touch(api: BotsPaseo): void {
    this.api = api;
    if (this.timer === null && !this.running) this.arm(0);
  }

  /** `agent.turn_started`: note the start and check now. */
  turnStarted(api: BotsPaseo, agentId: string): void {
    this.api = api;
    this.turnStarts.set(agentId, this.now());
    void this.check();
  }

  /** One check; serialised (a check asked for during one runs once more after it). */
  check(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.checkOnce()
      .catch((error) => this.deps.onError?.(error))
      .finally(() => {
        this.running = null;
        if (this.stopped) return;
        if (this.again) {
          this.again = false;
          void this.check();
          return;
        }
        this.arm(this.last.length ? BUSY_CHECK_MS : IDLE_CHECK_MS);
      });
    return this.running;
  }

  private async checkOnce(): Promise<void> {
    const api = this.api;
    if (!api || this.stopped) return;
    const input = await this.deps.read(api);
    const now = this.now();
    let busy = busyBots(input, this.sinceOf, this.turnStarts, now);
    if (busy.some((b) => b.stalled) && this.deps.weeklyFull && (await this.deps.weeklyFull().catch(() => false))) {
      // Weekly quota used up: stalled bots drop off (their clock restarts if they come back).
      for (const b of busy) if (b.stalled) this.sinceOf.delete(b.id);
      busy = busy.filter((b) => !b.stalled);
    }
    // Turn starts are only needed until the bot's busy clock is set.
    for (const id of this.turnStarts.keys()) if (now - this.turnStarts.get(id)! > 60_000) this.turnStarts.delete(id);
    this.last = busy;
    const key = JSON.stringify(busy);
    if (key === this.lastSent) return;
    // Remembered only once paseo-apns took it, so a failed post is retried on the next check.
    if (await this.port.post(busy)) this.lastSent = key;
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) (this.deps.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    const set = this.deps.setTimer ?? ((fn: () => void, delay: number) => {
      const t = setTimeout(fn, delay);
      t.unref?.();
      return t;
    });
    this.timer = set(() => {
      this.timer = null;
      void this.check();
    }, ms);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.deps.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
  }
}

export type { WorkersBot };
