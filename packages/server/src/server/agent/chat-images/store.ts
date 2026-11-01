import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import type { AgentTimelineImage } from "../agent-sdk-types.js";
import { readImageHeader, type ImageHeader } from "./image-header.js";

/**
 * Daemon-side home of chat images: images the user sent and images a tool returned (e.g. pi's
 * `read` on a PNG). Timeline rows carry an AgentTimelineImage reference, never bytes, so timeline
 * sync and compact fetches stay small on slow links. Files are content-addressed by sha256, so
 * provider history replay after a restart produces the same ids and writes nothing new.
 *
 * Each new image is prepared once in a worker thread, in the background: a ThumbHash placeholder
 * (~25 bytes, carried on the reference so clients show a blurred preview at full size with no
 * request) and a display JPEG at chat width (DISPLAY_MAX_WIDTH), cached next to the originals.
 * Clients download the display image on tap (or straight away on a good link) through the file
 * read RPC, and the original only when the user opens it. HEIC is decoded with libheif (wasm);
 * clients that cannot show HEIC get a full-size JPEG instead of the original.
 */

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const IMAGE_ID_PATTERN = /^[0-9a-f]{64}$/;
const THUMBNAIL_EDGES = [160, 320, 640] as const;
const THUMBNAIL_QUALITY: Record<(typeof THUMBNAIL_EDGES)[number], number> = {
  160: 55,
  320: 65,
  640: 72,
};
/** GIF and WebP are not decoded; small ones are sent as their own thumbnail. */
const PASSTHROUGH_MAX_BYTES = 192 * 1024;
const THUMBNAIL_MAX_PIXELS = 50_000_000;
const THUMBNAIL_TIMEOUT_MS = 30_000;
/** Display images: phone width at 3x is ~1170 px, a capped laptop column at 2x ~960 px. */
export const DISPLAY_MAX_WIDTH = 1080;
const DISPLAY_MAX_HEIGHT = 2400;
const DISPLAY_QUALITY = 72;
const FULL_QUALITY = 85;
const KNOWN_EXTENSIONS = ["png", "jpg", "gif", "webp", "heic", "bmp", "tiff", "avif", "img"];

export interface ChatImageInput {
  /** Base64, or a data URL. */
  data: string;
  mimeType?: string | null;
  fileName?: string | null;
}

export interface ChatImageDisplay {
  /** Absolute path of the display file (a cached JPEG, or the original when it is small). */
  path: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
}

export interface ChatImagePrepared {
  /** Base64 ThumbHash, absent for formats that are not decoded (GIF, WebP). */
  thumbhash?: string;
  display: ChatImageDisplay;
}

interface PreparedSidecar {
  thumbhash?: string;
  display: Omit<ChatImageDisplay, "path"> & { file: string };
}

export interface ChatImageThumbnail {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

function extensionFor(mimeType: string, header: ImageHeader | null): string {
  if (header) return header.format === "jpeg" ? "jpg" : header.format;
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/heic":
    case "image/heif":
      return "heic";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    case "image/avif":
      return "avif";
    default:
      return "img";
  }
}

function decodeImageData(input: ChatImageInput): { bytes: Buffer; mimeType: string } {
  const dataUrl = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(input.data);
  const mimeType = dataUrl?.[1] ?? input.mimeType ?? "application/octet-stream";
  return { bytes: Buffer.from(dataUrl?.[2] ?? input.data, "base64"), mimeType };
}

export function snapThumbnailEdge(requested: number | undefined): (typeof THUMBNAIL_EDGES)[number] {
  const wanted = requested ?? 320;
  return THUMBNAIL_EDGES.find((edge) => edge >= wanted) ?? THUMBNAIL_EDGES.at(-1)!;
}

export function isChatImageId(value: string): boolean {
  return IMAGE_ID_PATTERN.test(value);
}

