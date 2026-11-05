import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Page, WebSocketRoute } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { encodeRgbaPng } from "../support/helpers/assistant-images";
import { attachImageFromMenu, submitMessageWithButton } from "../support/helpers/composer";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";

/**
 * The device that sent a photo shows its own copy: at once, no blur, and nothing comes back down
 * (no placeholder, display or original request). The photo goes up once, also on a slow uplink.
 * Byte counts and screenshots go to SENT_IMAGE_SHOT_DIR.
 */

const PROVIDER = "sent-image-pi";
const MODEL = "pi-image-model";
const SHOT_DIR = process.env.SENT_IMAGE_SHOT_DIR ?? process.env.CHAT_IMAGES_SHOT_DIR;
const SENT_IMAGES_STORAGE_KEY = "paseo-sent-chat-images";

// A gradient "photo" with a sun and some noise, so it is recognisable and does not compress to
// nothing (a phone photo is incompressible too).
function photoPng(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  let seed = 7;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const t = y / height;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = (seed >> 16) % 24;
      const sun = Math.hypot(x - width * 0.7, y - height * 0.45) < height * 0.16;
      data[i] = sun ? 255 : Math.round(40 + 190 * t) + noise;
      data[i + 1] = sun ? 220 : Math.round(60 + 80 * t) + noise;
      data[i + 2] = sun ? 120 : Math.round(140 - 60 * t) + noise;
      data[i + 3] = 255;
    }
  }
  return encodeRgbaPng(width, height, data);
}

const PHOTO = { name: "view.png", mimeType: "image/png", buffer: photoPng(1200, 900) };

interface WireCounts {
  upBytes: number;
  downBytes: number;
  /** send_agent_message_request frames that carried image bytes. */
  imageUploads: number;
  imageUploadBytes: number;
  /** agent.image.thumbnail.request frames (placeholder / display / full), by variant. */
  imageVariantRequests: Record<string, number>;
  /** file_explorer_request reads of a chat image (display image or original). */
  imageFileReads: number;
  /** Binary frames from the daemon (file transfer chunks of the display image or original). */
  binaryDownFrames: number;
  binaryDownBytes: number;
  byType: Record<string, { up: number; down: number; upBytes: number; downBytes: number }>;
  /** Socket closes seen by the meter: which side closed, and why. */
  closes: Array<{ by: "app" | "daemon"; code: number | undefined; reason: string | undefined }>;
}

function emptyCounts(): WireCounts {
  return {
    upBytes: 0,
    downBytes: 0,
    imageUploads: 0,
    imageUploadBytes: 0,
    imageVariantRequests: {},
    imageFileReads: 0,
    binaryDownFrames: 0,
    binaryDownBytes: 0,
    byType: {},
    closes: [],
  };
}

function sendAfter(delayMs: number, send: () => void): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      send();
      resolve();
    }, delayMs);
  });
}

function frameBytes(message: string | Buffer): number {
  return typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
}

function parseFrame(message: string | Buffer): Record<string, unknown> | null {
  if (typeof message !== "string") return null;
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    const inner = parsed.message;
    return parsed.type === "session" && inner && typeof inner === "object"
      ? (inner as Record<string, unknown>)
      : parsed;
  } catch {
    return null;
  }
}

/**
 * Counts every daemon WebSocket frame by type. The meter takes the JSON frame compression out of
 * the hello (and the checked uplink out of server_info), so every frame can be read; images are
 * already compressed, so their byte counts are the real ones.
 */
