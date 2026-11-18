import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  BOTS_PLUGIN_ID,
  COMPACT,
  SHOWCASE_PLUGIN_ID,
  WIDE,
  closeScreen,
  expectRowActive,
  footerItem,
  headerRow,
  installSidebarPlugins,
  popoverBox,
  runCommand,
  visibleTestId,
} from "../support/helpers/plugin-sidebar-items";
import { seedSidebarFooterPreferences } from "../support/helpers/sidebar-nav-settings";
import { seedWorkspace } from "../support/helpers/seed-client";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import { claudeAndCodexReports } from "../support/helpers/usage-sidebar-item";

/** Set PASEO_QA_SCREENSHOT_DIR to keep QA screenshots of each state. */
async function qaScreenshot(page: Page, name: string, area?: Locator) {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  // Let popover, sheet and drawer animations settle so the image shows the final state.
  await page.waitForTimeout(600);
  // Expo's fast-refresh indicator sits over the footer's Hosts icon.
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  const file = path.join(directory, `${name}.png`);
  if (area) await area.screenshot({ path: file });
  else await page.screenshot({ path: file });
}

/** Footer rows sit above the fixed bottom line, spanning it from Add project to Settings. */
async function expectFooterRow(page: Page, row: Locator) {
  // Polled: on compact the drawer is still sliding in when the row first shows.
  await expect
    .poll(async () => {
      const addProject = (await visibleTestId(page, "sidebar-add-project").boundingBox())!;
      const settings = (await visibleTestId(page, "sidebar-settings").boundingBox())!;
      const box = (await row.boundingBox())!;
      return {
        aboveBottomLine: box.y + box.height <= addProject.y,
        alignedLeft: Math.abs(box.x - addProject.x) < 1,
        alignedRight: Math.abs(box.x + box.width - (settings.x + settings.width)) < 1,
      };
    })
    .toEqual({ aboveBottomLine: true, alignedLeft: true, alignedRight: true });
}

function botRow(page: Page, rowId: string): Locator {
  return headerRow(page, BOTS_PLUGIN_ID, `bots-${rowId}`);
}

/** The open screen's header title; a pushed screen keeps the one below it mounted. */
function screenTitle(page: Page): Locator {
  return page.locator('[data-testid="plugin-surface-title"]:visible').last();
}

function sidebarFooter(page: Page): Locator {
  return visibleTestId(page, "sidebar-add-project").locator("xpath=..");
}

