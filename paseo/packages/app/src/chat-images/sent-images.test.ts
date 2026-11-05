import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import { chatImageIdForBase64, decodeImageBase64 } from "./image-hash";
import { sha256Js } from "./sha256";
import {
  collectSentChatImageAttachmentIds,
  flushSentChatImages,
  forgetSentChatImage,
  hydrateSentChatImages,
  rememberSentChatImage,
  resetSentChatImagesForTests,
  SENT_CHAT_IMAGES_STORAGE_KEY,
  touchSentChatImage,
  useSentChatImagesStore,
} from "./sent-images";

function bytes(length: number, seed = 1): Buffer {
  return Buffer.from(Array.from({ length }, (_, i) => (i * 31 + seed * 17) % 256));
}

function nodeSha(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function attachment(id: string, byteSize: number): AttachmentMetadata {
  return {
    id,
    mimeType: "image/jpeg",
    storageType: "native-file",
    storageKey: `/cache/${id}.jpg`,
    byteSize,
    createdAt: 1,
  };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: vi.fn(async (key: string) => data.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

describe("image ids", () => {
  it("plain SHA-256 matches node for lengths around the block edges", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const data = bytes(length, length);
      expect(Buffer.from(sha256Js(data)).toString("hex")).toBe(nodeSha(data));
    }
  });

  it("is the daemon's id: sha256 of the decoded base64, also from a data URL", async () => {
    const photo = bytes(4099);
    const base64 = photo.toString("base64");
    expect(Buffer.from(decodeImageBase64(base64)).equals(photo)).toBe(true);
    expect(await chatImageIdForBase64(base64)).toBe(nodeSha(photo));
    expect(await chatImageIdForBase64(`data:image/jpeg;base64,${base64}`)).toBe(nodeSha(photo));
  });
});

describe("sent chat images", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
    resetSentChatImagesForTests({ storage, maxBytes: 10_000 });
  });

  it("lists a sent photo under its daemon id and keeps its file from the GC", async () => {
    const photo = bytes(3000);
    const id = await rememberSentChatImage(attachment("a1", 3000), photo.toString("base64"));
    expect(id).toBe(nodeSha(photo));
    expect(useSentChatImagesStore.getState().byImageId[id!]?.attachment.id).toBe("a1");
    expect(collectSentChatImageAttachmentIds()).toEqual(new Set(["a1"]));
  });

  it("hashes once per attachment, also when the outbox retries the send", async () => {
    const data = bytes(3000).toString("base64");
    const first = rememberSentChatImage(attachment("a1", 3000), data);
    const second = rememberSentChatImage(attachment("a1", 3000), data);
    expect(second).toBe(first);
    await first;
  });

  it("survives a restart", async () => {
    const photo = bytes(3000);
    await rememberSentChatImage(attachment("a1", 3000), photo.toString("base64"));
    await flushSentChatImages();
    expect(storage.data.has(SENT_CHAT_IMAGES_STORAGE_KEY)).toBe(true);

    resetSentChatImagesForTests({ storage, maxBytes: 10_000 });
    expect(useSentChatImagesStore.getState().byImageId).toEqual({});
    await hydrateSentChatImages();
    expect(useSentChatImagesStore.getState().byImageId[nodeSha(photo)]?.attachment.id).toBe("a1");
  });

  it("evicts the least recently shown first when over its share of the cache", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const a = await rememberSentChatImage(attachment("a", 4000), bytes(10, 1).toString("base64"));
      vi.setSystemTime(2_000);
      const b = await rememberSentChatImage(attachment("b", 4000), bytes(10, 2).toString("base64"));
      vi.setSystemTime(3_000);
      touchSentChatImage(a!);
      vi.setSystemTime(4_000);
      const c = await rememberSentChatImage(attachment("c", 4000), bytes(10, 3).toString("base64"));
      const kept = Object.keys(useSentChatImagesStore.getState().byImageId);
      expect(kept.sort()).toEqual([a, c].sort());
      expect(kept).not.toContain(b);
      // The GC then deletes b's file.
      expect(collectSentChatImageAttachmentIds()).toEqual(new Set(["a", "c"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets an image whose local file is gone", async () => {
    const id = await rememberSentChatImage(attachment("a1", 3000), bytes(3000).toString("base64"));
    forgetSentChatImage(id!);
    expect(useSentChatImagesStore.getState().byImageId[id!]).toBeUndefined();
    expect(collectSentChatImageAttachmentIds().size).toBe(0);
  });

  it("an unreadable saved list starts empty instead of failing", async () => {
    storage.data.set(SENT_CHAT_IMAGES_STORAGE_KEY, "{not json");
    await hydrateSentChatImages();
    expect(useSentChatImagesStore.getState()).toMatchObject({ hydrated: true, byImageId: {} });
  });
});
