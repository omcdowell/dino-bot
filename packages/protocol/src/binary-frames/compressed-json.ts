import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { Decompress as ZstdDecompress } from "fzstd";

/**
 * Compressed JSON session frames (client capability compressed_frames).
 *
 * permessage-deflate would do this in the WebSocket layer, but React Native's iOS WebSocket does
 * not negotiate it, and that is the client most often on a weak cellular link. So the daemon
 * compresses JSON frames itself and sends them as binary frames [0x20, ...raw DEFLATE].
 *
 * Each frame is a complete DEFLATE stream, compressed against a preset dictionary: the last
 * 32 KiB of plain text carried by earlier compressed frames on the same socket. Both ends keep
 * that history, so small repetitive messages (streaming deltas, agent updates) shrink to about a
 * twentieth, yet every frame decodes on its own given the history. (Streaming DEFLATE with sync
 * flushes would be cheaper, but fflate's streaming compressor corrupts output under flushes.)
 *
 * Small frames may still arrive as plain text; they do not touch the history.
 */
export const CompressedJsonOpcode = 0x20;

/** Frames below this size go as plain text: compression saves little. */
export const COMPRESSED_JSON_MIN_BYTES = 160;

/** DEFLATE's window: older history cannot be referenced anyway. */
export const COMPRESSED_JSON_HISTORY_BYTES = 32 * 1024;

export function isCompressedJsonFrame(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes[0] === CompressedJsonOpcode;
}

/** Sliding window of the plain bytes carried by compressed frames on one socket. */
export class CompressedJsonHistory {
  private bytes = new Uint8Array(0);

  get dictionary(): Uint8Array | undefined {
    return this.bytes.length > 0 ? this.bytes : undefined;
  }

  append(plain: Uint8Array): void {
    const limit = COMPRESSED_JSON_HISTORY_BYTES;
    if (plain.length >= limit) {
      this.bytes = plain.slice(plain.length - limit);
      return;
    }
    const next = new Uint8Array(Math.min(limit, this.bytes.length + plain.length));
    const keep = next.length - plain.length;
    next.set(this.bytes.subarray(this.bytes.length - keep), 0);
    next.set(plain, keep);
    this.bytes = next;
  }
}

/** Receiver side: one per socket, fed every compressed frame in order. */
export class JsonFrameDecompressor {
  private readonly history = new CompressedJsonHistory();

  decompress(frame: Uint8Array): string {
    const plain = inflateSync(frame.subarray(1), { dictionary: this.history.dictionary });
    this.history.append(plain);
    return strFromU8(plain);
  }
}

/**
 * Checked frames (client capability checked_frames), the successor of the plain 0x20 frame:
 *
 *   [0x21, generation u8, seq u16 BE, crc32 u32 BE of the plain text, ...raw DEFLATE]
 *
 * On a checked socket every JSON frame the daemon sends is one of these, small ones too, so the
 * sequence numbers cover the whole JSON stream. The receiver checks that each frame is the next
 * in sequence, decodes against its history and compares the checksum. A frame that fails any of
 * these means its history no longer matches the sender's (the 2026-10-10 "invalid distance"):
 * a wrong dictionary can also decode silently to the wrong text, which only the checksum sees.
 *
 * Instead of dropping the socket, the receiver sends a reset [0x22, generation, seq of the first
 * frame it is missing], drops every JSON frame until the daemon's reset ack [0x23, next
 * generation, seq of the next frame], and starts again with an empty history. The daemon empties
 * its history and sends the frames from the missing one again, compressed afresh. If the daemon
 * no longer holds them it closes the socket and the client reconnects, as before.
 */
export const CheckedJsonOpcode = 0x21;
/**
 * zstd frames (client capability zstd_frames, on top of checked_frames): the same header, but the
 * body is the next piece of ONE zstd stream per socket, flushed after each message (what Discord
 * ships). The stream's window (256 KiB) replaces the 32 KiB history:
 *
 *   [0x24, generation u8, seq u16 BE, crc32 u32 BE of the plain text, ...zstd stream chunk]
 *
 * Sequence, checksum, reset and ack work exactly as for 0x21; a reset starts a new zstd stream.
 * The client decodes with fzstd (pure JS: Hermes has no WebAssembly).
 */