async function installWireMeter(page: Page) {
  let counts = emptyCounts();
  // A slow uplink: frames reach the daemon in order, each after its bytes at this rate. (CDP
  // throttling does not apply here: routed sockets do not go through the browser's network stack.)
  let uplinkBytesPerSecond: number | null = null;
  let uplink: Promise<void> = Promise.resolve();
  const bump = (type: string, direction: "up" | "down", bytes: number) => {
    const row = (counts.byType[type] ??= { up: 0, down: 0, upBytes: 0, downBytes: 0 });
    row[direction] += 1;
    row[direction === "up" ? "upBytes" : "downBytes"] += bytes;
  };
  const onUp = (message: string | Buffer) => {
    const bytes = frameBytes(message);
    counts.upBytes += bytes;
    const frame = parseFrame(message);
    const type = typeof frame?.type === "string" ? frame.type : "binary";
    bump(type, "up", bytes);
    if (type === "send_agent_message_request") {
      const images = Array.isArray(frame?.images) ? (frame.images as Array<{ data?: string }>) : [];
      if (images.length > 0) {
        counts.imageUploads += 1;
        counts.imageUploadBytes += images.reduce(
          (sum, image) => sum + (image.data?.length ?? 0),
          0,
        );
      }
    }
    if (type === "agent.image.thumbnail.request") {
      const variant = typeof frame?.variant === "string" ? frame.variant : "thumbnail";
      counts.imageVariantRequests[variant] = (counts.imageVariantRequests[variant] ?? 0) + 1;
    }
    if (type === "file_explorer_request" && String(frame?.path ?? "").includes("chat-images")) {
      counts.imageFileReads += 1;
    }
  };
  const onDown = (message: string | Buffer) => {
    const bytes = frameBytes(message);
    counts.downBytes += bytes;
    if (typeof message !== "string") {
      counts.binaryDownFrames += 1;
      counts.binaryDownBytes += bytes;
      bump("binary", "down", bytes);
      return;
    }
    const frame = parseFrame(message);
    bump(typeof frame?.type === "string" ? frame.type : "unknown", "down", bytes);
  };

  const queueUplink = (bytes: number, send: () => void) => {
    const rate = uplinkBytesPerSecond;
    if (rate === null) {
      send();
      return;
    }
    const delayMs = (bytes / rate) * 1000;
    uplink = uplink.then(() => sendAfter(delayMs, send));
  };

  await page.routeWebSocket(daemonWsRoutePattern(), (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      let outgoing = message;
      const frame = parseFrame(message);
      if (frame?.type === "hello" && frame.capabilities && typeof frame.capabilities === "object") {
        const capabilities = frame.capabilities as Record<string, unknown>;
        delete capabilities.compressed_frames;
        delete capabilities.checked_frames;
        delete capabilities.zstd_frames;
        outgoing = JSON.stringify(
          JSON.parse(message as string).type === "session"
            ? { type: "session", message: frame }
            : frame,
        );
      }
      onUp(outgoing);
      queueUplink(frameBytes(outgoing), () => server.send(outgoing));
    });
    ws.onClose((code, reason) => {
      counts.closes.push({ by: "app", code, reason });
      void server.close({ code, reason });
    });
    server.onClose((code, reason) => {
      counts.closes.push({ by: "daemon", code, reason });
      void ws.close({ code, reason });
    });
    server.onMessage((message) => {
      let incoming = message;
      const frame = parseFrame(message);
      const payload = frame?.payload as { status?: unknown; features?: Record<string, unknown> };
      if (frame?.type === "status" && payload?.status === "server_info" && payload.features) {
        payload.features.checkedUplink = false;
        const envelope = JSON.parse(message as string) as Record<string, unknown>;
        incoming = JSON.stringify(
          envelope.type === "session" ? { ...envelope, message: frame } : frame,
        );
      }
      onDown(incoming);
      ws.send(incoming);
    });
  });

  return {
    setUplinkRate(bytesPerSecond: number | null): void {
      uplinkBytesPerSecond = bytesPerSecond;
    },
    take(): WireCounts {
      const taken = counts;
      counts = emptyCounts();
      return taken;
    },
  };
}

interface SentImageSeed {
  agentId: string;
  workspaceId: string;
  cleanup: () => Promise<void>;
}

