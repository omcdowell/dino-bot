import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineImage } from "@getpaseo/protocol/agent-types";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { encodeRgbaPng } from "../support/helpers/assistant-images";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";

const PROVIDER = "chat-images-pi";
const MODEL = "pi-image-model";
const SHOT_DIR = process.env.CHAT_IMAGES_SHOT_DIR;
// Real phone photos for screenshots and byte counts (not in the repo: megabytes). Without them the
// test sends a generated photo and the small HEIC fixture the server tests use.
const PHOTO_JPEG = process.env.CHAT_IMAGES_PHOTO_JPEG;
const PHOTO_HEIC =
  process.env.CHAT_IMAGES_PHOTO_HEIC ??
  path.resolve("../server/src/server/agent/chat-images/test-fixtures/landscape-160x120.heic");

// A gradient "photo" with a sun, so the thumbnail is recognisable in screenshots.
function photoPng(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const t = y / height;
      const sun = Math.hypot(x - width * 0.7, y - height * 0.45) < height * 0.16;
      data[i] = sun ? 255 : Math.round(40 + 200 * t);
      data[i + 1] = sun ? 220 : Math.round(60 + 80 * t);
      data[i + 2] = sun ? 120 : Math.round(140 - 60 * t);
      data[i + 3] = 255;
    }
  }
  return encodeRgbaPng(width, height, data);
}

// A "screenshot" of a chart: bars on white, like a page an agent reads.
function chartPng(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  const bars = [0.35, 0.6, 0.45, 0.8, 0.55, 0.9];
  const barWidth = width / (bars.length * 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const bar = Math.floor(x / (barWidth * 2));
      const inBar =
        x % (barWidth * 2) >= barWidth / 2 &&
        x % (barWidth * 2) < barWidth * 1.5 &&
        y > height * (1 - (bars[bar] ?? 0));
      data[i] = inBar ? 37 : 250;
      data[i + 1] = inBar ? 99 : 250;
      data[i + 2] = inBar ? 235 : 250;
      data[i + 3] = 255;
    }
  }
  return encodeRgbaPng(width, height, data);
}

interface ChatImagesSeed {
  agentId: string;
  workspaceId: string;
  photo: AgentTimelineImage;
  heic: AgentTimelineImage;
  cleanup: () => Promise<void>;
}

