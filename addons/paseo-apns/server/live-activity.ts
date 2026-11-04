/**
 * Live Activity of busy bots: one Lock Screen / Dynamic Island activity on the phone listing
 * the bots that are working or have herdr workers out.
 *
 * A separate channel from alerts:
 *   - pushes go out with `apns-push-type: liveactivity` to `<topic>.push-type.liveactivity`;
 *   - no sound, no badge; the start push carries the `alert` Apple requires, without `sound`;
 *   - they are logged as la-* events, never "sent", so the one-alert-per-10-min limit
 *     (rate-limit.ts, restored from "sent" only) neither counts nor blocks them.
 *
 * Flow:
 *   - The bots plugin POSTs the busy set to /live-activity whenever it changes (it debounces 5 s).
 *   - The app calls the `live-activity.sync` RPC on every connect and token change with its install
 *     id, its push-to-start token and the activities it has (id + update token). The answer is the
 *     current state, which the app applies locally (start/update/end), so an open app never waits
 *     for a push. It also reports the phone's light/dark setting, which goes into the content state
 *     of that install's pushes (`appearance`): on iOS 26 the widget cannot see it itself. Likewise
 *     its Lock Screen dino setting (`dinoLayers`, 3 or 6 fps): the widget cannot read the app's copy
 *     on the phone, so a push without it would draw 3 fps until the app next updates the card.
 *   - flush() runs MIN_INTERVAL_MS after the first change (changes inside the window are one push;
 *     a set that settles back to what the phone shows sends nothing), and never closer together:
 *       busy, an activity with a token whose last state differs  -> update
 *       busy, no activity and no start pending                   -> start (push-to-start token)
 *       idle                                                     -> end every activity
 *     A started activity gets its update token when iOS wakes the app; until it is synced the start
 *     stays pending and no second start is sent.
 *   - While busy and unchanged, a heartbeat update every HEARTBEAT_MS moves the stale date on.
 *     If the daemon stops, the activity turns stale after STALE_AFTER_S and the widget greys out.
 *   - iOS ends an activity after 8 h; past MAX_AGE_MS the server ends it and starts a fresh one.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApnsEnvironment } from "./config.ts";
import type { ApnsSender, DeviceOutcome } from "./apns-client.ts";
import { ApnsKeyError } from "./jwt.ts";
import { tokenTail } from "./devices.ts";
import type { PushLog } from "./push-log.ts";

/** Swift `ActivityAttributes` struct name in the app and widget extension. */
export const ATTRIBUTES_TYPE = "PaseoBotsAttributes";
/** A change reaches the phone within ~5 s; changes inside 5 s are one push. */
export const MIN_INTERVAL_MS = 5_000;
export const STALE_AFTER_S = 30 * 60;
export const HEARTBEAT_MS = 20 * 60_000;
/** iOS ends a Live Activity after 8 h; restart it a little before. */
export const MAX_AGE_MS = 7 * 3600_000 + 45 * 60_000;
export const MAX_ROWS = 12;
const NAME_CHARS = 40;
const MAX_ACTIVITIES_PER_INSTALL = 4;
const MAX_INSTALLS = 10;

export type LaBot = {
  id: string;
  name: string;
  /** The bot's chat is running a turn. */
  working: boolean;
  /** Herdr workers outstanding (running, blocked or stalled). */
  workers: number;
  /** Busy since, unix seconds. */
  since: number;
  /** Lucide icon name (`.bot.json` "icon"): the widget draws the bot's tile from it. */
  icon?: string;
  /** Not working and every outstanding worker is stalled: the widget greys the row. Optional. */
  stalled?: boolean;
  /** How many of `workers` are stalled (grey bars). Optional. */
  stalledWorkers?: number;
};
/** The activity's ContentState (Swift `PaseoBotsAttributes.ContentState`). */
export type LaState = { bots: LaBot[]; more: number };
/** The phone's light/dark setting, as the app last reported it. */
export type LaAppearance = "light" | "dark";
/** The phone's Lock Screen dino setting (frames per second), as the app last reported it. */
export type LaDinoLayers = 3 | 6;
export const isDinoLayers = (v: unknown): v is LaDinoLayers => v === 3 || v === 6;
/** What one install's activity is sent: the shared state plus that phone's own settings. */
export type LaContent = LaState & { appearance?: LaAppearance; dinoLayers?: LaDinoLayers };
/** One install's own settings, as its app last reported them (absent: never reported). */
export type LaInstallLook = { appearance?: LaAppearance | null; dinoLayers?: LaDinoLayers | null };

