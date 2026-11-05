import { describe, expect, it } from "vitest";
import {
  fetchSystemdTimers,
  parseTimers,
  setSystemdTimerPaused,
  timerBadge,
  timerMeta,
  TIMERS_METHOD,
  TIMERS_PLUGIN_ID,
  TIMERS_SET_METHOD,
  type SystemdTimer,
} from "./systemd-timers";

const HOST = { serverId: "box", serverName: "box" };

function row(overrides: Record<string, unknown> = {}) {
  return {
    unit: "fc-daily-standup.timer",
    name: "fc-daily-standup",
    description: "FC daily standup, 06:00 Asia/Singapore",
    schedule: "daily 06:00 Asia/Singapore",
    nextRunAt: "2026-10-12T22:00:00.000Z",
    lastRunAt: "2026-10-11T22:00:00.000Z",
    timerState: "active",
    lastResult: "ok",
    resultDetail: null,
    ...overrides,
  };
}

function timer(overrides: Record<string, unknown> = {}): SystemdTimer {
  return parseTimers({ timers: [row(overrides)] }, HOST)[0];
}

describe("systemd timers", () => {
  it("asks each host's bots plugin and tags rows with the host", async () => {
    const calls: unknown[] = [];
    const timers = await fetchSystemdTimers([
      {
        ...HOST,
        client: {
          invokePluginRpc: async (...args) => {
            calls.push(args);
            return { timers: [row()], error: null };
          },
        },
      },
    ]);
    expect(calls).toEqual([[TIMERS_PLUGIN_ID, TIMERS_METHOD, {}]]);
    expect(timers).toEqual([{ ...row(), serverId: "box", serverName: "box" }]);
  });

  it("a host without the plugin (or failing) contributes nothing, others still show", async () => {
    const timers = await fetchSystemdTimers([
      {
        serverId: "mac",
        serverName: "mac",
        client: { invokePluginRpc: () => Promise.reject(new Error("unknown plugin")) },
      },
      { ...HOST, client: { invokePluginRpc: async () => ({ timers: [row()] }) } },
    ]);
    expect(timers.map((t) => t.serverId)).toEqual(["box"]);
  });

  it("drops malformed rows and defaults unknown fields", () => {
    const parsed = parseTimers(
      { timers: [{ name: "x" }, null, row({ lastResult: "weird", timerState: "weird" })] },
      HOST,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ lastResult: "never", timerState: "active" });
    expect(parseTimers(null, HOST)).toEqual([]);
    expect(parseTimers({ timers: "no" }, HOST)).toEqual([]);
  });

  it("badge: running, paused (even after a failed run), failed, stopped, active", () => {
    expect(timerBadge(timer({ lastResult: "running" })).label).toBe("Running");
    expect(timer({ timerState: "paused" }).timerState).toBe("paused");
    expect(timerBadge(timer({ timerState: "paused", lastResult: "failed" }))).toEqual({
      label: "Paused",
      variant: "muted",
    });
    expect(timerBadge(timer({ lastResult: "failed" }))).toEqual({
      label: "Failed",
      variant: "error",
    });
    expect(timerBadge(timer({ timerState: "inactive" })).label).toBe("Stopped");
    expect(timerBadge(timer())).toEqual({ label: "Active", variant: "success" });
  });

  it("meta line: cadence, last run + result, next run", () => {
    const text = { lastRunAgo: "5m ago", nextRun: "in 3m", showHost: false };
    expect(timerMeta(timer(), text)).toBe(
      "daily 06:00 Asia/Singapore · Last run 5m ago · Next run in 3m",
    );
    expect(timerMeta(timer({ lastResult: "failed", resultDetail: "exit 203" }), text)).toContain(
      "Last run 5m ago, failed (exit 203)",
    );
    expect(timerMeta(timer({ lastRunAt: null, lastResult: "never" }), text)).toContain("Never run");
    expect(timerMeta(timer({ timerState: "inactive" }), text)).not.toContain("Next run");
    expect(timerMeta(timer(), { ...text, showHost: true }).startsWith("box · daily")).toBe(true);
  });

  it("pause/resume calls bots.timers.set on the host and surfaces the plugin's error", async () => {
    const calls: unknown[] = [];
    const ok = {
      invokePluginRpc: async (...args: unknown[]) => {
        calls.push(args);
        return { timers: [], error: null };
      },
    };
    await setSystemdTimerPaused(ok, "oauth-watch.timer", true);
    await setSystemdTimerPaused(ok, "oauth-watch.timer", false);
    expect(calls).toEqual([
      [TIMERS_PLUGIN_ID, TIMERS_SET_METHOD, { unit: "oauth-watch.timer", paused: true }],
      [TIMERS_PLUGIN_ID, TIMERS_SET_METHOD, { unit: "oauth-watch.timer", paused: false }],
    ]);
    const refused = {
      invokePluginRpc: async () => ({ timers: [], error: "not one of our timers: x.timer" }),
    };
    await expect(setSystemdTimerPaused(refused, "x.timer", true)).rejects.toThrow(
      "not one of our timers",
    );
  });
});