/** An agent with a tool-call image (chart), a photo with a caption, and a HEIC from a phone. */
async function seedChatImages(): Promise<ChatImagesSeed> {
  const workspace = await seedWorkspace({ repoPrefix: "chat-images-" });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "chat-images" });
  const cleanup = async () => {
    await client.close();
    await workspace.cleanup();
  };
  try {
    const chartPath = path.join(workspace.repoPath, "chart.png");
    await writeFile(chartPath, chartPng(960, 600));
    const agent = await client.createAgent({
      provider: PROVIDER,
      model: MODEL,
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Chat images",
    });
    await client.sendMessage(agent.id, `read ${chartPath}`);
    await client.waitForFinish(agent.id, 30_000);
    const photo = PHOTO_JPEG
      ? { data: (await readFile(PHOTO_JPEG)).toString("base64"), mimeType: "image/jpeg" }
      : { data: photoPng(1600, 1200).toString("base64"), mimeType: "image/png" };
    await client.sendMessage(agent.id, "Here is the view from the car", { images: [photo] });
    await client.waitForFinish(agent.id, 30_000);
    const heic = await readFile(PHOTO_HEIC);
    await client.sendMessage(agent.id, "And one straight off my phone", {
      images: [{ data: heic.toString("base64"), mimeType: "image/heic" }],
    });
    await client.waitForFinish(agent.id, 30_000);

    const timeline = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
    const refs = timeline.entries.flatMap((entry) =>
      entry.item.type === "user_message" ? (entry.item.images ?? []) : [],
    );
    expect(refs).toHaveLength(2);
    // Wait for the daemon to prepare both (placeholder + display image), and record the bytes
    // each step costs on the wire.
    const rows = [];
    for (const ref of refs) {
      const placeholder = await client.fetchAgentImageVariant(ref.id, "placeholder");
      const full = await client.fetchAgentImageVariant(ref.id, "full");
      rows.push({
        mimeType: ref.mimeType,
        size: `${ref.width}x${ref.height}`,
        referenceJsonBytes: JSON.stringify(ref).length,
        thumbhashBytes: Buffer.from(placeholder.thumbhash ?? "", "base64").byteLength,
        display: `${placeholder.width}x${placeholder.height}`,
        displayBytes: placeholder.byteSize,
        fullScreenMimeType: full.mimeType,
        fullScreenBytes: full.byteSize,
        originalBytes: ref.byteSize,
      });
    }
    if (SHOT_DIR) {
      await mkdir(SHOT_DIR, { recursive: true });
      await writeFile(path.join(SHOT_DIR, "bytes.json"), `${JSON.stringify(rows, null, 2)}\n`);
    }
    const [photoRef, heicRef] = refs as [AgentTimelineImage, AgentTimelineImage];
    return {
      agentId: agent.id,
      workspaceId: workspace.workspaceId,
      photo: { ...photoRef, display: { width: 0, height: 0, byteSize: rows[0]!.displayBytes! } },
      heic: { ...heicRef, display: { width: 0, height: 0, byteSize: rows[1]!.displayBytes! } },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** The browser plays a device that asks to save data (images wait for a tap) unless told not. */
async function openChat(page: Page, seed: ChatImagesSeed, options: { saveData: boolean }) {
  if (options.saveData) {
    await page.addInitScript(() => {
      const connection = (navigator as { connection?: object }).connection;
      if (connection) Object.defineProperty(connection, "saveData", { get: () => true });
    });
  }
  await openAgentRoute(page, { workspaceId: seed.workspaceId, agentId: seed.agentId });
  await expect(page.getByTestId("chat-image")).toHaveCount(3, { timeout: 30_000 });
}

function chatImage(page: Page, imageId: string) {
  return page.locator(`[data-testid="chat-image"][data-image="${imageId}"]`);
}

async function expectState(page: Page, imageId: string, state: string): Promise<void> {
  await expect(chatImage(page, imageId)).toHaveAttribute("data-state", state, {
    timeout: 30_000,
  });
}

async function waitForImagesShown(page: Page, selector: string): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .locator(selector)
          .evaluateAll(
            (images) =>
              images.length > 0 &&
              images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
          ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOT_DIR, name) });
}

/**
 * Slows the page's network (WebSockets included, Chrome 99+) so a download takes ~`seconds`
 * and the progress can be seen. Returns a function that lifts the limit.
 */
async function throttle(page: Page, bytes: number, seconds: number): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: Math.max(1024, Math.round(bytes / seconds)),
    uploadThroughput: -1,
  });
  return async () => {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await cdp.detach();
  };
}

/** Blurred → downloading (slowed down) → downloaded → opened full screen, for one image. */
async function walkImageStates(page: Page, image: AgentTimelineImage, prefix: string) {
  const tile = chatImage(page, image.id);
  await expectState(page, image.id, "idle");
  await expect(tile.getByTestId("chat-image-placeholder")).toBeVisible({ timeout: 30_000 });
  await expect(tile.getByTestId("chat-image-download")).toBeVisible();
  await tile.scrollIntoViewIfNeeded();
  await shot(page, `${prefix}-1-blurred.png`);

  const unthrottle = await throttle(page, image.display?.byteSize ?? 50_000, 8);
  await tile.click();
  // A display image of a few chunks shows partial progress; a tiny one goes 0% → done.
  const chunked = (image.display?.byteSize ?? 0) > 3 * 16 * 1024;
  await expect(tile.getByTestId("chat-image-progress")).toContainText(chunked ? /[1-9]\d?%/ : /%/, {
    timeout: 30_000,
  });
  await shot(page, `${prefix}-2-downloading.png`);
  await unthrottle();

  await expectState(page, image.id, "loaded");
  await waitForImagesShown(page, '[data-testid="chat-image-display"] img');
  await shot(page, `${prefix}-3-downloaded.png`);

  await tile.click();
  await expect(page.getByTestId("attachment-lightbox")).toBeVisible();
  // The full-size image replaces the display image in the lightbox (a JPEG for HEIC on web).
  await expect
    .poll(
      () =>
        page
          .getByTestId("attachment-lightbox")
          .locator("img")
          .evaluateAll((images) =>
            Math.max(0, ...images.map((element) => (element as HTMLImageElement).naturalWidth)),
          ),
      { timeout: 60_000 },
    )
    .toBe(image.width);
  await shot(page, `${prefix}-4-opened.png`);
  await page.getByTestId("attachment-lightbox-close").click();
}

