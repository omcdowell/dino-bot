import { afterEach, describe, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  truncateSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import {
  describeTarFailure,
  ensureSherpaOnnxModel,
  getSherpaOnnxModelDir,
} from "./model-downloader.js";
import { getSherpaOnnxModelSpec } from "./model-catalog.js";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-speech-models-"));
}

const logger = pino({ level: "silent" });

describe("sherpa model downloader", () => {
  test("does not expose a partial model when tar extraction fails", async () => {
    const root = makeTmpDir();
    const modelsDir = path.join(root, "models");
    const spec = getSherpaOnnxModelSpec("kokoro-en-v0_19");
    const sourceDir = path.join(root, "source", spec.extractedDir);
    const archive = path.join(
      modelsDir,
      ".downloads",
      path.basename(new URL(spec.archiveUrl).pathname),
    );
    try {
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(path.dirname(archive), { recursive: true });
      writeFileSync(path.join(sourceDir, "model.onnx"), Buffer.alloc(32_768, 1));
      execFileSync("tar", [
        "cf",
        archive,
        "-C",
        path.dirname(sourceDir),
        `${spec.extractedDir}/model.onnx`,
      ]);
      truncateSync(archive, 1_024);
      await expect(ensureSherpaOnnxModel({ modelsDir, modelId: spec.id, logger })).rejects.toThrow(
        "tar exited",
      );
      expect(existsSync(getSherpaOnnxModelDir(modelsDir, spec.id))).toBe(false);
      expect(existsSync(archive)).toBe(true);
      expect(readdirSync(modelsDir)).toEqual([".downloads"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repairs a partial legacy extraction when its cached archive remains", async () => {
    const root = makeTmpDir();
    const modelsDir = path.join(root, "models");
    const spec = getSherpaOnnxModelSpec("kokoro-en-v0_19");
    const sourceDir = path.join(root, "source", spec.extractedDir);
    const modelDir = getSherpaOnnxModelDir(modelsDir, spec.id);
    const archive = path.join(
      modelsDir,
      ".downloads",
      path.basename(new URL(spec.archiveUrl).pathname),
    );
    try {
      for (const dir of [sourceDir, modelDir]) {
        mkdirSync(path.join(dir, "espeak-ng-data"), { recursive: true });
        for (const filename of ["model.onnx", "voices.bin", "tokens.txt", "lexicon-en-us.txt"]) {
          writeFileSync(path.join(dir, filename), "complete model data");
        }
      }
      mkdirSync(path.dirname(archive), { recursive: true });
      execFileSync("tar", ["cf", archive, "-C", path.dirname(sourceDir), spec.extractedDir]);
      writeFileSync(path.join(modelDir, "model.onnx"), "truncated");
      await ensureSherpaOnnxModel({ modelsDir, modelId: spec.id, logger });
      expect(readFileSync(path.join(modelDir, "model.onnx"), "utf8")).toBe("complete model data");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing bzip2 (GNU tar on a minimal Linux) gets a plain reason with the fix", () => {
    const gnu =
      "tar (child): bzip2: Cannot exec: No such file or directory\ntar (child): Error is not recoverable: exiting now\ntar: Child returned status 2\ntar: Error is not recoverable: exiting now";
    expect(describeTarFailure(2, gnu, "/m/.downloads/kokoro-en-v0_19.tar.bz2")).toMatch(
      /bzip2 is not installed.*sudo apt install bzip2/,
    );
    expect(describeTarFailure(2, "tar: Unexpected EOF in archive", "/m/x.tar.bz2")).toBe(
      "tar exited with code 2: tar: Unexpected EOF in archive",
    );
    expect(describeTarFailure(1, "", "/m/x.tar")).toBe("tar exited with code 1");
  });

  test("getSherpaOnnxModelDir maps modelId to extractedDir", () => {
    const modelsDir = "/tmp/models";
    expect(getSherpaOnnxModelDir(modelsDir, "parakeet-tdt-0.6b-v2-int8")).toContain(
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    );
    expect(getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19")).toContain("kokoro-en-v0_19");
  });

  test("ensureSherpaOnnxModel succeeds without downloading when files exist", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19");

    mkdirSync(path.join(modelDir, "espeak-ng-data"), { recursive: true });
    writeFileSync(path.join(modelDir, "model.onnx"), "x");
    writeFileSync(path.join(modelDir, "voices.bin"), "x");
    writeFileSync(path.join(modelDir, "tokens.txt"), "x");
    writeFileSync(path.join(modelDir, "lexicon-en-us.txt"), "x");

    const out = await ensureSherpaOnnxModel({
      modelsDir,
      modelId: "kokoro-en-v0_19",
      logger,
    });

    expect(out).toBe(modelDir);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("an archive installed before the lexicon existed fetches only the lexicon", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19");
    try {
      mkdirSync(path.join(modelDir, "espeak-ng-data"), { recursive: true });
      for (const filename of ["model.onnx", "voices.bin", "tokens.txt"]) {
        writeFileSync(path.join(modelDir, filename), "installed");
      }
      const fetched: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          fetched.push(String(url));
          return new Response("hello || h e l o\n");
        }),
      );

      const out = await ensureSherpaOnnxModel({
        modelsDir,
        modelId: "kokoro-en-v0_19",
        logger,
      });

      expect(out).toBe(modelDir);
      expect(fetched).toEqual([
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/lexicon-en-us.txt",
      ]);
      expect(readFileSync(path.join(modelDir, "lexicon-en-us.txt"), "utf8")).toBe(
        "hello || h e l o\n",
      );
      expect(readFileSync(path.join(modelDir, "model.onnx"), "utf8")).toBe("installed");
      expect(readdirSync(modelDir)).not.toContain("lexicon-en-us.txt.partial");
    } finally {
      rmSync(modelsDir, { recursive: true, force: true });
    }
  });

  test("a failed lexicon download leaves no partial file", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19");
    try {
      mkdirSync(modelDir, { recursive: true });
      for (const filename of ["model.onnx", "voices.bin", "tokens.txt"]) {
        writeFileSync(path.join(modelDir, filename), "installed");
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("nope", { status: 503, statusText: "Unavailable" })),
      );
      await expect(
        ensureSherpaOnnxModel({ modelsDir, modelId: "kokoro-en-v0_19", logger }),
      ).rejects.toThrow("503");
      expect(readdirSync(modelDir).sort()).toEqual(["model.onnx", "tokens.txt", "voices.bin"]);
    } finally {
      rmSync(modelsDir, { recursive: true, force: true });
    }
  });
});