export type LaActivity = {
  id: string;
  token: string | null;
  /** First seen (ms). */
  startedAt: number;
  /** Hash of the state it shows (pushed, or applied by the app at sync). */
  hash: string | null;
  /** When it last got a state and stale date (push or sync), ms. */
  sentAt: number | null;
};
export type LaInstall = {
  environment: ApnsEnvironment;
  startToken: string | null;
  activities: LaActivity[];
  /** A start was pushed and its activity has not synced yet (ms). */
  pendingStartAt: number | null;
  seenAt: number;
  /** Last reported by the app (sync); older apps never send it. */
  appearance?: LaAppearance | null;
  /** Last reported by the app (sync); older apps never send it. */
  dinoLayers?: LaDinoLayers | null;
};

const HEX = /^[0-9a-f]{64,200}$/;

/** Rows sorted working first, then longest busy; names trimmed; at most MAX_ROWS (+ `more`). */
export function normaliseState(bots: LaBot[]): LaState {
  const clean = bots
    .filter((b) => b.working || b.workers > 0)
    .map((b) => ({
      id: b.id.slice(0, 64),
      name: (b.name.length > NAME_CHARS ? `${b.name.slice(0, NAME_CHARS - 1)}…` : b.name) || b.id,
      working: b.working,
      workers: Math.max(0, Math.trunc(b.workers)),
      since: Math.trunc(b.since),
      ...(b.icon ? { icon: b.icon } : {}),
      // Passed through for the widget (bots plugin); left out when not set.
      ...(b.stalled === true ? { stalled: true } : {}),
      ...(b.stalledWorkers ? { stalledWorkers: Math.min(Math.max(0, Math.trunc(b.workers)), Math.max(0, Math.trunc(b.stalledWorkers))) } : {}),
    }))
    .sort((a, b) => Number(b.working) - Number(a.working) || a.since - b.since || a.id.localeCompare(b.id));
  return { bots: clean.slice(0, MAX_ROWS), more: Math.max(0, clean.length - MAX_ROWS) };
}

export const stateHash = (state: LaState | LaContent) => JSON.stringify(state);

/**
 * The content state for one install: iOS 26 gives a Live Activity the dark colour scheme in both
 * appearances, so the widget takes light/dark from here (the app reports it with each sync). The
 * dino setting likewise: the widget cannot read the app's copy on the phone.
 */
export function contentFor(state: LaState, look: LaInstallLook): LaContent {
  const out: LaContent = { ...state };
  if (look.appearance) out.appearance = look.appearance;
  if (isDinoLayers(look.dinoLayers)) out.dinoLayers = look.dinoLayers;
  return out;
}

/** The aps body for a start / update / end. Times in unix seconds. */
export function buildLaPayload(
  event: "start" | "update" | "end",
  state: LaContent,
  nowS: number,
): Record<string, unknown> {
  const aps: Record<string, unknown> = { timestamp: nowS, event, "content-state": state };
  if (event === "start") {
    aps["attributes-type"] = ATTRIBUTES_TYPE;
    aps.attributes = {};
    // Apple requires an alert to start an activity. No `sound`: it lights the activity up, silently.
    const n = state.bots.length + state.more;
    aps.alert = { title: "Bots busy", body: n === 1 ? `${state.bots[0]?.name ?? "1 bot"} is busy` : `${n} bots busy` };
  }
  if (event === "end") aps["dismissal-date"] = nowS;
  else aps["stale-date"] = nowS + STALE_AFTER_S;
  return { aps };
}

class InstallStore {
  constructor(private readonly path: string) {}

  read(): Record<string, LaInstall> {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return parsed && typeof parsed.installs === "object" && parsed.installs ? parsed.installs : {};
    } catch {
      return {};
    }
  }

  write(installs: Record<string, LaInstall>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, installs }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

export interface SyncInput {
  installId: string;
  environment: ApnsEnvironment;
  startToken: string | null;
  activities: Array<{ id: string; token: string | null }>;
  /** Absent or null: keep the last one reported. */
  appearance?: LaAppearance | null;
  /** Absent or null: keep the last one reported. */
  dinoLayers?: LaDinoLayers | null;
}

