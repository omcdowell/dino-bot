import { describe, expect, it } from "vitest";
import { JsonlFrameDecoder, type JsonlFrameProblem } from "./jsonl-frame-decoder.js";

function decoderHarness() {
  const frames: Record<string, unknown>[] = [];
  const problems: JsonlFrameProblem[] = [];
  return {
    frames,
    problems,
    decoder: new JsonlFrameDecoder({
      frame: (frame) => frames.push(frame),
      problem: (problem) => problems.push(problem),
    }),
  };
}

function chunkFrames(frame: Record<string, unknown>, chunkSize: number) {
  const payload = Buffer.from(JSON.stringify(frame));
  const count = Math.ceil(payload.byteLength / chunkSize);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId: "catalog",
    index,
    count,
    byteLength: payload.byteLength,
    data: payload.subarray(index * chunkSize, (index + 1) * chunkSize).toString("base64"),
  }));
}

describe("JsonlFrameDecoder", () => {
  it("publishes ordinary frames across arbitrary stream chunks", () => {
    const { decoder, frames, problems } = decoderHarness();
    decoder.write('{"type":"ready"');
    decoder.write('}\r\n{"type":"notice","value":2}\n');
    expect(frames).toEqual([{ type: "ready" }, { type: "notice", value: 2 }]);
    expect(problems).toEqual([]);
  });

  it("publishes several frames from one chunk and keeps a trailing partial line", () => {
    const { decoder, frames, problems } = decoderHarness();
    decoder.write('{"a":1}\n\n{"b":2}\r\n{"c"');
    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
    decoder.write(":3}");
    expect(frames).toHaveLength(2);
    decoder.write("\n");
    expect(frames).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(problems).toEqual([]);
  });

  // A Pi get_messages reply for a long bot chat is one 60+ MB line. Rescanning the whole
  // buffered line on every pipe read made decoding quadratic (64 MB took ~57 s, past the
  // 60 s RPC timeout under load), so history replay failed.
  it("decodes a very long single line in linear time", () => {
    const { decoder, frames, problems } = decoderHarness();
    const value = "x".repeat(32 * 1024 * 1024);
    const line = `${JSON.stringify({ type: "response", id: "req_1", data: { value } })}\n`;
    const startedAt = performance.now();
    for (let offset = 0; offset < line.length; offset += 64 * 1024) {
      decoder.write(line.slice(offset, offset + 64 * 1024));
    }
    const elapsedMs = performance.now() - startedAt;
    expect(frames).toHaveLength(1);
    expect((frames[0]?.data as { value: string }).value.length).toBe(value.length);
    expect(problems).toEqual([]);
    // The quadratic decoder needed ~5 s for 32 MB; a linear one needs well under a second.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("reassembles a large ordered v2 frame", () => {
    const { decoder, frames, problems } = decoderHarness();
    const frame = { type: "models", value: "x".repeat(1024 * 1024) };
    for (const chunk of chunkFrames(frame, 256 * 1024)) {
      decoder.write(`${JSON.stringify(chunk)}\n`);
    }
    expect(frames).toEqual([frame]);
    expect(problems).toEqual([]);
  });

  it("drops an out-of-order sequence before accepting the next frame", () => {
    const { decoder, frames, problems } = decoderHarness();
    const chunks = chunkFrames({ type: "models", value: "x".repeat(1024 * 1024) }, 256 * 1024);
    decoder.write(`${JSON.stringify(chunks[1])}\n`);
    decoder.write('{"type":"ready"}\n');
    expect(frames).toEqual([{ type: "ready" }]);
    expect(problems).toEqual(["out-of-order-chunk"]);
  });
});
