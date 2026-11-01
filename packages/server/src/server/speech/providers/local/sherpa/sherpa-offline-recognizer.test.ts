import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

import {
  parseSttProviderEnv,
  probeSherpaCuda,
  resolveSttExecutionProvider,
  selectParakeetModel,
  SherpaOfflineRecognizerEngine,
  STT_PROVIDER_ENV,
} from "./sherpa-offline-recognizer.js";
import { applySttCudaLibraryEnv, STT_CUDA_LIBRARY_PATH_ENV } from "./sherpa-runtime-env.js";

function spyLogger() {
  const logger = pino({ level: "silent" });
  const warn = vi.spyOn(logger, "warn");
  const info = vi.spyOn(logger, "info");
  return { logger, warn, info };
}

describe("parseSttProviderEnv", () => {
  it("defaults to cpu when unset or empty", () => {
    expect(parseSttProviderEnv(undefined)).toEqual({ provider: "cpu" });
    expect(parseSttProviderEnv("")).toEqual({ provider: "cpu" });
    expect(parseSttProviderEnv("  ")).toEqual({ provider: "cpu" });
  });

  it("accepts cpu and cuda case-insensitively, gpu as an alias for cuda", () => {
    expect(parseSttProviderEnv("cpu")).toEqual({ provider: "cpu" });
    expect(parseSttProviderEnv("CUDA")).toEqual({ provider: "cuda" });
    expect(parseSttProviderEnv(" cuda ")).toEqual({ provider: "cuda" });
    expect(parseSttProviderEnv("gpu")).toEqual({ provider: "cuda" });
  });

  it("falls back to cpu and reports unknown values", () => {
    expect(parseSttProviderEnv("tensorrt")).toEqual({ provider: "cpu", invalidValue: "tensorrt" });
  });
});

