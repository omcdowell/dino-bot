export interface ThumbnailDiskStore {
  /** A display URI for a stored thumbnail, or null. `bytes` is its in-memory cost. */
  read(key: string): Promise<{ uri: string; bytes: number } | null>;
  /** Stores a base64 JPEG and returns its display URI (null when there is no disk). */
  write(
    key: string,
    thumbnail: { data: string; mimeType: string },
  ): Promise<{ uri: string; bytes: number } | null>;
}