export interface SyncOutput {
  /** null: no bot is busy; the app ends its activities. */
  state: LaState | null;
  /** Unix seconds; the app passes it as the activity's stale date. */
  staleDate: number | null;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface LiveActivityDeps {
  storePath: string;
  /** `<bundle id>.push-type.liveactivity`; null when not configured. */
  topic: string | null;
  sender: ApnsSender | null;
  log: PushLog;
  now?: () => number;
  timers?: Timers;
  minIntervalMs?: number;
}

export class LiveActivityService {
  private readonly store: InstallStore;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly minIntervalMs: number;
  private desired: LaState = { bots: [], more: 0 };
  private lastFlushAt = -Infinity;
  private timer: unknown = null;
  private timerAt: number | null = null;
  private heartbeat: unknown = null;
  private flushing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  /** Pushes made, for status and tests. */
  readonly counts = { start: 0, update: 0, end: 0, failed: 0 };

  constructor(private readonly deps: LiveActivityDeps) {
    this.store = new InstallStore(deps.storePath);
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
    this.minIntervalMs = deps.minIntervalMs ?? MIN_INTERVAL_MS;
  }

  get busy(): boolean {
    return this.desired.bots.length > 0;
  }

  state(): LaState {
    return this.desired;
  }

  /** New busy set from the bots plugin. Returns whether it changed (a flush is then scheduled). */
  setBots(bots: LaBot[]): { changed: boolean; flushAt: string | null } {
    const next = normaliseState(bots);
    if (stateHash(next) === stateHash(this.desired)) return { changed: false, flushAt: null };
    this.desired = next;
    return { changed: true, flushAt: new Date(this.schedule()).toISOString() };
  }

  /** The app's view: registers its tokens and activities; answers with the state to show. */
  sync(input: SyncInput): SyncOutput {
    const installs = this.store.read();
    const now = this.now();
    const held = installs[input.installId];
    const busy = this.busy;
    const appearance = input.appearance ?? held?.appearance ?? null;
    const dinoLayers = input.dinoLayers ?? held?.dinoLayers ?? null;
    // The app applies the answer with its own appearance and dino setting, which it just reported.
    const hash = busy ? stateHash(contentFor(this.desired, { appearance, dinoLayers })) : null;
    const known = new Map((held?.activities ?? []).map((a) => [a.id, a]));
    const activities: LaActivity[] = input.activities.slice(0, MAX_ACTIVITIES_PER_INSTALL).map((a) => {
      const prev = known.get(a.id);
      const token = a.token && HEX.test(a.token) ? a.token : (prev?.token ?? null);
      // The app applies the answer locally, so the activity shows `hash` from now on.
      // It also gets a fresh stale date, so the heartbeat counts from now.
      return busy
        ? { id: a.id, token, startedAt: prev?.startedAt ?? now, hash, sentAt: now }
        : { id: a.id, token, startedAt: prev?.startedAt ?? now, hash: prev?.hash ?? null, sentAt: prev?.sentAt ?? null };
    });
    const startToken = input.startToken && HEX.test(input.startToken) ? input.startToken : (held?.startToken ?? null);
    installs[input.installId] = {
      environment: input.environment,
      startToken,
      // Idle: the app ends its activities on this answer, so none are kept.
      activities: busy ? activities : [],
      pendingStartAt: activities.length ? null : busy ? (held?.pendingStartAt ?? null) : null,
      seenAt: now,
      appearance,
      dinoLayers,
    };
    this.write(installs);
    const changedTokens =
      held?.startToken !== startToken || activities.some((a) => known.get(a.id)?.token !== a.token);
    if (changedTokens) {
      this.deps.log.append("la-sync", {
        install: input.installId.slice(0, 8),
        startToken: startToken ? tokenTail(startToken) : null,
        activities: activities.map((a) => ({ id: a.id.slice(0, 8), token: a.token ? tokenTail(a.token) : null })),
      });
    }
    return busy ? { state: this.desired, staleDate: Math.floor(now / 1000) + STALE_AFTER_S } : { state: null, staleDate: null };
  }

  status() {
    const installs = Object.values(this.store.read());
    return {
      busy: this.desired.bots.length + this.desired.more,
      installs: installs.length,
      startTokens: installs.filter((i) => i.startToken).length,
      activities: installs.reduce((n, i) => n + i.activities.length, 0),
      pushes: { ...this.counts },
    };
  }

