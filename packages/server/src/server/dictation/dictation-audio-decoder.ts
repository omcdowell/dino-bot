import { OpusDecoder } from "opus-decoder";
import {
  resolveDictationAudioEncoding,
  splitLen16OpusPackets,
} from "@getpaseo/protocol/dictation-audio-format";

/**
 * Turns dictation chunks into PCM16LE mono at the format's rate. Chunks must be fed in seq
 * order (Opus is stateful across packets); the stream manager already forwards in order.
 */
export interface DictationAudioDecoder {
  readonly encoding: "pcm16" | "opus-len16";
  /** Resolves once decode() may be called (Opus compiles its WebAssembly first). */
  readonly ready: Promise<void>;
  decode(chunk: Buffer): Buffer;
  close(): void;
}

const OPUS_DECODE_RATES = new Set([8000, 12000, 16000, 24000, 48000]);

class Pcm16PassthroughDecoder implements DictationAudioDecoder {
  readonly encoding = "pcm16" as const;
  readonly ready = Promise.resolve();
  decode(chunk: Buffer): Buffer {
    return chunk;
  }
  close(): void {}
}

interface OpusFrameDecoder {
  ready: Promise<void>;
  decodeFrame(frame: Uint8Array): {
    channelData: Float32Array[];
    samplesDecoded: number;
    errors: Array<{ message: string }>;
  };
  free(): void;
}

export function float32ToPcm16le(samples: Float32Array, count = samples.length): Buffer {
  const out = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), i * 2);
  }
  return out;
}

class OpusLen16Decoder implements DictationAudioDecoder {
  readonly encoding = "opus-len16" as const;
  readonly ready: Promise<void>;
  constructor(private readonly decoder: OpusFrameDecoder) {
    this.ready = decoder.ready;
  }

  decode(chunk: Buffer): Buffer {
    const packets = splitLen16OpusPackets(chunk);
    const parts: Buffer[] = [];
    for (const packet of packets) {
      const decoded = this.decoder.decodeFrame(packet);
      if (decoded.errors.length > 0) {
        throw new Error(`Opus decode failed: ${decoded.errors[0]?.message ?? "unknown error"}`);
      }
      const channel = decoded.channelData[0];
      if (channel && decoded.samplesDecoded > 0) {
        parts.push(float32ToPcm16le(channel, decoded.samplesDecoded));
      }
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  close(): void {
    try {
      this.decoder.free();
    } catch {
      // already freed
    }
  }
}

/**
 * Decoder for a dictation format, or an Error describing why the format is not readable.
 * Opus uses `opus-decoder` (libopus compiled to WebAssembly; no native build on the daemon).
 */
export function createDictationAudioDecoder(
  format: string,
  inputRate: number,
): DictationAudioDecoder {
  const encoding = resolveDictationAudioEncoding(format);
  if (encoding === null) {
    throw new Error(`Unsupported dictation audio format: ${format}`);
  }
  if (encoding === "pcm16") {
    return new Pcm16PassthroughDecoder();
  }
  if (!OPUS_DECODE_RATES.has(inputRate)) {
    throw new Error(`Unsupported Opus dictation rate: ${inputRate}`);
  }
  const decoder = new OpusDecoder({
    channels: 1,
    sampleRate: inputRate as 16000,
  }) as unknown as OpusFrameDecoder;
  return new OpusLen16Decoder(decoder);
}
