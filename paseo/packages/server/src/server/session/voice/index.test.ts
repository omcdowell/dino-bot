import { EventEmitter } from "node:events";
import pino from "pino";
import { expect, test } from "vitest";
import { SessionDelivery } from "../owned-subscriptions/index.js";
import { VoiceSessions } from "./index.js";
import type { StreamingTranscriptionSession } from "../../speech/speech-provider.js";

test("a failed speech close reports the failure without retaining observation demand", async () => {
  class BrokenCloseStream extends EventEmitter implements StreamingTranscriptionSession {
    readonly requiredSampleRate = 16000;
    async connect() {}
    appendPcm16() {}
    commit() {}
    clear() {}
    close() {
      throw new Error("Speech worker close failed");
    }
  }
  const source = {};
  const delivery = new SessionDelivery(() => {});
  delivery.attach(source, true);
  const demands: boolean[] = [];
  const voice = new VoiceSessions(
    {
      sessionId: "failed-speech-close",
      logger: pino({ level: "silent" }),
      host: {
        emit() {},
        async loadAgent() {
          throw new Error("Unexpected agent load");
        },
        async reloadAgentSession() {
          throw new Error("Unexpected agent reload");
        },
        async sendSpokenInput() {
          throw new Error("Unexpected spoken input");
        },
        async interruptAgentIfRunning() {},
        hasActiveAgentRun: () => false,
      },
      stt: null,
      tts: null,
      dictation: {
        stt: { id: "local", createSession: () => new BrokenCloseStream() },
        // Close on detach (no resume window), so the close failure surfaces here.
        resumeGraceMs: 0,
      },
    },
    delivery,
    () => demands.push(voice.hasDemand),
  );
  const request = {
    type: "dictation_stream_start" as const,
    dictationId: "recording",
    format: "audio/pcm;rate=16000;bits=16",
  };
  await delivery.request(source, request, () => voice.handleMessage(request));
  expect(voice.hasDemand).toBe(true);
  await expect(delivery.detach(source)).rejects.toThrow();
  expect(voice.hasDemand).toBe(false);
  expect(demands.at(-1)).toBe(false);
});

test("a dictation stream outlives its socket and resumes on the next socket of the session", async () => {
  class RecordingStream extends EventEmitter implements StreamingTranscriptionSession {
    readonly requiredSampleRate = 16000;
    appended = 0;
    closed = false;
    async connect() {}
    appendPcm16() {
      this.appended += 1;
    }
    commit() {}
    clear() {}
    close() {
      this.closed = true;
    }
  }
  const streams: RecordingStream[] = [];
  const sent: Array<{ source: object; message: { type: string; payload?: unknown } }> = [];
  const delivery = new SessionDelivery((source, message) => sent.push({ source, message }));
  const voice = new VoiceSessions(
    {
      sessionId: "resume",
      logger: pino({ level: "silent" }),
      host: {
        emit() {},
        async loadAgent() {
          throw new Error("Unexpected agent load");
        },
        async reloadAgentSession() {
          throw new Error("Unexpected agent reload");
        },
        async sendSpokenInput() {
          throw new Error("Unexpected spoken input");
        },
        async interruptAgentIfRunning() {},
        hasActiveAgentRun: () => false,
      },
      stt: null,
      tts: null,
      dictation: {
        stt: {
          id: "local",
          createSession: () => {
            const stream = new RecordingStream();
            streams.push(stream);
            return stream;
          },
        },
      },
    },
    delivery,
    () => {},
  );
  const format = "audio/pcm;rate=16000;bits=16";
  const audio = Buffer.from(new Int16Array(160).fill(900).buffer).toString("base64");
  const send = (source: object, message: Parameters<VoiceSessions["handleMessage"]>[0]) =>
    delivery.request(source, message, () => voice.handleMessage(message));
  const acks = (source: object) =>
    sent
      .filter((entry) => entry.source === source && entry.message.type === "dictation_stream_ack")
      .map((entry) => entry.message.payload);

  const first = {};
  delivery.attach(first, true);
  await send(first, { type: "dictation_stream_start", dictationId: "d", format });
  for (const seq of [0, 1, 2]) {
    await send(first, { type: "dictation_stream_chunk", dictationId: "d", seq, audio, format });
  }
  await delivery.detach(first); // the phone lost its socket
  expect(streams[0]!.closed).toBe(false);
  expect(voice.hasDemand).toBe(false);

  const second = {};
  delivery.attach(second, true);
  await send(second, { type: "dictation_stream_start", dictationId: "d", format, resume: true });
  expect(acks(second)).toEqual([{ dictationId: "d", ackSeq: 2, resumed: true }]);
  await send(second, { type: "dictation_stream_chunk", dictationId: "d", seq: 3, audio, format });
  expect(acks(second).at(-1)).toEqual({ dictationId: "d", ackSeq: 3 });
  expect(streams).toHaveLength(1);
  expect(streams[0]!.appended).toBe(4);
  await delivery.detach(second);
});