  /** Resolves when no flush is running (tests). */
  async whenIdle(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  /** Schedules a flush (if none is) and returns when it runs (ms). */
  private schedule(): number {
    // Trailing window from the first change: everything inside it is one push, and a blip that
    // settles back (a 2 s DM turn) sends nothing. Never closer than the window to the last flush.
    const at = Math.max(this.now() + this.minIntervalMs, this.lastFlushAt + this.minIntervalMs);
    if (this.timer === null && !this.stopped) {
      this.timerAt = at;
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.timerAt = null;
        void this.flush();
      }, at - this.now());
    }
    return this.timerAt ?? at;
  }

  /** Sends what the installs need. Serialised: a call during a flush runs once more after it. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = null;
      if (this.again && !this.stopped) {
        this.again = false;
        this.schedule();
      }
    });
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    if (this.stopped || !this.deps.sender || !this.deps.topic) return;
    const now = this.now();
    this.lastFlushAt = now;
    const installs = this.store.read();
    const busy = this.busy;
    try {
      for (const [id, install] of Object.entries(installs)) {
        const state = contentFor(this.desired, install);
        const hash = stateHash(state);
        if (!busy) {
          for (const a of install.activities) if (a.token) await this.pushTo(install, a, "end", state, now);
          install.activities = [];
          install.pendingStartAt = null;
          continue;
        }
        for (const a of [...install.activities]) {
          if (!a.token) continue;
          if (now - a.startedAt > MAX_AGE_MS) {
            await this.pushTo(install, a, "end", state, now);
            install.activities = install.activities.filter((x) => x !== a);
            continue;
          }
          const due = a.hash !== hash || a.sentAt === null || now - a.sentAt >= HEARTBEAT_MS;
          if (due && (await this.pushTo(install, a, "update", state, now))) {
            a.hash = hash;
            a.sentAt = now;
          }
        }
        if (!install.activities.length && install.pendingStartAt === null && install.startToken) {
          if (await this.pushTo(install, null, "start", state, now)) install.pendingStartAt = now;
        }
        installs[id] = install;
      }
    } finally {
      this.write(installs);
    }
    this.armHeartbeat();
  }

  /** One push. Returns true when APNs took it. Drops dead tokens. */
  private async pushTo(install: LaInstall, activity: LaActivity | null, event: "start" | "update" | "end", state: LaContent, now: number): Promise<boolean> {
    const token = activity ? activity.token! : install.startToken!;
    const payload = JSON.stringify(buildLaPayload(event, state, Math.floor(now / 1000)));
    let out: DeviceOutcome;
    try {
      out = await this.deps.sender!.push(install.environment, token, payload, {
        pushType: "liveactivity",
        topic: this.deps.topic!,
        // 10 so a change shows within seconds. Heartbeats only move the stale date.
        priority: 10,
        expiresInSeconds: event === "start" ? 300 : 3600,
      });
    } catch (error) {
      this.counts.failed += 1;
      const code = error instanceof ApnsKeyError ? error.code : String((error as NodeJS.ErrnoException).code ?? "error");
      this.deps.log.append("la-failed", { push: event, code });
      return false;
    }
    const fields = { token: tokenTail(token), activity: activity?.id.slice(0, 8) ?? null, bots: state.bots.length + state.more };
    if (out.status === "sent") {
      this.counts[event] += 1;
      this.deps.log.append(`la-${event}`, { ...fields, apnsId: out.apnsId });
      return true;
    }
    this.counts.failed += 1;
    this.deps.log.append("la-failed", { ...fields, push: event, status: out.status, reason: out.reason, http: out.http });
    if (out.status === "dropped") {
      if (activity) install.activities = install.activities.filter((a) => a !== activity);
      else install.startToken = null;
    }
    return false;
  }

  private armHeartbeat(): void {
    if (this.heartbeat !== null) {
      this.timers.clear(this.heartbeat);
      this.heartbeat = null;
    }
    if (!this.busy || this.stopped) return;
    this.heartbeat = this.timers.set(() => {
      this.heartbeat = null;
      this.schedule();
    }, HEARTBEAT_MS);
  }

  private write(installs: Record<string, LaInstall>): void {
    const entries = Object.entries(installs).sort((a, b) => b[1].seenAt - a[1].seenAt);
    this.store.write(Object.fromEntries(entries.slice(0, MAX_INSTALLS)));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    if (this.heartbeat !== null) this.timers.clear(this.heartbeat);
    this.timer = null;
    this.heartbeat = null;
  }
}
