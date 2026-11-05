import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

import { readImageHeader } from "./image-header.js";
import {
  ChatImageStore,
  DISPLAY_MAX_WIDTH,
  isChatImageId,
  snapThumbnailEdge,
  storeChatImages,
} from "./store.js";

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "test-fixtures");
const landscapeHeic = () => fs.readFileSync(path.join(FIXTURES, "landscape-160x120.heic"));
const portraitHeic = () => fs.readFileSync(path.join(FIXTURES, "portrait-irot-120x160.heic"));

function solidPng(width: number, height: number, alpha = 255): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = 200;
    png.data[i * 4 + 1] = 30;
    png.data[i * 4 + 2] = 30;
    png.data[i * 4 + 3] = alpha;
  }
  return PNG.sync.write(png);
}

// Noise: a photo-like PNG that is much larger than its JPEG.
function noisyPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  let seed = 7;
  for (let i = 0; i < png.data.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    png.data[i] = i % 4 === 3 ? 255 : seed & 0xff;
  }
  return PNG.sync.write(png);
}

function solidJpeg(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4, 128);
  return Buffer.from(jpeg.encode({ width, height, data }, 80).data);
}

/** Inserts an EXIF APP1 segment with the given orientation after SOI. */
function withOrientation(jpegBytes: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpegBytes.subarray(0, 2), segment, payload, jpegBytes.subarray(2)]);
}

