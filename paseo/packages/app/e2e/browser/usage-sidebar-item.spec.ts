import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { gotoWorkspace, waitForTabBar } from "../support/helpers/launcher";
import {
  connectNewWorkspaceDaemonClient,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import { expectFooterSeparator } from "../support/helpers/sidebar-nav-settings";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import {
  claudeAndCodexReports,
  closeUsage,
  closeUsageFromBackdrop,
  expectNoUsageItem,
  expectPinnedUsage,
  expectSummaryInSidebar,
  expectUnpinnableRows,
  openCompactSidebar,
  openUsageFromIcon,
  openUsageFromItem,
  pinRow,
  scrollUsage,
  setSummaryInSidebar,
  togglePin,
  usageItem,
  usageModal,
  installTallUsageSource,
} from "../support/helpers/usage-sidebar-item";
import { seedSidebarFooterPreferences } from "../support/helpers/sidebar-nav-settings";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import { createTempGitRepo } from "../support/helpers/workspace";

const WIDE = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };

type ScreenshotArea = { kind: "page" } | { kind: "footer" } | { kind: "element"; locator: Locator };

/** Set PASEO_QA_SCREENSHOT_DIR to keep QA screenshots of each state. */
async function qaScreenshot(page: Page, name: string, area: ScreenshotArea = { kind: "page" }) {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  // Let sheet and drawer animations settle so the image shows the final state.
  await page.waitForTimeout(600);
  // Expo's fast-refresh indicator sits over the footer's Hosts icon.
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  const file = path.join(directory, `${name}.png`);
  if (area.kind === "element") {
    await area.locator.screenshot({ path: file });
    return;
  }
  const clip = area.kind === "footer" ? await footerClip(page) : undefined;
  await page.screenshot({ path: file, clip });
}

/** Includes summary rows above the fixed icon row. */
async function footerClip(page: Page) {
  return (await page.locator('[data-testid="sidebar-footer"]:visible').boundingBox())!;
}

