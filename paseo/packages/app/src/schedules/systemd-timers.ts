/**
 * Systemd user timers (no-model jobs) for the Schedules screen. They come from the bots plugin's
 * `bots.timers` RPC (paseo-bots), not the daemon's schedule store. The only action is pause/resume
 * (`bots.timers.set`: stop + disable / enable + start). Hosts without the plugin contribute nothing
 * and raise no error.
 *
 * System timers (unit file outside the user's home: distro /usr/lib, snap's /etc/systemd/user —
 * the plugin decides, `system: true`) are fetched too (`includeAll`) but hidden until "Show all".
 */
export const TIMERS_PLUGIN_ID = "bots";
export const TIMERS_METHOD = "bots.timers";
export const TIMERS_SET_METHOD = "bots.timers.set";

export interface SystemdTimer {
  unit: string;
  name: string;
  description: string | null;
  schedule: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** "paused" = stopped + disabled; "inactive" = stopped, still enabled. */
  timerState: "active" | "paused" | "inactive";
  lastResult: "ok" | "failed" | "running" | "never";
  resultDetail: string | null;
  /** Vendor/distro timer (ubuntu-insights, snap, systemd-tmpfiles-clean…); hidden by default. */
  system: boolean;
  serverId: string;
  serverName: string;
}

export interface TimersClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}

export interface TimersHost {
  serverId: string;
  serverName: string;
  client: TimersClient;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const RESULTS = ["ok", "failed", "running", "never"] as const;
const STATES = ["active", "paused", "inactive"] as const;

/** Tolerant parse of one host's answer; malformed rows are dropped. */
export function parseTimers(answer: unknown, host: Omit<TimersHost, "client">): SystemdTimer[] {
  const rows = (answer as { timers?: unknown } | null)?.timers;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): SystemdTimer[] => {
    const unit = str(row?.unit);
    const name = str(row?.name);
    if (!unit || !name) return [];
    const result = RESULTS.find((r) => r === row.lastResult) ?? "never";
    return [
      {
        unit,
        name,
        description: str(row.description),
        schedule: str(row.schedule) ?? "",
        nextRunAt: str(row.nextRunAt),
        lastRunAt: str(row.lastRunAt),
        timerState: STATES.find((state) => state === row.timerState) ?? "active",
        lastResult: result,
        resultDetail: str(row.resultDetail),
        system: row.system === true,
        serverId: host.serverId,
        serverName: host.serverName,
      },
    ];
  });
}

export async function fetchSystemdTimers(hosts: readonly TimersHost[]): Promise<SystemdTimer[]> {
  const perHost = await Promise.all(
    hosts.map((host) =>
      host.client
        .invokePluginRpc(TIMERS_PLUGIN_ID, TIMERS_METHOD, { includeAll: true })
        .then((answer) => parseTimers(answer, host))
        .catch((): SystemdTimer[] => []),
    ),
  );
  return perHost.flat();
}

/** Pause (stop + disable, survives a reboot) or resume (enable + start) one timer on its host. */
export async function setSystemdTimerPaused(
  client: TimersClient,
  unit: string,
  paused: boolean,
): Promise<void> {
  const answer = (await client.invokePluginRpc(TIMERS_PLUGIN_ID, TIMERS_SET_METHOD, {
    unit,
    paused,
  })) as { error?: unknown } | null;
  if (typeof answer?.error === "string" && answer.error) throw new Error(answer.error);
}

/** What the card lists: yours, plus system timers once "Show all" is on; `hidden` counts the rest. */
export function visibleTimers(
  timers: readonly SystemdTimer[],
  showAll: boolean,
): { shown: SystemdTimer[]; hidden: number; system: number } {
  const system = timers.filter((timer) => timer.system).length;
  const shown = showAll ? [...timers] : timers.filter((timer) => !timer.system);
  return { shown, hidden: timers.length - shown.length, system };
}

/** Row title: the timer's Description= line when it has one (moved Paseo schedules read as
 * sentences), else the unit name; the unit name then moves to the subtitle. */
export function timerTitle(timer: SystemdTimer): {
  title: string;
  subtitle: string | null;
} {
  const description = timer.description?.trim();
  return description
    ? { title: description, subtitle: timer.name }
    : { title: timer.name, subtitle: null };
}

export function timerBadge(timer: SystemdTimer): {
  label: string;
  variant: "success" | "error" | "muted";
} {
  if (timer.lastResult === "running") return { label: "Running", variant: "success" };
  if (timer.timerState === "paused") return { label: "Paused", variant: "muted" };
  if (timer.lastResult === "failed") return { label: "Failed", variant: "error" };
  if (timer.timerState === "inactive") return { label: "Stopped", variant: "muted" };
  return { label: "Active", variant: "success" };
}

/** "every 15min · Last run 5m ago, failed (exit 1) · Next run in 3m"; the card header says
 * "Systemd timers · no model", so rows do not repeat it. */
export function timerMeta(
  timer: SystemdTimer,
  text: { lastRunAgo: string; nextRun: string; showHost: boolean },
): string {
  const failed = timer.lastResult === "failed" ? `, failed (${timer.resultDetail ?? "error"})` : "";
  const parts = [
    timer.schedule,
    timer.lastRunAt ? `Last run ${text.lastRunAgo}${failed}` : "Never run",
  ];
  if (timer.timerState === "active" && text.nextRun) parts.push(`Next run ${text.nextRun}`);
  if (text.showHost) parts.unshift(timer.serverName);
  return parts.filter(Boolean).join(" · ");
}
