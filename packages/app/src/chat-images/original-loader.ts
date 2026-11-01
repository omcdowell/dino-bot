import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineImage } from "@getpaseo/protocol/agent-types";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import {
  persistAttachmentFromBytes,
  releaseAttachmentPreviewUrl,
  resolveAttachmentPreviewUrl,
} from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";

/**
 * Originals load only when the user opens an image, through the ordinary file read RPC (binary
 * frames, chunked). The last few stay in the attachment store for this run; the attachment GC
 * removes them on a later start, so originals never accumulate on the device.
 */
const MAX_ORIGINAL_BYTES = 40 * 1024 * 1024;
const KEPT_ORIGINALS = 12;

interface LoadedOriginal {
  promise: Promise<{ uri: string; metadata: AttachmentMetadata }>;
  release: () => void;
}

const loaded = new Map<string, LoadedOriginal>();

function evictOldest(): void {
  while (loaded.size > KEPT_ORIGINALS) {
    const [key, oldest] = loaded.entries().next().value as [string, LoadedOriginal];
    loaded.delete(key);
    oldest.release();
  }
}

const HEIC_TYPES = new Set(["image/heic", "image/heif"]);

/** Where the full-size image to show lives: the original, or a JPEG of a HEIC the view can't show. */
async function resolveFullImage(
  client: DaemonClient,
  image: AgentTimelineImage,
  acceptsHeic: boolean,
): Promise<{ path: string; mimeType: string }> {
  if (!HEIC_TYPES.has(image.mimeType) || acceptsHeic) {
    return { path: image.source, mimeType: image.mimeType };
  }
  const full = await client.fetchAgentImageVariant(image.id, "full");
  if (!full.path) throw new Error("Image unavailable");
  return { path: full.path, mimeType: full.mimeType ?? "image/jpeg" };
}

/**
 * Loads the full-size image for the lightbox. HEIC originals are only shown where the platform
 * decodes HEIC (`acceptsHeic`, iOS); elsewhere the daemon's full-size JPEG of it is read.
 */
export function loadChatImageOriginal(input: {
  client: DaemonClient;
  image: AgentTimelineImage;
  acceptsHeic?: boolean;
}): Promise<string> {
  const { client, image } = input;
  const acceptsHeic = input.acceptsHeic === true;
  const key = HEIC_TYPES.has(image.mimeType) && !acceptsHeic ? `${image.id}-jpeg` : image.id;
  const existing = loaded.get(key);
  if (existing) {
    loaded.delete(key);
    loaded.set(key, existing);
    return existing.promise.then((value) => value.uri);
  }
  let releaseRetention: (() => void) | null = null;
  const promise = (async () => {
    const full = await resolveFullImage(client, image, acceptsHeic);
    const target = resolveFilePreviewReadTarget({ path: full.path });
    if (!target) throw new Error("Image unavailable");
    const file = await client.readFile(target.cwd, target.path, undefined, MAX_ORIGINAL_BYTES);
    const metadata = await persistAttachmentFromBytes({
      id: `chat-image-${key}`,
      bytes: file.bytes,
      mimeType: full.mimeType,
      fileName: image.fileName ?? null,
    });
    releaseRetention = retainAttachmentForGarbageCollection(metadata.id);
    return { uri: await resolveAttachmentPreviewUrl(metadata), metadata };
  })();
  const entry: LoadedOriginal = {
    promise,
    release: () => {
      releaseRetention?.();
      void promise
        .then(({ uri, metadata }) =>
          releaseAttachmentPreviewUrl({ attachment: metadata, url: uri }),
        )
        .catch(() => {});
    },
  };
  loaded.set(key, entry);
  promise.catch(() => {
    if (loaded.get(key) === entry) loaded.delete(key);
  });
  evictOldest();
  return promise.then((value) => value.uri);
}
