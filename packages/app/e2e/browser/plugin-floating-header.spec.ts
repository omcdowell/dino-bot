import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { COMPACT, WIDE, visibleTestId } from "../support/helpers/plugin-sidebar-items";
import { getServerId } from "../support/helpers/server-id";

// Sam 2026-10-13: "i want the header and swipe animation implemented for group chats". A plugin
// screen registered with `mobileFloatingHeader` gets the bot chat's floating header on phones.
// (The slide over the phone home is native only; see navigation/mobile-home-stack.test.ts.)

const PLUGIN_ID = "floating-demo";

const SOURCE = `import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

let taps = 0;
const listeners = new Set();
function tap() {
  taps += 1;
  for (const listener of listeners) listener(taps);
}

function Avatar({ theme }) {
  return <View testID="demo-avatar" style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.accent }} />;
}

function Controls({ theme }) {
  return (
    <Pressable testID="demo-info" accessibilityRole="button" accessibilityLabel="Group info" onPress={tap}
      style={{ width: 40, height: 36, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: theme.colors.foreground }}>i</Text>
    </Pressable>
  );
}

function Thread({ theme, floatingHeaderInset }) {
  const [count, setCount] = React.useState(taps);
  React.useEffect(() => {
    listeners.add(setCount);
    return () => listeners.delete(setCount);
  }, []);
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text testID="demo-first-line" style={{ color: theme.colors.foreground }}>First line of the thread</Text>
      <Text testID="demo-inset" style={{ color: theme.colors.foregroundMuted }}>
        {"inset: " + (floatingHeaderInset === undefined ? "none" : String(floatingHeaderInset))}
      </Text>
      <Text testID="demo-taps" style={{ color: theme.colors.foregroundMuted }}>{"Info taps: " + count}</Text>
      {Array.from({ length: 30 }, (_, index) => (
        <Text key={index} style={{ color: theme.colors.foreground }}>{"Message " + (index + 1)}</Text>
      ))}
    </ScrollView>
  );
}

export default function contribute(client) {
  client.addScreen({
    id: "thread",
    title: (params) => params.name ?? "Thread",
    Component: Thread,
    mobileFloatingHeader: { Avatar, Controls },
  });
  return () => {};
}
`;

async function installFloatingDemo() {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const config = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), `paseo-${PLUGIN_ID}-`));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), SOURCE);
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(directory);
  return async () => {
    await client.removePlugin(PLUGIN_ID);
    await client.patchDaemonConfig({ pluginsEnabled: config.config.pluginsEnabled });
    await client.close();
    await rm(directory, { recursive: true, force: true });
  };
}

async function openThread(page: Page) {
  const host = encodeURIComponent(getServerId());
  await page.goto(`/h/${host}/plugin/${PLUGIN_ID}/surface/thread?param.name=Alarm%20Clock`);
  await expect(visibleTestId(page, "demo-first-line")).toBeVisible({ timeout: 30_000 });
}

async function shot(page: Page, name: string) {
  const directory = process.env.E2E_SHOT_DIR;
  if (!directory) return;
  await page.waitForTimeout(400);
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

test.describe("Plugin screen floating header", () => {
  let cleanup: () => Promise<void>;

  test.beforeEach(async () => {
    cleanup = await installFloatingDemo();
  });

  test.afterEach(async () => {
    await cleanup();
  });

  test("on a phone the screen gets the chat's floating header over its content", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(COMPACT);
    await openThread(page);

    await expect(visibleTestId(page, "workspace-floating-header")).toBeVisible();
    await expect(visibleTestId(page, "plugin-floating-title-text")).toHaveText("Alarm Clock");
    await expect(visibleTestId(page, "demo-avatar")).toBeVisible();
    await expect(page.locator('[data-testid="plugin-surface-close"]:visible')).toHaveCount(0);

    // The content starts below the floating controls and is told how much they cover.
    const inset = Number(
      ((await visibleTestId(page, "demo-inset").textContent()) ?? "").replace("inset: ", ""),
    );
    expect(inset).toBeGreaterThan(44);
    const title = (await visibleTestId(page, "plugin-floating-title").boundingBox())!;
    const firstLine = (await visibleTestId(page, "demo-first-line").boundingBox())!;
    expect(firstLine.y).toBeGreaterThanOrEqual(title.y + title.height);
    await shot(page, "floating-header-compact");

    // The plugin's controls work from the header.
    await visibleTestId(page, "demo-info").click();
    await expect(visibleTestId(page, "demo-taps")).toHaveText("Info taps: 1");
  });

  test("on a wide layout the screen keeps the header bar", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(WIDE);
    await openThread(page);

    await expect(visibleTestId(page, "plugin-surface-title")).toHaveText("Alarm Clock");
    await expect(visibleTestId(page, "plugin-surface-close")).toBeVisible();
    await expect(page.locator('[data-testid="workspace-floating-header"]:visible')).toHaveCount(0);
    await expect(visibleTestId(page, "demo-inset")).toHaveText("inset: none");
    await shot(page, "floating-header-wide");
  });
});
