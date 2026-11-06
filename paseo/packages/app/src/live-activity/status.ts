/**
 * The Live Activity icon diagnostic on the Network page ("This device"): what the app stored in the
 * shared keychain group, and what the widget itself found when it last drew the icons (the widget
 * writes a small report, WidgetIconReport.swift). Together they tell where an avatar is lost on a
 * phone: not stored, stored but unreadable, or stored and the widget cannot read it.
 */

/** The widget's last report. at: unix seconds; read: bots drawn from the keychain; missing: no
 * item for the bot; errors/status: other keychain failures and the first OSStatus; bundled: bots
 * drawn from the avatars built into the widget. memory: the widget's own memory, null from widgets
 * before it was reported. writeFailure: the keychain refused the widget's earlier report writes
 * (last OSStatus and how many) before this one got through; null when none were refused. */
export interface WidgetIconReport {
  at: number;
  read: number;
  missing: number;
  errors: number;
  status: number;
  bundled: number;
  memory: WidgetMemory | null;
  writeFailure: { status: number; count: number } | null;
}

/** The widget extension's memory as iOS counts it against its limit (phys_footprint), in MB, when it
 * wrote the report: now, the process's peak so far, and the limit (now + what iOS still allowed it,
 * os_proc_available_memory; null where iOS gives none, as in the simulator). */
export interface WidgetMemory {
  now: number;
  peak: number;
  limit: number | null;
}

export interface LiveActivityIconStatus {
  /** Bot icons in the shared keychain group (what the widget can read). */
  stored: number;
  /** Of those, how many the app reads back as images; null when this build cannot tell. */
  readable: number | null;
  /** Of those, how many are avatars (the rest are Lucide tiles), from the icon index. */
  avatars: number;
  /** The shared keychain group, or null when this build has none. */
  group: string | null;
  /** The last keychain error (OSStatus) of an icon write or count, or null. */
  lastError: number | null;
  /** The widget's last report, or null when it never wrote one. */
  widget: WidgetIconReport | null;
  /** Keychain status (OSStatus) of the app's read of that report: 0 read, -25300 the widget never
   * wrote one, anything else the app could not read it; null from builds that do not say. */
  widgetStatus: number | null;
  /** Where the app found that report: the App Group (SharedStore.swift) or the keychain; null when
   * there is none, or from builds that do not say. */
  widgetSource: "group" | "keychain" | null;
  /** Whether this build has the App Group container shared with the widget, and how many bot icons
   * are in it (null without one); null from builds before 25. */
  appGroup: { available: boolean; icons: number | null } | null;
  /** The Lock Screen dino's timer layers (3 or 6): the app's setting, what the running activity's
   * content state carries (what the widget draws from), and the App Group copy (the widget's
   * fallback for pushes without it); null on builds before 25. */
  dino: {
    app: DinoLayerCount | null;
    card: DinoLayerCount | null;
    group: DinoLayerCount | null;
  } | null;
  /** Where the Lock Screen card's light/dark comes from; null on builds before 25. */
  appearance: LiveActivityAppearanceStatus | null;
}

export type Appearance = "light" | "dark";

export type DinoLayerCount = 3 | 6;

/**
 * The Lock Screen card's light/dark (iOS 26 gives the widget the dark scheme in both, so the app
 * tells it): what the app last read from the phone, what the running activity's content state
 * carries (what the widget draws from), and the shared keychain copy (the widget's fallback) with
 * the OSStatus of the app's last write to it.
 */
export interface LiveActivityAppearanceStatus {
  app: Appearance | null;
  card: Appearance | null;
  keychain: Appearance | null;
  keychainStatus: number | null;
}

/** What the native `iconStatus` returns. */
export interface NativeIconStatus {
  stored: number;
  ids?: string[];
  readable?: number;
  group: string | null;
  lastError: number | null;
  widget?: string | null;
  widgetStatus?: number;
  widgetSource?: string | null;
  appGroup?: { available?: unknown; icons?: unknown } | null;
  dino?: { app?: unknown; card?: unknown; group?: unknown } | null;
  appearance?: {
    app?: unknown;
    card?: unknown;
    keychain?: unknown;
    keychainStatus?: unknown;
  } | null;
}

function appearanceOf(value: unknown): Appearance | null {
  return value === "light" || value === "dark" ? value : null;
}

function appearanceStatus(
  raw: NativeIconStatus["appearance"],
): LiveActivityAppearanceStatus | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return {
    app: appearanceOf(raw.app),
    card: appearanceOf(raw.card),
    keychain: appearanceOf(raw.keychain),
    keychainStatus: typeof raw.keychainStatus === "number" ? raw.keychainStatus : null,
  };
}

