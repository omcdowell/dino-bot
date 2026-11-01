import { generateMessageId } from "@/types/stream";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { isDictationOpusFormat } from "@getpaseo/protocol/dictation-audio-format";
import { i18n } from "@/i18n/i18next";

const MAX_CHUNKS_PER_FLUSH_TURN = 128;
const DICTATION_DRAIN_IDLE_TIMEOUT_MS = 30_000;

const waitForNextFlushTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type DictationStreamAckMessage = Extract<SessionOutboundMessage, { type: "dictation_stream_ack" }>;

interface DrainWaitResult {
  kind: "signaled" | "timed-out";
}

export interface DictationStreamClient {
  readonly isConnected: boolean;
  startDictationStream(
    dictationId: string,
    format: string,
    options?: { resume?: boolean },
  ): Promise<{ ackSeq: number; resumed: boolean } | void>;
  /** COMPAT(dictationOpus): optional so test doubles and old clients read as "no". */
  supportsDictationOpus?(): boolean;
  sendDictationStreamChunk(dictationId: string, seq: number, audio: string, format: string): void;
  finishDictationStream(
    dictationId: string,
    finalSeq: number,
  ): Promise<{ dictationId: string; text: string }>;
  cancelDictationStream(dictationId: string): void;
  subscribeRawMessages(handler: (message: SessionOutboundMessage) => void): () => void;
}

export interface DictationStreamSenderParams {
  client: DictationStreamClient | null;
  format: string;
  createDictationId?: () => string;
}

interface DictationFinishResult {
  dictationId: string;
  text: string;
}

/** Wire counters for the current recording (reset by clearAll). */
export interface DictationSendStats {
  chunksSent: number;
  base64CharsSent: number;
  /** Chunks sent again for a seq that had already gone out once (after a drop). */
  chunksResent: number;
  base64CharsResent: number;
  /** Restarts that reattached to the daemon's stream instead of replaying from seq 0. */
  resumes: number;
}

const emptyStats = (): DictationSendStats => ({
  chunksSent: 0,
  base64CharsSent: 0,
  chunksResent: 0,
  base64CharsResent: 0,
  resumes: 0,
});

/**
 * Small, non-React state machine for dictation streaming.
 *
 * Responsibilities:
 * - Maintain an ordered buffer of base64 audio segments (PCM or Opus, see `format`)
 * - Start/restart a dictation stream (dictationId)
 * - Send missing segments (seq) when connected
 * - After a dropped connection, reattach to the same dictationId with `resume` so only the
 *   segments the daemon has not acked are resent; a daemon that lost the stream (or predates
 *   resume) acks -1 and gets the full replay
 * - Finish/cancel the stream
 *
 * This class intentionally keeps sending synchronous (no internal async mutex),
 * so enqueues can't "miss" a flush due to in-flight await/coalescing bugs.
 */
export class DictationStreamSender {
  private client: DictationStreamClient | null = null;
  private format: string;
  private readonly createDictationId: () => string;

  private dictationId: string | null = null;
  /** The stream we lost the socket for; reused (with resume) by the next restart. */
  private resumeDictationId: string | null = null;
  private highestSentSeq = -1;
  private stats: DictationSendStats = emptyStats();
  private sendSeq = 0;
  private acknowledgedSeq = -1;
  private segments: string[] = [];
  private streamReady = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private drainWaiters: Array<() => void> = [];
  private clientCleanup: (() => void) | null = null;

  private startGeneration = 0;
  private startPromise: Promise<void> | null = null;

  constructor(params: DictationStreamSenderParams) {
    this.format = params.format;
    this.createDictationId = params.createDictationId ?? generateMessageId;
    this.setClient(params.client);
  }

  setClient(client: DictationStreamClient | null): void {
    if (this.client === client) {
      return;
    }

    if (this.clientCleanup) {
      this.clientCleanup();
      this.clientCleanup = null;
    }
    this.resetStreamForReplay();
    this.client = client;

    if (!client) {
      return;
    }

    this.clientCleanup = client.subscribeRawMessages((message) => {
      if (message.type !== "dictation_stream_ack") {
        return;
      }
      this.handleAck(message);
    });
  }