describe("readImageHeader", () => {
  test("reads PNG, JPEG, GIF and WebP sizes", () => {
    expect(readImageHeader(solidPng(30, 20))).toMatchObject({
      format: "png",
      width: 30,
      height: 20,
    });
    expect(readImageHeader(solidJpeg(40, 10))).toMatchObject({
      format: "jpeg",
      width: 40,
      height: 10,
      orientation: 1,
    });
    const gif = Buffer.from("GIF89a\x05\x00\x07\x00\x00\x00\x00", "latin1");
    expect(readImageHeader(gif)).toMatchObject({ format: "gif", width: 5, height: 7 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBPVP8X", 8, "latin1");
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    expect(readImageHeader(webp)).toMatchObject({ format: "webp", width: 100, height: 50 });
  });

  test("reads HEIC sizes, with the irot rotation applied", () => {
    expect(readImageHeader(landscapeHeic())).toMatchObject({
      format: "heic",
      mimeType: "image/heic",
      width: 160,
      height: 120,
      orientation: 1,
    });
    expect(readImageHeader(portraitHeic())).toMatchObject({ width: 120, height: 160 });
  });

  test("swaps the display size for rotated JPEGs", () => {
    const header = readImageHeader(withOrientation(solidJpeg(40, 10), 6));
    expect(header).toMatchObject({ orientation: 6, pixelWidth: 40, width: 10, height: 40 });
  });

  test("returns null for non-images", () => {
    expect(readImageHeader(Buffer.from("hello world, not an image at all"))).toBeNull();
  });
});

describe("ChatImageStore", () => {
  let directory: string;
  let store: ChatImageStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-image-store-"));
    store = new ChatImageStore(directory, { prepareInBackground: false });
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("stores an image once, by content, and returns a reference without bytes", () => {
    const png = solidPng(64, 32);
    const first = store.put({ data: png.toString("base64"), mimeType: "image/png" });
    const second = store.put({
      data: `data:image/png;base64,${png.toString("base64")}`,
      fileName: "shot.png",
    });
    expect(first).toMatchObject({
      mimeType: "image/png",
      byteSize: png.byteLength,
      width: 64,
      height: 32,
    });
    expect(isChatImageId(first!.id)).toBe(true);
    expect(second).toMatchObject({ id: first!.id, source: first!.source, fileName: "shot.png" });
    expect(JSON.stringify(first)).not.toContain(png.toString("base64").slice(0, 40));
    expect(fs.readdirSync(directory).filter((name) => !name.startsWith("."))).toHaveLength(1);
    expect(fs.readFileSync(first!.source)).toEqual(png);
  });

  test("sniffs the real format over the declared MIME type", () => {
    const image = store.put({ data: solidJpeg(8, 8).toString("base64"), mimeType: "image/png" });
    expect(image?.mimeType).toBe("image/jpeg");
    expect(image?.source.endsWith(".jpg")).toBe(true);
  });

  test("resolves only well-formed known ids", () => {
    const image = store.put({ data: solidPng(4, 4).toString("base64"), mimeType: "image/png" })!;
    expect(store.resolve(image.id)).toBe(image.source);
    expect(store.resolve("../etc/passwd")).toBeNull();
    expect(store.resolve("a".repeat(64))).toBeNull();
    expect(new ChatImageStore(directory).resolve(image.id)).toBe(image.source);
  });

  test("makes a small JPEG thumbnail of a large PNG and caches it", async () => {
    const image = store.put({
      data: solidPng(1200, 600, 0).toString("base64"),
      mimeType: "image/png",
    })!;
    const thumbnail = await store.thumbnail(image.id, 320);
    expect(thumbnail).toMatchObject({ mimeType: "image/jpeg", width: 320, height: 160 });
    expect(thumbnail.bytes.byteLength).toBeLessThan(8 * 1024);
    // Transparent pixels are composited over white.
    const decoded = jpeg.decode(thumbnail.bytes, { useTArray: true });
    expect(decoded.data[0]).toBeGreaterThan(240);
    expect(fs.existsSync(path.join(directory, "thumbs", `${image.id}-320.jpg`))).toBe(true);
    const again = await store.thumbnail(image.id, 300);
    expect(again.bytes).toEqual(thumbnail.bytes);
  });

  test("applies EXIF orientation to the thumbnail", async () => {
    const image = store.put({
      data: withOrientation(solidJpeg(400, 100), 6).toString("base64"),
      mimeType: "image/jpeg",
    })!;
    expect(image).toMatchObject({ width: 100, height: 400 });
    const thumbnail = await store.thumbnail(image.id, 160);
    expect(thumbnail).toMatchObject({ width: 40, height: 160 });
  });

  test("passes small GIFs through and rejects unknown ids", async () => {
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const image = store.put({ data: gif.toString("base64"), mimeType: "image/gif" })!;
    const thumbnail = await store.thumbnail(image.id);
    expect(thumbnail).toMatchObject({ mimeType: "image/gif", width: 1, height: 1 });
    await expect(store.thumbnail("b".repeat(64))).rejects.toThrow("Image not found");
  });

  test("storeChatImages skips undecodable blocks without throwing", () => {
    const images = storeChatImages(
      [
        { data: "", mimeType: "image/png" },
        { data: solidPng(2, 2).toString("base64"), mimeType: "image/png" },
      ],
      store,
    );
    expect(images).toHaveLength(1);
  });

  test("snaps requested edges to the cached sizes", () => {
    expect(snapThumbnailEdge(undefined)).toBe(320);
    expect(snapThumbnailEdge(100)).toBe(160);
    expect(snapThumbnailEdge(161)).toBe(320);
    expect(snapThumbnailEdge(5000)).toBe(640);
  });
});

describe("ChatImageStore preparation (placeholder and display image)", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-image-prepare-"));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("makes a ThumbHash and a chat-width JPEG once, and later puts carry them", async () => {
    const store = new ChatImageStore(directory, { prepareInBackground: false });
    const png = noisyPng(2400, 1200);
    const image = store.put({ data: png.toString("base64"), mimeType: "image/png" })!;
    expect(image.thumbhash).toBeUndefined();
    const prepared = await store.prepare(image.id);
    expect(prepared.thumbhash).toMatch(/^[A-Za-z0-9+/=]{20,60}$/);
    expect(prepared.display).toMatchObject({
      mimeType: "image/jpeg",
      width: DISPLAY_MAX_WIDTH,
      height: DISPLAY_MAX_WIDTH / 2,
    });
    const display = fs.readFileSync(prepared.display.path);
    expect(display.byteLength).toBe(prepared.display.byteSize);
    expect(jpeg.decode(display, { useTArray: true }).width).toBe(DISPLAY_MAX_WIDTH);
    // A restart (new store) reads the sidecar: the reference has everything at once.
    const again = new ChatImageStore(directory).put({
      data: png.toString("base64"),
      mimeType: "image/png",
    })!;
    expect(again).toMatchObject({
      thumbhash: prepared.thumbhash,
      display: { width: DISPLAY_MAX_WIDTH, height: DISPLAY_MAX_WIDTH / 2 },
    });
  });

  test("sends a flat PNG as is when it is smaller than its JPEG", async () => {
    const store = new ChatImageStore(directory, { prepareInBackground: false });
    const image = store.put({
      data: solidPng(2400, 1200).toString("base64"),
      mimeType: "image/png",
    })!;
    const prepared = await store.prepare(image.id);
    expect(prepared.display).toMatchObject({ path: image.source, width: 2400, height: 1200 });
    expect(
      fs.readdirSync(path.join(directory, "thumbs")).filter((n) => n.endsWith(".jpg")),
    ).toEqual([]);
  });

  test("keeps a small upright PNG as its own display image", async () => {
    const store = new ChatImageStore(directory, { prepareInBackground: false });
    const image = store.put({
      data: solidPng(300, 200).toString("base64"),
      mimeType: "image/png",
    })!;
    const prepared = await store.prepare(image.id);
    expect(prepared.display).toMatchObject({ path: image.source, mimeType: "image/png" });
    expect(prepared.thumbhash).toBeTruthy();
  });

  test("patches references handed out before preparation finished", async () => {
    const store = new ChatImageStore(directory);
    const image = store.put({
      data: solidJpeg(1600, 1200).toString("base64"),
      mimeType: "image/jpeg",
    })!;
    expect(image.thumbhash).toBeUndefined();
    await store.prepare(image.id);
    expect(image.thumbhash).toBeTruthy();
    expect(image.display).toMatchObject({ width: DISPLAY_MAX_WIDTH, height: 810 });
  });

  test("decodes HEIC: placeholder, display JPEG, JPEG for full screen unless HEIC is accepted", async () => {
    const store = new ChatImageStore(directory, { prepareInBackground: false });
    const heic = landscapeHeic();
    const image = store.put({ data: heic.toString("base64"), mimeType: "image/heic" })!;
    expect(image).toMatchObject({ mimeType: "image/heic", width: 160, height: 120 });
    expect(image.source.endsWith(".heic")).toBe(true);
    const prepared = await store.prepare(image.id);
    expect(prepared.thumbhash).toBeTruthy();
    expect(prepared.display).toMatchObject({ mimeType: "image/jpeg", width: 160, height: 120 });
    const decoded = jpeg.decode(fs.readFileSync(prepared.display.path), { useTArray: true });
    expect([decoded.width, decoded.height]).toEqual([160, 120]);
    // A real photo, not a blank decode: the sky in the fixture is blue-ish, not black.
    expect(decoded.data[2]).toBeGreaterThan(60);

    const full = await store.full(image.id);
    expect(full).toMatchObject({ mimeType: "image/jpeg", width: 160, height: 120 });
    expect(full.path).not.toBe(image.source);
    expect(await store.full(image.id, { acceptsHeic: true })).toMatchObject({
      path: image.source,
      mimeType: "image/heic",
    });
    const thumbnail = await store.thumbnail(image.id, 160);
    expect(thumbnail).toMatchObject({ mimeType: "image/jpeg", width: 160, height: 120 });
  });

  test("rotates a HEIC with an irot box like the phone shows it", async () => {
    const store = new ChatImageStore(directory, { prepareInBackground: false });
    const image = store.put({ data: portraitHeic().toString("base64"), mimeType: "image/heic" })!;
    expect(image).toMatchObject({ width: 120, height: 160 });
    const prepared = await store.prepare(image.id);
    expect(prepared.display).toMatchObject({ width: 120, height: 160 });
  });
});
