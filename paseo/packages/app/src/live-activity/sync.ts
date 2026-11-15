/**
 * Live Activity of busy bots, app side (iOS). The daemon decides what it shows: the paseo-apns
 * plugin (`live-activity.sync` RPC) answers with the busy bots, or null when none is busy. The
 * app hands the plugin its push-to-start token and its activities' update tokens, so the plugin
 * can start, update and end the activity by push while the app is closed, and applies each answer
 * locally (update, start in the foreground, or end), so an open app never waits for a push.
 *
 * Syncs on every connect, on every token/activity change from the native module, and when the
 * app comes to the foreground. One sync at a time; a request during one runs once more after it.
 *
 * A host that cannot push (the plugin's local mode answers `pushes: false`) never updates the
 * activity while the app is closed, so while the app is open the app polls the sync every
 * POLL_MS itself; the activity is then live while the app is in use and greys out at its stale
 * date after. Hosts that push (or older add-ons, which leave the field out) are not polled.
 *
 * One host owns the activity (la-vanish). The app runs one sync per host profile, and they all
 * drive the same native activity. A host whose answer is null (its own busy set is empty, or a
 * busy-set blip) used to end the activity another host had just started; that host then started a
 * new one, every ~3 s while the app was open. Now the first host that answers with a busy state
 * owns the activity (a host that pushes takes it over from a local-mode one); only the owner
 * applies its answers, and only the owner's null ends it. The owner lets go on its own null and
 * when its sync stops. With no owner (fresh launch, an activity left from before) a null answer
 * still ends what is there.
 *
 * End reasons (diagnostics): the native module keeps a ring of why it ended activities
 * (`ends` in getState: endOthers, apply-null, system end/dismiss), the owner ring adds which host's
 * null ended them; each sync sends the reasons this host has not sent yet (`ends`), which
 * paseo-apns logs (an older one strips the field).
 *
 * Bot icons (./icons.ts): on connect and foreground, at most every ICONS_MIN_INTERVAL_MS, the app
 * refreshes the icons the widget reads (after the sync in flight, busy bots first); when one changed
 * it syncs again, so a running activity is redrawn with it. Each state it shows carries the bots'
 * Lucide icon names (withIconNames), so the widget can draw the tile itself when the keychain has
 * no icon for a bot.
 */

import { LUCIDE_NAME } from "./icons";

export const APNS_PLUGIN_ID = "apns";
export const SYNC_METHOD = "live-activity.sync";
export const INSTALL_ID_KEY = "@paseo:live-activity-install-id";
export const ICONS_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** Poll interval while the app is open and the host cannot push (local mode). */
export const POLL_MS = 15 * 1000;

export interface NativeLiveActivityState {
  enabled: boolean;
  startToken: string | null;
  activities: Array<{ id: string; token: string | null }>;
  /**
   * The phone's light/dark setting as the app last saw it (native AppearanceSync). Reported with
   * each sync so paseo-apns puts it in the content state of its pushes: on iOS 26 the widget
   * cannot see the system appearance itself. Absent on older native builds.
   */
  appearance?: string | null;
  /**
   * The Lock Screen dino's timer layers (3 or 6, the Network page switch; native DinoSetting).
   * Reported with each sync so paseo-apns can put it in the content state of its pushes, as for
   * the appearance. Absent on older native builds.
   */
  dinoLayers?: number | null;
  /** Recent activity-end reasons, oldest first (native ring, la-vanish). Absent on older builds. */
  ends?: string[] | null;
}

export interface LiveActivityNative {
  isSupported(): boolean;
  getState(): Promise<NativeLiveActivityState>;
  apply(stateJson: string | null, staleDate: number | null): Promise<string>;
  addListener(event: "onChange", listener: () => void): { remove(): void };
}

export interface SyncClient {
  readonly isConnected: boolean;
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  subscribeConnectionStatus(listener: (state: { status: string }) => void): () => void;
}

export interface SyncDeps {
  native: LiveActivityNative | null;
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
  /** Subscribe to the app coming to the foreground. */
  onForeground(listener: () => void): () => void;
  environment: "development" | "production";
  /** The iOS bundle id (APNs topic). */
  topic: string | null;
  randomId(): string;
  /**
   * Refreshes the bot icons the widget reads, the given (busy) bots first; resolves whether any
   * icon changed and every listed bot's Lucide icon name.
   */
  syncIcons?: (first: string[]) => Promise<{ changed: boolean; names: Record<string, string> }>;
  /** The icon names kept from the last refresh. */
  loadIconNames?: () => Promise<Record<string, string>>;
  now?: () => number;
  warn?: (message: string, error?: unknown) => void;
  /** Whether the app is in the foreground; polling (local mode) only syncs then. Default: always. */
  isActive?: () => boolean;
  /**
   * Whether the host runs the given plugin (plugins/plugin-available.ts). A host without the
   * push plugin is not called at all (rel-demo bug 8). Default: assume it does.
   */
  hasPlugin?: (pluginId: string) => Promise<boolean>;
  /** Which host's sync may drive the activity; default: the one shared by the whole app. */
  owner?: ActivityOwner;
  /** The host's id (server id), for ownership and end reasons. Default: a per-sync id. */
  hostId?: string;
}

