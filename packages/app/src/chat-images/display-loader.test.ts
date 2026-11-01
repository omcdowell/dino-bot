import { describe, expect, it, vi } from "vitest";
import type { ThumbnailDiskStore } from "./thumbnail-disk-types";
import {
  bytesToBase64,
  createChatImageDisplayLoader,
  type FetchDisplayImage,
} from "./display-loader";
import { shouldAutoDownloadImages } from "./network-policy";
import { chatImageFrameSize, CHAT_IMAGE_MAX_WIDTH } from "./sizing";
import { planThumbnailEviction, ThumbnailMemoryCache } from "./thumbnail-memory";

vi.mock("./thumbnail-disk", () => ({ thumbnailDiskStore: { read: vi.fn(), write: vi.fn() } }));
vi.mock("@/runtime/network-monitor", () => ({ useNetworkMonitorStore: vi.fn() }));

function memoryDisk(): ThumbnailDiskStore & { keys: () => string[] } {
  const files = new Map<string, string>();
  return {
    keys: () => [...files.keys()],
    async read(key) {
      const data = files.get(key);
      return data ? { uri: `disk:${key}`, bytes: 1 } : null;
    },
    async write(key, image) {
      files.set(key, image.data);
      return { uri: `disk:${key}`, bytes: 1 };
    },
  };
}

const display = { data: "anBlZw==", mimeType: "image/jpeg", width: 1080, height: 810 };

describe("chat image display loader", () => {
  it("downloads once with progress for every tile, then serves memory and disk", async () => {
    const disk = memoryDisk();
    const fetch = vi.fn<FetchDisplayImage>(async (onProgress) => {
      onProgress(0, 100);
      onProgress(50, 100);
      onProgress(100, 100);
      return display;
    });
    const loader = createChatImageDisplayLoader({ disk, memoryBytes: 1024 });
    const first: number[] = [];
    const second: number[] = [];
    const [a, b] = await Promise.all([
      loader.load({ serverId: "s", imageId: "img", fetch, onProgress: (r) => first.push(r) }),
      loader.load({ serverId: "s", imageId: "img", fetch, onProgress: (r) => second.push(r) }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(first).toEqual([0, 50, 100]);
    expect(second).toEqual([0, 50, 100]);
    expect(loader.peek("s", "img")?.uri).toBe(a.uri);

    const cold = createChatImageDisplayLoader({ disk, memoryBytes: 1024 });
    expect(cold.peek("s", "img")).toBeUndefined();
    expect((await cold.cached("s", "img"))?.uri).toMatch(/^disk:/);
    expect(await cold.cached("s", "other")).toBeNull();
    await cold.load({ serverId: "s", imageId: "img", fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("downloads at most two images at a time", async () => {
    let active = 0;
    let peak = 0;
    const fetch: FetchDisplayImage = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return display;
    };
    const loader = createChatImageDisplayLoader({ disk: memoryDisk(), memoryBytes: 1024 });
    await Promise.all(
      ["1", "2", "3", "4", "5"].map((id) => loader.load({ serverId: "s", imageId: id, fetch })),
    );
    expect(peak).toBe(2);
  });

  it("does not cache a failed download", async () => {
    const loader = createChatImageDisplayLoader({ disk: memoryDisk(), memoryBytes: 1024 });
    const failing = vi.fn<FetchDisplayImage>(async () => {
      throw new Error("offline");
    });
    await expect(loader.load({ serverId: "s", imageId: "x", fetch: failing })).rejects.toThrow();
    const ok = vi.fn<FetchDisplayImage>(async () => display);
    await loader.load({ serverId: "s", imageId: "x", fetch: ok });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("encodes bytes as base64 without Buffer", () => {
    expect(bytesToBase64(new Uint8Array([0, 1, 2, 250, 255]))).toBe("AAEC+v8=");
    const big = new Uint8Array(100_000).fill(65);
    expect(atob(bytesToBase64(big))).toHaveLength(100_000);
  });
});

describe("chat image auto-download", () => {
  const good = { isConnected: true, isExpensive: false };
  it("downloads on a good, unmetered link only", () => {
    expect(shouldAutoDownloadImages({ constrained: false, phone: null, saveData: false })).toBe(
      true,
    );
    expect(shouldAutoDownloadImages({ constrained: false, phone: good, saveData: false })).toBe(
      true,
    );
    expect(shouldAutoDownloadImages({ constrained: true, phone: good, saveData: false })).toBe(
      false,
    );
    expect(
      shouldAutoDownloadImages({
        constrained: false,
        phone: { isConnected: true, isExpensive: true },
        saveData: false,
      }),
    ).toBe(false);
    expect(shouldAutoDownloadImages({ constrained: false, phone: good, saveData: true })).toBe(
      false,
    );
  });
});

describe("chat image frame", () => {
  it("keeps the photo's aspect ratio, capped on wide screens and for tall images", () => {
    expect(chatImageFrameSize({ width: 4032, height: 3024 }, { height: 900 })).toEqual({
      aspectRatio: 4032 / 3024,
      maxWidth: CHAT_IMAGE_MAX_WIDTH,
    });
    const portrait = chatImageFrameSize({ width: 3024, height: 4032 }, { height: 900 });
    expect(portrait.aspectRatio).toBeCloseTo(0.75);
    expect(portrait.maxWidth).toBe(Math.round(540 * 0.75));
    expect(chatImageFrameSize({}, { height: 900 }).aspectRatio).toBeCloseTo(4 / 3);
  });
});

describe("thumbnail memory", () => {
  it("evicts least recently used entries past the byte budget", () => {
    const cache = new ThumbnailMemoryCache(10);
    cache.set("a", { uri: "a", width: 1, height: 1, bytes: 4 });
    cache.set("b", { uri: "b", width: 1, height: 1, bytes: 4 });
    cache.get("a");
    cache.set("c", { uri: "c", width: 1, height: 1, bytes: 4 });
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.bytes).toBe(8);
  });

  it("plans disk eviction oldest first down to the budget", () => {
    expect(
      planThumbnailEviction(
        [
          { name: "new", bytes: 5, modifiedAt: 3 },
          { name: "old", bytes: 5, modifiedAt: 1 },
          { name: "mid", bytes: 5, modifiedAt: 2 },
        ],
        10,
      ),
    ).toEqual(["old"]);
    expect(planThumbnailEviction([{ name: "a", bytes: 1, modifiedAt: 1 }], 10)).toEqual([]);
  });
});
