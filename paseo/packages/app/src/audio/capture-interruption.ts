/**
 * What the JS audio engine does with an `onAudioInterruption` event from expo-two-way-audio.
 *
 * Native (ios/AudioEngine.swift) reports three phases:
 * - "began":   a phone call, Siri, an alarm… took the audio session. Native has already stopped
 *              the mic and released the session, so no more audio arrives.
 * - "ended":   the interruption is over and iOS said we may resume. Native has already turned
 *              the mic back on and re-activated the (non-mixing) session on its own.
 * - "blocked": the interruption is over but iOS said not to resume.
 *
 * Policies:
 * - "end-on-began" (dictation): the capture is over as soon as the interruption begins, so the
 *   caller can stop cleanly and keep what it captured. Without this, the UI kept "recording"
 *   silence for the whole call.
 * - "end-if-blocked" (realtime voice): capture ends only when iOS refuses to resume; otherwise
 *   native resumes the mic after the interruption and the conversation carries on.
 *
 * Whatever the policy, an "ended" while JS is not capturing means native re-opened the mic and
 * the session for nobody: hand both back so we never hold the mic outside a capture and the
 * user's music can come back.
 */
export type CaptureInterruptionPolicy = "end-on-began" | "end-if-blocked";

export type CaptureInterruptionAction =
  /** Capture is over: mark it stopped, release the session if idle, tell the caller. */
  | "end-capture"
  /** Nobody is capturing but native resumed the mic: turn it off and release the session. */
  | "silence-mic"
  | "none";

export function resolveCaptureInterruption(input: {
  event: string;
  captureActive: boolean;
  policy: CaptureInterruptionPolicy;
}): CaptureInterruptionAction {
  const { event, captureActive, policy } = input;
  switch (event) {
    case "began":
      return captureActive && policy === "end-on-began" ? "end-capture" : "none";
    case "blocked":
      return captureActive ? "end-capture" : "none";
    case "ended":
      return captureActive ? "none" : "silence-mic";
    default:
      return "none";
  }
}
