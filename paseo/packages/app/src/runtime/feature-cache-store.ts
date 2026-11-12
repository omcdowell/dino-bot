import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CompactV2FeatureCache } from "@getpaseo/protocol/compact-v2";
import { z } from "zod";

/**
 * compact_v2 (A1): the daemon's server_info feature map, one per host (serverId). The client
 * presents the map's hash in hello; when the daemon's map is unchanged it sends only the hash and
 * the client restores the map from here, so connects and reconnects skip ~0.8 KB of wire. Kept
 * across launches so a cold start skips it too. Not a secret; dropped with the host.
 */

const STORAGE_KEY = "@paseo:feature-cache-v1";
const EntrySchema = z.object({
  hash: z.string().min(1).max(64),
  features: z.record(z.string(), z.unknown()),
});
const StoredSchema = z.record(z.string(), EntrySchema);
type Entry = z.infer<typeof EntrySchema>;

export interface FeatureCachePersistence {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface FeatureCacheRegistry {
  cacheFor(serverId: string): CompactV2FeatureCache;
  forgetServer(serverId: string): void;
  /** Resolves once stored maps are loaded (connects before then get the full map). */
  ready: Promise<void>;
}

export function createFeatureCacheRegistry(storage: FeatureCachePersistence): FeatureCacheRegistry {
  const entries = new Map<string, Entry>();
  let writeChain: Promise<void> = Promise.resolve();
  let loaded = false;

  const persist = () => {
    const snapshot = Object.fromEntries(entries);
    writeChain = writeChain
      .then(() => storage.setItem(STORAGE_KEY, JSON.stringify(snapshot)))
      .catch(() => undefined);
  };

  const ready = (async () => {
    try {
      const raw = await storage.getItem(STORAGE_KEY);
      const parsed = raw ? StoredSchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success) {
        for (const [serverId, entry] of Object.entries(parsed.data)) {
          // A map received while loading is newer than the stored one.
          if (!entries.has(serverId)) entries.set(serverId, entry);
        }
      }
    } catch {
      // Unreadable storage: the next connect gets the full map and stores it again.
    } finally {
      loaded = true;
    }
  })();

  return {
    ready,
    cacheFor: (serverId) => ({
      get: () => entries.get(serverId) ?? null,
      set: (entry) => {
        const current = entries.get(serverId);
        if (current?.hash === entry.hash) return;
        entries.set(serverId, { hash: entry.hash, features: entry.features });
        if (loaded) persist();
        else void ready.then(persist);
      },
    }),
    forgetServer: (serverId) => {
      if (entries.delete(serverId)) persist();
    },
  };
}

let defaultRegistry: FeatureCacheRegistry | null = null;

export function getFeatureCacheRegistry(): FeatureCacheRegistry {
  defaultRegistry ??= createFeatureCacheRegistry(AsyncStorage);
  return defaultRegistry;
}
