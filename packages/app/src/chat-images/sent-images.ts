import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect } from "react";
import { create } from "zustand";
import { z } from "zod";
import type { AttachmentMetadata } from "@/attachments/types";
import { getSentChatImagesMaxBytes } from "@/runtime/replica-cache/budget";
import { chatImageIdForBase64 } from "./image-hash";

/**
 * Photos this device sent, by the daemon's image id (sha256 of the bytes, hashed here before the
 * bytes go up). The sender's own bubble shows the local file for that id: at once, full size, no
 * blur and no download. The file stays in the attachment store (the attachment GC keeps every
 * file listed here), the list survives restarts, and its share of the device cache (the 500 MB
 * budget, runtime/replica-cache/budget) evicts the least recently shown first. An id with no
 * entry, or whose file is gone, takes the normal blur/tap path, as on any other device.
 */

export const SENT_CHAT_IMAGES_STORAGE_KEY = "paseo-sent-chat-images";
const VERSION = 1;
/** Showing an image moves it to the back of the eviction line; saved at most this often. */
const TOUCH_PERSIST_DELAY_MS = 5_000;

export interface SentChatImage {
  imageId: string;
  attachment: AttachmentMetadata;
  byteSize: number;
  usedAt: number;
}

interface SentChatImagesState {
  hydrated: boolean;
  byImageId: Record<string, SentChatImage>;
}

const AttachmentSchema = z
  .object({
    id: z.string(),
    mimeType: z.string(),
    storageType: z.enum(["web-indexeddb", "desktop-file", "native-file"]),
    storageKey: z.string(),
    fileName: z.string().nullable().optional(),
    byteSize: z.number().nullable().optional(),
    createdAt: z.number(),
  })
  .passthrough();

const PersistedSchema = z.object({
  version: z.literal(VERSION),
  images: z.array(
    z.object({
      imageId: z.string(),
      attachment: AttachmentSchema,
      byteSize: z.number(),
      usedAt: z.number(),
    }),
  ),
});

interface BackingStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

export const useSentChatImagesStore = create<SentChatImagesState>(() => ({
  hydrated: false,
  byImageId: {},
}));

let storage: BackingStorage = AsyncStorage;
let hydration: Promise<void> | null = null;
let writeChain: Promise<void> = Promise.resolve();
let touchTimer: ReturnType<typeof setTimeout> | null = null;
let maxBytes: () => number = getSentChatImagesMaxBytes;
/** Attachment id → image id, so a retry of the same send does not hash again. */
const hashed = new Map<string, Promise<string | null>>();

/** Tests only. */
export function resetSentChatImagesForTests(options?: {
  storage?: BackingStorage;
  maxBytes?: number;
}): void {
  storage = options?.storage ?? AsyncStorage;
  hydration = null;
  writeChain = Promise.resolve();
  if (touchTimer) clearTimeout(touchTimer);
  touchTimer = null;
  maxBytes = options?.maxBytes !== undefined ? () => options.maxBytes! : getSentChatImagesMaxBytes;
  hashed.clear();
  useSentChatImagesStore.setState({ hydrated: false, byImageId: {} });
}

function persist(): Promise<void> {
  const images = Object.values(useSentChatImagesStore.getState().byImageId);
  const snapshot = JSON.stringify({ version: VERSION, images });
  writeChain = writeChain
    .catch(() => undefined)
    .then(() => storage.setItem(SENT_CHAT_IMAGES_STORAGE_KEY, snapshot));
  return writeChain.catch((error: unknown) => {
    console.warn("[SentChatImages] failed to save", error);
  });
}

