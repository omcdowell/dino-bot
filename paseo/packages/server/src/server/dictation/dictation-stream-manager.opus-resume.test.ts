import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import pino from "pino";

import {
  DICTATION_OPUS_FORMAT,
  DICTATION_PCM_FORMAT,
  joinLen16OpusPackets,
  splitLen16OpusPackets,
} from "@getpaseo/protocol/dictation-audio-format";
import {
  DictationStreamManager,
  createDictationStreamRegistry,
} from "./dictation-stream-manager.js";
import { createDictationAudioDecoder } from "./dictation-audio-decoder.js";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionSession,
} from "../speech/speech-provider.js";
import { pcm16lePeakAbs } from "../speech/audio.js";

// 7.4 s of real speech (LibriSpeech-style sample from the Parakeet model's test_wavs), encoded on
// macOS by the same AudioToolbox Opus encoder the iOS app uses (16 kHz mono, 16 kbps, 20 ms).
const OPUS_FIXTURE = readFileSync(
  path.join(__dirname, "test-fixtures", "speech-16k-16kbps.opus-len16"),
);
const FIXTURE_SAMPLES = 237920 / 2;

class FakeSession extends EventEmitter implements StreamingTranscriptionSession {
  appended: Buffer[] = [];
  closed = false;
  requiredSampleRate = 16000;
  async connect(): Promise<void> {}
  appendPcm16(pcm16le: Buffer): void {
    this.appended.push(pcm16le);
  }
  commit(): void {}
  clear(): void {}
  close(): void {
    this.closed = true;
  }
}

class FakeProvider implements SpeechToTextProvider {
  readonly id = "fake";
  sessions: FakeSession[] = [];
  createSession(): StreamingTranscriptionSession {
    const session = new FakeSession();
    this.sessions.push(session);
    return session;
  }
}

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

function setup() {
  const provider = new FakeProvider();
  const emitted: Emitted[] = [];
  const manager = new DictationStreamManager({
    logger: pino({ level: "silent" }),
    emit: (msg) => emitted.push(msg as Emitted),
    sessionId: "s1",
    stt: provider,
    autoCommitSeconds: 0,
  });
  const acks = () => emitted.filter((m) => m.type === "dictation_stream_ack").map((m) => m.payload);
  const errors = () => emitted.filter((m) => m.type === "dictation_stream_error");
  return { provider, manager, emitted, acks, errors };
}

/** Split the fixture into chunks of whole packets, like the phone sends them. */
function opusChunks(packetsPerChunk: number): string[] {
  const packets = splitLen16OpusPackets(OPUS_FIXTURE);
  const chunks: string[] = [];
  for (let i = 0; i < packets.length; i += packetsPerChunk) {
    const framed = joinLen16OpusPackets(packets.slice(i, i + packetsPerChunk));
    chunks.push(Buffer.from(framed).toString("base64"));
  }
  return chunks;
}

const pcmChunk = (value: number, samples = 1600) =>
  Buffer.from(new Int16Array(samples).fill(value).buffer).toString("base64");

