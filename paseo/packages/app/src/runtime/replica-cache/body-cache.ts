import type { ReplicaRowIndexEntry, ReplicaRowStore } from "./row-store";
import { utf8ByteLength } from "./row-store-sqlite";

const MB = 1024 * 1024;
/** B2b default budget for tool bodies on the device (separate from the chat rows' budget). */
export const BODY_CACHE_MAX_BYTES = 50 * MB;
const EVICT_TO_RATIO = 0.9;

/**
 * B2b durable body cache. Full tool-call rows fetched from the daemon are kept on disk keyed by the
 * daemon's `bodyHash` (a content hash, set only once the call is final), so a body is never stale:
 * expanding the same tool again, or after an app restart, reads it from here instead of the
 * network. Bounded (LRU by last use), per host (bodies of a removed host go with its rows).
 * Payloads stay on disk; memory holds keys, sizes and access times only.
 */
export class DurableBodyCache {
  private readonly index = new Map<string, ReplicaRowIndexEntry>();
  private totalBytes = 0;
  private ready: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly rowStore: ReplicaRowStore,
    private readonly maxBytes: number = BODY_CACHE_MAX_BYTES,
    private readonly now: () => number = Date.now,
  ) {}

  private key(serverId: string, hash: string): string {
    return `${serverId}\u0000${hash}`;
  }

  private load(): Promise<void> {
    this.ready ??= (async () => {
      await this.rowStore.open();
      for (const entry of await this.rowStore.readIndex()) {
        if (entry.kind !== "body") continue;
        this.index.set(this.key(entry.serverId, entry.id), { ...entry });
        this.totalBytes += entry.bytes;
      }
    })().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private serial(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Hashes held for a host (sent as `have` so the daemon skips them). */
  async hashes(serverId: string): Promise<Set<string>> {
    try {
      await this.load();
    } catch {
      return new Set();
    }
    const out = new Set<string>();
    for (const entry of this.index.values()) if (entry.serverId === serverId) out.add(entry.id);
    return out;
  }

  async get<Item = unknown>(serverId: string, hash: string): Promise<Item | undefined> {
    try {
      await this.load();
      const entry = this.index.get(this.key(serverId, hash));
      if (!entry) return undefined;
      const rows = await this.rowStore.read(serverId, ["body"], [hash]);
      const row = rows[0];
      if (!row) {
        this.drop(serverId, hash);
        return undefined;
      }
      entry.touchedAt = this.now();
      const at = entry.touchedAt;
      void this.serial(() => this.rowStore.touch([{ serverId, kind: "body", id: hash }], at));
      return JSON.parse(row.payload) as Item;
    } catch {
      return undefined;
    }
  }

  async put(serverId: string, hash: string, item: unknown): Promise<void> {
    const payload = JSON.stringify(item);
    const bytes = utf8ByteLength(payload);
    if (bytes > this.maxBytes) return;
    try {
      await this.load();
    } catch {
      return;
    }
    await this.serial(async () => {
      const key = this.key(serverId, hash);
      const previous = this.index.get(key);
      const evict = this.pickEvictions(bytes - (previous?.bytes ?? 0), key);
      await this.rowStore.apply({
        upserts: [{ serverId, kind: "body", id: hash, payload }],
        deletes: evict.map(({ serverId: s, id }) => ({ serverId: s, kind: "body" as const, id })),
      });
      for (const entry of evict) this.drop(entry.serverId, entry.id);
      if (previous) this.totalBytes -= previous.bytes;
      this.index.set(key, { serverId, kind: "body", id: hash, bytes, touchedAt: this.now() });
      this.totalBytes += bytes;
    });
  }

  storedBytes(): number {
    return this.totalBytes;
  }

  private pickEvictions(delta: number, keep: string): ReplicaRowIndexEntry[] {
    if (this.totalBytes + delta <= this.maxBytes) return [];
    const target = Math.floor(this.maxBytes * EVICT_TO_RATIO);
    let projected = this.totalBytes + delta;
    const picked: ReplicaRowIndexEntry[] = [];
    const byAge = [...this.index.entries()]
      .filter(([key]) => key !== keep)
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
    for (const [, entry] of byAge) {
      if (projected <= target) break;
      picked.push(entry);
      projected -= entry.bytes;
    }
    return picked;
  }

  private drop(serverId: string, hash: string): void {
    const key = this.key(serverId, hash);
    const entry = this.index.get(key);
    if (!entry) return;
    this.index.delete(key);
    this.totalBytes -= entry.bytes;
  }
}

let shared: DurableBodyCache | null = null;

/** Set once by the host runtime (same row store as the replica cache). */
export function setDurableBodyCache(cache: DurableBodyCache | null): void {
  shared = cache;
}

export function getDurableBodyCache(): DurableBodyCache | null {
  return shared;
}