describe("resolveSttExecutionProvider", () => {
  it("returns cpu without probing when the env var is unset", () => {
    const { logger, warn } = spyLogger();
    const probeCuda = vi.fn();
    expect(resolveSttExecutionProvider({ env: {}, probeCuda, logger })).toBe("cpu");
    expect(probeCuda).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on an unknown value and uses cpu without probing", () => {
    const { logger, warn } = spyLogger();
    const probeCuda = vi.fn();
    const env = { [STT_PROVIDER_ENV]: "metal" };
    expect(resolveSttExecutionProvider({ env, probeCuda, logger })).toBe("cpu");
    expect(probeCuda).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("uses cuda when requested and the probe succeeds", () => {
    const { logger, warn, info } = spyLogger();
    const probeCuda = vi.fn(() => ({ ok: true }));
    const env = { [STT_PROVIDER_ENV]: "cuda" };
    expect(resolveSttExecutionProvider({ env, probeCuda, logger })).toBe("cuda");
    expect(probeCuda).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("falls back to cpu and logs once when the CUDA probe fails", () => {
    const { logger, warn } = spyLogger();
    const probeCuda = vi.fn(() => ({ ok: false, reason: "libcudnn.so.9 not found" }));
    const env = { [STT_PROVIDER_ENV]: "cuda" };
    expect(resolveSttExecutionProvider({ env, probeCuda, logger })).toBe("cpu");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ reason: "libcudnn.so.9 not found" });
  });

  it("falls back to cpu when the probe itself throws", () => {
    const { logger, warn } = spyLogger();
    const probeCuda = vi.fn(() => {
      throw new Error("spawn failed");
    });
    const env = { [STT_PROVIDER_ENV]: "cuda" };
    expect(resolveSttExecutionProvider({ env, probeCuda, logger })).toBe("cpu");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("probeSherpaCuda", () => {
  it("fails without spawning when the probe model is missing", () => {
    const result = probeSherpaCuda({ probeModelPath: "/nonexistent/silero_vad.onnx" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("probe model missing");
  });
});

const INT8_DIR = "/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
const FP32_DIR = "/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-fp32";

describe("selectParakeetModel", () => {
  it("uses the int8 files on cpu", () => {
    const { logger } = spyLogger();
    const selection = selectParakeetModel({ modelDir: INT8_DIR, provider: "cpu", logger });
    expect(selection.provider).toBe("cpu");
    expect(selection.model.encoder).toBe(`${INT8_DIR}/encoder.int8.onnx`);
    expect(selection.cpuFallbackModel).toBeUndefined();
  });

  it("uses the sibling fp32 model on cuda with int8 as cpu fallback", () => {
    const { logger } = spyLogger();
    const selection = selectParakeetModel({
      modelDir: INT8_DIR,
      provider: "cuda",
      logger,
      exists: (p) => p.startsWith(FP32_DIR),
    });
    expect(selection.provider).toBe("cuda");
    expect(selection.model).toMatchObject({
      encoder: `${FP32_DIR}/encoder.onnx`,
      decoder: `${FP32_DIR}/decoder.onnx`,
      joiner: `${FP32_DIR}/joiner.onnx`,
      tokens: `${FP32_DIR}/tokens.txt`,
    });
    expect(selection.cpuFallbackModel?.encoder).toBe(`${INT8_DIR}/encoder.int8.onnx`);
  });

  it("stays on cpu with a warning when cuda has no fp32 model", () => {
    const { logger, warn } = spyLogger();
    const selection = selectParakeetModel({
      modelDir: INT8_DIR,
      provider: "cuda",
      logger,
      exists: () => false,
    });
    expect(selection.provider).toBe("cpu");
    expect(selection.model.encoder).toBe(`${INT8_DIR}/encoder.int8.onnx`);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("SherpaOfflineRecognizerEngine decode routing", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function modelFiles(name: string) {
    dir ??= mkdtempSync(path.join(tmpdir(), "sherpa-engine-"));
    const modelDir = path.join(dir, name);
    mkdirSync(modelDir, { recursive: true });
    const files = {
      kind: "nemo_transducer" as const,
      encoder: path.join(modelDir, "encoder.onnx"),
      decoder: path.join(modelDir, "decoder.onnx"),
      joiner: path.join(modelDir, "joiner.onnx"),
      tokens: path.join(modelDir, "tokens.txt"),
    };
    for (const f of [files.encoder, files.decoder, files.joiner, files.tokens]) {
      writeFileSync(f, "");
    }
    return files;
  }

  function fakeSherpa() {
    const created: Array<{ provider: string; encoder: string; decoded: unknown[] }> = [];
    class FakeRecognizer {
      readonly entry: { provider: string; encoder: string; decoded: unknown[] };
      constructor(config: { modelConfig: { provider: string; transducer: { encoder: string } } }) {
        this.entry = {
          provider: config.modelConfig.provider,
          encoder: config.modelConfig.transducer.encoder,
          decoded: [],
        };
        created.push(this.entry);
      }
      createStream() {
        return { acceptWaveform: (_arg: unknown) => {} };
      }
      decode(stream: unknown) {
        this.entry.decoded.push(stream);
      }
      getResult() {
        return { text: "" };
      }
    }
    return { created, OfflineRecognizer: FakeRecognizer as never };
  }

  it("decodes short audio on the GPU and long audio on a lazily created CPU recognizer", () => {
    const gpuModel = modelFiles("fp32");
    const cpuModel = modelFiles("int8");
    const { created, OfflineRecognizer } = fakeSherpa();
    const engine = new SherpaOfflineRecognizerEngine(
      { model: gpuModel, cpuFallbackModel: cpuModel, provider: "cuda", maxCudaAudioSeconds: 10 },
      pino({ level: "silent" }),
      { OfflineRecognizer },
    );
    expect(created).toHaveLength(1);

    const short = engine.createStream();
    engine.acceptWaveform(short, 16000, new Float32Array(16000 * 5));
    engine.decode(short);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ provider: "cuda", encoder: gpuModel.encoder });
    expect(created[0]?.decoded).toEqual([short]);

    const long = engine.createStream();
    engine.acceptWaveform(long, 16000, new Float32Array(16000 * 6));
    engine.acceptWaveform(long, 16000, new Float32Array(16000 * 6));
    engine.decode(long);
    engine.decode(long);
    expect(created).toHaveLength(2);
    expect(created[1]).toMatchObject({ provider: "cpu", encoder: cpuModel.encoder });
    expect(created[1]?.decoded).toEqual([long, long]);
    expect(created[0]?.decoded).toEqual([short]);
  });

  it("never routes to a fallback on cpu", () => {
    const cpuModel = modelFiles("int8");
    const { created, OfflineRecognizer } = fakeSherpa();
    const engine = new SherpaOfflineRecognizerEngine(
      { model: cpuModel, provider: "cpu", maxCudaAudioSeconds: 1 },
      pino({ level: "silent" }),
      { OfflineRecognizer },
    );
    const stream = engine.createStream();
    engine.acceptWaveform(stream, 16000, new Float32Array(16000 * 5));
    engine.decode(stream);
    expect(created).toHaveLength(1);
    expect(created[0]?.decoded).toEqual([stream]);
  });
});

describe("applySttCudaLibraryEnv", () => {
  const ok = () => ({ applied: true });

  it("leaves the env alone unless cuda is requested", () => {
    const env = { [STT_CUDA_LIBRARY_PATH_ENV]: "/gpu", LD_LIBRARY_PATH: "/pkg" };
    const verify = vi.fn(ok);
    expect(applySttCudaLibraryEnv(env, { verify, platform: "linux" })).toEqual({ applied: false });
    expect(env.LD_LIBRARY_PATH).toBe("/pkg");
    expect(verify).not.toHaveBeenCalled();
  });

  it("reports a missing library path when cuda is requested", () => {
    const env = { [STT_PROVIDER_ENV]: "cuda", LD_LIBRARY_PATH: "/pkg" };
    const result = applySttCudaLibraryEnv(env, { verify: ok, platform: "linux" });
    expect(result.applied).toBe(false);
    expect(result.reason).toContain(STT_CUDA_LIBRARY_PATH_ENV);
    expect(env.LD_LIBRARY_PATH).toBe("/pkg");
  });

  it("prepends the CUDA dirs ahead of the platform package dir once verified", () => {
    const env = {
      [STT_PROVIDER_ENV]: "cuda",
      [STT_CUDA_LIBRARY_PATH_ENV]: "/gpu/sherpa:/gpu/cudnn",
      LD_LIBRARY_PATH: "/pkg:/gpu/cudnn",
    };
    const verify = vi.fn(ok);
    expect(applySttCudaLibraryEnv(env, { verify, platform: "linux" })).toEqual({ applied: true });
    expect(env.LD_LIBRARY_PATH).toBe("/gpu/sherpa:/gpu/cudnn:/pkg");
    expect(verify.mock.calls[0]?.[0].LD_LIBRARY_PATH).toBe("/gpu/sherpa:/gpu/cudnn:/pkg");
  });

  it("does not touch the env when the version check fails", () => {
    const env = {
      [STT_PROVIDER_ENV]: "cuda",
      [STT_CUDA_LIBRARY_PATH_ENV]: "/gpu/sherpa",
      LD_LIBRARY_PATH: "/pkg",
    };
    const result = applySttCudaLibraryEnv(env, {
      verify: () => ({ applied: false, reason: "GPU libs are 1.13.8 but addon is 1.12.28" }),
      platform: "linux",
    });
    expect(result).toEqual({ applied: false, reason: "GPU libs are 1.13.8 but addon is 1.12.28" });
    expect(env.LD_LIBRARY_PATH).toBe("/pkg");
  });
});
