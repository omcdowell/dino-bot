/**
 * In-memory LRU of chat image thumbnails, bounded by bytes. Values are display URIs (a data: URI
 * or a file:// URI of the disk copy) plus the thumbnail's pixel size.
 */

export interface ChatImageThumbnailEntry {
  uri: string;
  width: number;
  height: number;
  /** Bytes this entry costs in memory (data: URIs) or 0 for file URIs. */
  bytes: number;
}

export class ThumbnailMemoryCache {
  private readonly entries = new Map<string, ChatImageThumbnailEntry>();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): ChatImageThumbnailEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: ChatImageThumbnailEntry): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.totalBytes -= previous.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, entry);
    this.totalBytes += entry.bytes;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.totalBytes <= this.maxBytes || oldestKey === key) break;
      this.entries.delete(oldestKey);
      this.totalBytes -= oldest.bytes;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }
}

/** Which disk files to delete so the rest fit in `maxBytes`: oldest first. */
export function planThumbnailEviction(
  files: ReadonlyArray<{ name: string; bytes: number; modifiedAt: number }>,
  maxBytes: number,
): string[] {
  let total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total <= maxBytes) return [];
  const oldestFirst = [...files].sort((a, b) => a.modifiedAt - b.modifiedAt);
  const evicted: string[] = [];
  for (const file of oldestFirst) {
    if (total <= maxBytes) break;
    evicted.push(file.name);
    total -= file.bytes;
  }
  return evicted;
}
