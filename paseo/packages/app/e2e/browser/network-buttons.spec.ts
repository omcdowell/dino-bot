import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { ensureExplorerSidebar } from "../support/helpers/workspace-tabs";

/**
 * The Network page's "Run tests" / "Copy report" buttons are `size="sm"`. On wide layouts their
 * icons must be the sm button icon size (14 px) in the button's text colour, like every other
 * sm button, not lucide's 24 px default. The phone keeps its current 24 px look on purpose.
 * Measurements and screenshots go to E2E_SHOT_DIR when set.
 */
const SHOT_DIR = process.env.E2E_SHOT_DIR;
const SM_ICON = 14;
const SM_HEIGHT = 32;
const PHONE_ICON = 24;

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

async function measure(page: Page) {
  const result: Record<string, unknown> = {};
  for (const id of ["network-run-tests", "network-copy-report"]) {
    const button = page.getByTestId(id).filter({ visible: true }).first();
    await expect(button).toBeVisible({ timeout: 30_000 });
    result[id] = await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const svg = element.querySelector("svg")?.getBoundingClientRect();
      const text = Array.from(element.querySelectorAll("div")).find(
        (node) => node.childElementCount === 0 && node.textContent,
      );
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        iconWidth: svg ? Math.round(svg.width) : null,
        iconHeight: svg ? Math.round(svg.height) : null,
        fontSize: text ? getComputedStyle(text).fontSize : null,
        textColor: text ? getComputedStyle(text).color : null,
        iconColor: element.querySelector("svg")?.getAttribute("stroke") ?? null,
        padding: getComputedStyle(element).padding,
      };
    });
  }
  return result as Record<
    string,
    {
      height: number;
      iconWidth: number | null;
      iconHeight: number | null;
      textColor: string | null;
      iconColor: string | null;
    }
  >;
}

async function record(page: Page, name: string, value: unknown): Promise<void> {
  if (!SHOT_DIR) return;
  await mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
  await writeFile(path.join(SHOT_DIR, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function expectButtons(sizes: Awaited<ReturnType<typeof measure>>, icon: number): void {
  for (const size of Object.values(sizes)) {
    expect(size.iconWidth).toBe(icon);
    expect(size.iconHeight).toBe(icon);
    expect(size.height).toBe(SM_HEIGHT);
  }
}

test("desktop Explorer Network tab uses sm button icons", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const workspace = await seedWorkspace({ repoPrefix: "network-buttons-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    const explorer = await ensureExplorerSidebar(page);
    await explorer.getByRole("button", { name: "New tab", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Network/ }).click();
    await expect(explorer.getByTestId("network-status")).toBeVisible({ timeout: 30_000 });
    const sizes = await measure(page);
    await record(page, "desktop-explorer-network", sizes);
    expectButtons(sizes, SM_ICON);
    for (const size of Object.values(sizes)) {
      expect(
        await page.evaluate((c) => {
          const probe = document.createElement("div");
          probe.style.color = c ?? "";
          document.body.append(probe);
          const resolved = getComputedStyle(probe).color;
          probe.remove();
          return resolved;
        }, size.iconColor),
      ).toBe(size.textColor);
    }
  } finally {
    await workspace.cleanup();
  }
});

test("phone Network page keeps its current icons", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/network");
  const sizes = await measure(page);
  await record(page, "phone-network", sizes);
  expectButtons(sizes, PHONE_ICON);
});