/** Max end reasons kept by the owner ring and sent per sync (paseo-apns accepts 16 of 160 chars). */
export const MAX_ENDS = 16;
const END_CHARS = 160;

/**
 * Which host's sync drives the one native activity (la-vanish). One per app (`sharedActivityOwner`);
 * tests make their own.
 */
export interface ActivityOwner {
  /** The owning host id, or null. */
  current(): string | null;
  /**
   * A busy answer from `host`: true when it may apply it (it owns the activity now). Taken when
   * nobody owns it, or from a local-mode owner by a host that pushes.
   */
  claim(host: string, pushes: boolean): boolean;
  /** A null answer from `host`: true when it may end the activity (it owns it, or nobody does). */
  mayEnd(host: string): boolean;
  release(host: string): void;
  /** Records why the app ended its activity (ring, newest last). */
  recordEnd(reason: string): void;
  ends(): string[];
}

export function createActivityOwner(now: () => number = Date.now): ActivityOwner {
  let owner: { host: string; pushes: boolean } | null = null;
  const ring: string[] = [];
  return {
    current: () => owner?.host ?? null,
    claim(host, pushes) {
      if (owner === null || owner.host === host || (!owner.pushes && pushes)) {
        owner = { host, pushes };
        return true;
      }
      return false;
    },
    mayEnd: (host) => owner === null || owner.host === host,
    release(host) {
      if (owner?.host === host) owner = null;
    },
    recordEnd(reason) {
      ring.push(`${new Date(now()).toISOString()} ${reason}`.slice(0, END_CHARS));
      if (ring.length > MAX_ENDS) ring.splice(0, ring.length - MAX_ENDS);
    },
    ends: () => [...ring],
  };
}

export const sharedActivityOwner: ActivityOwner = createActivityOwner();
let hostSeq = 0;

interface SyncAnswer {
  ok: boolean;
  reason: string | null;
  state: unknown;
  staleDate: number | null;
  /** false: the host cannot push (local mode); the app polls while open. */
  pushes?: boolean;
}

const HEX = /^[0-9a-f]{64,200}$/;
const INSTALL_RE = /^[A-Za-z0-9-]{8,64}$/;

function isAnswer(value: unknown): value is SyncAnswer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.ok === "boolean" && "state" in v;
}

/**
 * The activity state with each bot's Lucide icon name added (when the server did not send one), so
 * the widget can draw the bot's tile without the keychain. Anything not shaped like a state is
 * returned as is.
 */
export function withIconNames(state: unknown, names: Record<string, string>): unknown {
  if (typeof state !== "object" || state === null) return state;
  const bots = (state as { bots?: unknown }).bots;
  if (!Array.isArray(bots)) return state;
  const out: unknown[] = [];
  for (const bot of bots as unknown[]) {
    const b = bot as { id?: unknown; icon?: unknown } | null;
    const name = typeof b?.id === "string" ? names[b.id] : undefined;
    const add = typeof b === "object" && b !== null && typeof b.icon !== "string";
    out.push(
      add && name !== undefined && LUCIDE_NAME.test(name)
        ? Object.assign({}, b, { icon: name })
        : bot,
    );
  }
  return Object.assign({}, state, { bots: out });
}

