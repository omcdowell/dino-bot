import * as zlib from "node:zlib";
import { deflateRawSync } from "node:zlib";
import {
  CHECKED_JSON_HEADER_BYTES,
  CompressedJsonHistory,
  CompressedJsonOpcode,
  crc32,
  encodeCompressionResetAck,
  writeCheckedFrameHeader,
  ZstdJsonOpcode,
} from "./compressed-json.js";

/** Sender side (Node only): one per socket. See compressed-json.ts for the format. */
export class JsonFrameCompressor {
  private readonly history = new CompressedJsonHistory();

  compress(text: string): Uint8Array {
    const plain = Buffer.from(text, "utf8");
    const body = deflateRawSync(plain, { level: 6, dictionary: this.history.dictionary });
    this.history.append(plain);
    const frame = new Uint8Array(body.length + 1);
    frame[0] = CompressedJsonOpcode;
    frame.set(body, 1);
    return frame;
  }
}

/** How much of its recent JSON stream a checked socket keeps for resending after a reset. */
export const CHECKED_JSON_RESEND_MAX_FRAMES = 512;
export const CHECKED_JSON_RESEND_MAX_BYTES = 512 * 1024;

/**
 * Sender side of checked frames (Node only): one per socket. Keeps the plain text of its recent
 * frames so a reset can resend them against a fresh history. See compressed-json.ts.
 */
export class CheckedJsonFrameCompressor {
  private history = new CompressedJsonHistory();
  private generation = 0;
  private nextSeq = 0;
  private readonly recent: Array<{ seq: number; text: string; bytes: number }> = [];
  private recentBytes = 0;

  compress(text: string): Uint8Array {
    const plain = Buffer.from(text, "utf8");
    const body = deflateRawSync(plain, { level: 6, dictionary: this.history.dictionary });
    this.history.append(plain);
    const frame = new Uint8Array(body.length + CHECKED_JSON_HEADER_BYTES);
    const seq = this.nextSeq;
    writeCheckedFrameHeader(frame, { generation: this.generation, seq, crc: crc32(plain) });
    frame.set(body, CHECKED_JSON_HEADER_BYTES);
    this.nextSeq = (seq + 1) & 0xffff;
    this.remember(seq, text, plain.length);
    return frame;
  }

  /**
   * The receiver asked to start again from `seq`. Returns the ack and the frames to resend (already
   * compressed in the new generation, in order), or null when the reset is stale (an older
   * generation) or the frames are no longer held: then the caller closes the socket.
   */
  reset(request: { generation: number; seq: number }): { ack: Uint8Array; frames: Uint8Array[] } | "stale" | null {
    if (request.generation !== this.generation) return "stale";
    const start = this.recent.findIndex((entry) => entry.seq === request.seq);
    const resendAll = request.seq === this.nextSeq;
    if (start < 0 && !resendAll) return null;
    const texts = resendAll ? [] : this.recent.slice(start).map((entry) => entry.text);
    this.history = new CompressedJsonHistory();
    this.generation = (this.generation + 1) & 0xff;
    this.recent.length = 0;
    this.recentBytes = 0;
    const ack = encodeCompressionResetAck({ generation: this.generation, seq: this.nextSeq });
    return { ack, frames: texts.map((text) => this.compress(text)) };
  }

  private remember(seq: number, text: string, bytes: number): void {
    this.recent.push({ seq, text, bytes });
    this.recentBytes += bytes;
    while (
      this.recent.length > CHECKED_JSON_RESEND_MAX_FRAMES ||
      (this.recentBytes > CHECKED_JSON_RESEND_MAX_BYTES && this.recent.length > 1)
    ) {
      this.recentBytes -= this.recent.shift()!.bytes;
    }
  }
}

/** Window and match tables of the per-socket zstd stream: ~0.8 MB of memory per socket. */
export const ZSTD_FRAME_PARAMS = {
  level: 6,
  windowLog: 18,
  hashLog: 16,
  chainLog: 16,
} as const;

/** The slice of node:zlib's zstd API used here (Node 22.15+/23.8+; older @types/node lack it). */
interface ZstdCompress {
  write(chunk: Buffer): boolean;
  flush(kind: number, callback: () => void): void;
  close(): void;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}
const zstdApi = zlib as unknown as {
  createZstdCompress?: (options: { params: Record<number, number> }) => ZstdCompress;
  constants: Record<string, number>;
};

/** Whether this Node has streaming zstd (node:zlib, Node 22.15+/23.8+). */
export function zstdFramesAvailable(): boolean {
  return typeof zstdApi.createZstdCompress === "function";
}

