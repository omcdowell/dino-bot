import { describe, expect, it, vi } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { DictationStreamSender } from "@/dictation/dictation-stream-sender";

interface FakeFinish {
  dictationId: string;
  finalSeq: number;
}
interface FakeStart {
  dictationId: string;
  format: string;
  resume?: boolean;
}
interface FakeChunk {
  dictationId: string;
  seq: number;
  audio: string;
  format: string;
}

interface FakeAck {
  type: "dictation_stream_ack";
  payload: {
    dictationId: string;
    ackSeq: number;
  };
}

type FakeRawMessageListener = (message: SessionOutboundMessage) => void;

class FakeDaemonClient {
  isConnected = true;
  autoAck = true;
  throwOnNextChunk = false;
  disconnectOnChunkError = false;
  starts: FakeStart[] = [];
  chunks: FakeChunk[] = [];
  finishes: FakeFinish[] = [];
  cancels: string[] = [];
  private readonly rawMessageListeners = new Set<FakeRawMessageListener>();

  get rawMessageListenerCount(): number {
    return this.rawMessageListeners.size;
  }

  /** What the daemon answers a start with; undefined = an old client/daemon (void, fresh). */
  startAck: ((start: FakeStart) => { ackSeq: number; resumed: boolean }) | undefined;
  supportsOpus = false;

  async startDictationStream(
    dictationId: string,
    format: string,
    options?: { resume?: boolean },
  ): Promise<{ ackSeq: number; resumed: boolean } | void> {
    const start: FakeStart = { dictationId, format, ...(options?.resume ? { resume: true } : {}) };
    this.starts.push(start);
    return this.startAck?.(start);
  }

  supportsDictationOpus(): boolean {
    return this.supportsOpus;
  }

  sendDictationStreamChunk(dictationId: string, seq: number, audio: string, format: string): void {
    if (this.throwOnNextChunk) {
      this.throwOnNextChunk = false;
      if (this.disconnectOnChunkError) {
        this.isConnected = false;
      }
      throw new Error("WebSocket is closing");
    }
    this.chunks.push({ dictationId, seq, audio, format });
    if (this.autoAck) {
      this.emitAck(dictationId, seq);
    }
  }

  subscribeRawMessages(handler: FakeRawMessageListener): () => void {
    this.rawMessageListeners.add(handler);
    return () => this.rawMessageListeners.delete(handler);
  }

  setConnected(isConnected: boolean): void {
    this.isConnected = isConnected;
  }

  emitAck(dictationId: string, ackSeq: number): void {
    const message: FakeAck = {
      type: "dictation_stream_ack",
      payload: { dictationId, ackSeq },
    };
    for (const listener of this.rawMessageListeners) {
      listener(message);
    }
  }

  async finishDictationStream(
    dictationId: string,
    finalSeq: number,
  ): Promise<{ dictationId: string; text: string }> {
    this.finishes.push({ dictationId, finalSeq });
    return { dictationId, text: "ok" };
  }

  cancelDictationStream(dictationId: string): void {
    this.cancels.push(dictationId);
  }
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const promiseOutcome = async <T>(promise: Promise<T>, timeoutMs: number) => {
  return Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), timeoutMs)),
  ]);
};

