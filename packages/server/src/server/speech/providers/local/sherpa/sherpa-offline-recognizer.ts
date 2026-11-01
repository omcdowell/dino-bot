import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type pino from "pino";

import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";
import {
  parseSttProviderEnv,
  STT_PROVIDER_ENV,
  type SherpaExecutionProvider,
} from "./sherpa-runtime-env.js";

export { parseSttProviderEnv, STT_PROVIDER_ENV, type SherpaExecutionProvider };

export interface CudaProbeResult {
  ok: boolean;
  reason?: string;
}

// Runs in a throwaway child: a CUDA init failure inside onnxruntime aborts the
// process (uncaught Ort::Exception), so it must never happen in the worker itself.
// A tiny Silero VAD session with provider "cuda" exercises the CUDA EP, cuBLAS and
// cuDNN. A CPU-only sherpa build prints "Fallback to cpu" and is treated as failure.
const CUDA_PROBE_SCRIPT = `
const sherpa = require(process.argv[1]);
const vad = new sherpa.Vad({ sileroVad: { model: process.argv[2], threshold: 0.5,
  minSilenceDuration: 0.25, minSpeechDuration: 0.25, windowSize: 512 },
  sampleRate: 16000, numThreads: 1, provider: "cuda", debug: 0 }, 1);
for (let i = 0; i < 4; i++) vad.acceptWaveform(new Float32Array(512));
process.stdout.write("PASEO_CUDA_PROBE_OK");
`;

