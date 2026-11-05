import type { ThumbnailDiskStore } from "./thumbnail-disk-types";

/**
 * Web and Electron keep display images in their own IndexedDB database, capped by entry count (a
 * display image is ~100-250 KB, so 400 entries is at most ~100 MB). Separate from the chat cache.
 */
const DB_NAME = "paseo-chat-thumbs";
const STORE = "thumbs";
const MAX_ENTRIES = 400;
const SWEEP_EVERY_WRITES = 50;

interface StoredThumbnail {
  data: string;
  mimeType: string;
  at: number;
}

let database: Promise<IDBDatabase | null> | null = null;
let writesSinceSweep = SWEEP_EVERY_WRITES;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  database ??= new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      const store = request.result.createObjectStore(STORE);
      store.createIndex("at", "at");
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => resolve(null));
  });
  return database;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function sweep(db: IDBDatabase): Promise<void> {
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  const count = await requestToPromise(store.count());
  let excess = count - MAX_ENTRIES;
  if (excess <= 0) return;
  const cursorRequest = store.index("at").openCursor();
  cursorRequest.addEventListener("success", () => {
    const cursor = cursorRequest.result;
    if (!cursor || excess <= 0) return;
    cursor.delete();
    excess -= 1;
    cursor.continue();
  });
}

function toDataUri(entry: StoredThumbnail): { uri: string; bytes: number } {
  return { uri: `data:${entry.mimeType};base64,${entry.data}`, bytes: entry.data.length };
}

export const thumbnailDiskStore: ThumbnailDiskStore = {
  async read(key) {
    const db = await openDatabase();
    if (!db) return null;
    try {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      const entry = (await requestToPromise(store.get(key))) as StoredThumbnail | undefined;
      return entry ? toDataUri(entry) : null;
    } catch {
      return null;
    }
  },
  async write(key, thumbnail) {
    const entry: StoredThumbnail = { ...thumbnail, at: Date.now() };
    const db = await openDatabase();
    if (db) {
      try {
        const store = db.transaction(STORE, "readwrite").objectStore(STORE);
        await requestToPromise(store.put(entry, key));
        writesSinceSweep += 1;
        if (writesSinceSweep >= SWEEP_EVERY_WRITES) {
          writesSinceSweep = 0;
          void sweep(db).catch(() => {});
        }
      } catch {
        // Quota or a closed database: the thumbnail still shows from memory.
      }
    }
    return toDataUri(entry);
  },
};
