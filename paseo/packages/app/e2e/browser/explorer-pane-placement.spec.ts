// Locks two behaviours that used to break together on web/desktop:
// 1) with the explorer pane focused, a newly appearing agent must auto-open into the
//    MAIN pane in the background — the explorer pane is a background surface and must
//    never swallow entity tabs or lose the user's focus, and
// 2) splitting a tab out of a pane leaves a New tab behind, and the app must stay
//    interactive in the [agent | New | explorer] state.
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedCorruptedWorkspaceLayout } from "../support/helpers/workspace-layout";
import {
  openChangesTreePanel,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";

function visible(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

function agentTabChip(page: Page, agentId: string): Locator {
  return visible(page, `workspace-tab-agent_${agentId}`);
}

function draftTabChip(page: Page): Locator {
  return page.locator('[data-testid^="workspace-tab-draft_"]').filter({ visible: true });
}

/** Scope the shared tab row to the Explorer dock. */
function explorerTabRow(page: Page): Locator {
  return visible(page, "workspace-explorer-sidebar").getByTestId("workspace-tabs-row");
}

function mainTabRow(page: Page): Locator {
  return page
    .locator('[data-testid^="workspace-pane-"]')
    .getByTestId("workspace-tabs-row")
    .filter({ visible: true });
}

async function selectExplorerChanges(page: Page): Promise<void> {
  await openChangesTreePanel(page);
  await expect(visible(page, "changes-tree-panel").first()).toBeVisible();
}

async function closeSeededDraftInMainPane(page: Page): Promise<void> {
  const chip = draftTabChip(page).first();
  await chip.hover();
  await page
    .locator('[data-testid^="workspace-draft-close-"]')
    .filter({ visible: true })
    .first()
    .click();
  await expect(draftTabChip(page)).toHaveCount(0, { timeout: 15_000 });
}

function newTabPaneChild(page: Page): Locator {
  return page
    .getByTestId("split-group-child")
    .filter({ has: page.getByTestId("workspace-new-tab-panel") })
    .first();
}

async function emptyPaneBox(page: Page) {
  const paneChild = newTabPaneChild(page);
  await expect(paneChild).toBeVisible({ timeout: 15_000 });
  const box = await paneChild.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("New tab pane has no bounding box");
  return box;
}

async function paneBoxContainingChip(page: Page, chip: Locator) {
  const paneChild = page.getByTestId("split-group-child").filter({ has: chip }).first();
  await expect(paneChild).toBeVisible({ timeout: 15_000 });
  const box = await paneChild.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Pane has no bounding box");
  return box;
}

/** dnd-kit pointer drag from a tab chip to an absolute point. */
async function dragChipTo(
  page: Page,
  chip: Locator,
  target: { x: number; y: number },
): Promise<void> {
  const chipBox = await chip.boundingBox();
  expect(chipBox).not.toBeNull();
  if (!chipBox) throw new Error("Dragged chip has no bounding box");

  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
  await page.mouse.down();
  // Exceed the 8px PointerSensor activation distance before heading to the target.
  await page.mouse.move(chipBox.x + chipBox.width / 2 + 12, chipBox.y + chipBox.height / 2 + 4);
  await page.mouse.move(target.x, target.y, { steps: 20 });
  await page.mouse.up();
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));
  return errors;
}

test.describe("explorer pane tab placement", () => {});

async function closeOnlyDraft(page: Page): Promise<void> {
  await draftTabChip(page).hover();
  await page.getByRole("button", { name: "Close", exact: true }).click();
}

async function moveOnlyDraftIntoRightSplit(page: Page): Promise<void> {
  await mainTabRow(page).getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Split pane right/ }).click();
  const target = await emptyPaneBox(page);
  await dragChipTo(page, draftTabChip(page), {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  });
  await expect(mainTabRow(page)).toHaveCount(1);
}

async function expectNewLauncher(page: Page): Promise<void> {
  await expect(
    page.getByTestId("workspace-new-tab-panel").getByRole("button", { name: "Agent", exact: true }),
  ).toBeVisible();
  await expect(draftTabChip(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveCount(0);
  await expect(page.getByText("Paseo ran into a problem.", { exact: true })).toHaveCount(0);
}

async function openAgentDraftFromLauncher(page: Page): Promise<void> {
  await expectNewLauncher(page);
  await page
    .getByTestId("workspace-new-tab-panel")
    .getByRole("button", { name: "Agent", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible();
}

// Explorer cannot replace the ordinary workspace canvas, including on restore.
test("closing the last split-born tab with hidden Explorer keeps a usable workspace", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "last-pane-hidden-explorer-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await openAgentDraftFromLauncher(page);
  await closeOnlyDraft(page);
  await expectNewLauncher(page);
  await openAgentDraftFromLauncher(page);
  await moveOnlyDraftIntoRightSplit(page);
  await closeOnlyDraft(page);
  await expectNewLauncher(page);
  await page.reload();
  await expectNewLauncher(page);
});

test("visible Explorer does not replace the last ordinary workspace pane", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "last-pane-visible-explorer-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await page.getByRole("button", { name: "Open Explorer sidebar", exact: true }).click();
  await openAgentDraftFromLauncher(page);
  await moveOnlyDraftIntoRightSplit(page);
  await closeOnlyDraft(page);
  await expectNewLauncher(page);
  await page.reload();
  await expectNewLauncher(page);
});

test("reloading a saved hidden generated Explorer recovers a usable workspace", async ({
  page,
  withWorkspace,
}) => {
  const otherWorkspace = await withWorkspace({ prefix: "uncorrupted-explorer-" });
  await gotoWorkspace(page, otherWorkspace.workspaceId);
  await openAgentDraftFromLauncher(page);

  const workspace = await withWorkspace({ prefix: "saved-hidden-explorer-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await expectNewLauncher(page);
  await seedCorruptedWorkspaceLayout(page, workspace.workspaceId);
  await page.reload();
  await expectNewLauncher(page);
  await gotoWorkspace(page, otherWorkspace.workspaceId);
  await expect(draftTabChip(page)).toHaveCount(1);
});
