import { describe, expect, it } from "vitest";

import { decodeWithEmptyRetry, EMPTY_RETRY_LEAD_SECONDS } from "./parakeet-decode.js";

const RATE = 16000;

/** Fake engine mimicking the Parakeet TDT failure: audio that starts mid-speech decodes empty. */
class StartsMidSpeechEngine {
  readonly sampleRate = RATE;
  readonly decoded: Float32Array[] = [];
  createStream() {
    const stream = {
      samples: new Float32Array(0),
      freed: false,
      free() {
        stream.freed = true;
      },
    };
    return stream;
  }
  acceptWaveform(stream: { samples: Float32Array }, _sr: number, samples: Float32Array) {
    stream.samples = samples;
  }
  decode(stream: { samples: Float32Array }) {
    this.decoded.push(stream.samples);
  }
  getResult(stream: { samples: Float32Array }) {
    const s = stream.samples;
    const first = s.findIndex((v) => Math.abs(v) > 1e-3);
    if (first <= 0) return { text: "", tokens: [], timestamps: [] };
    return {
      text: "hello world",
      tokens: [" hello", " world"],
      timestamps: [first / RATE, first / RATE + 0.4],
    };
  }
}

function tone(seconds: number, amp = 0.3): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amp * Math.cos(i / 5));
}

describe("decodeWithEmptyRetry", () => {
  it("returns the first result without a retry when text is non-empty", () => {
    const engine = new StartsMidSpeechEngine();
    const samples = new Float32Array(RATE * 2);
    samples.set(tone(1), RATE / 2);
    const result = decodeWithEmptyRetry(engine, RATE, samples) as { text: string };
    expect(result.text).toBe("hello world");
    expect(engine.decoded).toHaveLength(1);
  });

  it("re-decodes with leading silence when speech-bearing audio decodes empty, and shifts timestamps back", () => {
    const engine = new StartsMidSpeechEngine();
    const result = decodeWithEmptyRetry(engine, RATE, tone(3)) as {
      text: string;
      timestamps: number[];
    };
    expect(engine.decoded).toHaveLength(2);
    expect(engine.decoded[1]!.length).toBe(Math.round(3 * RATE + EMPTY_RETRY_LEAD_SECONDS * RATE));
    expect(result.text).toBe("hello world");
    expect(result.timestamps[0]).toBeCloseTo(0, 5);
    expect(result.timestamps[1]).toBeCloseTo(0.4, 5);
  });

  it("does not retry silence or very short audio", () => {
    const engine = new StartsMidSpeechEngine();
    decodeWithEmptyRetry(engine, RATE, new Float32Array(RATE * 3));
    decodeWithEmptyRetry(engine, RATE, tone(0.3));
    expect(engine.decoded).toHaveLength(2);
  });

  it("returns the first (empty) result when the retry is empty too", () => {
    const engine = new StartsMidSpeechEngine();
    engine.getResult = () => ({ text: "", tokens: [], timestamps: [] });
    const result = decodeWithEmptyRetry(engine, RATE, tone(2)) as { text: string };
    expect(result.text).toBe("");
    expect(engine.decoded).toHaveLength(2);
  });
});