export class ChatImageStore {
  private readonly paths = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<ChatImageThumbnail>>();
  private readonly preparing = new Map<string, Promise<ChatImagePrepared>>();
  private readonly prepared = new Map<string, ChatImagePrepared>();
  /** References handed out before preparation finished; patched in place when it does. */
  private readonly unpreparedRefs = new Map<string, AgentTimelineImage[]>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly directory: string,
    private readonly options: { prepareInBackground?: boolean } = {},
  ) {}

  /** Stores the image (once) and returns its reference. Synchronous: callers record timeline rows. */
  put(input: ChatImageInput): AgentTimelineImage | null {
    const { bytes, mimeType } = decodeImageData(input);
    if (bytes.byteLength === 0) return null;
    const header = readImageHeader(bytes);
    const id = createHash("sha256").update(bytes).digest("hex");
    const source = this.writeOnce(id, extensionFor(mimeType, header), bytes);
    const fileName = input.fileName?.trim();
    const reference: AgentTimelineImage = {
      id,
      mimeType: header?.mimeType ?? mimeType,
      source,
      byteSize: bytes.byteLength,
      ...(header ? { width: header.width, height: header.height } : {}),
      ...(fileName ? { fileName } : {}),
    };
    const prepared = this.readPrepared(id);
    if (prepared) {
      applyPrepared(reference, prepared);
    } else if (header && this.options.prepareInBackground !== false) {
      const waiting = this.unpreparedRefs.get(id) ?? [];
      waiting.push(reference);
      this.unpreparedRefs.set(id, waiting);
      void this.prepare(id).catch(() => undefined);
    }
    return reference;
  }

  /**
   * The placeholder and display image of an image, made once (in the worker) and cached on disk.
   * References handed out earlier get the placeholder patched in, so later timeline fetches carry
   * it even though the live row went out first.
   */
  prepare(id: string): Promise<ChatImagePrepared> {
    const known = this.readPrepared(id);
    if (known) return Promise.resolve(known);
    const pending = this.preparing.get(id);
    if (pending) return pending;
    const promise = this.createPrepared(id)
      .then((prepared) => {
        this.prepared.set(id, prepared);
        for (const reference of this.unpreparedRefs.get(id) ?? []) {
          applyPrepared(reference, prepared);
        }
        return prepared;
      })
      .finally(() => {
        this.preparing.delete(id);
        this.unpreparedRefs.delete(id);
      });
    this.preparing.set(id, promise);
    return promise;
  }

  /**
   * What to open full screen: the original, or for HEIC on a client that cannot show it a
   * full-size JPEG made from it.
   */
  async full(id: string, options: { acceptsHeic?: boolean } = {}): Promise<ChatImageDisplay> {
    const source = this.resolve(id);
    if (!source) throw new Error("Image not found");
    const original = await fs.promises.readFile(source);
    const header = readImageHeader(original);
    if (!header) throw new Error("Unsupported image format");
    if (header.format !== "heic" || options.acceptsHeic) {
      return {
        path: source,
        mimeType: header.mimeType,
        width: header.width,
        height: header.height,
        byteSize: original.byteLength,
      };
    }
    const file = path.join(this.directory, "thumbs", `${id}-full.jpg`);
    const cached = await fs.promises.stat(file).catch(() => null);
    if (cached) {
      return {
        path: file,
        mimeType: "image/jpeg",
        width: header.width,
        height: header.height,
        byteSize: cached.size,
      };
    }
    const [result] = await this.decode(source, header, [
      { kind: "jpeg", quality: FULL_QUALITY, file },
    ]);
    if (result?.kind !== "jpeg") throw new Error("Image conversion failed");
    return {
      path: file,
      mimeType: "image/jpeg",
      width: result.width,
      height: result.height,
      byteSize: result.byteSize,
    };
  }

  private sidecarPath(id: string): string {
    return path.join(this.directory, "thumbs", `${id}.json`);
  }

  private readPrepared(id: string): ChatImagePrepared | null {
    const known = this.prepared.get(id);
    if (known) return known;
    if (!isChatImageId(id)) return null;
    try {
      const sidecar = JSON.parse(fs.readFileSync(this.sidecarPath(id), "utf8")) as PreparedSidecar;
      const displayPath = path.isAbsolute(sidecar.display.file)
        ? sidecar.display.file
        : path.join(this.directory, sidecar.display.file);
      if (!fs.existsSync(displayPath)) return null;
      const { file: _file, ...display } = sidecar.display;
      const prepared: ChatImagePrepared = {
        ...(sidecar.thumbhash ? { thumbhash: sidecar.thumbhash } : {}),
        display: { ...display, path: displayPath },
      };
      this.prepared.set(id, prepared);
      return prepared;
    } catch {
      return null;
    }
  }

  private async createPrepared(id: string): Promise<ChatImagePrepared> {
    const source = this.resolve(id);
    if (!source) throw new Error("Image not found");
    const original = await fs.promises.readFile(source);
    const header = readImageHeader(original);
    if (!header) throw new Error("Unsupported image format");
    let prepared: ChatImagePrepared;
    const originalDisplay: ChatImageDisplay = {
      path: source,
      mimeType: header.mimeType,
      width: header.width,
      height: header.height,
      byteSize: original.byteLength,
    };
    if (header.format === "gif" || header.format === "webp") {
      // Not decoded: the original is the display image; no placeholder beyond the reserved box.
      prepared = { display: originalDisplay };
    } else {
      // A PNG/JPEG already at most chat width and upright is shown as is (no re-encoding).
      const keepOriginal =
        header.format !== "heic" &&
        header.orientation === 1 &&
        header.width <= DISPLAY_MAX_WIDTH &&
        header.height <= DISPLAY_MAX_HEIGHT;
      const file = path.join(this.directory, "thumbs", `${id}-w${DISPLAY_MAX_WIDTH}.jpg`);
      const results = await this.decode(source, header, [
        { kind: "thumbhash" },
        ...(keepOriginal
          ? []
          : [
              {
                kind: "jpeg" as const,
                maxWidth: DISPLAY_MAX_WIDTH,
                maxHeight: DISPLAY_MAX_HEIGHT,
                quality: DISPLAY_QUALITY,
                file,
              },
            ]),
      ]);
      const hash = results.find((result) => result.kind === "thumbhash");
      const jpeg = results.find((result) => result.kind === "jpeg");
      // A flat PNG (a chart, a screenshot) can be smaller than its JPEG: then send the original.
      const originalIsSmaller =
        jpeg?.kind === "jpeg" &&
        header.format !== "heic" &&
        header.orientation === 1 &&
        original.byteLength <= jpeg.byteSize;
      if (originalIsSmaller) await fs.promises.rm(file, { force: true });
      prepared = {
        ...(hash?.kind === "thumbhash" ? { thumbhash: hash.thumbhash } : {}),
        display:
          jpeg?.kind === "jpeg" && !originalIsSmaller
            ? {
                path: file,
                mimeType: "image/jpeg",
                width: jpeg.width,
                height: jpeg.height,
                byteSize: jpeg.byteSize,
              }
            : originalDisplay,
      };
    }
    const { path: displayPath, ...display } = prepared.display;
    const sidecar: PreparedSidecar = {
      ...(prepared.thumbhash ? { thumbhash: prepared.thumbhash } : {}),
      display: { ...display, file: path.relative(this.directory, displayPath) },
    };
    await this.writeFileAtomic(this.sidecarPath(id), Buffer.from(JSON.stringify(sidecar)));
    return prepared;
  }

  /** One decode at a time: each can hold a few hundred MB of RGBA. */
  private decode(
    source: string,
    header: ImageHeader,
    outputs: WorkerOutput[],
  ): Promise<WorkerResult[]> {
    const run = this.queue.then(() =>
      runImageWorker({
        path: source,
        format: header.format,
        orientation: header.orientation,
        maxPixels: THUMBNAIL_MAX_PIXELS,
        outputs,
      }),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Absolute path of the original, or null when the id is unknown or malformed. */
  resolve(id: string): string | null {
    if (!isChatImageId(id)) return null;
    const known = this.paths.get(id);
    if (known && fs.existsSync(known)) return known;
    for (const extension of KNOWN_EXTENSIONS) {
      const candidate = path.join(this.directory, `${id}.${extension}`);
      if (fs.existsSync(candidate)) {
        this.paths.set(id, candidate);
        return candidate;
      }
    }
    return null;
  }

  async thumbnail(id: string, requestedEdge?: number): Promise<ChatImageThumbnail> {
    const source = this.resolve(id);
    if (!source) throw new Error("Image not found");
    const edge = snapThumbnailEdge(requestedEdge);
    const key = `${id}-${edge}`;
    const pending = this.inFlight.get(key);
    if (pending) return await pending;
    const promise = this.loadOrCreateThumbnail(source, key, edge).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return await promise;
  }

  private async loadOrCreateThumbnail(
    source: string,
    key: string,
    edge: (typeof THUMBNAIL_EDGES)[number],
  ): Promise<ChatImageThumbnail> {
    const cached = path.join(this.directory, "thumbs", `${key}.jpg`);
    const existing = await readThumbnailFile(cached);
    if (existing) return existing;

    const original = await fs.promises.readFile(source);
    const header = readImageHeader(original);
    if (!header) throw new Error("Unsupported image format for thumbnails");
    if (header.format === "gif" || header.format === "webp") {
      if (original.byteLength > PASSTHROUGH_MAX_BYTES) {
        throw new Error("Unsupported image format for thumbnails");
      }
      return {
        bytes: original,
        mimeType: header.mimeType,
        width: header.width,
        height: header.height,
      };
    }
    const [result] = await this.decode(source, header, [
      { kind: "jpeg", maxEdge: edge, quality: THUMBNAIL_QUALITY[edge] },
    ]);
    if (result?.kind !== "jpeg" || !result.data) throw new Error("Thumbnail failed");
    const thumbnail: ChatImageThumbnail = {
      bytes: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength),
      mimeType: "image/jpeg",
      width: result.width,
      height: result.height,
    };
    await this.writeFileAtomic(cached, thumbnail.bytes);
    return thumbnail;
  }

  private writeOnce(id: string, extension: string, bytes: Buffer): string {
    const existing = this.resolve(id);
    if (existing) return existing;
    const target = path.join(this.directory, `${id}.${extension}`);
    fs.mkdirSync(this.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const temporary = path.join(this.directory, `.${id}.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, bytes, { mode: PRIVATE_FILE_MODE });
    fs.renameSync(temporary, target);
    this.paths.set(id, target);
    return target;
  }

  private async writeFileAtomic(target: string, bytes: Buffer): Promise<void> {
    await fs.promises.mkdir(path.dirname(target), {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, bytes, { mode: PRIVATE_FILE_MODE });
    await fs.promises.rename(temporary, target);
  }
}

async function readThumbnailFile(file: string): Promise<ChatImageThumbnail | null> {
  try {
    const bytes = await fs.promises.readFile(file);
    const header = readImageHeader(bytes);
    if (!header) return null;
    return { bytes, mimeType: header.mimeType, width: header.width, height: header.height };
  } catch {
    return null;
  }
}

type WorkerOutput =
  | { kind: "thumbhash" }
  | {
      kind: "jpeg";
      quality: number;
      maxEdge?: number;
      maxWidth?: number;
      maxHeight?: number;
      /** Written by the worker (atomically) instead of returned. */
      file?: string;
    };

type WorkerResult =
  | { kind: "thumbhash"; thumbhash: string }
  | {
      kind: "jpeg";
      width: number;
      height: number;
      byteSize: number;
      file?: string;
      data?: Uint8Array;
    };

interface ImageJob {
  path: string;
  format: ImageHeader["format"];
  orientation: number;
  maxPixels: number;
  outputs: WorkerOutput[];
}

type ImageWorkerMessage = { ok: true; results: WorkerResult[] } | { ok: false; error: string };

function applyPrepared(reference: AgentTimelineImage, prepared: ChatImagePrepared): void {
  if (prepared.thumbhash) reference.thumbhash = prepared.thumbhash;
  reference.display = {
    width: prepared.display.width,
    height: prepared.display.height,
    byteSize: prepared.display.byteSize,
  };
}

function runImageWorker(job: ImageJob): Promise<WorkerResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./thumbnail-worker.cjs", import.meta.url), {
      workerData: job,
    });
    let settled = false;
    const finish = (error: Error | null, value?: WorkerResult[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () => finish(new Error("Image worker timed out")),
      THUMBNAIL_TIMEOUT_MS,
    );
    worker.once("message", (message: ImageWorkerMessage) => {
      if (!message.ok) finish(new Error(message.error));
      else finish(null, message.results);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error(`Image worker exited with code ${code}`));
    });
  });
}

let configuredStore: ChatImageStore | null = null;

/** Called once at daemon start with `$PASEO_HOME/chat-images`. */
export function configureChatImageStore(directory: string): ChatImageStore {
  configuredStore = new ChatImageStore(directory);
  return configuredStore;
}

/** The daemon's store. Unconfigured (unit tests), it lives in the OS temp dir. */
export function getChatImageStore(): ChatImageStore {
  configuredStore ??= new ChatImageStore(
    path.join(os.tmpdir(), `paseo-chat-images-${process.getuid?.() ?? "user"}`),
  );
  return configuredStore;
}

/** References for the image blocks of a provider message or tool result. Never throws. */
export function storeChatImages(
  blocks: readonly ChatImageInput[],
  store: ChatImageStore = getChatImageStore(),
): AgentTimelineImage[] {
  const images: AgentTimelineImage[] = [];
  for (const block of blocks) {
    try {
      const image = store.put(block);
      if (image) images.push(image);
    } catch {
      // A failed write loses the preview, never the message.
    }
  }
  return images;
}
