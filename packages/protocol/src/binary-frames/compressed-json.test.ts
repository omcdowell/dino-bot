import { describe, expect, test } from "vitest";
import {
  CheckedJsonFrameCompressor,
  JsonFrameCompressor,
  ZstdJsonFrameCompressor,
  zstdFramesAvailable,
} from "./compressed-json-node.js";
import {
  CheckedJsonFrameDecoder,
  CheckedJsonFrameEncoder,
  CheckedJsonOpcode,
  ZstdJsonOpcode,
  crc32,
  decodeCompressionReset,
  decodeCompressionResetAck,
  isCheckedJsonFrame,
  readCheckedFrameHeader,
  CompressedJsonOpcode,
  isCompressedJsonFrame,
  JsonFrameDecompressor,
} from "./compressed-json.js";

test("frames decode in order through one shared dictionary and shrink", () => {
  const compressor = new JsonFrameCompressor();
  const decompressor = new JsonFrameDecompressor();
  let plain = 0;
  let compressed = 0;
  for (let index = 0; index < 40; index += 1) {
    const text = JSON.stringify({
      type: "session",
      message: {
        type: "agent_stream",
        payload: { agentId: "agent-1", seq: index, event: { text: `token ${index} é ✓` } },
      },
    });
    const frame = compressor.compress(text);
    expect(frame[0]).toBe(CompressedJsonOpcode);
    expect(isCompressedJsonFrame(frame)).toBe(true);
    expect(decompressor.decompress(frame)).toBe(text);
    plain += text.length;
    compressed += frame.length;
  }
  expect(compressed / plain).toBeLessThan(0.25);
});

test("frames of every size decode in order, including ones larger than the history", () => {
  const compressor = new JsonFrameCompressor();
  const decompressor = new JsonFrameDecompressor();
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let index = 0; index < 300; index += 1) {
    const length = Math.floor(random() ** 3 * 200_000) + 1;
    let text = "";
    while (text.length < length) {
      text +=
        random() < 0.5
          ? `{"type":"agent_stream","seq":${Math.floor(random() * 1e6)}}`
          : String.fromCharCode(32 + Math.floor(random() * 2000));
    }
    expect(decompressor.decompress(compressor.compress(text)) === text).toBe(true);
  }
});

test("a large frame round-trips", () => {
  const text = JSON.stringify({
    rows: Array.from({ length: 5000 }, (_, i) => ({ i, s: "x".repeat(i % 50) })),
  });
  const frame = new JsonFrameCompressor().compress(text);
  expect(new JsonFrameDecompressor().decompress(frame)).toBe(text);
});

