import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { buildSchedulesRoute } from "../../src/utils/host-routes";

// A stand-in for the paseo-bots plugin's `bots.timers` RPC (systemd user timers, read-only).
const sharedSource = `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const botsTimersRpc = defineRpc({
  name: "bots.timers",
  input: z.object({}),
  output: z.object({ timers: z.array(z.any()), error: z.string().nullable() }),
});
export const botsTimersSetRpc = defineRpc({
  name: "bots.timers.set",
  input: z.object({ unit: z.string(), paused: z.boolean() }),
  output: z.object({ timers: z.array(z.any()), error: z.string().nullable() }),
});`;

const serverSource = `import { botsTimersRpc, botsTimersSetRpc } from "./shared/rpc";
const at = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const paused = new Set();
const list = () => ({
    error: null,
    timers: [
      { unit: "oauth-watch.timer", name: "oauth-watch", description: "Run oauth-watch every 5 minutes",
        schedule: "every 5min", nextRunAt: at(3), lastRunAt: at(-2), timerState: "active", lastResult: "ok", resultDetail: null },
      { unit: "fc-daily-standup.timer", name: "fc-daily-standup", description: "FC daily standup, 06:00 Asia/Singapore",
        schedule: "daily 06:00 Asia/Singapore", nextRunAt: at(600), lastRunAt: null, timerState: "active", lastResult: "never", resultDetail: null },
      { unit: "herdrapp-testbed.timer", name: "herdrapp-testbed", description: "herdr-app nightly TUI-conformance testbed",
        schedule: "daily 03:30", nextRunAt: at(1080), lastRunAt: at(-360), timerState: "active", lastResult: "failed", resultDetail: "exit 203" },
    ].map((t) => (paused.has(t.unit) ? { ...t, timerState: "paused", nextRunAt: null } : t)),
});
export default function contribute(server) {
  server.handle(botsTimersRpc, async () => list());
  server.handle(botsTimersSetRpc, async ({ unit, paused: pause }) => {
    if (pause) paused.add(unit); else paused.delete(unit);
    return list();
  });
  return () => {};
}`;

async function shot(page: Page, name: string): Promise<void> {
  const directory = process.env.E2E_SHOT_DIR;
  if (!directory) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

test("Schedules lists the host's systemd timers read-only, marked no model", async ({ page }) => {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-bots-timers-"));
  try {
    await mkdir(path.join(directory, "shared"));
    await Promise.all([
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "bots", requirements: pluginRequirements }),
      ),
      writeFile(path.join(directory, "index.server.ts"), serverSource),
      writeFile(path.join(directory, "shared", "rpc.ts"), sharedSource),
    ]);
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(buildSchedulesRoute());
    const card = page.getByTestId("systemd-timers");
    await expect(card).toContainText("Systemd timers · no model", { timeout: 30_000 });
    // No Paseo schedules: the timers replace the empty state, the New schedule button stays.
    await expect(page.getByTestId("schedules-empty")).toHaveCount(0);
    await expect(page.getByTestId("schedules-new")).toBeVisible();
    const oauth = page.getByTestId("systemd-timer-oauth-watch");
    await expect(oauth).toContainText("every 5min · Last run 2m ago");
    await expect(oauth).toContainText("Next run in 3m");
    await expect(oauth).toContainText("Active");
    await expect(page.getByTestId("systemd-timer-fc-daily-standup")).toContainText("Never run");
    const failed = page.getByTestId("systemd-timer-herdrapp-testbed");
    await expect(failed).toContainText("failed (exit 203)");
    await expect(failed).toContainText("Failed");
    await shot(page, "timers-wide");

    // Pause, then resume, from the row menu.
    await page.getByTestId("systemd-timer-kebab-oauth-watch").click();
    await page.getByTestId("systemd-timer-pause-oauth-watch").click();
    await expect(oauth).toContainText("Paused");
    await expect(oauth).not.toContainText("Next run");
    await page.getByTestId("systemd-timer-kebab-oauth-watch").click();
    await expect(page.getByTestId("systemd-timer-resume-oauth-watch")).toBeVisible();
    await shot(page, "timers-menu-resume");
    await page.getByTestId("systemd-timer-resume-oauth-watch").click();
    await expect(oauth).toContainText("Next run in 3m");
    await expect(oauth).toContainText("Active");

    // Ended tab: no timers there, and the filter stays so Active is one tap away.
    await page.getByTestId("schedules-filter-ended").click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("schedules-status-filter")).toBeVisible();
    await page.getByTestId("schedules-filter-active").click();
    await expect(card).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(oauth).toBeVisible();
    await shot(page, "timers-compact");
  } finally {
    await client.removePlugin("bots").catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
