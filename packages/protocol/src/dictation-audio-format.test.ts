import { describe, expect, it } from "vitest";

import {
  DICTATION_OPUS_FORMAT,
  DICTATION_PCM_FORMAT,
  isDictationOpusFormat,
  joinLen16OpusPackets,
  resolveDictationAudioEncoding,
  splitLen16OpusPackets,
} from "./dictation-audio-format";
import { DictationStreamAckMessageSchema, DictationStreamStartMessageSchema } from "./messages";

describe("dictation audio format", () => {
  it("reads PCM and len16 Opus format strings", () => {
    expect(resolveDictationAudioEncoding(DICTATION_PCM_FORMAT)).toBe("pcm16");
    expect(resolveDictationAudioEncoding("audio/pcm;rate=24000;bits=16")).toBe("pcm16");
    expect(resolveDictationAudioEncoding(DICTATION_OPUS_FORMAT)).toBe("opus-len16");
    expect(resolveDictationAudioEncoding("AUDIO/OPUS; rate=16000; framing=LEN16")).toBe(
      "opus-len16",
    );
    expect(resolveDictationAudioEncoding("audio/opus;rate=16000;framing=ogg")).toBeNull();
    expect(
      resolveDictationAudioEncoding("audio/opus;rate=16000;channels=2;framing=len16"),
    ).toBeNull();
    expect(isDictationOpusFormat(DICTATION_OPUS_FORMAT)).toBe(true);
    expect(isDictationOpusFormat(DICTATION_PCM_FORMAT)).toBe(false);
  });

  it("frames packets as 2-byte big-endian length + bytes", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array(300).fill(7);
    const framed = joinLen16OpusPackets([a, b]);
    expect(Array.from(framed.subarray(0, 5))).toEqual([0, 3, 1, 2, 3]);
    expect(Array.from(framed.subarray(5, 7))).toEqual([0x01, 0x2c]);
    expect(framed.length).toBe(2 + 3 + 2 + 300);
    const split = splitLen16OpusPackets(framed);
    expect(split.map((p) => Array.from(p))).toEqual([Array.from(a), Array.from(b)]);
  });

  it("an empty chunk holds no packets", () => {
    expect(splitLen16OpusPackets(new Uint8Array())).toEqual([]);
    expect(joinLen16OpusPackets([])).toEqual(new Uint8Array());
  });

  it("rejects truncated or empty packets", () => {
    expect(() => splitLen16OpusPackets(new Uint8Array([0]))).toThrow(/Truncated/);
    expect(() => splitLen16OpusPackets(new Uint8Array([0, 5, 1, 2]))).toThrow(/Truncated/);
    expect(() => splitLen16OpusPackets(new Uint8Array([0, 0]))).toThrow(/Truncated/);
    expect(() => joinLen16OpusPackets([new Uint8Array()])).toThrow(/Invalid/);
    expect(() => joinLen16OpusPackets([new Uint8Array(0x10000)])).toThrow(/Invalid/);
  });
});

describe("dictation resume wire fields", () => {
  it("start.resume and ack.resumed are optional (old peers omit them)", () => {
    expect(
      DictationStreamStartMessageSchema.parse({
        type: "dictation_stream_start",
        dictationId: "d",
        format: DICTATION_PCM_FORMAT,
      }).resume,
    ).toBeUndefined();
    expect(
      DictationStreamStartMessageSchema.parse({
        type: "dictation_stream_start",
        dictationId: "d",
        format: DICTATION_OPUS_FORMAT,
        resume: true,
      }).resume,
    ).toBe(true);
    expect(
      DictationStreamAckMessageSchema.parse({
        type: "dictation_stream_ack",
        payload: { dictationId: "d", ackSeq: 4, resumed: true },
      }).payload.resumed,
    ).toBe(true);
  });
});
