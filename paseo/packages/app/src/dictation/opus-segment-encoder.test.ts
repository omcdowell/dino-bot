import { describe, expect, it, vi } from "vitest";
import { splitLen16OpusPackets } from "@getpaseo/protocol/dictation-audio-format";

import { OpusSegmentEncoder, type NativeOpusEncoderPort } from "./opus-segment-encoder";

/**
 * Stand-in for the native AudioToolbox encoder with the same contract: 20 ms (640-byte) PCM16
 * frames in, one len16 packet per frame out, partial frames held until the next call, flush
 * pads the tail. The "packet" is 3 bytes: frame index + first sample byte, enough to check
 * framing and order.
 */
function fakeNative(overrides: Partial<NativeOpusEncoderPort> = {}) {
  const pending = new Map<number, number[]>();
  const frames = new Map<number, number>();
  let next = 1;
  const packet = (handle: number, first: number) => {
    const index = frames.get(handle) ?? 0;
    frames.set(handle, index + 1);
    return [0, 3, 0xaa, index & 0xff, first & 0xff];
  };
  const drain = (handle: number, pad: boolean) => {
    const buf = pending.get(handle) ?? [];
    if (pad && buf.length % 640 !== 0) {
      buf.push(...Array.from({ length: 640 - (buf.length % 640) }, () => 0));
    }
    const out: number[] = [];
    while (buf.length >= 640) {
      const frame = buf.splice(0, 640);
      out.push(...packet(handle, frame[0]!));
    }
    pending.set(handle, buf);
    return new Uint8Array(out);
  };
  const native = {
    isOpusEncoderAvailable: vi.fn(() => true),
    createOpusEncoder: vi.fn((_bitRate: number) => {
      const handle = next++;
      pending.set(handle, []);
      return handle;
    }),
    opusEncode: vi.fn((handle: number, pcm: Uint8Array) => {
      pending.get(handle)!.push(...pcm);
      return drain(handle, false);
    }),
    flushOpusEncoder: vi.fn((handle: number) => drain(handle, true)),
    releaseOpusEncoder: vi.fn((handle: number) => {
      pending.delete(handle);
    }),
    ...overrides,
  };
  return native;
}

describe("OpusSegmentEncoder", () => {
  it("returns whole len16 packets per capture callback and pads the tail on finish", () => {
    const native = fakeNative();
    const encoder = OpusSegmentEncoder.create(native, 16000)!;
    expect(encoder).not.toBeNull();
    expect(native.createOpusEncoder).toHaveBeenLastCalledWith(16000);

    // 4096 bytes = 6 whole 640-byte frames + 256 bytes carried over.
    const first = encoder.encode(new Uint8Array(4096).fill(1));
    expect(splitLen16OpusPackets(first)).toHaveLength(6);
    // 384 more completes frame 7 exactly.
    const second = encoder.encode(new Uint8Array(384).fill(2));
    expect(splitLen16OpusPackets(second).map((p) => p[1])).toEqual([6]);
    // Less than one frame: nothing yet.
    expect(encoder.encode(new Uint8Array(100).fill(3))).toHaveLength(0);
    const tail = encoder.finish();
    expect(splitLen16OpusPackets(tail).map((p) => [p[1], p[2]])).toEqual([[7, 3]]);
    expect(native.releaseOpusEncoder).toHaveBeenCalledTimes(2); // self-test + finish
    // Finished: further calls are inert.
    expect(encoder.encode(new Uint8Array(640))).toHaveLength(0);
    expect(encoder.finish()).toHaveLength(0);
  });

  it("is null on an old binary or a platform without the native encoder (records PCM)", () => {
    expect(OpusSegmentEncoder.create(null)).toBeNull();
    expect(OpusSegmentEncoder.create({})).toBeNull();
    expect(
      OpusSegmentEncoder.create(fakeNative({ isOpusEncoderAvailable: () => false })),
    ).toBeNull();
    expect(OpusSegmentEncoder.create(fakeNative({ createOpusEncoder: () => -1 }))).toBeNull();
  });

  it("is null when the self-test output is not whole len16 packets", () => {
    const garbage = fakeNative({
      opusEncode: () => new Uint8Array([0, 9, 1]),
      flushOpusEncoder: () => new Uint8Array(),
    });
    expect(OpusSegmentEncoder.create(garbage)).toBeNull();
    expect(garbage.releaseOpusEncoder).toHaveBeenCalledTimes(1);

    const throws = fakeNative({
      opusEncode: () => {
        throw new Error("codec missing");
      },
    });
    expect(OpusSegmentEncoder.create(throws)).toBeNull();
  });

  it("release() frees the native encoder without emitting the tail", () => {
    const native = fakeNative();
    const encoder = OpusSegmentEncoder.create(native)!;
    encoder.encode(new Uint8Array(100));
    encoder.release();
    expect(native.flushOpusEncoder).toHaveBeenCalledTimes(1); // only the self-test
    expect(encoder.finish()).toHaveLength(0);
  });
});
