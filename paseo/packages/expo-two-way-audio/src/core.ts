import { type PermissionResponse } from "expo-modules-core";
import ExpoTwoWayAudioModule from "./ExpoTwoWayAudioModule";

export async function initialize() {
  return await ExpoTwoWayAudioModule.initialize();
}

export function playPCMData(audioData: Uint8Array) {
  return ExpoTwoWayAudioModule.playPCMData(audioData);
}

export function bypassVoiceProcessing(bypass: boolean) {
  return ExpoTwoWayAudioModule.bypassVoiceProcessing(bypass);
}

export function toggleRecording(val: boolean): boolean {
  return ExpoTwoWayAudioModule.toggleRecording(val);
}

export function isRecording(): boolean {
  return ExpoTwoWayAudioModule.isRecording();
}

/**
 * Hand the OS audio session / audio focus back once nothing is being captured or played,
 * so other apps' audio can resume. Safe to call when already released.
 */
export function releaseAudioSession() {
  // COMPAT(releaseAudioSession): added in v0.2.6. An OTA JS update can land on an older
  // binary whose native module lacks this function, so probe the native object rather than
  // this wrapper (which always exists). Drop the guard once the binary floor is >= v0.2.6.
  if (typeof ExpoTwoWayAudioModule.releaseAudioSession !== "function") {
    return;
  }
  return ExpoTwoWayAudioModule.releaseAudioSession();
}

export function tearDown() {
  return ExpoTwoWayAudioModule.tearDown();
}

export function restart() {
  return ExpoTwoWayAudioModule.restart();
}

export async function getMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return ExpoTwoWayAudioModule.getMicrophonePermissionsAsync();
}

export async function requestMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return ExpoTwoWayAudioModule.requestMicrophonePermissionsAsync();
}

export function getMicrophoneModeIOS() {
  return ExpoTwoWayAudioModule.getMicrophoneModeIOS();
}

export function setMicrophoneModeIOS() {
  return ExpoTwoWayAudioModule.setMicrophoneModeIOS();
}

export function isPlaying(): boolean {
  return ExpoTwoWayAudioModule.isPlaying();
}

export function stopPlayback() {
  return ExpoTwoWayAudioModule.stopPlayback();
}

export function pausePlayback() {
  return ExpoTwoWayAudioModule.pausePlayback();
}

export function resumePlayback() {
  return ExpoTwoWayAudioModule.resumePlayback();
}

// COMPAT(dictationOpus): added with build 48. An OTA JS update can land on an older binary
// whose native module lacks these, so callers check `isOpusEncoderAvailable()` first.
export function isOpusEncoderAvailable(): boolean {
  return (
    typeof ExpoTwoWayAudioModule.createOpusEncoder === "function" &&
    typeof ExpoTwoWayAudioModule.opusEncode === "function"
  );
}

/** iOS: AudioToolbox Opus, 16 kHz mono, 20 ms frames. Returns a handle, or -1 if unavailable. */
export function createOpusEncoder(bitRate: number): number {
  return ExpoTwoWayAudioModule.createOpusEncoder(bitRate);
}

/** PCM16LE mono in; len16-framed Opus packets out (empty until a full 20 ms frame is buffered). */
export function opusEncode(handle: number, pcm: Uint8Array): Uint8Array {
  return ExpoTwoWayAudioModule.opusEncode(handle, pcm);
}

/** Pads the last partial frame with silence and returns the remaining packets. */
export function flushOpusEncoder(handle: number): Uint8Array {
  return ExpoTwoWayAudioModule.flushOpusEncoder(handle);
}

export function releaseOpusEncoder(handle: number): void {
  ExpoTwoWayAudioModule.releaseOpusEncoder(handle);
}
