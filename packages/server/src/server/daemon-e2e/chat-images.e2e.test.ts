import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { PNG } from "pngjs";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

let ctx: DaemonTestContext;
let cwd: string;

function pngBase64(width: number, height: number): string {
  const png = new PNG({ width, height });
  png.data.fill(180);
  return PNG.sync.write(png).toString("base64");
}

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "chat-images-"));
});

afterEach(async () => {
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 60_000);

// #4556: the image a message was sent with must survive in the canonical timeline row, so a
// reload or another device can show it. The row carries a reference, never the bytes.
test("a sent image is in the timeline by reference, with a thumbnail and the original", async () => {
  expect(ctx.client.getLastServerInfoMessage()?.features?.chatImages).toBe(true);
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "images" });
  const data = pngBase64(900, 600);

  await ctx.client.sendMessage(agent.id, "look at this", {
    images: [{ data, mimeType: "image/png" }],
  });
  await ctx.client.waitForFinish(agent.id, 30_000);

  const timeline = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
  const row = timeline.entries
    .map((entry) => entry.item)
    .find((item) => item.type === "user_message" && item.text === "look at this");
  expect(row).toMatchObject({
    images: [{ mimeType: "image/png", width: 900, height: 600, byteSize: expect.any(Number) }],
  });
  expect(JSON.stringify(timeline)).not.toContain(data.slice(0, 64));
  const image = row?.type === "user_message" ? row.images?.[0] : undefined;
  if (!image) throw new Error("missing image reference");

  const thumbnail = await ctx.client.fetchAgentImageThumbnail(image.id, { maxEdge: 160 });
  expect(thumbnail).toMatchObject({ mimeType: "image/jpeg", width: 160, height: 107 });
  expect(Buffer.from(thumbnail.data, "base64").byteLength).toBeLessThan(6 * 1024);

  const original = await ctx.client.readFile(path.dirname(image.source), image.source);
  expect(Buffer.from(original.bytes)).toEqual(readFileSync(image.source));
  expect(Buffer.from(original.bytes).toString("base64")).toBe(data);

  await expect(ctx.client.fetchAgentImageThumbnail("../../etc/passwd")).rejects.toThrow(
    "Image not found",
  );
}, 60_000);

// Update 1: a HEIC photo gets a ThumbHash placeholder and its display size on the reference, a
// chat-width JPEG to download with progress, and a full-size JPEG for clients that can't show HEIC.
test("a sent HEIC gets a placeholder, a display JPEG and a full-size JPEG", async () => {
  const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "heic" });
  const heic = readFileSync(
    path.join(import.meta.dirname, "../agent/chat-images/test-fixtures/landscape-160x120.heic"),
  );

  await ctx.client.sendMessage(agent.id, "a heic", {
    images: [{ data: heic.toString("base64"), mimeType: "image/heic" }],
  });
  await ctx.client.waitForFinish(agent.id, 30_000);

  const findRow = async () => {
    const timeline = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
    const row = timeline.entries
      .map((entry) => entry.item)
      .find((item) => item.type === "user_message" && item.text === "a heic");
    return row?.type === "user_message" ? row.images?.[0] : undefined;
  };
  const image = await findRow();
  if (!image) throw new Error("missing image reference");
  expect(image).toMatchObject({ mimeType: "image/heic", width: 160, height: 120 });

  const placeholder = await ctx.client.fetchAgentImageVariant(image.id, "placeholder");
  expect(placeholder.thumbhash).toMatch(/^[A-Za-z0-9+/=]+$/);
  expect(Buffer.from(placeholder.thumbhash!, "base64").byteLength).toBeLessThan(40);
  expect(placeholder).toMatchObject({ mimeType: "image/jpeg", width: 160, height: 120 });

  // Prepared images are carried on the reference itself: no request for the placeholder.
  expect(await findRow()).toMatchObject({
    thumbhash: placeholder.thumbhash,
    display: { width: 160, height: 120, byteSize: placeholder.byteSize },
  });

  const display = await ctx.client.fetchAgentImageVariant(image.id, "display");
  expect(display.path).toBeTruthy();
  const progress: number[] = [];
  const bytes = await ctx.client.readFile(
    path.dirname(display.path!),
    display.path!,
    undefined,
    0,
    {
      chunkBytes: 1024,
      onProgress: (received) => progress.push(received),
    },
  );
  expect(bytes.bytes.byteLength).toBe(display.byteSize);
  expect(Buffer.from(bytes.bytes).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  // The daemon honours small chunks (8 KB minimum), so a slow link shows progress.
  expect(progress[0]).toBe(0);
  expect(progress.at(-1)).toBe(display.byteSize);

  const full = await ctx.client.fetchAgentImageVariant(image.id, "full");
  expect(full).toMatchObject({ mimeType: "image/jpeg", width: 160, height: 120 });
  const asHeic = await ctx.client.fetchAgentImageVariant(image.id, "full", { acceptsHeic: true });
  expect(asHeic).toMatchObject({ mimeType: "image/heic", path: image.source });
}, 60_000);