  getDictationId(): string | null {
    return this.dictationId ?? this.resumeDictationId;
  }

  getFormat(): string {
    return this.format;
  }

  /** Choose the audio format for the next recording. Only allowed while no audio is buffered. */
  setFormat(format: string): void {
    if (format === this.format) {
      return;
    }
    if (this.segments.length > 0) {
      throw new Error("Cannot change dictation format while audio is buffered");
    }
    this.resetStreamForReplay();
    this.resumeDictationId = null;
    this.format = format;
  }

  getStats(): DictationSendStats {
    return { ...this.stats };
  }

  getSegmentCount(): number {
    return this.segments.length;
  }

  dispose(): void {
    this.setClient(null);
  }

  getFinalSeq(): number {
    return this.segments.length - 1;
  }

  hasSegments(): boolean {
    return this.segments.length > 0;
  }

  clearAll(): void {
    this.resetStreamForReplay();
    this.resumeDictationId = null;
    this.segments = [];
    this.highestSentSeq = -1;
    this.stats = emptyStats();
  }

  /**
   * Drop the live stream. The buffered audio stays; the next start reattaches to the same
   * dictationId (resume) when there is audio to keep, else it starts fresh.
   */
  resetStreamForReplay(): void {
    this.clearScheduledFlush();
    if (this.dictationId && this.segments.length > 0) {
      this.resumeDictationId = this.dictationId;
    }
    this.dictationId = null;
    this.sendSeq = 0;
    this.acknowledgedSeq = -1;
    this.streamReady = false;
    this.startPromise = null;
    this.startGeneration += 1;
    this.resolveDrainWaiters();
  }

  enqueueSegment(base64Pcm: string): void {
    this.segments.push(base64Pcm);

    const client = this.client;
    if (!client?.isConnected) {
      return;
    }

    if (!this.dictationId) {
      if (!this.startPromise) {
        void this.restartStream("enqueue").catch((error) => {
          console.error("[DictationStreamSender] Failed to start stream from enqueue", error);
        });
      }
      return;
    }

    this.flush();
  }

  flush(): number {
    const client = this.client;
    const dictationId = this.dictationId;
    if (!client?.isConnected || !dictationId || !this.streamReady) {
      if (!client?.isConnected && this.hasPendingSegments()) {
        this.invalidateStream();
      }
      return 0;
    }

    let sent = 0;
    while (this.sendSeq < this.segments.length && sent < MAX_CHUNKS_PER_FLUSH_TURN) {
      const seq = this.sendSeq;
      const audio = this.segments[seq];
      try {
        client.sendDictationStreamChunk(dictationId, seq, audio, this.format);
      } catch {
        this.invalidateStream();
        return sent;
      }
      this.stats.chunksSent += 1;
      this.stats.base64CharsSent += audio.length;
      if (seq <= this.highestSentSeq) {
        this.stats.chunksResent += 1;
        this.stats.base64CharsResent += audio.length;
      } else {
        this.highestSentSeq = seq;
      }
      this.sendSeq = seq + 1;
      sent += 1;
    }

    if (this.hasPendingSegments()) {
      this.scheduleFlush();
    } else {
      this.resolveDrainWaiters();
    }
    return sent;
  }

