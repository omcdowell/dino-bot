/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { DictationAudioSourceConfig } from "./use-dictation-audio-source.types";
import { resolveInterruptedDictation } from "./use-dictation.shared";

const mocks = vi.hoisted(() => ({
  audioConfig: null as null | DictationAudioSourceConfig,
  audioStart: vi.fn(async () => {}),
  audioStop: vi.fn(async () => {}),
  // The device can encode Opus: the format follows the daemon's flag.
  prepareFormat: vi.fn((preferOpus: boolean) =>
    preferOpus ? "audio/opus;rate=16000;channels=1;framing=len16" : "audio/pcm;rate=16000;bits=16",
  ),
}));

vi.mock("@/hooks/use-dictation-audio-source", () => ({
  useDictationAudioSource: (config: DictationAudioSourceConfig) => {
    mocks.audioConfig = config;
    return {
      start: mocks.audioStart,
      stop: mocks.audioStop,
      volume: 0,
      prepareFormat: mocks.prepareFormat,
    };
  },
}));

const { useDictation } = await import("./use-dictation");

class FakeClient {
  isConnected = true;
  dictationOpus = false;
  starts: { dictationId: string; format: string }[] = [];
  chunkFormats: string[] = [];
  supportsDictationOpus(): boolean {
    return this.dictationOpus;
  }
  finishes: { dictationId: string; finalSeq: number }[] = [];
  cancels: string[] = [];
  private readonly listeners = new Set<(message: SessionOutboundMessage) => void>();

  async startDictationStream(dictationId: string, format: string): Promise<void> {
    this.starts.push({ dictationId, format });
  }
  sendDictationStreamChunk(dictationId: string, seq: number, _audio: string, format: string): void {
    this.chunkFormats.push(format);
    for (const listener of this.listeners) {
      listener({
        type: "dictation_stream_ack",
        payload: { dictationId, ackSeq: seq },
      } as SessionOutboundMessage);
    }
  }
  async finishDictationStream(dictationId: string, finalSeq: number) {
    this.finishes.push({ dictationId, finalSeq });
    return { dictationId, text: "what I said before the call" };
  }
  cancelDictationStream(dictationId: string): void {
    this.cancels.push(dictationId);
  }
  subscribeRawMessages(handler: (message: SessionOutboundMessage) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  subscribeConnectionStatus(): () => void {
    return () => {};
  }
  on(): () => void {
    return () => {};
  }
}

function setup(client: FakeClient) {
  const onTranscript = vi.fn();
  const onPermanentFailure = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() =>
    useDictation({
      client: client as never,
      onTranscript,
      onPermanentFailure,
      onError,
      canConfirm: () => client.isConnected,
    }),
  );
  return { hook, onTranscript, onPermanentFailure, onError };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useDictation audio interruption (call, Siri)", () => {
  beforeEach(() => {
    mocks.audioConfig = null;
    vi.clearAllMocks();
  });