describe("DictationStreamSender", () => {
  it("enqueues segments and sends them after stream start", async () => {
    const client = new FakeDaemonClient();
    const ids = ["d1"];
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => ids.shift() ?? "dX",
    });

    sender.enqueueSegment("seg0");
    sender.enqueueSegment("seg1");

    await tick();

    expect(client.starts).toEqual([{ dictationId: "d1", format: "audio/pcm;rate=16000;bits=16" }]);
    expect(client.chunks).toEqual([
      { dictationId: "d1", seq: 0, audio: "seg0", format: "audio/pcm;rate=16000;bits=16" },
      { dictationId: "d1", seq: 1, audio: "seg1", format: "audio/pcm;rate=16000;bits=16" },
    ]);
  });

  it("restarts stream and resends from seq=0 on reconnect", async () => {
    const client = new FakeDaemonClient();
    const ids = ["d1", "d2"];
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => ids.shift() ?? "dX",
    });

    sender.enqueueSegment("seg0");
    sender.enqueueSegment("seg1");
    await tick();

    const before = client.chunks.length;
    await sender.restartStream("reconnect");

    // Same stream id, asking to resume; this daemon answers like an old one (fresh stream).
    expect(client.starts).toEqual([
      { dictationId: "d1", format: "audio/pcm;rate=16000;bits=16" },
      { dictationId: "d1", format: "audio/pcm;rate=16000;bits=16", resume: true },
    ]);
    const d2Chunks = client.chunks.slice(before);
    expect(d2Chunks.map((c) => [c.seq, c.audio])).toEqual([
      [0, "seg0"],
      [1, "seg1"],
    ]);
  });

  it("finish flushes all queued segments and sends finish with finalSeq", async () => {
    const client = new FakeDaemonClient();
    const ids = ["d1"];
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => ids.shift() ?? "dX",
    });

    sender.enqueueSegment("seg0");
    sender.enqueueSegment("seg1");

    const finalSeq = sender.getFinalSeq();
    const result = await sender.finish(finalSeq);

    expect(result.text).toBe("ok");
    expect(client.chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(client.finishes).toEqual([{ dictationId: "d1", finalSeq: 1 }]);
  });

  it("keeps segments while disconnected and sends them after restart when reconnected", async () => {
    const client = new FakeDaemonClient();
    client.isConnected = false;
    const ids = ["d1"];
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => ids.shift() ?? "dX",
    });

    sender.enqueueSegment("seg0");
    sender.enqueueSegment("seg1");

    expect(client.starts).toHaveLength(0);
    expect(client.chunks).toHaveLength(0);

    client.isConnected = true;
    await sender.restartStream("reconnect");

    expect(client.chunks.map((c) => c.seq)).toEqual([0, 1]);
  });

  it("keeps capture safe and buffers later segments when a chunk send throws", async () => {
    const client = new FakeDaemonClient();
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => "d1",
    });

    sender.enqueueSegment("before-outage");
    await tick();

    client.throwOnNextChunk = true;
    client.disconnectOnChunkError = true;

    expect(() => sender.enqueueSegment("during-outage")).not.toThrow();
    expect(() => sender.enqueueSegment("after-outage")).not.toThrow();
    expect(sender.getSegmentCount()).toBe(3);
  });

  it("removes its raw-message listener when disposed", () => {
    const client = new FakeDaemonClient();
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
    });

    expect(client.rawMessageListenerCount).toBe(1);
    sender.dispose();
    expect(client.rawMessageListenerCount).toBe(0);
  });

  it("replays segments captured before, during, and after an outage from seq 0", async () => {
    const client = new FakeDaemonClient();
    const ids = ["d1", "d2"];
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => ids.shift() ?? "dX",
    });

    sender.enqueueSegment("before-outage");
    await tick();

    client.throwOnNextChunk = true;
    client.disconnectOnChunkError = true;
    expect(() => sender.enqueueSegment("during-outage")).not.toThrow();
    sender.enqueueSegment("after-outage");

    client.setConnected(true);
    const before = client.chunks.length;
    await sender.restartStream("reconnect");

    const replay = client.chunks.slice(before).map((chunk) => [chunk.seq, chunk.audio]);
    expect(replay).toEqual([
      [0, "before-outage"],
      [1, "during-outage"],
      [2, "after-outage"],
    ]);
  });

  it("fails finish after a transport transition without losing buffered audio", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDaemonClient();
      client.setConnected(false);
      const ids = ["d1", "d2"];
      const sender = new DictationStreamSender({
        client,
        format: "audio/pcm;rate=16000;bits=16",
        createDictationId: () => ids.shift() ?? "dX",
      });

      for (let seq = 0; seq < 129; seq += 1) {
        sender.enqueueSegment(`segment-${seq}`);
      }

      client.setConnected(true);
      const finish = sender.finish(sender.getFinalSeq());
      const outcome = promiseOutcome(finish, 1);

      await tick();
      client.setConnected(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(outcome).resolves.toBe("rejected");
      expect(sender.getSegmentCount()).toBe(129);
      expect(sender.getFinalSeq()).toBe(128);

      client.setConnected(true);
      sender.resetStreamForReplay();
      const before = client.chunks.length;
      await sender.restartStream("retry");
      await expect(sender.finish(128)).resolves.toEqual({ dictationId: "d1", text: "ok" });
      expect(client.starts.at(-1)).toMatchObject({ dictationId: "d1", resume: true });
      expect(client.chunks.slice(before)).toHaveLength(129);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for server delivery acknowledgement before finishing", async () => {
    const client = new FakeDaemonClient();
    client.autoAck = false;
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => "d1",
    });

    sender.enqueueSegment("seg0");
    sender.enqueueSegment("seg1");
    await tick();

    const finish = sender.finish(1);
    await tick();
    expect(client.finishes).toEqual([]);

    client.emitAck("d1", 1);
    await expect(finish).resolves.toEqual({ dictationId: "d1", text: "ok" });
  });

  it("does not replay long buffered native dictation in one synchronous burst", async () => {
    const client = new FakeDaemonClient();
    client.isConnected = false;
    const sender = new DictationStreamSender({
      client,
      format: "audio/pcm;rate=16000;bits=16",
      createDictationId: () => "d1",
    });

    for (let seq = 0; seq < 480; seq += 1) {
      sender.enqueueSegment(`native-frame-${seq}`);
    }

    client.isConnected = true;
    const finish = sender.finish(sender.getFinalSeq());

    await tick();

    expect(client.chunks.length).toBeLessThanOrEqual(128);
    await expect(finish).resolves.toEqual({
      dictationId: "d1",
      text: "ok",
    });
    expect(client.finishes).toEqual([{ dictationId: "d1", finalSeq: 479 }]);
  });
});