/** Loads the saved list once. The attachment GC waits for this before deleting anything. */
export function hydrateSentChatImages(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    let loaded: SentChatImage[] = [];
    try {
      const raw = await storage.getItem(SENT_CHAT_IMAGES_STORAGE_KEY);
      if (raw) {
        const parsed = PersistedSchema.safeParse(JSON.parse(raw));
        if (parsed.success) loaded = parsed.data.images as SentChatImage[];
      }
    } catch (error) {
      console.warn("[SentChatImages] failed to load", error);
    }
    const current = useSentChatImagesStore.getState().byImageId;
    const byImageId: Record<string, SentChatImage> = {};
    for (const image of loaded) byImageId[image.imageId] = image;
    Object.assign(byImageId, current);
    useSentChatImagesStore.setState({ hydrated: true, byImageId });
  })();
  return hydration;
}

function evictOverBudget(byImageId: Record<string, SentChatImage>): Record<string, SentChatImage> {
  const budget = maxBytes();
  const images = Object.values(byImageId);
  let total = images.reduce((sum, image) => sum + image.byteSize, 0);
  if (total <= budget) return byImageId;
  const next = { ...byImageId };
  for (const image of images.sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= budget) break;
    delete next[image.imageId];
    total -= image.byteSize;
  }
  return next;
}

/**
 * Called with each image's base64 just before it is sent: hashes it to the daemon's id and keeps
 * the local file for that id. Resolves once listed, so the entry exists before the daemon's
 * reference can come back. Never throws (a failure only means the normal download path).
 */
export function rememberSentChatImage(
  attachment: AttachmentMetadata,
  data: string,
): Promise<string | null> {
  const known = hashed.get(attachment.id);
  if (known) return known;
  const run = (async () => {
    try {
      const imageId = await chatImageIdForBase64(data);
      await hydrateSentChatImages();
      const byteSize = attachment.byteSize ?? Math.floor((data.length * 3) / 4);
      const entry: SentChatImage = { imageId, attachment, byteSize, usedAt: Date.now() };
      const byImageId = evictOverBudget({
        ...useSentChatImagesStore.getState().byImageId,
        [imageId]: entry,
      });
      useSentChatImagesStore.setState({ byImageId });
      await persist();
      return imageId;
    } catch (error) {
      console.warn("[SentChatImages] failed to remember a sent image", error);
      hashed.delete(attachment.id);
      return null;
    }
  })();
  hashed.set(attachment.id, run);
  return run;
}

/** The local file is gone (deleted, reinstall): use the normal download path for this id. */
export function forgetSentChatImage(imageId: string): void {
  const { byImageId } = useSentChatImagesStore.getState();
  const entry = byImageId[imageId];
  if (!entry) return;
  const next = { ...byImageId };
  delete next[imageId];
  hashed.delete(entry.attachment.id);
  useSentChatImagesStore.setState({ byImageId: next });
  void persist();
}

/** The image was shown: it goes to the back of the eviction line. */
export function touchSentChatImage(imageId: string): void {
  const { byImageId } = useSentChatImagesStore.getState();
  const entry = byImageId[imageId];
  if (!entry) return;
  useSentChatImagesStore.setState({
    byImageId: { ...byImageId, [imageId]: { ...entry, usedAt: Date.now() } },
  });
  if (touchTimer) return;
  touchTimer = setTimeout(() => {
    touchTimer = null;
    void persist();
  }, TOUCH_PERSIST_DELAY_MS);
}

/** Attachment ids the GC must keep. */
export function collectSentChatImageAttachmentIds(): Set<string> {
  return new Set(
    Object.values(useSentChatImagesStore.getState().byImageId).map((image) => image.attachment.id),
  );
}

/** The local copy of an image this device sent, and whether the saved list has loaded yet. */
export function useSentChatImage(imageId: string): {
  ready: boolean;
  attachment: AttachmentMetadata | null;
} {
  const ready = useSentChatImagesStore((state) => state.hydrated);
  const attachment = useSentChatImagesStore(
    (state) => state.byImageId[imageId]?.attachment ?? null,
  );
  useEffect(() => {
    if (!ready) void hydrateSentChatImages();
  }, [ready]);
  return { ready, attachment };
}

/** Waits for pending writes (tests). */
export function flushSentChatImages(): Promise<void> {
  return writeChain.catch(() => undefined);
}
