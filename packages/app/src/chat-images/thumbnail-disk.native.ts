import * as FileSystem from "expo-file-system/legacy";
import { planThumbnailEviction } from "./thumbnail-memory";
import type { ThumbnailDiskStore } from "./thumbnail-disk-types";

/**
 * Display images on the phone live as files in the OS cache directory (iOS may purge it), capped
 * at 128 MB (~600-900 photos at chat width), oldest first. They are separate from the 500 MB chat
 * cache; originals are never stored here.
 */
const DIRECTORY = `${FileSystem.cacheDirectory ?? ""}paseo-chat-thumbs/`;
const MAX_BYTES = 128 * 1024 * 1024;
const SWEEP_EVERY_WRITES = 25;

let ready: Promise<void> | null = null;
let writesSinceSweep = SWEEP_EVERY_WRITES;

function ensureDirectory(): Promise<void> {
  ready ??= FileSystem.makeDirectoryAsync(DIRECTORY, { intermediates: true }).catch(() => {});
  return ready;
}

function fileUri(key: string): string {
  return `${DIRECTORY}${key.replace(/[^A-Za-z0-9_-]/g, "_")}.jpg`;
}

async function sweep(): Promise<void> {
  const names = await FileSystem.readDirectoryAsync(DIRECTORY);
  const files = await Promise.all(
    names.map(async (name) => {
      const info = await FileSystem.getInfoAsync(`${DIRECTORY}${name}`);
      return info.exists
        ? { name, bytes: info.size ?? 0, modifiedAt: info.modificationTime ?? 0 }
        : { name, bytes: 0, modifiedAt: 0 };
    }),
  );
  await Promise.all(
    planThumbnailEviction(files, MAX_BYTES).map((name) =>
      FileSystem.deleteAsync(`${DIRECTORY}${name}`, { idempotent: true }),
    ),
  );
}

export const thumbnailDiskStore: ThumbnailDiskStore = {
  async read(key) {
    if (!FileSystem.cacheDirectory) return null;
    const uri = fileUri(key);
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists ? { uri, bytes: 256 } : null;
  },
  async write(key, thumbnail) {
    if (!FileSystem.cacheDirectory) return null;
    await ensureDirectory();
    const uri = fileUri(key);
    await FileSystem.writeAsStringAsync(uri, thumbnail.data, {
      encoding: FileSystem.EncodingType.Base64,
    });
    writesSinceSweep += 1;
    if (writesSinceSweep >= SWEEP_EVERY_WRITES) {
      writesSinceSweep = 0;
      void sweep().catch(() => {});
    }
    return { uri, bytes: 256 };
  },
};
