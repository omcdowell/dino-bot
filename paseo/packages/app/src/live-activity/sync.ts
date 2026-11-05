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
}

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
    });
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
    await namesLoaded;
    await native.apply(
      answer.state ? JSON.stringify(withIconNames(answer.state, names)) : null,
      answer.staleDate ?? null,
    );
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
    setPolling(false);
    unsubscribeConnection();
    nativeListener.remove();
    unsubscribeForeground();
  };
}
