/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationModule } from "./lazy-dictation";

const mocks = vi.hoisted(() => ({
  client: { isConnected: true } as { isConnected: boolean } | null,
  ready: true,
  serverInfo: null as unknown,
  unavailable: null as string | null,
  toast: { show: vi.fn(), error: vi.fn() },
  dictationOptions: null as null | {
    onTranscript: (text: string, meta: { requestId: string }) => void;
    onError?: (error: Error) => void;
    canStart?: () => boolean;
    canConfirm?: () => boolean;
    enableDuration?: boolean;
  },
  startDictation: vi.fn(async () => {}),
  cancelDictation: vi.fn(async () => {}),
  confirmDictation: vi.fn(async () => {}),
  retryFailedDictation: vi.fn(async () => {}),
  discardFailedDictation: vi.fn(),
}));

vi.mock("@/components/dictation-controls", () => ({ DictationOverlay: () => null }));
vi.mock("@/contexts/toast-api-context", () => ({ useToast: () => mocks.toast }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mocks.client,
  useHostRuntimeIsConnected: () => mocks.client?.isConnected ?? false,
  useHostRuntimeAgentDirectoryStatus: () => "ready",
}));
vi.mock("@/hooks/use-is-dictation-ready", () => ({ useIsDictationReady: () => mocks.ready }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: { "host-1": { serverInfo: mocks.serverInfo } } }),
}));
vi.mock("@/utils/server-info-capabilities", () => ({
  resolveVoiceUnavailableMessage: () => mocks.unavailable,
}));
vi.mock("@/hooks/use-dictation", () => ({
  useDictation: (options: NonNullable<typeof mocks.dictationOptions>) => {
    mocks.dictationOptions = options;
    return {
      isRecording: false,
      isRecordingActive: () => false,
      isProcessing: false,
      partialTranscript: "",
      volume: 0.25,
      duration: 3,
      error: null,
      status: "idle",
      startDictation: mocks.startDictation,
      cancelDictation: mocks.cancelDictation,
      confirmDictation: mocks.confirmDictation,
      retryFailedDictation: mocks.retryFailedDictation,
      discardFailedDictation: mocks.discardFailedDictation,
      reset: () => {},
    };
  },
}));

const dictationModule = await import("./dictation");
const { usePluginDictation } = dictationModule;

describe("usePluginDictation", () => {
  beforeEach(() => {
    mocks.client = { isConnected: true };
    mocks.ready = true;
    mocks.unavailable = null;
    mocks.dictationOptions = null;
    vi.clearAllMocks();
  });

  it("is ready and starts the app's dictation when the host can dictate", async () => {
    const { result } = renderHook(() =>
      usePluginDictation({ serverId: "host-1", onTranscript: () => {} }),
    );
    expect(result.current).toMatchObject({
      ready: true,
      unavailableMessage: null,
      status: "idle",
      volume: 0.25,
      duration: 3,
    });
    expect(mocks.dictationOptions?.enableDuration).toBe(true);
    expect(mocks.dictationOptions?.canStart?.()).toBe(true);

    await act(() => result.current.start());
    expect(mocks.startDictation).toHaveBeenCalledTimes(1);
    expect(result.current.cancel).toBe(mocks.cancelDictation);
    expect(result.current.confirm).toBe(mocks.confirmDictation);
    expect(result.current.retry).toBe(mocks.retryFailedDictation);
    expect(result.current.discard).toBe(mocks.discardFailedDictation);
  });

  it("toasts the host's reason and does not record when dictation is unavailable", async () => {
    mocks.unavailable = "Dictation model is still downloading";
    const { result } = renderHook(() =>
      usePluginDictation({ serverId: "host-1", onTranscript: () => {} }),
    );
    expect(result.current.ready).toBe(false);
    expect(result.current.unavailableMessage).toBe("Dictation model is still downloading");

    await act(() => result.current.start());
    expect(mocks.toast.error).toHaveBeenCalledWith("Dictation model is still downloading");
    expect(mocks.startDictation).not.toHaveBeenCalled();
  });

  it("does not record while the host is disconnected", async () => {
    mocks.client = { isConnected: false };
    mocks.ready = false;
    const { result } = renderHook(() =>
      usePluginDictation({ serverId: "host-1", onTranscript: () => {} }),
    );
    expect(result.current.ready).toBe(false);
    await act(() => result.current.start());
    expect(mocks.startDictation).not.toHaveBeenCalled();
    expect(mocks.dictationOptions?.canConfirm?.()).toBe(false);
  });

  it("hands the transcript to the latest callback and errors to onError, else a toast", () => {
    const first = vi.fn();
    const second = vi.fn();
    const onError = vi.fn();
    const { rerender } = renderHook(
      ({ onTranscript, withError }) =>
        usePluginDictation({
          serverId: "host-1",
          onTranscript,
          onError: withError ? onError : undefined,
        }),
      { initialProps: { onTranscript: first, withError: true } },
    );
    rerender({ onTranscript: second, withError: true });
    act(() => mocks.dictationOptions?.onTranscript("hello there", { requestId: "r1" }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("hello there");

    act(() => mocks.dictationOptions?.onError?.(new Error("boom")));
    expect(onError).toHaveBeenCalledWith(new Error("boom"));
    expect(mocks.toast.error).not.toHaveBeenCalled();

    rerender({ onTranscript: second, withError: false });
    act(() => mocks.dictationOptions?.onError?.(new Error("boom")));
    expect(mocks.toast.error).toHaveBeenCalledWith("boom");
  });
});

describe("the module lazy-dictation loads by require", () => {
  it("has the shape the plugin runtime expects", () => {
    // Typed: tsgo fails here if ./dictation drifts from DictationModule.
    const shape: DictationModule = dictationModule;
    expect(typeof shape.usePluginDictation).toBe("function");
    expect(typeof shape.DictationOverlay).toBe("function");
  });
});
