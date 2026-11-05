import { randomUUID } from "node:crypto";
import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { renameModalInput, renameModalSubmit } from "../support/helpers/rename";
import type { SeedDaemonClient } from "../support/helpers/seed-client";
import path from "node:path";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function fetchAgentTitle(client: SeedDaemonClient, agentId: string): Promise<string | null> {
  const result = await client.fetchAgents({ scope: "active" });
  return result.entries.find((entry) => entry.agent.id === agentId)?.agent.title ?? null;
}

async function shot(page: import("@playwright/test").Page, name: string): Promise<void> {
  const dir = process.env.E2E_SHOT_DIR;
  if (dir) await page.screenshot({ path: path.join(dir, name) });
}

/**
 * Compact "sessions dropdown" rename path. The desktop rename specs drive the right-click
 * `workspace-tab-context-*` menu, which portals into overlay-root and was never broken. This
 * exercises the tab switcher's per-session actions on a phone-sized viewport — the path that
 * regressed when the actions menu presented as a popover instead of a bottom sheet.
 */
test.describe("Workspace session rename (compact tab switcher)", () => {
  test("renames an agent session from the switcher's per-session actions sheet", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.setViewportSize(MOBILE_VIEWPORT);
    const initialTitle = `switcher-rename-${randomUUID().slice(0, 8)}`;
    const session = await seedMockAgentWorkspace({
      repoPrefix: "workspace-switcher-rename-",
      title: initialTitle,
    });

    try {
      await openAgentRoute(page, session);
      await expect(page.getByTestId("workspace-tab-switcher-trigger")).toBeVisible({
        timeout: 30_000,
      });

      // The phone header floats: no tab row, the tab you are on is the name pill.
      await expect(page.getByTestId("workspace-tabs-row")).toHaveCount(0);
      await expect(page.getByTestId("workspace-floating-header")).toBeVisible();
      await expect(
        page.getByTestId("workspace-header-controls-pill").getByTestId("workspace-explorer-toggle"),
      ).toBeVisible();
      // The name pill is the sheet's only opener: no ⋯ button beside it.
      await expect(page.getByTestId("workspace-header-menu-trigger")).toHaveCount(0);
      await shot(page, "web-header.png");

      // The name pill opens the ⋯ sheet, whose Tabs group lists the sessions.
      await page.getByRole("button", { name: /Switch tabs/ }).click();
      await expect(page.getByRole("button", { name: "Bottom sheet backdrop" }).first()).toBeVisible(
        {
          timeout: 10_000,
        },
      );
      await expect(page.getByTestId("workspace-header-tabs-label")).toBeVisible();
      await expect(page.getByTestId(`workspace-header-tab-agent_${session.agentId}`)).toBeVisible();
      await shot(page, "web-menu.png");

      // Open this session's "…" actions. Before the fix this tried to open a popover-Modal
      // that never surfaced over the sheet on native; it now opens as a stacked sheet.
      const menuBase = `workspace-tab-menu-agent_${session.agentId}`;
      const actionsTrigger = page.getByTestId(`${menuBase}-trigger`);
      await expect(actionsTrigger).toBeVisible({ timeout: 15_000 });
      await actionsTrigger.click();

      const renameItem = page.getByTestId(`${menuBase}-rename`);
      await expect(renameItem).toBeVisible({ timeout: 10_000 });
      await renameItem.click();

      const modalPrefix = `workspace-tab-rename-modal-agent-${session.agentId}`;
      const input = renameModalInput(page, modalPrefix);
      await expect(input).toBeVisible({ timeout: 10_000 });
      await expect(input).toHaveValue(initialTitle);

      const renamed = "Renamed from the dropdown";
      await input.fill(renamed);
      await renameModalSubmit(page, modalPrefix).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      // The title pill shows the workspace; the renamed tab is listed in the ⋯ sheet.
      const tabRow = page.getByTestId(`workspace-header-tab-agent_${session.agentId}`);
      if (!(await tabRow.isVisible())) {
        await page.getByRole("button", { name: /Switch tabs/ }).click();
      }
      await expect(tabRow).toContainText(renamed, { timeout: 15_000 });
      await expect.poll(() => fetchAgentTitle(session.client, session.agentId)).toBe(renamed);
    } finally {
      await session.cleanup();
    }
  });
});
