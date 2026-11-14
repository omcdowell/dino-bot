// Every systemd user timer on the host, for the app's Schedules screen ("Systemd timers · no
// model"). `systemctl --user` only, via execFile (no shell), never sudo. The only write is
// pause/resume (setTimerPaused) of one existing user timer.
//
// Which timers: all of them (14 Nov: "just put anything with a systemd timer into the
// list") — loaded ones from `list-timers --all`, plus stopped+disabled ones that only
// `list-unit-files` still knows, so a paused timer stays listed for Resume.
//
// System vs yours (14 Nov: "have a show all button"): every row carries `system`. A timer
// is yours when its unit file (FragmentPath) is under your home (~/.config/systemd/user,
// ~/.local/share/systemd/user, or a `systemctl --user link`ed file there) or is a transient one
// under /run/user/<uid>/systemd/transient (`systemd-run --user --on-calendar`). Anything else is
// system: /usr/lib + /lib (distro packages: ubuntu-insights, launchpadlib, systemd-tmpfiles-clean),
// /etc/systemd/user (snap installs its user timers there), /usr/local/lib, generators. Decided by
// file location, not by name, so a timer you write is never hidden whatever it is called. No
// FragmentPath at all → yours (shown; never hide something we cannot place).
// `bots.timers` hides system timers unless `includeAll: true` — so an app that sends `{}` (the
// TestFlight build without the toggle) sees only yours.
//
// Recovered from paseo-bots `feat/timers-in-scheduler` (1dc3078, f0d1f90; never merged, lost in
// the monorepo move) minus its own-unit-dir allow-list.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { TIMER_UNIT_RE, type SystemdTimerDto, type TimersAnswerDto } from "../shared/timers-rpc";

export type Systemctl = (args: string[]) => Promise<string>;

export const systemctl: Systemctl = (args) =>
  new Promise((resolve, reject) => {
    execFile("systemctl", ["--user", ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || "").trim() || error.message)) : resolve(stdout),
    );
  });

export interface Where {
  /** Default: os.homedir(). */
  home?: string;
  /** Default: process.getuid(). */
  uid?: number;
}

/** True for a unit file outside your home and not one of your transient units (see top). */
export function isSystemUnit(fragmentPath: string | undefined, where: Where = {}): boolean {
  const path = (fragmentPath ?? "").trim();
  if (!path) return false;
  const home = (where.home ?? homedir()).replace(/\/+$/, "");
  if (home && path.startsWith(`${home}/`)) return false;
  const uid = where.uid ?? process.getuid?.();
  if (uid !== undefined && path.startsWith(`/run/user/${uid}/systemd/transient/`)) return false;
  return true;
}

const SHOW_PROPS = [
  "Id", "Description", "FragmentPath", "ActiveState", "UnitFileState", "Unit", "TimersCalendar",
  "TimersMonotonic", "LastTriggerUSec", "Result", "ExecMainStatus", "ExecMainStartTimestamp",
];

interface ListedTimer {
  unit: string;
  activates: string | null;
  next: number | null;
  last: number | null;
}

/** `list-timers --output=json` → units with next/last in µs since epoch. */
export function parseListTimers(json: string): ListedTimer[] {
  const rows = JSON.parse(json || "[]") as unknown;
  if (!Array.isArray(rows)) return [];
  const usec = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);
  return rows.flatMap((row) =>
    row && typeof row.unit === "string" && row.unit.endsWith(".timer")
      ? [{ unit: row.unit, activates: typeof row.activates === "string" ? row.activates : null, next: usec(row.next), last: usec(row.last) }]
      : [],
  );
}

/** `list-unit-files --type=timer --output=json` → timer unit names. A paused (stopped + disabled)
 * timer is unloaded and missing from list-timers, so this keeps it listed for Resume. */
export function parseUnitFiles(json: string): string[] {
  const rows = JSON.parse(json || "[]") as unknown;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) =>
    row && typeof row.unit_file === "string" && row.unit_file.endsWith(".timer") ? [row.unit_file] : [],
  );
}

/** `systemctl show a b …` → one map per unit; repeated keys (several triggers) collect in order. */
export function parseShow(text: string): Map<string, Map<string, string[]>> {
  const units = new Map<string, Map<string, string[]>>();
  for (const block of text.split(/\n\s*\n/)) {
    const props = new Map<string, string[]>();
    for (const line of block.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      props.set(key, [...(props.get(key) ?? []), line.slice(eq + 1)]);
    }
    const id = props.get("Id")?.[0];
    if (id) units.set(id, props);
  }
  return units;
}

