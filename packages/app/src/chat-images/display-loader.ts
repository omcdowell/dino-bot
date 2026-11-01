import { thumbnailDiskStore } from "./thumbnail-disk";
import type { ThumbnailDiskStore } from "./thumbnail-disk-types";
import { ThumbnailMemoryCache, type ChatImageThumbnailEntry } from "./thumbnail-memory";

/**
 * Loads a chat image's display image (chat width, ~100-250 KB JPEG): memory, then disk, then the
 * daemon. A download reports progress, is shared by every tile showing the same image, and at
 * most two run at a time so a chat full of images does not starve the timeline on a slow link.
 * Nothing here decides *whether* to download: tiles ask `cached()` first and only call `load()`
 * on a tap or when the link is good (see network-policy).
 */

const MAX_CONCURRENT_FETCHES = 2;

export interface FetchedDisplayImage {
  /** Base64 bytes. */
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

export type DisplayProgress = (receivedBytes: number, totalBytes: number) => void;
export type FetchDisplayImage = (onProgress: DisplayProgress) => Promise<FetchedDisplayImage>;

export interface ChatImageDisplayLoader {
  /** In memory: render at once, no flash. */
  peek(serverId: string, imageId: string): ChatImageThumbnailEntry | undefined;
  /** In memory or on disk; never touches the network. */
  cached(serverId: string, imageId: string): Promise<ChatImageThumbnailEntry | null>;
  load(input: {
    serverId: string;
    imageId: string;
    fetch: FetchDisplayImage;
    onProgress?: DisplayProgress;
  }): Promise<ChatImageThumbnailEntry>;
}

interface InFlight {
  promise: Promise<ChatImageThumbnailEntry>;
  listeners: Set<DisplayProgress>;
}

export function createChatImageDisplayLoader(options: {
  disk: ThumbnailDiskStore;
  memoryBytes: number;
}): ChatImageDisplayLoader {
  const memory = new ThumbnailMemoryCache(options.memoryBytes);
  const inFlight = new Map<string, InFlight>();
  const waiting: Array<() => void> = [];
  let active = 0;

  const keyFor = (serverId: string, imageId: string) => `${serverId}:${imageId}`;
  const diskKey = (serverId: string, imageId: string) =>
    `${serverId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}-${imageId}-display`;

  async function withFetchSlot<T>(run: () => Promise<T>): Promise<T> {
    if (active >= MAX_CONCURRENT_FETCHES) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  function peek(serverId: string, imageId: string): ChatImageThumbnailEntry | undefined {
    return memory.get(keyFor(serverId, imageId));
  }

  async function cached(serverId: string, imageId: string) {
    const inMemory = peek(serverId, imageId);
    if (inMemory) return inMemory;
    const stored = await options.disk.read(diskKey(serverId, imageId));
    if (!stored) return null;
    const entry = { ...stored, width: 0, height: 0 };
    memory.set(keyFor(serverId, imageId), entry);
    return entry;
  }

  async function download(
    serverId: string,
    imageId: string,
    fetch: FetchDisplayImage,
    listeners: Set<DisplayProgress>,
  ): Promise<ChatImageThumbnailEntry> {
    const fromCache = await cached(serverId, imageId);
    if (fromCache) return fromCache;
    const fetched = await withFetchSlot(() =>
      fetch((received, total) => {
        for (const listener of listeners) listener(received, total);
      }),
    );
    const stored = await options.disk.write(diskKey(serverId, imageId), fetched).catch(() => null);
    const entry: ChatImageThumbnailEntry = {
      uri: stored?.uri ?? `data:${fetched.mimeType};base64,${fetched.data}`,
      bytes: stored?.bytes ?? fetched.data.length,
      width: fetched.width,
      height: fetched.height,
    };
    memory.set(keyFor(serverId, imageId), entry);
    return entry;
  }

  return {
    peek,
    cached,
    load({ serverId, imageId, fetch, onProgress }) {
      const inMemory = peek(serverId, imageId);
      if (inMemory) return Promise.resolve(inMemory);
      const key = keyFor(serverId, imageId);
      const pending = inFlight.get(key);
      if (pending) {
        if (onProgress) pending.listeners.add(onProgress);
        return pending.promise;
      }
      const listeners = new Set<DisplayProgress>(onProgress ? [onProgress] : []);
      const promise = download(serverId, imageId, fetch, listeners).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, { promise, listeners });
      return promise;
    },
  };
}

export const chatImageDisplays = createChatImageDisplayLoader({
  disk: thumbnailDiskStore,
  memoryBytes: 24 * 1024 * 1024,
});

/** Base64 of bytes without Buffer (Hermes and browsers both have btoa). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
