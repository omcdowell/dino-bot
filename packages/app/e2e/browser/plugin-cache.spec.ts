import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { gotoWorkspace } from "../support/helpers/launcher";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { headerRow } from "../support/helpers/plugin-sidebar-items";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

// Plugin cache (Sam 2026-10-11, "on the desktop app, i have to wait for the plugin to load"):
// plugin UI shows from the device cache before the host answers, and a connect does not resend a
// bundle the app already has.

const PLUGIN_ID = "cached-bots";

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        omp: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    },
  },
});

/** A bots-like sidebar item: one row per bot from a server RPC, kept on the device (persist). */
const CLIENT_SOURCE = `import React from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { listBots } from "./shared/rpc";

function BotsItem() {
  const list = useRpc(listBots);
  const { data } = useQuery({ queryKey: ["bots", "list"], queryFn: () => list({}), meta: { persist: true } });
  return (data?.bots ?? []).map((bot) => (
    <SidebarRow key={bot} id={"bot-" + bot} icon="Rocket" label={bot + " (" + data.servedAt + ")"} onPress={() => {}} />
  ));
}

export default function contribute(client) {
  client.addSidebarHeaderItem({ id: "bots", title: "Bots", Component: BotsItem });
  return () => {};
}
`;

async function installCachedBotsPlugin() {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-cache-"));
  await mkdir(path.join(directory, "shared"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), CLIENT_SOURCE);
  await writeFile(
    path.join(directory, "shared/rpc.ts"),
    `import { defineRpc } from "@getpaseo/plugin"; import { z } from "zod"; export const listBots = defineRpc({ name: "bots.list", input: z.object({}), output: z.object({ bots: z.array(z.string()), servedAt: z.string() }) });`,
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import { listBots } from "./shared/rpc"; export default function contribute(server) { server.handle(listBots, async () => ({ bots: ["Flint", "Scrat"], servedAt: new Date().toISOString().slice(11, 23) })); return () => {}; }`,
  );
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(directory);
  return {
    async cleanup() {
      await client.removePlugin(PLUGIN_ID);
      await client.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
      await client.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const botRow = (page: Page, bot: string) => headerRow(page, PLUGIN_ID, `bots-bot-${bot}`);

/** The app's `paseo:plugins:catalog-response` marks: bundle characters the daemon sent. */
function catalogMarks(page: Page) {
  return page.evaluate(() =>
    performance
      .getEntriesByName("paseo:plugins:catalog-response")
      .map(
        (mark) => (mark as PerformanceMark).detail as { bundleChars: number; unchanged: number },
      ),
  );
}

async function waitForSavedRows(page: Page) {
  const key = `paseo:plugin-cache:v1:${getServerId()}:queries:${PLUGIN_ID}`;
  await expect
    .poll(() =>
      page.evaluate((name) => localStorage.getItem(name)?.includes("Scrat") ?? false, key),
    )
    .toBe(true);
}

test.describe("plugin cache", () => {
  let workspaceId: string;
  let cleanup: () => Promise<void>;

  test.beforeEach(async () => {
    const workspace = await seedWorkspace({ repoPrefix: "plugin-cache-" });
    const plugin = await installCachedBotsPlugin();
    workspaceId = workspace.workspaceId;
    cleanup = async () => {
      await plugin.cleanup();
      await workspace.cleanup();
    };
  });

  test.afterEach(async () => {
    await cleanup();
  });

  test("plugin rows show from the device cache while the host does not answer", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoWorkspace(page, workspaceId);
    await expect(botRow(page, "Scrat")).toBeVisible();
    const liveLabel = await botRow(page, "Scrat").innerText();
    await waitForSavedRows(page);

    // The host's socket opens but never answers: no handshake, no catalog, no RPC.
    await page.routeWebSocket(daemonWsRoutePattern(), () => {});
    const reloadedAt = Date.now();
    await page.reload();
    await expect(botRow(page, "Flint")).toBeVisible();
    await expect(botRow(page, "Scrat")).toBeVisible();
    // The last known data, not a fresh answer.
    expect(await botRow(page, "Scrat").innerText()).toBe(liveLabel);
    expect(Date.now() - reloadedAt).toBeLessThan(15_000);
    expect(await catalogMarks(page)).toEqual([]);
  });

  test("a reconnect does not resend the bundle the app already has, and refreshes the rows", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoWorkspace(page, workspaceId);
    await expect(botRow(page, "Scrat")).toBeVisible();
    const [first] = await catalogMarks(page);
    expect(first?.bundleChars).toBeGreaterThan(1000);
    expect(first?.unchanged).toBe(0);
    await waitForSavedRows(page);
    const cachedLabel = await botRow(page, "Scrat").innerText();

    await page.reload();
    await expect(botRow(page, "Scrat")).toBeVisible();
    await expect.poll(async () => (await catalogMarks(page)).length).toBe(1);
    const [second] = await catalogMarks(page);
    expect(second).toEqual({ bundleChars: 0, unchanged: 1 });
    // Then the live answer replaces the cached rows.
    await expect.poll(() => botRow(page, "Scrat").innerText()).not.toBe(cachedLabel);
  });
});