  async restartStream(reason: string): Promise<void> {
    const client = this.client;
    if (!client?.isConnected) {
      return;
    }

    if (isDictationOpusFormat(this.format) && client.supportsDictationOpus?.() !== true) {
      // Recorded as Opus for a daemon that read it, now connected to one that does not (e.g. a
      // rolled-back daemon). Sending would feed it noise; fail so the user can retry or discard.
      throw new Error("This daemon cannot read Opus dictation audio");
    }

    this.startGeneration += 1;
    const generation = this.startGeneration;

    const resumeId = this.segments.length > 0 ? (this.dictationId ?? this.resumeDictationId) : null;
    const dictationId = resumeId ?? this.createDictationId();
    this.dictationId = dictationId;
    this.resumeDictationId = null;
    this.sendSeq = 0;
    this.acknowledgedSeq = -1;
    this.streamReady = false;

    const start = (async () => {
      const ack = await client.startDictationStream(
        dictationId,
        this.format,
        resumeId ? { resume: true } : undefined,
      );
      if (this.startGeneration !== generation) {
        return;
      }
      if (this.dictationId !== dictationId) {
        return;
      }
      if (ack && ack.resumed && ack.ackSeq >= 0) {
        // The daemon kept the stream: resend only what it has not acknowledged.
        const ackSeq = Math.min(ack.ackSeq, this.segments.length - 1);
        this.acknowledgedSeq = ackSeq;
        this.sendSeq = ackSeq + 1;
        this.stats.resumes += 1;
      }
      this.streamReady = true;
      this.flush();
      this.resolveDrainWaiters();
    })()
      .catch((error) => {
        // If starting failed, keep the segments for retry but clear the stream so finish can error cleanly.
        if (this.startGeneration === generation && this.dictationId === dictationId) {
          if (this.segments.length > 0) {
            this.resumeDictationId = dictationId;
          }
          this.dictationId = null;
          this.sendSeq = 0;
          this.acknowledgedSeq = -1;
          this.streamReady = false;
          this.resolveDrainWaiters();
        }
        throw error;
      })
      .finally(() => {
        if (this.startPromise === start) {
          this.startPromise = null;
        }
      });

    this.startPromise = start;
    await start;
    void reason;
  }

  async finish(finalSeq: number): Promise<DictationFinishResult> {
    const client = this.client;
    if (!client) {
      throw new Error(i18n.t("common.errors.daemonClientUnavailable"));
    }
    if (!client.isConnected) {
      throw new Error(i18n.t("common.errors.daemonClientDisconnected"));
    }

    if (!this.dictationId) {
      await this.restartStream("finalize");
    }
    if (this.startPromise) {
      await this.startPromise;
    }

    const dictationId = this.dictationId;
    if (!dictationId || !this.streamReady) {
      throw new Error("Failed to start dictation stream");
    }

    this.flush();
    await this.waitForFlushDrain(finalSeq);
    return client.finishDictationStream(dictationId, finalSeq);
  }

  cancel(): void {
    const client = this.client;
    const dictationId = this.dictationId;
    if (client?.isConnected && dictationId) {
      client.cancelDictationStream(dictationId);
    }
    this.resetStreamForReplay();
    this.resumeDictationId = null;
  }

  private hasPendingSegments(): boolean {
    return this.sendSeq < this.segments.length;
  }

  private hasPendingDelivery(finalSeq: number): boolean {
    return this.hasPendingSegments() || this.acknowledgedSeq < finalSeq;
  }

  private handleAck(message: DictationStreamAckMessage): void {
    if (message.payload.dictationId !== this.dictationId) {
      return;
    }
    if (message.payload.ackSeq <= this.acknowledgedSeq) {
      return;
    }
    this.acknowledgedSeq = message.payload.ackSeq;
    this.resolveDrainWaiters();
  }

  private invalidateStream(): void {
    this.resetStreamForReplay();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 0);
  }

  private clearScheduledFlush(): void {
    if (!this.flushTimer) {
      return;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async waitForFlushDrain(finalSeq: number): Promise<void> {
    while (this.hasPendingDelivery(finalSeq)) {
      const client = this.client;
      if (!client?.isConnected || !this.dictationId || !this.streamReady) {
        throw new Error("Failed to flush dictation stream");
      }
      const result = await this.waitForDrainSignal();
      if (result.kind === "timed-out") {
        this.invalidateStream();
        throw new Error("Timed out waiting for dictation stream delivery");
      }
      await waitForNextFlushTurn();
    }
  }

  private waitForDrainSignal(): Promise<DrainWaitResult> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let waiter: (() => void) | null = null;
    const signal = new Promise<"signaled">((resolve) => {
      waiter = () => resolve("signaled");
      this.drainWaiters.push(waiter);
    });
    const timeout = new Promise<"timed-out">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timed-out"), DICTATION_DRAIN_IDLE_TIMEOUT_MS);
    });

    return Promise.race([signal, timeout])
      .finally(() => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (waiter) {
          this.drainWaiters = this.drainWaiters.filter((candidate) => candidate !== waiter);
        }
      })
      .then((kind) => ({ kind }));
  }

  private resolveDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