export const ZstdJsonOpcode = 0x24;
export const CompressionResetOpcode = 0x22;
export const CompressionResetAckOpcode = 0x23;
export const CHECKED_JSON_HEADER_BYTES = 8;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A checked frame of either codec: 0x21 (DEFLATE + history) or 0x24 (zstd stream). */
export function isCheckedJsonFrame(bytes: Uint8Array): boolean {
  return (
    bytes.length >= CHECKED_JSON_HEADER_BYTES &&
    (bytes[0] === CheckedJsonOpcode || bytes[0] === ZstdJsonOpcode)
  );
}

export interface CheckedFrameHeader {
  generation: number;
  seq: number;
  crc: number;
}

export function readCheckedFrameHeader(frame: Uint8Array): CheckedFrameHeader {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { generation: view.getUint8(1), seq: view.getUint16(2), crc: view.getUint32(4) };
}

export function writeCheckedFrameHeader(
  frame: Uint8Array,
  header: CheckedFrameHeader,
  opcode: number = CheckedJsonOpcode,
): void {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint8(0, opcode);
  view.setUint8(1, header.generation & 0xff);
  view.setUint16(2, header.seq & 0xffff);
  view.setUint32(4, header.crc >>> 0);
}

/** Receiver to sender: "my history broke at `seq`, start again from it". */
export function encodeCompressionReset(input: { generation: number; seq: number }): Uint8Array {
  const frame = new Uint8Array(4);
  const view = new DataView(frame.buffer);
  view.setUint8(0, CompressionResetOpcode);
  view.setUint8(1, input.generation & 0xff);
  view.setUint16(2, input.seq & 0xffff);
  return frame;
}

/** Sender to receiver: "history empty from here; the next frame is `seq` of `generation`". */
export function encodeCompressionResetAck(input: { generation: number; seq: number }): Uint8Array {
  const frame = encodeCompressionReset(input);
  frame[0] = CompressionResetAckOpcode;
  return frame;
}

function decodeResetLike(bytes: Uint8Array, opcode: number) {
  if (bytes.length !== 4 || bytes[0] !== opcode) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { generation: view.getUint8(1), seq: view.getUint16(2) };
}

export function decodeCompressionReset(bytes: Uint8Array) {
  return decodeResetLike(bytes, CompressionResetOpcode);
}

export function decodeCompressionResetAck(bytes: Uint8Array) {
  return decodeResetLike(bytes, CompressionResetAckOpcode);
}

export type CheckedFrameResult =
  | { kind: "message"; text: string }
  /** Send this reset upstream; JSON frames are dropped until the ack. */
  | { kind: "reset"; reset: Uint8Array; reason: string }
  /** Dropped while a reset is in flight. */
  | { kind: "dropped" };

/**
 * Receiver side of checked frames: one per socket, fed every checked frame and reset ack in order.
 * Never throws; a broken frame turns into a reset request.
 */
export class CheckedJsonFrameDecoder {
  private history = new CompressedJsonHistory();
  private zstd: { decoder: ZstdDecompress; out: Uint8Array[] } | null = null;
  private generation = 0;
  private nextSeq: number | null = null;
  private awaitingGeneration: number | null = null;
  private resetSentAt = 0;
  resets = 0;

  get awaitingReset(): boolean {
    return this.awaitingGeneration !== null;
  }

  /** ms since the pending reset was sent, or null. */
  resetPendingFor(now: number): number | null {
    return this.awaitingGeneration === null ? null : now - this.resetSentAt;
  }