async function seedAgent(): Promise<SentImageSeed> {
  const workspace = await seedWorkspace({ repoPrefix: "sent-image-" });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "sent-image" });
  const cleanup = async () => {
    await client.close();
    await workspace.cleanup();
  };
  try {
    const agent = await client.createAgent({
      provider: PROVIDER,
      model: MODEL,
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Sent image",
    });
    await client.sendMessage(agent.id, "Hello");
    await client.waitForFinish(agent.id, 30_000);
    return { agentId: agent.id, workspaceId: workspace.workspaceId, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function useSaveData(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const connection = (navigator as { connection?: object }).connection;
    if (connection) Object.defineProperty(connection, "saveData", { get: () => true });
  });
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return;
  await mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name) });
}

async function writeBytes(name: string, value: unknown): Promise<void> {
  if (!SHOT_DIR) return;
  await mkdir(SHOT_DIR, { recursive: true });
  await writeFile(path.join(SHOT_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
}

/** Sends the photo with a caption from the composer; returns the daemon's image id. */
async function sendPhoto(page: Page, caption: string): Promise<string> {
  await attachImageFromMenu(page, PHOTO);
  await expect(page.getByTestId("composer-image-attachment-pill").first()).toBeVisible({
    timeout: 10_000,
  });
  await submitMessageWithButton(page, caption);
  const tile = page.locator('[data-testid="chat-image"][data-image]');
  await expect(tile).toHaveCount(1, { timeout: 120_000 });
  const imageId = await tile.getAttribute("data-image");
  if (!imageId) throw new Error("chat image without an id");
  return imageId;
}

function sentTile(page: Page, imageId: string) {
  return page.locator(`[data-testid="chat-image"][data-image="${imageId}"]`);
}

async function expectShownFromLocalCopy(page: Page, imageId: string): Promise<void> {
  const tile = sentTile(page, imageId);
  await expect(tile).toHaveAttribute("data-state", "loaded", { timeout: 30_000 });
  await expect
    .poll(
      () =>
        tile
          .locator('[data-testid="chat-image-display"] img')
          .evaluateAll(
            (images) =>
              images.length > 0 &&
              images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
          ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** Lets any image fetch the app would start (auto download, placeholder) happen. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(4_000);
}

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

test.describe("own sent image", () => {
  let seed: SentImageSeed | null = null;
  test.afterEach(async () => {
    await seed?.cleanup();
    seed = null;
  });

  test("good link: shown from the local copy, uploaded once, no thumb/original request, also after a restart", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    seed = await seedAgent();
    const meter = await installWireMeter(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentRoute(page, { workspaceId: seed.workspaceId, agentId: seed.agentId });
    await expect(page.getByText("Hello").first()).toBeVisible({ timeout: 30_000 });
    meter.take();

    const imageId = await sendPhoto(page, "Here is the view from the car");
    const firstState = await sentTile(page, imageId).getAttribute("data-state");
    await settle(page);
    await sentTile(page, imageId).scrollIntoViewIfNeeded();
    await shot(page, "good-link-1-after-send.png");
    const send = meter.take();

    await page.reload({ waitUntil: "commit" });
    await expect(sentTile(page, imageId)).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await sentTile(page, imageId).scrollIntoViewIfNeeded();
    await shot(page, "good-link-2-after-restart.png");
    const restart = meter.take();

    await writeBytes("good-link-bytes.json", {
      photoBytes: PHOTO.buffer.byteLength,
      imageId,
      firstStateSeen: firstState,
      send,
      restart,
    });

    expect(send.imageUploads).toBe(1);
    await expectShownFromLocalCopy(page, imageId);
    expect(send.imageVariantRequests).toEqual({});
    expect(send.imageFileReads).toBe(0);
    expect(restart.imageVariantRequests).toEqual({});
    expect(restart.imageFileReads).toBe(0);
    expect(restart.imageUploads).toBe(0);
  });

  test("save-data link: no blur on the own image; once the local copy is gone it falls back to blur and tap", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    seed = await seedAgent();
    const meter = await installWireMeter(page);
    await useSaveData(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentRoute(page, { workspaceId: seed.workspaceId, agentId: seed.agentId });
    await expect(page.getByText("Hello").first()).toBeVisible({ timeout: 30_000 });
    meter.take();

    const imageId = await sendPhoto(page, "Here is the view from the car");
    await settle(page);
    await sentTile(page, imageId).scrollIntoViewIfNeeded();
    await shot(page, "save-data-1-after-send.png");
    const send = meter.take();
    const placeholderShown = await sentTile(page, imageId)
      .getByTestId("chat-image-placeholder")
      .count();
    const stateAfterSend = await sentTile(page, imageId).getAttribute("data-state");

    // The local copy is gone (cache evicted, reinstall): the normal blur/tap path comes back.
    await page.evaluate((key) => localStorage.removeItem(key), SENT_IMAGES_STORAGE_KEY);
    await page.reload({ waitUntil: "commit" });
    await expect(sentTile(page, imageId)).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await sentTile(page, imageId).scrollIntoViewIfNeeded();
    await shot(page, "save-data-2-local-copy-gone.png");
    const gone = meter.take();
    const stateWhenGone = await sentTile(page, imageId).getAttribute("data-state");

    await writeBytes("save-data-bytes.json", {
      photoBytes: PHOTO.buffer.byteLength,
      imageId,
      afterSend: { state: stateAfterSend, placeholderShown, wire: send },
      localCopyGone: { state: stateWhenGone, wire: gone },
    });

    expect(send.imageUploads).toBe(1);
    expect(stateAfterSend).toBe("loaded");
    expect(placeholderShown).toBe(0);
    expect(send.imageVariantRequests).toEqual({});
    expect(send.imageFileReads).toBe(0);
    expect(stateWhenGone).toBe("idle");
    await expect(sentTile(page, imageId).getByTestId("chat-image-download")).toBeVisible();
  });

  test("slow uplink: the photo goes up once even when its upload outlasts the liveness check", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    seed = await seedAgent();
    const meter = await installWireMeter(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentRoute(page, { workspaceId: seed.workspaceId, agentId: seed.agentId });
    await expect(page.getByText("Hello").first()).toBeVisible({ timeout: 30_000 });
    meter.take();

    // Base64 is 4/3 of the photo; the upload takes ~35 s, past the client's liveness check (two
    // missed pongs, ~22 s) but inside the daemon's 45 s socket lease (this meter hands the daemon the
    // whole frame at the end, so the daemon sees no bytes meanwhile; a real link trickles them in).
    // The 60 s request timeout is covered by the client unit test.
    const uploadSeconds = 35;
    const uploadBytesPerSecond = Math.round((PHOTO.buffer.byteLength * 4) / 3 / uploadSeconds);
    meter.setUplinkRate(uploadBytesPerSecond);
    const startedAt = Date.now();
    let imageId: string | null = null;
    let send: WireCounts | null = null;
    try {
      imageId = await sendPhoto(page, "Slow uplink photo");
    } finally {
      const tookMs = Date.now() - startedAt;
      // Anything still queued on the slow link (a second copy of the photo) arrives meanwhile.
      await page.waitForTimeout(5_000);
      meter.setUplinkRate(null);
      await settle(page);
      await shot(page, "slow-uplink-after-send.png");
      send = meter.take();
      await writeBytes("slow-uplink-bytes.json", {
        photoBytes: PHOTO.buffer.byteLength,
        uploadBytesPerSecond,
        tookMs,
        imageId,
        reconnects: send.byType.hello?.up ?? 0,
        send,
      });
    }

    expect(send?.byType.hello?.up ?? 0).toBe(0);
    expect(send?.imageUploads).toBe(1);
    expect(send?.imageVariantRequests).toEqual({});
  });
});