// The daemon starts with only the fake pi: the built-in providers stay off, so it does not probe
// the real CLIs on this machine (a real `pi` probe alone is ~300 MB at the 3 GB cap).
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
        [PROVIDER]: {
          extends: "pi",
          label: "Pi images",
          description: "Pi images test provider",
          enabled: true,
          command: [process.execPath, path.resolve("e2e/fixtures/fake-pi-image-rpc.mjs")],
          models: [{ id: MODEL, label: "Pi image", description: "Reads images" }],
        },
      },
    },
  },
});

// One image walk per test, each in a fresh browser context: a fresh "device" with nothing cached,
// and a fresh renderer (one page holding every step's images and reloads went over the 3 GB cap).
// Also, Chrome does not throttle the page's WebSocket a second time after a lifted throttle, so
// each slowed-down download needs its own page.
test.describe("chat images", () => {
  let seed: ChatImagesSeed | null = null;
  test.afterEach(async () => {
    await seed?.cleanup();
    seed = null;
  });

  test("laptop: blurred until tapped, progress, display size, then full size", async ({ page }) => {
    test.setTimeout(150_000);
    seed = await seedChatImages();
    await page.setViewportSize({ width: 1280, height: 860 });
    await openChat(page, seed, { saveData: true });
    await walkImageStates(page, seed.heic, "laptop-heic");

    // Cached display images show at once after a reload, even on a save-data link.
    await page.reload({ waitUntil: "commit" });
    await expectState(page, seed.heic.id, "loaded");
    await expectState(page, seed.photo.id, "idle");
    await waitForImagesShown(page, '[data-testid="chat-image-display"] img');
    await shot(page, "laptop-after-reload.png");
  });

  test("phone: the same steps at phone width, for a HEIC", async ({ page }) => {
    test.setTimeout(150_000);
    seed = await seedChatImages();
    await page.setViewportSize({ width: 390, height: 844 });
    await openChat(page, seed, { saveData: true });
    await walkImageStates(page, seed.heic, "phone-heic");
  });

  test("phone: the same steps for a JPEG photo", async ({ page }) => {
    test.setTimeout(150_000);
    seed = await seedChatImages();
    await page.setViewportSize({ width: 390, height: 844 });
    await openChat(page, seed, { saveData: true });
    await walkImageStates(page, seed.photo, "phone-photo");
  });

  test("a good link downloads images by itself", async ({ page }) => {
    test.setTimeout(150_000);
    seed = await seedChatImages();
    await page.setViewportSize({ width: 390, height: 844 });
    await openChat(page, seed, { saveData: false });
    await expect(page.locator('[data-testid="chat-image"][data-state="loaded"]')).toHaveCount(3, {
      timeout: 30_000,
    });
    await waitForImagesShown(page, '[data-testid="chat-image-display"] img');
    await shot(page, "phone-auto-downloaded.png");
    // The image a bot read (pi `read` on a PNG), under its tool call.
    await page.getByTestId("tool-call-images").scrollIntoViewIfNeeded();
    await shot(page, "phone-tool-call-image.png");
    await page.setViewportSize({ width: 1280, height: 860 });
    await shot(page, "laptop-auto-downloaded.png");
  });
});