test.describe("Usage item", () => {
  test("both compact footer entry points open Usage as a sheet", async ({ page }) => {
    await page.setViewportSize(COMPACT);
    await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
    await seedSidebarFooterPreferences(page, [{ key: "usage", visible: false }]);
    await gotoAppShell(page);
    await openCompactSidebar(page);
    const startingUrl = page.url();
    await expectNoUsageItem(page);

    await test.step("the icon opens a sheet without leaving the current screen", async () => {
      await openUsageFromIcon(page);
      await expect(usageModal(page).getByText("Claude", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(startingUrl);
      await qaScreenshot(page, "compact-usage-icon-sheet");
      await setSummaryInSidebar(page, true);
      await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
      await closeUsageFromBackdrop(page);
    });

    await test.step("the summary opens the same sheet", async () => {
      await openUsageFromItem(page);
      await expect(usageModal(page).getByText("Codex", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(startingUrl);
      await qaScreenshot(page, "compact-usage-summary-sheet");
      await closeUsageFromBackdrop(page);
    });
  });

  test("on desktop Usage opens as a dialog over the workspace and closes back to it", async ({
    page,
  }) => {
    const repo = await createTempGitRepo("usage-modal-");
    const client = await connectNewWorkspaceDaemonClient();
    try {
      const project = await openProjectViaDaemon(client, repo.path);
      await page.setViewportSize(WIDE);
      await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
      await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
      await gotoWorkspace(page, project.workspaceId);
      const workspaceUrl = page.url();

      await test.step("the summary opens a dialog over the workspace", async () => {
        await openUsageFromItem(page);
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("Claude", { exact: true })).toBeVisible();
        await expect(
          dialog.getByRole("button", { name: "Refresh all", exact: true }),
        ).toBeVisible();
        await expect(page).toHaveURL(workspaceUrl);
        await qaScreenshot(page, "desktop-usage-dialog");
      });

      await test.step("Close returns to the same workspace", async () => {
        await closeUsage(page);
        await expect(page).toHaveURL(workspaceUrl);
        await waitForTabBar(page);
      });

      await test.step("the icon opens it again, and Escape closes it", async () => {
        await openUsageFromIcon(page);
        await page.keyboard.press("Escape");
        await expect(usageModal(page)).toHaveCount(0);
        await expect(page).toHaveURL(workspaceUrl);
      });
    } finally {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });

  const layouts = {
    desktop: { viewport: WIDE, showSidebar: async (_page: Page) => {} },
    compact: { viewport: COMPACT, showSidebar: openCompactSidebar },
  };
  for (const [size, { viewport, showSidebar }] of Object.entries(layouts)) {
    test(`long usage reports scroll to the final window on ${size}`, async ({ page }) => {
      test.setTimeout(120_000);
      const source = await installTallUsageSource();
      try {
        await page.setViewportSize(viewport);
        await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
        await gotoAppShell(page);
        await showSidebar(page);
        await expect(usageItem(page)).toBeInViewport();
        await openUsageFromItem(page);
        const content = usageModal(page);
        await expect(content.getByText("Window 20", { exact: true })).toHaveCount(1);
        await waitForSettledPosition(content);
        await expect(content.getByText("Window 20", { exact: true })).not.toBeInViewport();
        await qaScreenshot(page, `${size}-usage-scroll-top`);
        await scrollUsage(page, 5_000);
        await expect(content.getByText("Window 20", { exact: true })).toBeInViewport();
        await qaScreenshot(page, `${size}-usage-scroll-bottom`);
        await scrollUsage(page, -5_000);
        await expect(content.getByText("Window 20", { exact: true })).not.toBeInViewport();
      } finally {
        await source.cleanup();
      }
    });
  }
});

test("without summary data the footer drops the Usage item and keeps the Usage icon", async ({
  page,
}) => {
  await installUsageReportsFixture(page, {
    lists: [
      [
        {
          id: "alpha:a",
          account: {},
          fetchedAt: new Date().toISOString(),
          sourceId: "alpha",
          sourceLabel: "Alpha plan",
          report: {
            status: "unavailable",
            problem: { kind: "no_quota", detail: "No active coding plan" },
          },
        },
      ],
    ],
  });
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  await expect(page.locator('[data-testid="sidebar-usage-icon"]:visible')).toBeVisible({
    timeout: 30_000,
  });
  await expectNoUsageItem(page);
  await expectFooterSeparator(page, false);
  await qaScreenshot(page, "desktop-footer-no-summary", { kind: "footer" });
  await openUsageFromIcon(page);
});

test("the Usage Settings switch turns on the sidebar summary and the pins with it", async ({
  page,
}) => {
  const serverId = getServerId();
  await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  const screen = page.getByTestId(`usage-host-${serverId}`);
  const claude = screen.getByTestId("usage-report-claude:default");

  await test.step("off by default: no Usage item, and rows that do not pin", async () => {
    await openUsageFromIcon(page);
    await expectNoUsageItem(page);
    await expect(claude.getByText("Session", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expectUnpinnableRows(claude);
    await expectUnpinnableRows(screen.getByTestId("usage-report-codex:default"));
    await expectSummaryInSidebar(page, false);
    await qaScreenshot(page, "usage-summary-off");
  });

  await test.step("on: the Usage item and the pins appear", async () => {
    await setSummaryInSidebar(page, true);
    await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
    await expect(pinRow(screen, "Claude", "Weekly")).toBeChecked();
    await togglePin(screen, "Claude", "Weekly");
    await expectPinnedUsage(page, ["31% 5h", "7% 5h", "12% wk"]);
    await qaScreenshot(page, "usage-summary-on");
  });

  await test.step("off then on again, after a reload, brings back the saved pins", async () => {
    await setSummaryInSidebar(page, false);
    await expectNoUsageItem(page);
    await expectUnpinnableRows(claude);
    await page.reload();
    await openUsageFromIcon(page);
    await expectSummaryInSidebar(page, false);
    await expect(claude.getByText("Session", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expectUnpinnableRows(claude);
    await setSummaryInSidebar(page, true);
    await expectPinnedUsage(page, ["31% 5h", "7% 5h", "12% wk"]);
    await expect(pinRow(screen, "Claude", "Session")).toBeChecked();
    await expect(pinRow(screen, "Claude", "Weekly")).not.toBeChecked();
  });
});

test("released hosts supply source logos through the client conversion", async ({ page }) => {
  await installUsageReportsFixture(page, {
    lists: [() => claudeAndCodexReports()],
    providerUsageListOnly: true,
  });
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
  // Source logos are decorative SVGs with no accessible role. Their path data distinguishes
  // the source artwork from the fallback gauge.
  const claudePath = /<path[^>]* d="([^"]+)"/.exec(claudeAndCodexReports()[0]!.icon!)![1]!;
  const codexPath = /<path[^>]* d="([^"]+)"/.exec(claudeAndCodexReports()[1]!.icon!)![1]!;
  const summary = usageItem(page).getByTestId("sidebar-usage-source");
  await expect(summary.nth(0).locator("svg path").first()).toHaveAttribute("d", claudePath);
  await expect(summary.nth(1).locator("svg path").first()).toHaveAttribute("d", codexPath);
  await qaScreenshot(page, "released-host-footer", { kind: "footer" });
  await openUsageFromItem(page);
  const screen = page.getByTestId(`usage-host-${getServerId()}`);
  await expect(
    screen.getByTestId("usage-report-claude").locator("svg path").first(),
  ).toHaveAttribute("d", claudePath);
  await expect(
    screen.getByTestId("usage-report-codex").locator("svg path").first(),
  ).toHaveAttribute("d", codexPath);
  await qaScreenshot(page, "released-host-usage-modal");
});
