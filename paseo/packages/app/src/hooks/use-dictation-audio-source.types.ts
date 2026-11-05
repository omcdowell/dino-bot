export interface DictationAudioSourceConfig {
  /** One base64 segment of audio, in the format the last `prepareFormat` returned. */
  onAudioSegment: (audioBase64: string) => void;
  onError?: (error: Error) => void;
  onInterruption?: () => void;
}

export interface DictationAudioSource {
  /**
   * Pick the encoding for the next `start()`. With `preferOpus` and a device that can encode it,
   * segments are len16 Opus (DICTATION_OPUS_FORMAT); otherwise PCM16. Returns that format.
   */
  prepareFormat: (preferOpus: boolean) => string;
  start: () => Promise<void>;
  /** `discard`: drop the encoder's buffered tail instead of emitting it (cancel). */
  stop: (options?: { discard?: boolean }) => Promise<void>;
  volume: number;
}