  it("stops and transcribes what was captured before the interruption", async () => {
    const client = new FakeClient();
    const { hook, onTranscript, onPermanentFailure } = setup(client);

    await act(() => hook.result.current.startDictation());
    expect(hook.result.current.isRecording).toBe(true);
    act(() => {
      mocks.audioConfig!.onAudioSegment("AAAA");
      mocks.audioConfig!.onAudioSegment("BBBB");
    });
    await flush();

    act(() => mocks.audioConfig!.onInterruption?.());
    await flush();

    expect(mocks.audioStop).toHaveBeenCalled();
    expect(client.finishes).toEqual([{ dictationId: expect.any(String), finalSeq: 1 }]);
    expect(onTranscript).toHaveBeenCalledWith("what I said before the call", expect.anything());
    expect(onPermanentFailure).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.isRecording).toBe(false);
  });

  it("keeps the audio for retry when the daemon is unreachable", async () => {
    const client = new FakeClient();
    const { hook, onTranscript, onPermanentFailure } = setup(client);

    await act(() => hook.result.current.startDictation());
    client.isConnected = false;
    act(() => mocks.audioConfig!.onAudioSegment("AAAA"));
    act(() => mocks.audioConfig!.onInterruption?.());
    await flush();

    expect(mocks.audioStop).toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onPermanentFailure).toHaveBeenCalledTimes(1);
    expect(hook.result.current.status).toBe("failed");
    expect(hook.result.current.isRecording).toBe(false);

    client.isConnected = true;
    await act(() => hook.result.current.retryFailedDictation());
    expect(client.finishes).toEqual([{ dictationId: expect.any(String), finalSeq: 0 }]);
    expect(onTranscript).toHaveBeenCalledWith("what I said before the call", expect.anything());
  });

  it("just stops when nothing was captured yet", async () => {
    const client = new FakeClient();
    const { hook, onTranscript, onPermanentFailure } = setup(client);

    await act(() => hook.result.current.startDictation());
    act(() => mocks.audioConfig!.onInterruption?.());
    await flush();

    expect(mocks.audioStop).toHaveBeenCalled();
    expect(client.finishes).toEqual([]);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onPermanentFailure).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("idle");
    expect(hook.result.current.isRecording).toBe(false);
  });

  it("ignores an interruption when not dictating", async () => {
    const client = new FakeClient();
    const { hook } = setup(client);
    act(() => mocks.audioConfig!.onInterruption?.());
    await flush();
    expect(mocks.audioStop).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("idle");
  });
});

describe("resolveInterruptedDictation", () => {
  it("finalizes captured audio when the daemon is reachable", () => {
    expect(resolveInterruptedDictation({ hasCapturedAudio: true, canFinalize: true })).toBe(
      "finalize",
    );
  });
  it("keeps captured audio for retry when it is not", () => {
    expect(
      resolveInterruptedDictation({
        hasCapturedAudio: true,
        canFinalize: false,
      }),
    ).toBe("keep-for-retry");
  });
  it("discards an empty dictation", () => {
    expect(
      resolveInterruptedDictation({
        hasCapturedAudio: false,
        canFinalize: true,
      }),
    ).toBe("discard");
  });
});

describe("useDictation audio format (dictationOpus feature flag)", () => {
  beforeEach(() => {
    mocks.audioConfig = null;
    vi.clearAllMocks();
  });

  it("records Opus when the daemon advertises dictationOpus", async () => {
    const client = new FakeClient();
    client.dictationOpus = true;
    const { hook } = setup(client);
    await act(() => hook.result.current.startDictation());
    act(() => mocks.audioConfig!.onAudioSegment("AAAA"));
    await flush();
    expect(mocks.prepareFormat).toHaveBeenCalledWith(true);
    expect(client.starts.map((s) => s.format)).toEqual([
      "audio/opus;rate=16000;channels=1;framing=len16",
    ]);
    expect(client.chunkFormats).toEqual(["audio/opus;rate=16000;channels=1;framing=len16"]);
  });

  it("records PCM for a daemon without the flag (today's daemon)", async () => {
    const client = new FakeClient();
    const { hook } = setup(client);
    await act(() => hook.result.current.startDictation());
    act(() => mocks.audioConfig!.onAudioSegment("AAAA"));
    await flush();
    expect(mocks.prepareFormat).toHaveBeenCalledWith(false);
    expect(client.starts.map((s) => s.format)).toEqual(["audio/pcm;rate=16000;bits=16"]);
    expect(client.chunkFormats).toEqual(["audio/pcm;rate=16000;bits=16"]);
  });

  it("cancel drops the encoder tail instead of sending it", async () => {
    const client = new FakeClient();
    client.dictationOpus = true;
    const { hook } = setup(client);
    await act(() => hook.result.current.startDictation());
    await act(() => hook.result.current.cancelDictation());
    expect(mocks.audioStop).toHaveBeenCalledWith({ discard: true });
  });
});