  decode(frame: Uint8Array, now = Date.now()): CheckedFrameResult {
    if (this.awaitingGeneration !== null) return { kind: "dropped" };
    const header = readCheckedFrameHeader(frame);
    if (header.generation !== this.generation) {
      // A frame of an older generation can only come before the ack; never after it.
      return this.requestReset(this.nextSeq ?? header.seq, `generation ${header.generation} != ${this.generation}`, now);
    }
    if (this.nextSeq !== null && header.seq !== this.nextSeq) {
      return this.requestReset(this.nextSeq, `seq ${header.seq} != ${this.nextSeq}`, now);
    }
    let plain: Uint8Array;
    try {
      const body = frame.subarray(CHECKED_JSON_HEADER_BYTES);
      plain =
        frame[0] === ZstdJsonOpcode
          ? this.inflateZstd(body)
          : inflateSync(body, { dictionary: this.history.dictionary });
    } catch (error) {
      return this.requestReset(header.seq, error instanceof Error ? error.message : String(error), now);
    }
    if (crc32(plain) !== header.crc) {
      return this.requestReset(header.seq, "checksum mismatch", now);
    }
    if (frame[0] !== ZstdJsonOpcode) this.history.append(plain);
    this.nextSeq = (header.seq + 1) & 0xffff;
    return { kind: "message", text: strFromU8(plain) };
  }

  /** The sender's reset ack. Returns false when it does not answer the pending reset. */
  acceptResetAck(ack: { generation: number; seq: number }): boolean {
    if (this.awaitingGeneration === null || ack.generation !== this.awaitingGeneration) return false;
    this.generation = ack.generation;
    this.nextSeq = ack.seq;
    this.awaitingGeneration = null;
    return true;
  }

  /** The next chunk of this socket's zstd stream; the decoder keeps the window between frames. */
  private inflateZstd(body: Uint8Array): Uint8Array {
    if (!this.zstd) {
      const out: Uint8Array[] = [];
      this.zstd = { decoder: new ZstdDecompress((chunk) => out.push(chunk)), out };
    }
    const { decoder, out } = this.zstd;
    out.length = 0;
    decoder.push(body);
    if (out.length === 1) return out[0]!.slice();
    let length = 0;
    for (const chunk of out) length += chunk.length;
    const plain = new Uint8Array(length);
    let offset = 0;
    for (const chunk of out) {
      plain.set(chunk, offset);
      offset += chunk.length;
    }
    out.length = 0;
    return plain;
  }

  private requestReset(seq: number, reason: string, now: number): CheckedFrameResult {
    this.history = new CompressedJsonHistory();
    this.zstd = null;
    this.awaitingGeneration = (this.generation + 1) & 0xff;
    this.resetSentAt = now;
    this.resets += 1;
    return {
      kind: "reset",
      reset: encodeCompressionReset({ generation: this.generation, seq }),
      reason,
    };
  }
}

/**
 * Client to daemon (server_info.features.checkedUplink): JSON frames as checked DEFLATE frames
 * (0x21) against the last 32 KiB of what this client sent, every frame, small ones too. Pure JS
 * (fflate), so it runs on Hermes, web and Electron. One-shot DEFLATE per frame, not a stream:
 * fflate's streaming compressor corrupts output under flushes (2026-10-10, 1 in ~400 frames at
 * level 6), and no sound pure-JS zstd encoder exists. The daemon closes the socket on a frame
 * that does not decode or check; the client reconnects.
 */
export const CHECKED_UPLINK_MAX_BYTES = 64 * 1024;

export class CheckedJsonFrameEncoder {
  private readonly history = new CompressedJsonHistory();
  private nextSeq = 0;

  /**
   * Frames above CHECKED_UPLINK_MAX_BYTES (image attachments: base64, barely compressible) stay
   * plain text, so the phone's JS thread never spends long deflating one; they skip the history.
   * Cost on the phone (node --jitless): ~1-5 ms per frame, most of it fflate indexing the history.
   */
  encode(text: string): Uint8Array | string {
    if (text.length > CHECKED_UPLINK_MAX_BYTES) return text;
    const plain = strToU8(text);
    const body = deflateSync(plain, { level: 6, dictionary: this.history.dictionary });
    this.history.append(plain);
    const frame = new Uint8Array(body.length + CHECKED_JSON_HEADER_BYTES);
    writeCheckedFrameHeader(frame, { generation: 0, seq: this.nextSeq, crc: crc32(plain) });
    frame.set(body, CHECKED_JSON_HEADER_BYTES);
    this.nextSeq = (this.nextSeq + 1) & 0xffff;
    return frame;
  }
}
