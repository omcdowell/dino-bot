import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UsageReport } from "@getpaseo/protocol/messages";
import type { Page } from "@playwright/test";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { pluginRequirements } from "./plugin-fixture";

/** A real store-backed plugin on the worker's isolated daemon. */
type LoginReports = Array<{ harness: string; report: UsageReport }>;

export async function installLoginUsage(initialReport: UsageReport | LoginReports) {
  const directory = await mkdtemp(path.join(tmpdir(), "usage-login-journey-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const store = path.join(directory, "report.json");
  const setReport = (report: UsageReport | LoginReports) =>
    writeFile(store, JSON.stringify(report));
  const cleanup = async () => {
    try {
      await client.removePlugin("login-journey");
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    await setReport(initialReport);
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "login-journey", requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
import {readFile} from "node:fs/promises";
import {z} from "zod";
export default function contribute(server) {
  const read = async () => {
    const value = JSON.parse(await readFile(${JSON.stringify(store)}, "utf8"));
    return Array.isArray(value) ? value : [{harness: "Claude", report: value}];
  };
  server.registerUsageSource({id: "login-journey", label: "Claude", input: z.object({index: z.number()}),
    discover: async () => (await read()).map((login, index) => ({key: "account", harness: login.harness, input: {index}})),
    fetch: async ({index}) => (await read())[index].report,
  });
  return () => {};
}`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installPluginSource({ source: directory });
    return { setReport, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function refreshLoginUsage(page: Page) {
  await page.getByRole("button", { name: "Refresh Claude", exact: true }).click();
}

export async function hoverUsageWindow(page: Page, window: string) {
  await page
    .getByRole("checkbox", { name: new RegExp(`^Pin Claude ${window}, `) })
    .getByTestId(/usage-pin-glyph-/)
    .hover();
}
