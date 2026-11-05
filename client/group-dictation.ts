/**
 * The Paseo mic in the group composer.
 *
 * Paseo builds from 28 on expose the app's dictation to plugins as `usePluginDictation` and
 * `DictationOverlay` on `@getpaseo/plugin/client/react-native`. The SDK this plugin compiles
 * against (0.11.1) does not declare them, and older apps do not have them, so the group screen
 * looks them up on the module at load time and hides the mic when they are missing.
 * No react-native import here, so the helpers run under `tsx --test`.
 */
import type { ComponentType } from "react";

export type DictationStatus = "idle" | "recording" | "uploading" | "failed";

export interface HostDictation {
  ready: boolean;
  unavailableMessage: string | null;
  status: DictationStatus;
  volume: number;
  duration: number;
  isRecording: boolean;
  isProcessing: boolean;
  error: string | null;
  start(): Promise<void>;
  cancel(): Promise<void>;
  confirm(): Promise<void>;
  retry(): Promise<void>;
  discard(): void;
}

export interface DictationOverlayProps {
  volume: number;
  duration: number;
  isRecording: boolean;
  isProcessing: boolean;
  status: DictationStatus;
  errorText?: string;
  onCancel(): void;
  onAccept(): void;
  onAcceptAndSend(): void;
  onRetry?(): void;
  onDiscard?(): void;
}

export interface DictationApi {
  usePluginDictation(options: {
    serverId: string;
    onTranscript(text: string): void;
    onError?(error: Error): void;
  }): HostDictation;
  DictationOverlay: ComponentType<DictationOverlayProps>;
}

/** The app's dictation, or null on Paseo builds without it (then the mic is hidden). */
export function hostDictation(module: unknown): DictationApi | null {
  if (!module || typeof module !== "object") return null;
  const m = module as Partial<Record<keyof DictationApi, unknown>>;
  if (typeof m.usePluginDictation !== "function") return null;
  const overlay = m.DictationOverlay;
  // A component: a function, or a memo/forwardRef object.
  if (!overlay || (typeof overlay !== "function" && typeof overlay !== "object")) return null;
  return m as unknown as DictationApi;
}

/** The overlay replaces the input from the first sound until the text lands or is discarded. */
export function showsDictationOverlay(status: DictationStatus, isRecording: boolean, isProcessing: boolean): boolean {
  return isRecording || isProcessing || status === "failed";
}

/**
 * Put dictated text at the cursor, with one space between it and any word it touches.
 * Returns the new draft and the cursor just after the inserted text.
 */
export function insertDictation(draft: string, cursor: number, spoken: string): { text: string; cursor: number } {
  const words = spoken.trim();
  const at = Math.max(0, Math.min(cursor, draft.length));
  if (!words) return { text: draft, cursor: at };
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && !/^\s/.test(after) ? " " : "";
  const insert = lead + words + tail;
  return { text: before + insert + after, cursor: at + lead.length + words.length };
}
