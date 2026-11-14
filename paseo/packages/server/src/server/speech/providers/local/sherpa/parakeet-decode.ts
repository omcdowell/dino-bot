/**
 * One-shot decode of float samples on a sherpa offline recognizer, with a retry for
 * Parakeet TDT's "empty result" failure.
 *
 * Parakeet TDT greedy decoding sometimes returns no text at all for clear speech when
 * the audio starts mid-word (no leading silence): the first frames predict blank with
 * a long duration and the decoder never recovers. It happens on sherpa-onnx 1.13.8
 * (live dictation lost 20261112T132833) and 2.0.1 (its NeMo log-zero guard change,
 * k2-fsa/sherpa-onnx#3999, moves which clips hit it, e.g. 20261109T152829). Prepending
 * 250 ms of silence recovers both clips. Doing it always changes ~3% of words on a
 * 74-file corpus, so only retry when the first decode is empty and the audio carries
 * signal.
 */

export interface DecodeEngine<S> {
  createStream(): S;
  acceptWaveform(stream: S, sampleRate: number, samples: Float32Array): void;
  decode(stream: S): void;
  getResult(stream: S): unknown;
}

export const EMPTY_RETRY_LEAD_SECONDS = 0.25;
/** Below this the clip is too short for the retry to be worth a second decode. */
const EMPTY_RETRY_MIN_SECONDS = 0.5;
/** RMS gate (about -50 dBFS): silence decodes empty legitimately. */
const EMPTY_RETRY_MIN_RMS = 0.003;

export function sherpaResultText(result: unknown): string {
  return String(
    (typeof result === "object" && result && "text" in result
      ? (result as { text?: unknown }).text
      : undefined) ??
      result ??
      "",
  ).trim();
}

function decodeOnce<S>(
  engine: DecodeEngine<S>,
  sampleRate: number,
  samples: Float32Array,
): unknown {
  const stream = engine.createStream();
  try {
    engine.acceptWaveform(stream, sampleRate, samples);
    engine.decode(stream);
    return engine.getResult(stream);
  } finally {
    try {
      (stream as { free?: () => void } | null)?.free?.();
    } catch {
      // ignore
    }
  }
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
}

function shiftTimestamps(result: unknown, seconds: number): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as { timestamps?: unknown };
  if (!Array.isArray(r.timestamps) && !ArrayBuffer.isView(r.timestamps)) return result;
  const shifted = Array.from(r.timestamps as ArrayLike<number>, (t) => Math.max(0, t - seconds));
  return { ...(result as object), timestamps: shifted };
}

export function decodeWithEmptyRetry<S>(
  engine: DecodeEngine<S>,
  sampleRate: number,
  samples: Float32Array,
): unknown {
  const first = decodeOnce(engine, sampleRate, samples);
  if (sherpaResultText(first).length > 0) return first;
  if (samples.length < EMPTY_RETRY_MIN_SECONDS * sampleRate) return first;
  if (rms(samples) < EMPTY_RETRY_MIN_RMS) return first;

  const lead = Math.round(EMPTY_RETRY_LEAD_SECONDS * sampleRate);
  const padded = new Float32Array(lead + samples.length);
  padded.set(samples, lead);
  const retry = decodeOnce(engine, sampleRate, padded);
  if (sherpaResultText(retry).length === 0) return first;
  return shiftTimestamps(retry, lead / sampleRate);
}
