import { i18n } from "@/i18n/i18next";

export type DictationStatus = "idle" | "recording" | "uploading" | "failed";

export interface UseDictationOptions {
  client: import("@getpaseo/client/internal/daemon-client").DaemonClient | null;
  onTranscript: (text: string, meta: { requestId: string }) => void;
  onPartialTranscript?: (text: string, meta: { requestId: string }) => void;
  onError?: (error: Error) => void;
  onPermanentFailure?: (error: Error, context: { requestId: string }) => void;
  canStart?: () => boolean;
  canConfirm?: () => boolean;
  enableDuration?: boolean;
}

export interface UseDictationResult {
  isRecording: boolean;
  isRecordingActive: () => boolean;
  isProcessing: boolean;
  partialTranscript: string;
  volume: number;
  duration: number;
  error: string | null;
  status: DictationStatus;
  startDictation: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  confirmDictation: () => Promise<void>;
  retryFailedDictation: () => Promise<void>;
  discardFailedDictation: () => void;
  reset: () => void;
}

export const DURATION_TICK_MS = 1000;
export const PCM_DICTATION_FORMAT = "audio/pcm;rate=16000;bits=16";

export const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return new Error(error);
  }
  return new Error(i18n.t("common.errors.unexpectedDictationError"));
};

export type InterruptedDictationOutcome = "finalize" | "keep-for-retry" | "discard";

/**
 * A call, Siri or an alarm took the mic in the middle of a dictation. Stop, and keep what was
 * said before it: transcribe it now when the daemon is reachable, otherwise hold the audio for
 * the existing retry. Only a dictation with no audio yet is simply dropped.
 */
export function resolveInterruptedDictation(input: {
  hasCapturedAudio: boolean;
  canFinalize: boolean;
}): InterruptedDictationOutcome {
  if (!input.hasCapturedAudio) {
    return "discard";
  }
  return input.canFinalize ? "finalize" : "keep-for-retry";
}

export const DICTATION_INTERRUPTED_MESSAGE = "Dictation was interrupted by another audio source.";