describe("checked frames", () => {
  const message = (index: number) =>
    JSON.stringify({ type: "session", message: { type: "agent_stream", payload: { seq: index } } });

  test("every frame decodes in order and carries its sequence and checksum", () => {
    const compressor = new CheckedJsonFrameCompressor();
    const decoder = new CheckedJsonFrameDecoder();
    for (let index = 0; index < 50; index += 1) {
      const frame = compressor.compress(message(index));
      expect(isCheckedJsonFrame(frame)).toBe(true);
      expect(readCheckedFrameHeader(frame).seq).toBe(index);
      expect(decoder.decode(frame)).toEqual({ kind: "message", text: message(index) });
    }
  });

  test("a corrupted frame asks for a reset; the resent frames decode and nothing is lost", () => {
    const compressor = new CheckedJsonFrameCompressor();
    const decoder = new CheckedJsonFrameDecoder();
    const received: string[] = [];
    const deliver = (frame: Uint8Array) => {
      const result = decoder.decode(frame);
      if (result.kind === "message") received.push(result.text);
      return result;
    };
    for (let index = 0; index < 5; index += 1) deliver(compressor.compress(message(index)));
    const broken = compressor.compress(message(5));
    broken[broken.length - 2] ^= 0xff;
    const result = deliver(broken);
    expect(result.kind).toBe("reset");
    // Frames already in flight are dropped until the ack.
    expect(deliver(compressor.compress(message(6)))).toEqual({ kind: "dropped" });
    const reset = decodeCompressionReset((result as { reset: Uint8Array }).reset)!;
    expect(reset).toEqual({ generation: 0, seq: 5 });
    const answer = compressor.reset(reset);
    if (!answer || answer === "stale") throw new Error("expected a resend");
    expect(decoder.acceptResetAck(decodeCompressionResetAck(answer.ack)!)).toBe(true);
    for (const frame of answer.frames) deliver(frame);
    deliver(compressor.compress(message(7)));
    expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(message));
  });

  test("a frame decoded against the wrong history fails its checksum instead of passing garbage", () => {
    const compressor = new CheckedJsonFrameCompressor();
    const decoder = new CheckedJsonFrameDecoder();
    const text = JSON.stringify({ type: "x", body: "abcdefgh".repeat(40) });
    decoder.decode(compressor.compress(text));
    // Same sequence, different history: a receiver that lost its history (new socket).
    const fresh = new CheckedJsonFrameDecoder();
    const result = fresh.decode(compressor.compress(text));
    expect(result.kind).toBe("reset");
  });

  test("a missing frame is noticed by its sequence number", () => {
    const compressor = new CheckedJsonFrameCompressor();
    const decoder = new CheckedJsonFrameDecoder();
    decoder.decode(compressor.compress(message(0)));
    compressor.compress(message(1));
    const result = decoder.decode(compressor.compress(message(2)));
    expect(result.kind).toBe("reset");
    expect(decodeCompressionReset((result as { reset: Uint8Array }).reset)).toEqual({
      generation: 0,
      seq: 1,
    });
  });

  test("a reset for frames no longer held, or of an older generation, is refused", () => {
    const compressor = new CheckedJsonFrameCompressor();
    for (let index = 0; index < 600; index += 1) compressor.compress(message(index));
    expect(compressor.reset({ generation: 0, seq: 3 })).toBeNull();
    expect(compressor.reset({ generation: 7, seq: 3 })).toBe("stale");
  });

  test("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe.runIf(zstdFramesAvailable())("zstd frames", () => {
  const message = (index: number) =>
    JSON.stringify({
      type: "session",
      message: { type: "agent_stream", payload: { seq: index, text: `token ${index} `.repeat(index % 7) } },
    });

  test("one stream per socket: every frame decodes in order and later ones shrink", async () => {
    const compressor = new ZstdJsonFrameCompressor();
    const decoder = new CheckedJsonFrameDecoder();
    const frames = await Promise.all(Array.from({ length: 200 }, (_, index) => compressor.compress(message(index))));
    frames.forEach((frame, index) => {
      expect(frame[0]).toBe(ZstdJsonOpcode);
      expect(readCheckedFrameHeader(frame).seq).toBe(index);
      expect(decoder.decode(frame)).toEqual({ kind: "message", text: message(index) });
    });
    const plain = frames.reduce((sum, _frame, index) => sum + message(index).length, 0);
    const wire = frames.reduce((sum, frame) => sum + frame.length, 0);
    expect(wire).toBeLessThan(plain / 3);
    compressor.dispose();
  });

  test("large frames, beyond the window, round-trip", async () => {
    const compressor = new ZstdJsonFrameCompressor();
    const decoder = new CheckedJsonFrameDecoder();
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let index = 0; index < 20; index += 1) {
      const size = Math.floor(random() * 600_000);
      let text = "";
      while (text.length < size) text += String.fromCharCode(32 + Math.floor(random() * 90)) + "agent ";
      const result = decoder.decode(await compressor.compress(JSON.stringify({ text })));
      expect(result).toEqual({ kind: "message", text: JSON.stringify({ text }) });
    }
    compressor.dispose();
  });

  test("a corrupted frame asks for a reset; a new stream resends and nothing is lost", async () => {
    const compressor = new ZstdJsonFrameCompressor();
    const decoder = new CheckedJsonFrameDecoder();
    const received: string[] = [];
    const deliver = (frame: Uint8Array) => {
      const result = decoder.decode(frame);
      if (result.kind === "message") received.push(result.text);
      return result;
    };
    for (let index = 0; index < 5; index += 1) deliver(await compressor.compress(message(index)));
    const broken = await compressor.compress(message(5));
    broken[broken.length - 1] ^= 0xff;
    const result = deliver(broken);
    expect(result.kind).toBe("reset");
    expect(deliver(await compressor.compress(message(6)))).toEqual({ kind: "dropped" });
    const reset = decodeCompressionReset((result as { reset: Uint8Array }).reset)!;
    const answer = compressor.reset(reset);
    if (!answer || answer === "stale") throw new Error("expected a resend");
    expect(decoder.acceptResetAck(decodeCompressionResetAck(answer.ack)!)).toBe(true);
    for (const frame of await Promise.all(answer.frames)) deliver(frame);
    deliver(await compressor.compress(message(7)));
    expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(message));
    compressor.dispose();
  });

  test("a frame from another stream fails instead of passing garbage", async () => {
    const compressor = new ZstdJsonFrameCompressor();
    const decoder = new CheckedJsonFrameDecoder();
    decoder.decode(await compressor.compress(message(1)));
    const second = await compressor.compress(message(2));
    expect(new CheckedJsonFrameDecoder().decode(second).kind).toBe("reset");
    compressor.dispose();
  });
});

describe("checked uplink frames", () => {
  test("the pure-JS encoder's frames decode in order on the other side, every size", () => {
    const encoder = new CheckedJsonFrameEncoder();
    const decoder = new CheckedJsonFrameDecoder();
    for (let index = 0; index < 300; index += 1) {
      const text = JSON.stringify({ type: "ping", index, pad: "x".repeat(index % 50 === 0 ? 70_000 : index) });
      const frame = encoder.encode(text);
      if (text.length > 64 * 1024) {
        expect(frame).toBe(text);
        continue;
      }
      if (typeof frame === "string") throw new Error("expected a binary frame");
      expect(frame[0]).toBe(CheckedJsonOpcode);
      expect(decoder.decode(frame)).toEqual({ kind: "message", text });
    }
  });

  test("small repeated frames shrink well below their size", () => {
    const encoder = new CheckedJsonFrameEncoder();
    const text = JSON.stringify({ type: "session", message: { type: "client_heartbeat", requestId: "abc" } });
    encoder.encode(text);
    expect((encoder.encode(text) as Uint8Array).length).toBeLessThan(text.length / 2);
  });
});