function botIds(state: unknown): string[] {
  const bots = (state as { bots?: unknown } | null)?.bots;
  if (!Array.isArray(bots)) return [];
  return bots
    .map((b: unknown) => (b as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string");
}

export async function installId(deps: Pick<SyncDeps, "storage" | "randomId">): Promise<string> {
  const held = await deps.storage.getItem(INSTALL_ID_KEY).catch(() => null);
  if (held && INSTALL_RE.test(held)) return held;
  const id = deps.randomId();
  await deps.storage.setItem(INSTALL_ID_KEY, id).catch(() => undefined);
  return id;
}

/** Starts syncing with one host; returns the stop function. No-op where unsupported. */
export function startLiveActivitySync(client: SyncClient, deps: SyncDeps): () => void {
  const native = deps.native;
  if (!native || !deps.topic || !native.isSupported()) return () => undefined;
  const warn = deps.warn ?? ((message: string, error?: unknown) => console.warn(message, error));
  const topic = deps.topic;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let warned = false;
  const id = installId(deps);
  const now = deps.now ?? Date.now;
  let iconsAt: number | null = null;
  let iconsRunning = false;
  let iconsWarned = false;
  let names: Record<string, string> = {};
  let busy: string[] = [];
  let poll: ReturnType<typeof setInterval> | null = null;
  const isActive = deps.isActive ?? (() => true);
  const owner = deps.owner ?? sharedActivityOwner;
  hostSeq += 1;
  const me = deps.hostId ?? `host-${hostSeq}`;
  /** End reasons already sent to this host. */
  const sentEnds = new Set<string>();
  const setPolling = (on: boolean) => {
    if (on && poll === null && !stopped) {
      poll = setInterval(() => {
        if (isActive() && client.isConnected) void sync();
      }, POLL_MS);
    } else if (!on && poll !== null) {
      clearInterval(poll);
      poll = null;
    }
  };
  const loadNames = async () => {
    const kept = await (deps.loadIconNames?.() ?? Promise.resolve({})).catch(() => ({}));
    names = { ...kept, ...names };
  };
  const namesLoaded = loadNames();

  const once = async () => {
    if (stopped || !client.isConnected) return;
    if (deps.hasPlugin && !(await deps.hasPlugin(APNS_PLUGIN_ID))) {
      setPolling(false);
      return;
    }
    const local = await native.getState();
    const ends = [...(Array.isArray(local.ends) ? local.ends : []), ...owner.ends()]
      .filter((e): e is string => typeof e === "string" && !sentEnds.has(e))
      .slice(-MAX_ENDS)
      .map((e) => e.slice(0, END_CHARS));
    const answer = await client.invokePluginRpc(APNS_PLUGIN_ID, SYNC_METHOD, {
      installId: await id,
      environment: deps.environment,
      topic,
      startToken: local.startToken && HEX.test(local.startToken) ? local.startToken : null,
      activities: local.activities
        .slice(0, 8)
        .map((a) => ({ id: a.id, token: a.token && HEX.test(a.token) ? a.token : null })),
      // Extra field: an older paseo-apns strips it (its zod object is not strict).
      ...(local.appearance === "light" || local.appearance === "dark"
        ? { appearance: local.appearance }
        : {}),
      ...(local.dinoLayers === 3 || local.dinoLayers === 6 ? { dinoLayers: local.dinoLayers } : {}),
      ...(ends.length ? { ends } : {}),
    });
    for (const e of ends) sentEnds.add(e);
    if (stopped || !isAnswer(answer)) return;
    if (!answer.ok) {
      if (!warned) {
        warned = true;
        warn(`[LiveActivity] paseo-apns refused the sync: ${answer.reason ?? "unknown"}`);
      }
      return;
    }
    setPolling(answer.pushes === false);
    busy = botIds(answer.state);
    if (answer.state) {
      // Another host owns the activity: leave it alone (la-vanish).
      if (!owner.claim(me, answer.pushes !== false)) return;
      await namesLoaded;
      if (stopped) return;
      await native.apply(
        JSON.stringify(withIconNames(answer.state, names)),
        answer.staleDate ?? null,
      );
      return;
    }
    // Only the owner's null ends the activity (or anyone's when nobody owns it).
    if (!owner.mayEnd(me)) return;
    owner.release(me);
    const result = await native.apply(null, null);
    if (result === "ended") owner.recordEnd(`apply-null:${me}`);
  };

  const sync = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = once()
      .catch((error: unknown) => {
        // Host without the plugin, or offline: say so once, retry on the next trigger.
        if (!warned) {
          warned = true;
          warn("[LiveActivity] sync with paseo-apns failed", error);
        }
      })
      .finally(() => {
        running = null;
        if (again && !stopped) {
          again = false;
          void sync();
        }
      });
    return running;
  };

  const icons = () => {
    const run = deps.syncIcons;
    if (!run || stopped || iconsRunning || !client.isConnected) return;
    if (iconsAt !== null && now() - iconsAt < ICONS_MIN_INTERVAL_MS) return;
    iconsRunning = true;
    iconsAt = now();
    // After the sync in flight, so the busy bots are known and go first.
    const before = running ?? Promise.resolve();
    before
      .then(() => run(busy))
      .then((result) => {
        const namesChanged = JSON.stringify(result.names) !== JSON.stringify(names);
        names = result.names;
        return (result.changed || namesChanged) && !stopped ? sync() : undefined;
      })
      .catch((error: unknown) => {
        // Host without the bots plugin, or offline: letters stay; retry on the next connect.
        iconsAt = null;
        if (!iconsWarned) {
          iconsWarned = true;
          warn("[LiveActivity] bot icons refresh failed", error);
        }
      })
      .finally(() => {
        iconsRunning = false;
      });
  };

  const unsubscribeConnection = client.subscribeConnectionStatus((state) => {
    if (state.status === "connected") {
      void sync();
      icons();
    }
  });
  const nativeListener = native.addListener("onChange", () => void sync());
  const unsubscribeForeground = deps.onForeground(() => {
    void sync();
    icons();
  });
  void sync();
  icons();

  return () => {
    stopped = true;
    owner.release(me);
    setPolling(false);
    unsubscribeConnection();
    nativeListener.remove();
    unsubscribeForeground();
  };
}