function appGroupStatus(raw: NativeIconStatus["appGroup"]): LiveActivityIconStatus["appGroup"] {
  if (typeof raw !== "object" || raw === null || typeof raw.available !== "boolean") return null;
  if (raw.icons !== null && raw.icons !== undefined && typeof raw.icons !== "number") return null;
  return { available: raw.available, icons: typeof raw.icons === "number" ? raw.icons : null };
}

function dinoLayerCount(value: unknown): DinoLayerCount | null {
  return value === 3 || value === 6 ? value : null;
}

function dinoStatus(raw: NativeIconStatus["dino"]): LiveActivityIconStatus["dino"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return {
    app: dinoLayerCount(raw.app),
    card: dinoLayerCount(raw.card),
    group: dinoLayerCount(raw.group),
  };
}

const REPORT_KEYS = ["at", "read", "missing", "errors", "status", "bundled"] as const;

export function parseWidgetReport(raw: string | null | undefined): WidgetIconReport | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (!REPORT_KEYS.every((k) => typeof v[k] === "number")) return null;
    const report = { memory: null, writeFailure: null } as WidgetIconReport;
    for (const k of REPORT_KEYS) report[k] = v[k] as number;
    const { mem, peak, avail } = v;
    if (typeof mem === "number" && typeof peak === "number" && typeof avail === "number") {
      report.memory = { now: mem, peak, limit: avail > 0 ? mem + avail : null };
    }
    const { wfail, wfails } = v;
    if (typeof wfail === "number" && typeof wfails === "number") {
      report.writeFailure = { status: wfail, count: wfails };
    }
    return report;
  } catch {
    return null;
  }
}

/** Stored ids whose index entry is an avatar (`avatar:<path>`). */
function avatarCount(ids: readonly string[], indexRaw: string | null): number {
  if (!indexRaw) return 0;
  try {
    const index = JSON.parse(indexRaw) as Record<string, { source?: unknown } | null>;
    return ids.filter((id) => {
      const source = index?.[id]?.source;
      return typeof source === "string" && source.startsWith("avatar:");
    }).length;
  } catch {
    return 0;
  }
}

export function iconStatusFromNative(
  native: NativeIconStatus,
  indexRaw: string | null,
): LiveActivityIconStatus {
  return {
    stored: native.stored,
    readable: typeof native.readable === "number" ? native.readable : null,
    avatars: avatarCount(native.ids ?? [], indexRaw),
    group: native.group,
    lastError: native.lastError,
    widget: parseWidgetReport(native.widget),
    widgetStatus: typeof native.widgetStatus === "number" ? native.widgetStatus : null,
    widgetSource:
      native.widgetSource === "group" || native.widgetSource === "keychain"
        ? native.widgetSource
        : null,
    appGroup: appGroupStatus(native.appGroup),
    dino: dinoStatus(native.dino),
    appearance: appearanceStatus(native.appearance),
  };
}

/**
 * Why the Network page has no icon status (it then says so instead of hiding the rows, la-avatars):
 * - noModule: the build has no PaseoLiveActivity native module (not iOS, or not linked);
 * - noIconStatus: the native module has no `iconStatus` (an older native build);
 * - failed: `iconStatus` threw or rejected;
 * - empty: it answered nothing usable.
 */
export type IconStatusUnavailable = "noModule" | "noIconStatus" | "failed" | "empty";

export type IconStatusResult =
  | { status: LiveActivityIconStatus; unavailable: null; error: null }
  | { status: null; unavailable: IconStatusUnavailable; error: string | null };

function unavailable(reason: IconStatusUnavailable, error: string | null = null): IconStatusResult {
  return { status: null, unavailable: reason, error };
}

/** Asks the native module for the icon status; says why when it cannot. */
export async function readIconStatus(
  native: { iconStatus?: () => Promise<NativeIconStatus> } | null | undefined,
  readIndex: () => Promise<string | null>,
): Promise<IconStatusResult> {
  if (!native) return unavailable("noModule");
  if (typeof native.iconStatus !== "function") return unavailable("noIconStatus");
  let answer: unknown;
  try {
    answer = await native.iconStatus();
  } catch (error) {
    return unavailable("failed", error instanceof Error ? error.message : String(error));
  }
  if (
    typeof answer !== "object" ||
    answer === null ||
    typeof (answer as NativeIconStatus).stored !== "number"
  ) {
    return unavailable("empty");
  }
  const index = await readIndex().catch(() => null);
  return {
    status: iconStatusFromNative(answer as NativeIconStatus, index),
    unavailable: null,
    error: null,
  };
}