describe("resume after a dropped connection", () => {
  const PCM = "audio/pcm;rate=16000;bits=16";

  async function recordThenDrop(client: FakeDaemonClient, sender: DictationStreamSender) {
    client.autoAck = false;
    for (let seq = 0; seq < 5; seq += 1) sender.enqueueSegment(`seg${seq}`);
    await tick();
    expect(client.chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4]);
    // The daemon acked 0..2; the acks for 3 and 4 were lost with the socket.
    client.emitAck("d1", 2);
    client.setConnected(false);
    sender.enqueueSegment("seg5"); // captured while offline
    sender.flush();
    client.setConnected(true);
    client.autoAck = true;
  }

  it("resends only what the daemon has not acknowledged", async () => {
    const client = new FakeDaemonClient();
    const sender = new DictationStreamSender({
      client,
      format: PCM,
      createDictationId: () => "d1",
    });
    await recordThenDrop(client, sender);

    client.startAck = (start) => ({
      ackSeq: start.resume ? 2 : -1,
      resumed: start.resume === true,
    });
    const before = client.chunks.length;
    await sender.restartStream("reconnect");

    expect(client.starts.at(-1)).toEqual({ dictationId: "d1", format: PCM, resume: true });
    expect(client.chunks.slice(before).map((c) => [c.seq, c.audio])).toEqual([
      [3, "seg3"],
      [4, "seg4"],
      [5, "seg5"],
    ]);
    expect(sender.getStats()).toMatchObject({ chunksSent: 8, chunksResent: 2, resumes: 1 });
    await expect(sender.finish(5)).resolves.toEqual({ dictationId: "d1", text: "ok" });
  });

  it("falls back to a full replay when the daemon lost the stream", async () => {
    const client = new FakeDaemonClient();
    const sender = new DictationStreamSender({
      client,
      format: PCM,
      createDictationId: () => "d1",
    });
    await recordThenDrop(client, sender);

    client.startAck = () => ({ ackSeq: -1, resumed: false });
    const before = client.chunks.length;
    await sender.restartStream("reconnect");

    expect(client.chunks.slice(before).map((c) => c.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sender.getStats()).toMatchObject({ chunksResent: 5, resumes: 0 });
  });

  it("starts a new stream id for a new recording and after cancel", async () => {
    const client = new FakeDaemonClient();
    const ids = ["d1", "d2", "d3"];
    const sender = new DictationStreamSender({
      client,
      format: PCM,
      createDictationId: () => ids.shift() ?? "dX",
    });
    sender.enqueueSegment("a");
    await tick();
    sender.clearAll();
    sender.enqueueSegment("b");
    await tick();
    sender.cancel();
    sender.enqueueSegment("c");
    await tick();
    expect(client.starts).toEqual([
      { dictationId: "d1", format: PCM },
      { dictationId: "d2", format: PCM },
      { dictationId: "d3", format: PCM },
    ]);
  });
});

describe("audio format and the dictationOpus feature flag", () => {
  const PCM = "audio/pcm;rate=16000;bits=16";
  const OPUS = "audio/opus;rate=16000;channels=1;framing=len16";

  it("sends Opus chunks with the Opus format when the daemon reads it", async () => {
    const client = new FakeDaemonClient();
    client.supportsOpus = true;
    const sender = new DictationStreamSender({
      client,
      format: PCM,
      createDictationId: () => "d1",
    });
    sender.setFormat(OPUS);
    sender.enqueueSegment("AAEC");
    await tick();
    expect(client.starts).toEqual([{ dictationId: "d1", format: OPUS }]);
    expect(client.chunks).toEqual([{ dictationId: "d1", seq: 0, audio: "AAEC", format: OPUS }]);
  });

  it("refuses to send Opus to a daemon that does not advertise it", async () => {
    const client = new FakeDaemonClient();
    client.supportsOpus = false;
    const sender = new DictationStreamSender({
      client,
      format: PCM,
      createDictationId: () => "d1",
    });
    sender.setFormat(OPUS);
    await expect(sender.restartStream("start")).rejects.toThrow(/Opus/);
    expect(client.starts).toEqual([]);
  });

  it("does not change format while audio is buffered", () => {
    const client = new FakeDaemonClient();
    client.isConnected = false;
    const sender = new DictationStreamSender({ client, format: PCM });
    sender.enqueueSegment("x");
    expect(() => sender.setFormat(OPUS)).toThrow(/buffered/);
    sender.clearAll();
    sender.setFormat(OPUS);
    expect(sender.getFormat()).toBe(OPUS);
  });
});