test.describe("Plugin sidebar items", () => {
  let workspaceId: string;
  let cleanup: () => Promise<void>;

  test.beforeEach(async () => {
    const workspace = await seedWorkspace({ repoPrefix: "plugin-sidebar-items-" });
    const plugins = await installSidebarPlugins();
    workspaceId = workspace.workspaceId;
    cleanup = async () => {
      await plugins.cleanup();
      await workspace.cleanup();
    };
  });

  test.afterEach(async () => {
    await cleanup();
  });

  test("a plugin's screen, header row, footer popover and command work together", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // The Usage item shows only with summary data, once it is turned on.
    await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
    await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
    await page.setViewportSize(WIDE);
    await gotoWorkspace(page, workspaceId);
    const row = headerRow(page, SHOWCASE_PLUGIN_ID, "deploys");
    const sync = footerItem(page, SHOWCASE_PLUGIN_ID, "sync");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(sync).toBeVisible();

    await test.step("a throwing item renders nothing and leaves the sidebar working", async () => {
      await expect(visibleTestId(page, `plugin-sidebar-${SHOWCASE_PLUGIN_ID}-broken`)).toHaveCount(
        0,
      );
      await expect(footerItem(page, SHOWCASE_PLUGIN_ID, "broken")).toHaveCount(0);
      await expect(page.getByText("Plugin failed", { exact: false })).toHaveCount(0);
      await expect(visibleTestId(page, "sidebar-settings")).toBeVisible();
    });

    await test.step("the header row highlights while its screen is open", async () => {
      await expectRowActive(row, false);
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/plugin/${SHOWCASE_PLUGIN_ID}/surface/deploys`));
      await expect(page.getByText("Deploys screen body", { exact: true })).toBeVisible();
      await expect(screenTitle(page)).toHaveText("Deploys");
      await expectRowActive(row, true);
      await qaScreenshot(page, "phase2-desktop-sidebar-screen");
      await closeScreen(page);
      await expectRowActive(row, false);
    });

    await test.step("the trailing button presses on its own", async () => {
      await page.getByRole("button", { name: "Refresh deploys", exact: true }).click();
      await expect(row).toHaveAccessibleName("Deploys (refreshed 1)");
      await expect(page).not.toHaveURL(/\/plugin\//);
      await expect(page.getByText("Deploys screen body", { exact: true })).toHaveCount(0);
    });

    await test.step("the footer row renders as a row above the bottom line", async () => {
      await expect(sync).toHaveAccessibleName("Sync");
      await expectFooterRow(page, sync);
      await expect(visibleTestId(page, "sidebar-usage")).toBeVisible();
      await qaScreenshot(page, "phase5-desktop-footer", sidebarFooter(page));
    });

    await test.step("the footer row opens a popover anchored to it", async () => {
      await sync.click();
      const popover = await popoverBox(page);
      const button = (await sync.boundingBox())!;
      await expect(page.getByText("Presentation: wide", { exact: true })).toBeVisible();
      expect(popover.y + popover.height).toBeLessThanOrEqual(button.y);
      expect(button.y - popover.y).toBeLessThan(300);
      expect(Math.abs(popover.x - button.x)).toBeLessThan(80);
      await qaScreenshot(page, "phase2-desktop-popover");
      await page.getByRole("button", { name: "Open deploys from popover", exact: true }).click();
      await expect(page.getByText("Deploys screen body", { exact: true })).toBeVisible();
      await expect(page.getByText("Sync details", { exact: true })).toHaveCount(0);
      await closeScreen(page);
    });

    await test.step("the command center item opens the screen", async () => {
      await runCommand(page, "Open deploys");
      await expect(page.getByText("Deploys screen body", { exact: true })).toBeVisible();
      await expectRowActive(row, true);
      await closeScreen(page);
    });

    await test.step("on a compact layout the popover is a bottom sheet", async () => {
      await page.setViewportSize(COMPACT);
      await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
      const compactSync = footerItem(page, SHOWCASE_PLUGIN_ID, "sync");
      await expect(compactSync).toBeInViewport();
      await expectFooterRow(page, compactSync);
      await expect(headerRow(page, SHOWCASE_PLUGIN_ID, "deploys")).toBeInViewport();
      await qaScreenshot(page, "phase2-compact-sidebar");
      await qaScreenshot(page, "phase5-compact-footer", sidebarFooter(page));
      await compactSync.click();
      await expect(page.getByText("Presentation: compact", { exact: true })).toBeVisible();
      const sheet = await popoverBox(page);
      expect(sheet.y).toBeGreaterThan(COMPACT.height / 2);
      await qaScreenshot(page, "phase2-compact-sheet");
      await page.getByRole("button", { name: "Close sync details", exact: true }).click();
      await expect(page.getByText("Sync details", { exact: true })).toHaveCount(0);
    });
  });

  test("a header row's shortcut hint presses the row", async ({ page }) => {
    await page.setViewportSize(WIDE);
    await gotoWorkspace(page, workspaceId);
    const newWorkspace = visibleTestId(page, "sidebar-global-new-workspace");
    await expect(newWorkspace).toBeVisible({ timeout: 30_000 });
    await newWorkspace.hover();
    const hint = page.getByText("Ctrl+N", { exact: true }).locator("visible=true");
    await expect(hint).toBeVisible();
    await qaScreenshot(page, "phase7-header-row-hint", newWorkspace.locator("xpath=../.."));
    await hint.click();
    await expect(page).toHaveURL(/\/new(\?|$)/);
  });

  test("a plugin adds and removes a footer item after setup", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(WIDE);
    await gotoWorkspace(page, workspaceId);
    await expect(botRow(page, "bot-1")).toBeVisible({ timeout: 30_000 });
    const alerts = footerItem(page, BOTS_PLUGIN_ID, "alerts");
    await expect(alerts).toHaveCount(0);

    await runCommand(page, "Add bot alerts");
    await expect(alerts).toBeVisible();
    await expect(alerts).toHaveAccessibleName("Bot alerts");
    await expectFooterRow(page, alerts);

    await runCommand(page, "Remove bot alerts");
    await expect(alerts).toHaveCount(0);
  });
});
