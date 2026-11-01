import { useCallback, useEffect, useRef } from "react";
import { Buffer } from "buffer";
import { useState } from "react";

import { createAudioEngine } from "@/audio";
import {
  DICTATION_OPUS_FORMAT,
  DICTATION_PCM_FORMAT,
} from "@getpaseo/protocol/dictation-audio-format";
import { OpusSegmentEncoder, type NativeOpusEncoderPort } from "@/dictation/opus-segment-encoder";

import type {
  DictationAudioSource,
  DictationAudioSourceConfig,
} from "./use-dictation-audio-source.types";

function loadNativeOpusPort(): NativeOpusEncoderPort | null {
  try {
    return require("@getpaseo/expo-two-way-audio") as NativeOpusEncoderPort;
  } catch {
    return null;
  }
}

export function useDictationAudioSource(config: DictationAudioSourceConfig): DictationAudioSource {
  const onAudioSegmentRef = useRef(config.onAudioSegment);
  const onErrorRef = useRef(config.onError);
  const onInterruptionRef = useRef(config.onInterruption);
  const [volume, setVolume] = useState(0);
  const engineRef = useRef<ReturnType<typeof createAudioEngine> | null>(null);
  // Set by prepareFormat for an Opus recording; null records PCM16.
  const opusEncoderRef = useRef<OpusSegmentEncoder | null>(null);

  const emitBytes = useCallback((bytes: Uint8Array) => {
    if (bytes.length === 0) {
      return;
    }
    onAudioSegmentRef.current(Buffer.from(bytes).toString("base64"));
  }, []);

  const getOrCreateEngine = useCallback(() => {
    if (engineRef.current) {
      return engineRef.current;
    }

    engineRef.current = createAudioEngine(
      {
        onCaptureData: (pcm) => {
          const encoder = opusEncoderRef.current;
          if (!encoder) {
            emitBytes(pcm);
            return;
          }
          try {
            // Whole 20 ms packets only; the remainder waits for the next callback.
            emitBytes(encoder.encode(pcm));
          } catch (error) {
            onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
          }
        },
        onVolumeLevel: (level) => {
          setVolume(level);
        },
        onError: (error) => {
          onErrorRef.current?.(error);
        },
        onInterruption: () => {
          onInterruptionRef.current?.();
        },
      },
      // A call or Siri ends the dictation as soon as it starts, so what was said before it is kept.
      { interruptionPolicy: "end-on-began" },
    );
    return engineRef.current;
  }, [emitBytes]);

  useEffect(() => {
    onAudioSegmentRef.current = config.onAudioSegment;
    onErrorRef.current = config.onError;
    onInterruptionRef.current = config.onInterruption;
  }, [config.onAudioSegment, config.onError, config.onInterruption]);

  const prepareFormat = useCallback((preferOpus: boolean) => {
    opusEncoderRef.current?.release();
    opusEncoderRef.current = preferOpus ? OpusSegmentEncoder.create(loadNativeOpusPort()) : null;
    return opusEncoderRef.current ? DICTATION_OPUS_FORMAT : DICTATION_PCM_FORMAT;
  }, []);

  const start = useCallback(async () => {
    const engine = getOrCreateEngine();
    await engine.initialize();
    await engine.startCapture();
  }, [getOrCreateEngine]);

  const stop = useCallback(
    async (options?: { discard?: boolean }) => {
      await engineRef.current?.stopCapture();
      setVolume(0);
      // Hand over the last partial frame before the caller reads the final seq.
      const encoder = opusEncoderRef.current;
      if (encoder) {
        opusEncoderRef.current = null;
        if (options?.discard) {
          encoder.release();
          return;
        }
        try {
          emitBytes(encoder.finish());
        } catch (error) {
          onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    },
    [emitBytes],
  );

  useEffect(() => {
    return () => {
      const engine = engineRef.current;
      engineRef.current = null;
      opusEncoderRef.current?.release();
      opusEncoderRef.current = null;
      void engine?.destroy().catch(() => undefined);
    };
  }, []);

  return {
    prepareFormat,
    start,
    stop,
    volume,
  };
}