describe("dictation Opus decoding", () => {
  const prevDebug = process.env.PASEO_DICTATION_DEBUG;
  beforeEach(() => {
    process.env.PASEO_DICTATION_DEBUG = "false";
  });
  afterEach(() => {
    process.env.PASEO_DICTATION_DEBUG = prevDebug;
  });

  it("decodes len16 Opus chunks to 16 kHz PCM16 for the STT session", async () => {
    const { provider, manager, acks, errors } = setup();
    await manager.handleStart("d1", DICTATION_OPUS_FORMAT);
    const chunks = opusChunks(5);
    for (const [seq, audioBase64] of chunks.entries()) {
      await manager.handleChunk({
        dictationId: "d1",
        seq,
        audioBase64,
        format: DICTATION_OPUS_FORMAT,
      });
    }
    expect(errors()).toEqual([]);
    expect(acks().at(-1)).toEqual({ dictationId: "d1", ackSeq: chunks.length - 1 });

    const pcm = Buffer.concat(provider.sessions[0]!.appended);
    const samples = pcm.length / 2;
    // Whole 20 ms frames: the encoder pads the tail up to one frame.
    expect(samples % 320).toBe(0);
    expect(Math.abs(samples - FIXTURE_SAMPLES)).toBeLessThanOrEqual(320);
    // Real speech, not silence or noise: well above the silence threshold (300).
    expect(pcm16lePeakAbs(pcm)).toBeGreaterThan(3000);
  });

  it("decodes the same audio whether chunks hold one packet or many", async () => {
    const decode = async (perChunk: number) => {
      const decoder = createDictationAudioDecoder(DICTATION_OPUS_FORMAT, 16000);
      await decoder.ready;
      const out = Buffer.concat(
        opusChunks(perChunk).map((c) => decoder.decode(Buffer.from(c, "base64"))),
      );
      decoder.close();
      return out;
    };
    const one = await decode(1);
    const many = await decode(13);
    expect(one.equals(many)).toBe(true);
  });

  it("keeps PCM working unchanged", async () => {
    const { provider, manager, errors } = setup();
    await manager.handleStart("d1", DICTATION_PCM_FORMAT);
    await manager.handleChunk({
      dictationId: "d1",
      seq: 0,
      audioBase64: pcmChunk(1234),
      format: DICTATION_PCM_FORMAT,
    });
    expect(errors()).toEqual([]);
    const pcm = Buffer.concat(provider.sessions[0]!.appended);
    expect(pcm.length).toBe(3200);
    expect(pcm.readInt16LE(0)).toBe(1234);
  });

  it("rejects an Opus framing it does not read", async () => {
    const { manager, errors, provider } = setup();
    await manager.handleStart("d1", "audio/opus;rate=16000;framing=ogg");
    expect(errors()).toHaveLength(1);
    expect(errors()[0]!.payload).toMatchObject({ retryable: false });
    expect(provider.sessions[0]!.closed).toBe(true);
  });

  it("fails the stream (not retryable) on a truncated Opus chunk", async () => {
    const { manager, errors } = setup();
    await manager.handleStart("d1", DICTATION_OPUS_FORMAT);
    const bad = Buffer.from([0x00, 0x40, 0x01, 0x02]).toString("base64");
    await manager.handleChunk({
      dictationId: "d1",
      seq: 0,
      audioBase64: bad,
      format: DICTATION_OPUS_FORMAT,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors()).toHaveLength(1);
    expect(errors()[0]!.payload).toMatchObject({ retryable: false });
  });
});

describe("dictation resume after a dropped connection", () => {
  it("keeps the stream and acks what it already has", async () => {
    const { provider, manager, acks } = setup();
    await manager.handleStart("d1", DICTATION_PCM_FORMAT);
    for (const seq of [0, 1, 2]) {
      await manager.handleChunk({
        dictationId: "d1",
        seq,
        audioBase64: pcmChunk(500 + seq),
        format: DICTATION_PCM_FORMAT,
      });
    }
    // seq 4 arrived, seq 3 was lost with the socket.
    await manager.handleChunk({
      dictationId: "d1",
      seq: 4,
      audioBase64: pcmChunk(504),
      format: DICTATION_PCM_FORMAT,
    });

    await manager.handleStart("d1", DICTATION_PCM_FORMAT, { resume: true });
    expect(acks().at(-1)).toEqual({ dictationId: "d1", ackSeq: 2, resumed: true });
    expect(provider.sessions).toHaveLength(1);
    expect(provider.sessions[0]!.closed).toBe(false);

    // The client resends from ackSeq + 1; the buffered seq 4 is a harmless duplicate.
    for (const seq of [3, 4, 5]) {
      await manager.handleChunk({
        dictationId: "d1",
        seq,
        audioBase64: pcmChunk(500 + seq),
        format: DICTATION_PCM_FORMAT,
      });
    }
    expect(acks().at(-1)).toEqual({ dictationId: "d1", ackSeq: 5 });
    const firstSamples = provider.sessions[0]!.appended.map((b) => b.readInt16LE(0));
    expect(firstSamples).toEqual([500, 501, 502, 503, 504, 505]);
  });

  it("resumes an Opus stream without restarting the decoder", async () => {
    const { provider, manager, acks, errors } = setup();
    const chunks = opusChunks(5);
    await manager.handleStart("d1", DICTATION_OPUS_FORMAT);
    const half = Math.floor(chunks.length / 2);
    for (let seq = 0; seq < half; seq += 1) {
      await manager.handleChunk({
        dictationId: "d1",
        seq,
        audioBase64: chunks[seq]!,
        format: DICTATION_OPUS_FORMAT,
      });
    }
    await manager.handleStart("d1", DICTATION_OPUS_FORMAT, { resume: true });
    expect(acks().at(-1)).toEqual({ dictationId: "d1", ackSeq: half - 1, resumed: true });
    for (let seq = half; seq < chunks.length; seq += 1) {
      await manager.handleChunk({
        dictationId: "d1",
        seq,
        audioBase64: chunks[seq]!,
        format: DICTATION_OPUS_FORMAT,
      });
    }
    expect(errors()).toEqual([]);

    const reference = createDictationAudioDecoder(DICTATION_OPUS_FORMAT, 16000);
    await reference.ready;
    const expected = Buffer.concat(chunks.map((c) => reference.decode(Buffer.from(c, "base64"))));
    reference.close();
    expect(Buffer.concat(provider.sessions[0]!.appended).equals(expected)).toBe(true);
  });

  it("starts fresh (ack -1, resumed false) when it no longer has the stream", async () => {
    const { provider, manager, acks } = setup();
    await manager.handleStart("gone", DICTATION_PCM_FORMAT, { resume: true });
    expect(acks()).toEqual([{ dictationId: "gone", ackSeq: -1, resumed: false }]);
    expect(provider.sessions).toHaveLength(1);
  });

  it("starts fresh when the format changed", async () => {
    const { provider, manager, acks } = setup();
    await manager.handleStart("d1", DICTATION_PCM_FORMAT);
    await manager.handleChunk({
      dictationId: "d1",
      seq: 0,
      audioBase64: pcmChunk(1),
      format: DICTATION_PCM_FORMAT,
    });
    await manager.handleStart("d1", DICTATION_OPUS_FORMAT, { resume: true });
    expect(acks().at(-1)).toEqual({ dictationId: "d1", ackSeq: -1, resumed: false });
    expect(provider.sessions).toHaveLength(2);
    expect(provider.sessions[0]!.closed).toBe(true);
  });

  it("a start without resume still restarts, as old clients expect", async () => {
    const { provider, manager, acks } = setup();
    await manager.handleStart("d1", DICTATION_PCM_FORMAT);
    await manager.handleChunk({
      dictationId: "d1",
      seq: 0,
      audioBase64: pcmChunk(1),
      format: DICTATION_PCM_FORMAT,
    });
    await manager.handleStart("d1", DICTATION_PCM_FORMAT);
    expect(acks().at(-1)).toEqual({ dictationId: "d1", ackSeq: -1 });
    expect(provider.sessions).toHaveLength(2);
  });
});

describe("dictation resume while the first start is still connecting", () => {
  it("does not restart the stream; the pending start's ack answers both", async () => {
    const provider = new FakeProvider();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      id: "slow",
      createSession: () => {
        const session = provider.createSession() as FakeSession;
        session.connect = () => gate;
        return session;
      },
    } as unknown as SpeechToTextProvider;
    const emitted: Emitted[] = [];
    const manager = new DictationStreamManager({
      logger: pino({ level: "silent" }),
      emit: (msg) => emitted.push(msg as Emitted),
      sessionId: "s1",
      stt: slow,
    });
    const first = manager.handleStart("d1", DICTATION_PCM_FORMAT, { resume: true });
    await manager.handleStart("d1", DICTATION_PCM_FORMAT, { resume: true });
    expect(provider.sessions).toHaveLength(1);
    expect(provider.sessions[0]!.closed).toBe(false);
    release();
    await first;
    expect(emitted.filter((m) => m.type === "dictation_stream_ack").map((m) => m.payload)).toEqual([
      { dictationId: "d1", ackSeq: -1, resumed: false },
    ]);
  });
});