function openZstdStream(): ZstdCompress {
  const c = zstdApi.constants as Record<string, number>;
  if (!zstdApi.createZstdCompress) throw new Error("node:zlib has no zstd");
  return zstdApi.createZstdCompress({
    params: {
      [c.ZSTD_c_compressionLevel!]: ZSTD_FRAME_PARAMS.level,
      [c.ZSTD_c_windowLog!]: ZSTD_FRAME_PARAMS.windowLog,
      [c.ZSTD_c_hashLog!]: ZSTD_FRAME_PARAMS.hashLog,
      [c.ZSTD_c_chainLog!]: ZSTD_FRAME_PARAMS.chainLog,
      [c.ZSTD_c_checksumFlag!]: 0,
    },
  });
}

/** One zstd stream; `push` compresses a message and flushes, in call order. */
class ZstdStream {
  private readonly stream = openZstdStream();
  private readonly chunks: Buffer[] = [];
  private failure: Error | null = null;
  private closed = false;

  constructor() {
    this.stream.on("data", (chunk: Buffer) => this.chunks.push(chunk));
    this.stream.on("error", (error: Error) => {
      this.failure = error;
    });
  }

  push(plain: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.failure || this.closed) {
        reject(this.failure ?? new Error("zstd stream closed"));
        return;
      }
      this.stream.write(plain);
      this.stream.flush(zstdApi.constants.ZSTD_e_flush!, () => {
        if (this.failure) {
          reject(this.failure);
          return;
        }
        const body = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
        this.chunks.length = 0;
        resolve(body);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.close();
  }
}

/**
 * Sender side of zstd frames (0x24, client capability zstd_frames): one zstd stream per socket,
 * flushed per message. Compression runs on the libuv pool, so `compress` returns a promise; the
 * caller sends results in call order (frames carry their seq from the moment of the call).
 * Resend and reset work as in CheckedJsonFrameCompressor; a reset opens a new stream.
 */
export class ZstdJsonFrameCompressor {
  private stream = new ZstdStream();
  private generation = 0;
  private nextSeq = 0;
  private readonly recent: Array<{ seq: number; text: string; bytes: number }> = [];
  private recentBytes = 0;
  private tail: Promise<unknown> = Promise.resolve();

  compress(text: string): Promise<Uint8Array> {
    const plain = Buffer.from(text, "utf8");
    const seq = this.nextSeq;
    const generation = this.generation;
    const stream = this.stream;
    const crc = crc32(plain);
    this.nextSeq = (seq + 1) & 0xffff;
    this.remember(seq, text, plain.length);
    const result = this.tail.then(() => stream.push(plain)).then((body) => {
      const frame = new Uint8Array(body.length + CHECKED_JSON_HEADER_BYTES);
      writeCheckedFrameHeader(frame, { generation, seq, crc }, ZstdJsonOpcode);
      frame.set(body, CHECKED_JSON_HEADER_BYTES);
      return frame;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** As CheckedJsonFrameCompressor.reset, with the resent frames still being compressed. */
  reset(
    request: { generation: number; seq: number },
  ): { ack: Uint8Array; frames: Promise<Uint8Array>[] } | "stale" | null {
    if (request.generation !== this.generation) return "stale";
    const start = this.recent.findIndex((entry) => entry.seq === request.seq);
    const resendAll = request.seq === this.nextSeq;
    if (start < 0 && !resendAll) return null;
    const texts = resendAll ? [] : this.recent.slice(start).map((entry) => entry.text);
    const old = this.stream;
    void this.tail.then(() => old.close());
    this.stream = new ZstdStream();
    this.generation = (this.generation + 1) & 0xff;
    this.recent.length = 0;
    this.recentBytes = 0;
    const ack = encodeCompressionResetAck({ generation: this.generation, seq: this.nextSeq });
    return { ack, frames: texts.map((text) => this.compress(text)) };
  }

  /** The socket closed: free the stream (its window and tables live outside the JS heap). */
  dispose(): void {
    const stream = this.stream;
    void this.tail.then(() => stream.close());
  }

  private remember(seq: number, text: string, bytes: number): void {
    this.recent.push({ seq, text, bytes });
    this.recentBytes += bytes;
    while (
      this.recent.length > CHECKED_JSON_RESEND_MAX_FRAMES ||
      (this.recentBytes > CHECKED_JSON_RESEND_MAX_BYTES && this.recent.length > 1)
    ) {
      this.recentBytes -= this.recent.shift()!.bytes;
    }
  }
}
