/** ~16 kbps voice Opus: about 2 KB/s of audio instead of 32 KB/s of PCM16. */
export const DICTATION_OPUS_BITRATE = 16_000;

/** The slice of `@getpaseo/expo-two-way-audio` the dictation encoder uses. */
export interface NativeOpusEncoderPort {
  isOpusEncoderAvailable?: () => boolean;
  createOpusEncoder?: (bitRate: number) => number;
  opusEncode?: (handle: number, pcm: Uint8Array) => Uint8Array;
  flushOpusEncoder?: (handle: number) => Uint8Array;
  releaseOpusEncoder?: (handle: number) => void;
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
    return Uint8Array.from(value as number[]);
  }
  return null;
}

/** Bytes are whole len16 packets: [len hi, len lo, ...len bytes]*. */
function isWholeLen16(bytes: Uint8Array): boolean {
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) return false;
    const size = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (size === 0) return false;
    offset += 2 + size;
  }
  return offset === bytes.length;
}

type EncoderPort = Required<
  Pick<NativeOpusEncoderPort, "opusEncode" | "flushOpusEncoder" | "releaseOpusEncoder">
>;

function encoderPortOf(
  native: NativeOpusEncoderPort | null | undefined,
): (EncoderPort & { createOpusEncoder: (bitRate: number) => number }) | null {
  if (
    !native ||
    typeof native.createOpusEncoder !== "function" ||
    typeof native.opusEncode !== "function" ||
    typeof native.flushOpusEncoder !== "function" ||
    typeof native.releaseOpusEncoder !== "function"
  ) {
    return null;
  }
  if (typeof native.isOpusEncoderAvailable === "function" && !native.isOpusEncoderAvailable()) {
    return null;
  }
  return {
    createOpusEncoder: native.createOpusEncoder,
    opusEncode: native.opusEncode,
    flushOpusEncoder: native.flushOpusEncoder,
    releaseOpusEncoder: native.releaseOpusEncoder,
  };
}

/** 20 ms of silence must come back as whole len16 packets (at least one). */
function passesSelfTest(port: EncoderPort, probe: number): boolean {
  try {
    const head = toBytes(port.opusEncode(probe, new Uint8Array(640)));
    const tail = toBytes(port.flushOpusEncoder(probe));
    return (
      head !== null &&
      tail !== null &&
      head.length + tail.length > 0 &&
      isWholeLen16(head) &&
      isWholeLen16(tail)
    );
  } catch {
    return false;
  } finally {
    try {
      port.releaseOpusEncoder(probe);
    } catch {
      // ignore
    }
  }
}

function createHandle(port: { createOpusEncoder: (bitRate: number) => number }, bitRate: number) {
  try {
    const handle = port.createOpusEncoder(bitRate);
    return typeof handle === "number" && handle >= 0 ? handle : null;
  } catch {
    return null;
  }
}

/**
 * One recording's PCM16 -> Opus pipeline on top of the native AudioToolbox encoder.
 * `encode` and `flush` return len16-framed packets (possibly empty).
 */
export class OpusSegmentEncoder {
  private handle: number | null;

  private constructor(
    private readonly native: EncoderPort,
    handle: number,
  ) {
    this.handle = handle;
  }

  /**
   * An encoder that passed a 20 ms self-test, or null (old binary, Android, codec missing,
   * unexpected output). Null means: record PCM, which every daemon reads.
   */
  static create(
    native: NativeOpusEncoderPort | null | undefined,
    bitRate = DICTATION_OPUS_BITRATE,
  ): OpusSegmentEncoder | null {
    const port = encoderPortOf(native);
    if (!port) return null;
    const probe = createHandle(port, bitRate);
    if (probe === null || !passesSelfTest(port, probe)) return null;
    const handle = createHandle(port, bitRate);
    return handle === null ? null : new OpusSegmentEncoder(port, handle);
  }

  encode(pcm: Uint8Array): Uint8Array {
    if (this.handle === null) return new Uint8Array();
    return toBytes(this.native.opusEncode(this.handle, pcm)) ?? new Uint8Array();
  }

  /** Last packets (tail padded to a full frame), then the encoder is released. */
  finish(): Uint8Array {
    if (this.handle === null) return new Uint8Array();
    const handle = this.handle;
    this.handle = null;
    try {
      return toBytes(this.native.flushOpusEncoder(handle)) ?? new Uint8Array();
    } finally {
      this.native.releaseOpusEncoder(handle);
    }
  }

  release(): void {
    if (this.handle === null) return;
    const handle = this.handle;
    this.handle = null;
    this.native.releaseOpusEncoder(handle);
  }
}