export function probeSherpaCuda(options: {
  probeModelPath: string;
  timeoutMs?: number;
}): CudaProbeResult {
  if (!existsSync(options.probeModelPath)) {
    return { ok: false, reason: `probe model missing: ${options.probeModelPath}` };
  }
  let sherpaEntry: string;
  try {
    sherpaEntry = createRequire(import.meta.url).resolve("sherpa-onnx-node");
  } catch (error) {
    return { ok: false, reason: `cannot resolve sherpa-onnx-node: ${String(error)}` };
  }
  const result = spawnSync(
    process.execPath,
    ["-e", CUDA_PROBE_SCRIPT, sherpaEntry, options.probeModelPath],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: options.timeoutMs ?? 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stderr = (result.stderr ?? "").trim();
  if (result.error) {
    return { ok: false, reason: `probe failed to run: ${result.error.message}` };
  }
  if (result.status !== 0 || !(result.stdout ?? "").includes("PASEO_CUDA_PROBE_OK")) {
    return {
      ok: false,
      reason: `probe exited with ${result.status ?? result.signal}: ${stderr.slice(-500)}`,
    };
  }
  if (/fallback to cpu/i.test(stderr)) {
    return { ok: false, reason: `sherpa-onnx has no CUDA support: ${stderr.slice(-300)}` };
  }
  return { ok: true };
}

/**
 * Decide the execution provider for the local STT recognizer from the env.
 * When cuda is requested but unusable, logs once (callers cache the result) and
 * returns cpu.
 */
export function resolveSttExecutionProvider(options: {
  env: NodeJS.ProcessEnv;
  probeCuda: () => CudaProbeResult;
  logger: pino.Logger;
}): SherpaExecutionProvider {
  const parsed = parseSttProviderEnv(options.env[STT_PROVIDER_ENV]);
  if (parsed.invalidValue !== undefined) {
    options.logger.warn(
      { env: STT_PROVIDER_ENV, value: parsed.invalidValue },
      "Unknown local STT provider; using cpu",
    );
  }
  if (parsed.provider !== "cuda") {
    return "cpu";
  }
  let probe: CudaProbeResult;
  try {
    probe = options.probeCuda();
  } catch (error) {
    probe = { ok: false, reason: `probe threw: ${String(error)}` };
  }
  if (!probe.ok) {
    options.logger.warn(
      { env: STT_PROVIDER_ENV, reason: probe.reason },
      "CUDA requested for local STT but unavailable; falling back to cpu",
    );
    return "cpu";
  }
  options.logger.info({ env: STT_PROVIDER_ENV }, "Local STT using CUDA execution provider");
  return "cuda";
}

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function assertModelFilesExist(model: SherpaOfflineRecognizerModel): void {
  assertFileExists(model.encoder, "offline encoder");
  assertFileExists(model.decoder, "offline decoder");
  assertFileExists(model.joiner, "offline joiner");
  assertFileExists(model.tokens, "tokens");
}

export interface SherpaOfflineRecognizerModel {
  kind: "nemo_transducer";
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

function nemoTransducerFiles(modelDir: string, suffix: string): SherpaOfflineRecognizerModel {
  return {
    kind: "nemo_transducer",
    encoder: `${modelDir}/encoder${suffix}.onnx`,
    decoder: `${modelDir}/decoder${suffix}.onnx`,
    joiner: `${modelDir}/joiner${suffix}.onnx`,
    tokens: `${modelDir}/tokens.txt`,
  };
}

export interface ParakeetModelSelection {
  provider: SherpaExecutionProvider;
  model: SherpaOfflineRecognizerModel;
  /** CPU model used for audio too long for the GPU (cuda only). */
  cpuFallbackModel?: SherpaOfflineRecognizerModel;
}

/**
 * Pick the Parakeet model files for the execution provider. The catalog ships
 * int8 models, whose quantized ops have no CUDA kernels (no speedup on GPU), so
 * cuda needs a full-precision export in the sibling `<dir minus -int8>-fp32`
 * directory (encoder.onnx + encoder.weights, decoder.onnx, joiner.onnx,
 * tokens.txt). Without it, cuda is pointless and we stay on cpu.
 */
export function selectParakeetModel(options: {
  modelDir: string;
  provider: SherpaExecutionProvider;
  logger: pino.Logger;
  exists?: (filePath: string) => boolean;
}): ParakeetModelSelection {
  const exists = options.exists ?? existsSync;
  const int8 = nemoTransducerFiles(options.modelDir, ".int8");
  if (options.provider !== "cuda") {
    return { provider: "cpu", model: int8 };
  }
  const fp32Dir = options.modelDir.replace(/-int8$/, "") + "-fp32";
  const fp32 = nemoTransducerFiles(fp32Dir, "");
  if (exists(fp32.encoder) && exists(fp32.decoder) && exists(fp32.joiner) && exists(fp32.tokens)) {
    return { provider: "cuda", model: fp32, cpuFallbackModel: int8 };
  }
  options.logger.warn(
    { fp32Dir },
    "CUDA requested for local STT but no fp32 Parakeet model found; using cpu",
  );
  return { provider: "cpu", model: int8 };
}

/**
 * Longest audio decoded on the GPU. Parakeet's encoder memory grows with input
 * length; on a 6 GB card 300 s fits and 360 s runs out of memory, which aborts
 * the process. Longer audio is decoded on the CPU fallback recognizer.
 */
export const DEFAULT_MAX_CUDA_AUDIO_SECONDS = 240;

export interface SherpaOfflineRecognizerConfig {
  model: SherpaOfflineRecognizerModel;
  numThreads?: number;
  provider?: SherpaExecutionProvider;
  /** cuda only: CPU model for audio longer than maxCudaAudioSeconds (default: model). */
  cpuFallbackModel?: SherpaOfflineRecognizerModel;
  maxCudaAudioSeconds?: number;
  debug?: 0 | 1;
  sampleRate?: number;
  featureDim?: number;
  decodingMethod?: "greedy_search";
  maxActivePaths?: number;
}

interface SherpaOfflineRecognizerNative {
  config?: { featConfig?: { sampleRate?: number } };
  createStream: () => unknown;
  decode: (stream: unknown) => void;
  getResult: (stream: unknown) => { text?: string } | string | undefined;
  free?: () => void;
}

interface SherpaOfflineStreamNative {
  acceptWaveform: ((arg: { samples: Float32Array; sampleRate: number }) => void) &
    ((sampleRate: number, samples: Float32Array) => void);
  free?: () => void;
}

type SherpaOfflineRecognizerCtor = new (config: unknown) => SherpaOfflineRecognizerNative;

export class SherpaOfflineRecognizerEngine {
  public readonly recognizer: SherpaOfflineRecognizerNative;
  public readonly sampleRate: number;
  public readonly provider: SherpaExecutionProvider;
  private readonly logger: pino.Logger;
  private readonly config: SherpaOfflineRecognizerConfig;
  private readonly createRecognizer: (
    model: SherpaOfflineRecognizerModel,
    provider: SherpaExecutionProvider,
  ) => SherpaOfflineRecognizerNative;
  private readonly maxCudaAudioSeconds: number;
  private readonly audioSecondsByStream = new WeakMap<object, number>();
  private cpuFallback: SherpaOfflineRecognizerNative | null = null;

  constructor(
    config: SherpaOfflineRecognizerConfig,
    logger: pino.Logger,
    options: { OfflineRecognizer?: SherpaOfflineRecognizerCtor } = {},
  ) {
    this.logger = logger.child({
      module: "speech",
      provider: "local",
      component: "offline-recognizer",
    });
    this.config = config;
    this.provider = config.provider ?? "cpu";
    this.maxCudaAudioSeconds = config.maxCudaAudioSeconds ?? DEFAULT_MAX_CUDA_AUDIO_SECONDS;

    assertModelFilesExist(config.model);

    const OfflineRecognizer =
      options.OfflineRecognizer ??
      (loadSherpaOnnxNode() as unknown as { OfflineRecognizer: SherpaOfflineRecognizerCtor })
        .OfflineRecognizer;

    const featConfig = {
      sampleRate: config.sampleRate ?? 16000,
      featureDim: config.featureDim ?? 80,
    };
    const numThreads = config.numThreads ?? 1;
    this.createRecognizer = (model, provider) =>
      new OfflineRecognizer({
        featConfig,
        modelConfig: {
          transducer: {
            encoder: model.encoder,
            decoder: model.decoder,
            joiner: model.joiner,
          },
          tokens: model.tokens,
          modelType: "nemo_transducer",
          numThreads,
          provider,
          debug: config.debug ?? 0,
        },
        decodingMethod: config.decodingMethod ?? "greedy_search",
        maxActivePaths: config.maxActivePaths ?? 4,
      });

    this.recognizer = this.createRecognizer(config.model, this.provider);
    const sr = this.recognizer?.config?.featConfig?.sampleRate;
    this.sampleRate =
      typeof sr === "number" && Number.isFinite(sr) && sr > 0 ? sr : featConfig.sampleRate;

    this.logger.info(
      {
        sampleRate: this.sampleRate,
        numThreads,
        provider: this.provider,
        encoder: config.model.encoder,
      },
      "Sherpa offline recognizer initialized",
    );
  }

  createStream(): SherpaOfflineStreamNative {
    return this.recognizer.createStream() as SherpaOfflineStreamNative;
  }

  acceptWaveform(
    stream: SherpaOfflineStreamNative,
    sampleRate: number,
    samples: Float32Array,
  ): void {
    if (!stream || typeof stream.acceptWaveform !== "function") {
      throw new Error("Unexpected sherpa offline stream: missing acceptWaveform()");
    }

    // sherpa-onnx-node expects: acceptWaveform({ samples, sampleRate })
    // sherpa-onnx (WASM) expects: acceptWaveform(sampleRate, samples)
    if (stream.acceptWaveform.length <= 1) {
      stream.acceptWaveform({ samples, sampleRate });
    } else {
      stream.acceptWaveform(sampleRate, samples);
    }
    if (sampleRate > 0) {
      const prior = this.audioSecondsByStream.get(stream) ?? 0;
      this.audioSecondsByStream.set(stream, prior + samples.length / sampleRate);
    }
  }

  /**
   * Decode a stream. On cuda, audio longer than maxCudaAudioSeconds goes to a
   * lazily created CPU recognizer (streams are recognizer-independent in sherpa).
   */
  decode(stream: SherpaOfflineStreamNative): void {
    const seconds = this.audioSecondsByStream.get(stream) ?? 0;
    if (this.provider === "cuda" && seconds > this.maxCudaAudioSeconds) {
      this.getCpuFallback().decode(stream);
      return;
    }
    this.recognizer.decode(stream);
  }

  getResult(stream: SherpaOfflineStreamNative): { text?: string } | string | undefined {
    return this.recognizer.getResult(stream);
  }

  private getCpuFallback(): SherpaOfflineRecognizerNative {
    if (!this.cpuFallback) {
      const model = this.config.cpuFallbackModel ?? this.config.model;
      assertModelFilesExist(model);
      this.logger.info(
        { maxCudaAudioSeconds: this.maxCudaAudioSeconds, encoder: model.encoder },
        "Audio too long for GPU; creating CPU fallback recognizer",
      );
      this.cpuFallback = this.createRecognizer(model, "cpu");
    }
    return this.cpuFallback;
  }

  free(): void {
    for (const recognizer of [this.recognizer, this.cpuFallback]) {
      try {
        recognizer?.free?.();
      } catch (err) {
        this.logger.warn({ err }, "Failed to free sherpa offline recognizer");
      }
    }
  }
}
