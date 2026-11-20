import { create } from "zustand";
import type { AttachmentMetadata } from "@/attachments/types";

/**
 * Photos in an outbox message go to the host one at a time, ahead of the message, as chunked
 * file uploads (daemon feature imageUploads). The message then carries only their upload ids.
 * Before this, every photo rode base64 inside one JSON frame: the phone's JS thread encrypted
 * the whole frame in one go (tens of seconds for a few camera photos), and a frame over the
 * daemon's 100 MiB socket limit closed the connection, so the outbox resent it for ever (UF1).
 */

export interface OutboxUploadProgress {
  /** 1-based number of the photo being sent. */
  index: number;
  count: number;
  /** Bytes of this photo handed to the socket. */
  sentBytes: number;
  totalBytes: number;
}

export const useOutboxUploadProgress = create<Record<string, OutboxUploadProgress>>(() => ({}));

export function setOutboxUploadProgress(
  clientMessageId: string,
  progress: OutboxUploadProgress,
): void {
  useOutboxUploadProgress.setState({ [clientMessageId]: progress });
}

export function clearOutboxUploadProgress(clientMessageId: string): void {
  const current = useOutboxUploadProgress.getState();
  if (!(clientMessageId in current)) return;
  const next = { ...current };
  delete next[clientMessageId];
  useOutboxUploadProgress.setState(next, true);
}

/** Whole percent of all the message's photos sent, counting finished ones as full. */
export function outboxUploadPercent(progress: OutboxUploadProgress): number {
  if (progress.count <= 0) return 0;
  const current = progress.totalBytes > 0 ? progress.sentBytes / progress.totalBytes : 0;
  const done = (progress.index - 1 + Math.min(1, Math.max(0, current))) / progress.count;
  return Math.min(100, Math.max(0, Math.floor(done * 100)));
}

/**
 * Hosts without imageUploads still get the photos inline. A frame over the daemon's socket limit
 * (ws maxPayload, 100 MiB) closes the connection and can never succeed, so the outbox fails such
 * a message at once instead. The limit leaves room for base64 (4/3) and, on an encrypted
 * connection, base64 of the ciphertext (4/3 again): 100 MiB / (16/9) is about 59 MB of photos.
 */
export const INLINE_IMAGES_MAX_BYTES = 48 * 1024 * 1024;

export function inlineImagesByteSize(images: readonly AttachmentMetadata[]): number {
  return images.reduce((sum, image) => sum + (image.byteSize ?? 0), 0);
}

export class InlineImagesTooLargeError extends Error {
  constructor(readonly byteSize: number) {
    super(`photos too large to send in one message (${Math.round(byteSize / 1e6)} MB)`);
    this.name = "InlineImagesTooLargeError";
  }
}