describe("dictation stream parked between sockets (shared registry)", () => {
  function twoSockets(resumeGraceMs?: number) {
    const provider = new FakeProvider();
    const streams = createDictationStreamRegistry();
    const make = () => {
      const emitted: Emitted[] = [];
      const idle = { count: 0 };
      const manager = new DictationStreamManager({
        logger: pino({ level: "silent" }),
        emit: (msg) => emitted.push(msg as Emitted),
        sessionId: "s1",
        stt: provider,
        autoCommitSeconds: 0,
        streams,
        resumeGraceMs,
        onIdle: () => {
          idle.count += 1;
        },
      });
      return { manager, emitted, idle };
    };
    return { provider, first: make(), second: make() };
  }
  const chunk = (manager: DictationStreamManager, seq: number) =>
    manager.handleChunk({
      dictationId: "d1",
      seq,
      audioBase64: pcmChunk(700 + seq),
      format: DICTATION_PCM_FORMAT,
    });

  it("keeps the stream when its socket goes and hands it to the resuming socket", async () => {
    const { provider, first, second } = twoSockets();
    await first.manager.handleStart("d1", DICTATION_PCM_FORMAT);
    await chunk(first.manager, 0);
    await chunk(first.manager, 1);

    first.manager.cleanupAll(); // socket gone
    expect(provider.sessions[0]!.closed).toBe(false);
    expect(first.manager.hasDemand).toBe(false);

    await second.manager.handleStart("d1", DICTATION_PCM_FORMAT, { resume: true });
    expect(second.emitted.map((m) => m.payload)).toEqual([
      { dictationId: "d1", ackSeq: 1, resumed: true },
    ]);
    expect(second.manager.hasDemand).toBe(true);
    await chunk(second.manager, 2);
    expect(second.emitted.at(-1)!.payload).toEqual({ dictationId: "d1", ackSeq: 2 });
    // Nothing more goes to the old socket.
    const firstCount = first.emitted.length;
    await chunk(second.manager, 3);
    expect(first.emitted).toHaveLength(firstCount);

    await second.manager.handleFinish("d1", 3);
    const stt = provider.sessions[0]!;
    stt.emit("committed", { segmentId: "s", previousSegmentId: null });
    stt.emit("transcript", { segmentId: "s", transcript: "hi there", isFinal: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.emitted.find((m) => m.type === "dictation_stream_final")?.payload).toMatchObject({
      text: "hi there",
    });
    expect(provider.sessions[0]!.closed).toBe(true);
    expect(second.idle.count).toBeGreaterThan(0);
  });

  it("closes a parked stream nobody resumed, and the late resume starts fresh", async () => {
    vi.useFakeTimers();
    try {
      const { provider, first, second } = twoSockets(1000);
      await first.manager.handleStart("d1", DICTATION_PCM_FORMAT);
      await chunk(first.manager, 0);
      first.manager.cleanupAll();
      await vi.advanceTimersByTimeAsync(999);
      expect(provider.sessions[0]!.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(provider.sessions[0]!.closed).toBe(true);

      await second.manager.handleStart("d1", DICTATION_PCM_FORMAT, { resume: true });
      expect(second.emitted.map((m) => m.payload)).toEqual([
        { dictationId: "d1", ackSeq: -1, resumed: false },
      ]);
      expect(provider.sessions).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
