import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** One systemd user timer on the host, for the app's Schedules screen (app: schedules/systemd-timers.ts). */
export const SystemdTimerSchema = z.object({
  /** `fc-daily-standup.timer` */
  unit: z.string(),
  /** `fc-daily-standup` */
  name: z.string(),
  /** The timer's Description= line; the app shows it as the row title when present. */
  description: z.string().nullable(),
  /** Human cadence, e.g. "daily 06:00 Asia/Singapore", "every 15min"; raw systemd spec otherwise. */
  schedule: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  /** "paused" = stopped + disabled (via bots.timers.set, survives a reboot); "inactive" = stopped
   * but still enabled (starts again at boot). Neither fires. */
  timerState: z.enum(["active", "paused", "inactive"]),
  lastResult: z.enum(["ok", "failed", "running", "never"]),
  /** For failed runs: "exit 1", "signal", "timeout"… */
  resultDetail: z.string().nullable(),
  /** Unit file outside your home (distro /usr/lib, snap's /etc/systemd/user…); hidden unless
   * `includeAll`. See server/systemd-timers.ts for the rule. */
  system: z.boolean(),
});
export type SystemdTimerDto = z.infer<typeof SystemdTimerSchema>;

const TimersAnswer = z.object({ timers: z.array(SystemdTimerSchema), error: z.string().nullable() });
export type TimersAnswerDto = z.infer<typeof TimersAnswer>;

/** `includeAll` = also system timers (the app's "Show all"); absent/false = only yours, which is
 * what an app without the toggle (sends `{}`) gets. */
const IncludeAll = z.boolean().optional();

/** Every systemd user timer on the host (`systemctl --user`), read-only. */
export const botsTimersRpc = defineRpc({
  name: "bots.timers",
  input: z.object({ includeAll: IncludeAll }),
  output: TimersAnswer,
});

/** A plain unit name: no spaces, no shell metacharacters, no leading "-", ends in `.timer`. */
export const TIMER_UNIT_RE = /^[A-Za-z0-9_\\][A-Za-z0-9@._:\\-]*\.timer$/;

/** Pause (stop + disable) or resume (enable + start) one user timer; answers the new list. */
export const botsTimersSetRpc = defineRpc({
  name: "bots.timers.set",
  input: z.object({ unit: z.string().regex(TIMER_UNIT_RE), paused: z.boolean(), includeAll: IncludeAll }),
  output: TimersAnswer,
});