/** Description= as written; vendor units sometimes quote it (`"Upload …"`). */
export function cleanDescription(raw: string | undefined): string | null {
  const text = (raw ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
  return text || null;
}

/** `*-*-* 06:00:00 Asia/Singapore` → "daily 06:00 Asia/Singapore"; unknown shapes stay raw. */
export function describeCalendar(spec: string): string {
  const m = /^(?:(\S+) )?\*-\*-\* (\S+)(?: (\S+))?$/.exec(spec.trim());
  if (!m) return spec;
  const [, days, time, zone] = m;
  const tz = zone ? ` ${zone}` : "";
  const [h, min, s] = time.split(":");
  if (h === "*" && min === "*") return `every minute${tz}`;
  const step = h === "*" ? /^(\d+)\/(\d+)$/.exec(min) : null;
  if (step && (s === "00" || s === undefined)) return `every ${step[2]}min${tz}`;
  if (!/^\d+(,\d+)*$/.test(h) || !/^\d+$/.test(min)) return spec;
  const at = h.split(",").map((hour) => `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`).join(", ");
  if (!days) return `daily ${at}${tz}`;
  return `${days === "Mon..Fri" ? "weekdays" : days} ${at}${tz}`;
}

const ONE_OFF = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?( \S+)?$/;
const MAX_PARTS = 3;

/** Several OnCalendar= lines → one short line: "daily 06:00, 18:00"; dated one-offs collapse to
 * "12 one-off times"; more than 3 distinct shapes → "a, b, c +N more". */
export function summariseCalendars(specs: string[]): string {
  const oneOffs = specs.filter((s) => ONE_OFF.test(s.trim()));
  const groups = new Map<string, string[]>();
  for (const spec of specs.filter((s) => !ONE_OFF.test(s.trim()))) {
    const text = describeCalendar(spec);
    const m = /^(daily|weekdays|\S+) ((?:\d{2}:\d{2}(?:, )?)+)( \S+)?$/.exec(text);
    const key = m ? `${m[1]}\u0000${m[3] ?? ""}` : `\u0001${text}`;
    groups.set(key, [...(groups.get(key) ?? []), ...(m ? m[2].split(", ") : [])]);
  }
  const parts = [...groups].map(([key, times]) => {
    if (key.startsWith("\u0001")) return key.slice(1);
    const [days, tz] = key.split("\u0000");
    return `${days} ${[...new Set(times)].sort().join(", ")}${tz}`;
  });
  if (oneOffs.length) parts.push(oneOffs.length === 1 ? oneOffs[0].trim() : `${oneOffs.length} one-off times`);
  return parts.length > MAX_PARTS ? `${parts.slice(0, MAX_PARTS).join(", ")} +${parts.length - MAX_PARTS} more` : parts.join(", ");
}

/** Calendar triggers win; else the repeating monotonic one ("every 15min"); boot-only stays raw. */
export function describeSchedule(calendar: string[], monotonic: string[]): string {
  const field = (entry: string, key: string) => new RegExp(`${key}=([^;]+?)\\s*;`).exec(entry)?.[1] ?? null;
  const cal = calendar.map((e) => field(e, "OnCalendar")).filter((v): v is string => !!v);
  if (cal.length) return summariseCalendars(cal);
  const every = monotonic.map((e) => field(e, "On(?:UnitActive|UnitInactive)USec")).find(Boolean);
  if (every) return `every ${every}`;
  return monotonic.map((e) => /\{\s*([^;]+?)\s*;/.exec(e)?.[1]).filter(Boolean).join(", ") || "unknown";
}

const iso = (usec: number | null) => (usec ? new Date(Math.floor(usec / 1000)).toISOString() : null);
/** `@1791793755` (show --timestamp=unix) → µs. */
const unixUsec = (v: string | undefined) => (v && /^@\d+$/.test(v) ? Number(v.slice(1)) * 1_000_000 : null);

function lastResult(service: Map<string, string[]> | undefined, ranAt: number | null) {
  const get = (k: string) => service?.get(k)?.[0] ?? "";
  if (["active", "activating", "deactivating", "reloading"].includes(get("ActiveState")) && get("ExecMainStartTimestamp")) {
    return { lastResult: "running" as const, resultDetail: null };
  }
  if (!ranAt) return { lastResult: "never" as const, resultDetail: null };
  const result = get("Result");
  if (result === "success" || result === "") return { lastResult: "ok" as const, resultDetail: null };
  const status = get("ExecMainStatus");
  const detail = result === "exit-code" && status && status !== "0" ? `exit ${status}` : result;
  return { lastResult: "failed" as const, resultDetail: detail };
}

const ACTIVE = ["active", "activating", "reloading"];

function timerState(timer: Map<string, string[]>): SystemdTimerDto["timerState"] {
  if (ACTIVE.includes(timer.get("ActiveState")?.[0] ?? "")) return "active";
  return timer.get("UnitFileState")?.[0] === "disabled" ? "paused" : "inactive";
}

/** Every user timer, soonest next run first (paused/stopped last). Read-only. */
export async function listSystemdTimers(run: Systemctl = systemctl, where: Where = {}): Promise<SystemdTimerDto[]> {
  const listed = new Map(parseListTimers(await run(["list-timers", "--all", "--output=json"])).map((t) => [t.unit, t]));
  const files = parseUnitFiles(await run(["list-unit-files", "--type=timer", "--output=json"]));
  const units = [...new Set([...listed.keys(), ...files])];
  if (!units.length) return [];
  const show = async (names: string[]) =>
    names.length ? parseShow(await run(["show", "--timestamp=unix", "-p", SHOW_PROPS.join(","), "--", ...names])) : new Map();
  const timers = await show(units);
  const serviceOf = (unit: string) => listed.get(unit)?.activates ?? timers.get(unit)?.get("Unit")?.[0] ?? null;
  const known = units.filter((unit) => timers.has(unit));
  const services = await show([...new Set(known.flatMap((unit) => serviceOf(unit) ?? []))]);
  const out = known.map((unit): SystemdTimerDto => {
    const timer = timers.get(unit)!;
    const t = listed.get(unit);
    const svc = serviceOf(unit);
    const service = svc ? services.get(svc) : undefined;
    const ranAt = t?.last ?? unixUsec(timer.get("LastTriggerUSec")?.[0]) ?? unixUsec(service?.get("ExecMainStartTimestamp")?.[0]);
    const state = timerState(timer);
    return {
      unit,
      name: unit.replace(/\.timer$/, ""),
      description: cleanDescription(timer.get("Description")?.[0]),
      schedule: describeSchedule(timer.get("TimersCalendar") ?? [], timer.get("TimersMonotonic") ?? []),
      nextRunAt: state === "active" ? iso(t?.next ?? null) : null,
      lastRunAt: iso(ranAt),
      timerState: state,
      ...lastResult(service, ranAt),
      system: isSystemUnit(timer.get("FragmentPath")?.[0], where),
    };
  });
  // Soonest first; timers with no next run last, by name.
  const key = (t: SystemdTimerDto) => `${t.nextRunAt ?? "\uffff"}|${t.name}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface AnswerOptions extends Where {
  /** Also system timers (the app's "Show all"). Default false: only yours. */
  includeAll?: boolean;
}

const visible = (timers: SystemdTimerDto[], opts: AnswerOptions) =>
  opts.includeAll ? timers : timers.filter((t) => !t.system);

/** The `bots.timers` answer: never throws; a systemctl failure is an error string. */
export async function timersAnswer(run: Systemctl = systemctl, opts: AnswerOptions = {}): Promise<TimersAnswerDto> {
  try {
    return { timers: visible(await listSystemdTimers(run, opts), opts), error: null };
  } catch (error) {
    return { timers: [], error: `systemd timers unavailable: ${message(error)}` };
  }
}

/**
 * Pause = `disable --now` (stop + disable: survives a reboot); resume = `enable --now`.
 * Only for an existing user `.timer` (one `listSystemdTimers` returns, system ones included: the
 * app only offers those once "Show all" lists them); anything else is refused without a write.
 * The answer's list is filtered like `bots.timers` (`includeAll`).
 */
export async function setTimerPaused(
  unit: string,
  paused: boolean,
  run: Systemctl = systemctl,
  opts: AnswerOptions = {},
): Promise<TimersAnswerDto> {
  try {
    if (!TIMER_UNIT_RE.test(unit)) return { ...(await timersAnswer(run, opts)), error: `not a timer unit name: ${unit}` };
    const before = await listSystemdTimers(run, opts);
    if (!before.some((t) => t.unit === unit)) return { timers: visible(before, opts), error: `no such user timer: ${unit}` };
    await run([paused ? "disable" : "enable", "--now", "--", unit]);
  } catch (error) {
    const answer = await timersAnswer(run, opts);
    return { ...answer, error: `could not ${paused ? "pause" : "resume"} ${unit}: ${message(error)}` };
  }
  return timersAnswer(run, opts);
}
