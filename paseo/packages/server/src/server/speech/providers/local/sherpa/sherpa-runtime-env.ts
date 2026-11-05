import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export type SherpaLoaderEnvKey = "LD_LIBRARY_PATH" | "DYLD_LIBRARY_PATH" | "PATH";

export interface SherpaLoaderEnvResolution {
  key: SherpaLoaderEnvKey;
  libDir: string;
  packageName: string;
}

export function sherpaPlatformArch(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const normalizedPlatform = platform === "win32" ? "win" : platform;
  return `${normalizedPlatform}-${arch}`;
}

export function sherpaPlatformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `sherpa-onnx-${sherpaPlatformArch(platform, arch)}`;
}

export function sherpaLoaderEnvKey(
  platform: NodeJS.Platform = process.platform,
): SherpaLoaderEnvKey | null {
  if (platform === "linux") {
    return "LD_LIBRARY_PATH";
  }
  if (platform === "darwin") {
    return "DYLD_LIBRARY_PATH";
  }
  if (platform === "win32") {
    return "PATH";
  }
  return null;
}

export function prependEnvPath(existing: string | undefined, value: string): string {
  const parts = (existing ?? "").split(path.delimiter).filter(Boolean);
  if (parts.includes(value)) {
    return parts.join(path.delimiter);
  }
  return [value, ...parts].join(path.delimiter);
}

export function resolveSherpaLoaderEnv(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): SherpaLoaderEnvResolution | null {
  const key = sherpaLoaderEnvKey(platform);
  if (!key) {
    return null;
  }

  const packageName = sherpaPlatformPackageName(platform, arch);
  const require = createRequire(import.meta.url);
  try {
    const pkgJson = require.resolve(`${packageName}/package.json`);
    return {
      key,
      libDir: path.dirname(pkgJson),
      packageName,
    };
  } catch {
    return null;
  }
}

/**
 * Find the actual case-sensitive key in a plain object that matches the given
 * key case-insensitively. On Windows, `{...process.env}` produces a plain
 * (case-sensitive) object where PATH is typically stored as `Path`. Using a
 * hardcoded `"PATH"` would miss the existing key and create a duplicate,
 * breaking the child process's PATH.
 */
function findEnvKey(env: NodeJS.ProcessEnv, key: string): string {
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) return k;
  }
  return key;
}

export function applySherpaLoaderEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): {
  changed: boolean;
  key: SherpaLoaderEnvKey | null;
  libDir: string | null;
  packageName: string | null;
} {
  const resolved = resolveSherpaLoaderEnv(platform, arch);
  if (!resolved) {
    return {
      changed: false,
      key: null,
      libDir: null,
      packageName: null,
    };
  }

  const actualKey = findEnvKey(env, resolved.key);
  const next = prependEnvPath(env[actualKey], resolved.libDir);
  const changed = next !== (env[actualKey] ?? "");
  env[actualKey] = next;
  return {
    changed,
    key: resolved.key,
    libDir: resolved.libDir,
    packageName: resolved.packageName,
  };
}

export type SherpaExecutionProvider = "cpu" | "cuda";

/** Env var selecting the onnxruntime execution provider for local STT. Default: cpu. */
export const STT_PROVIDER_ENV = "PASEO_STT_PROVIDER";

/**
 * Library dirs (path-delimited) for STT on cuda: the GPU build of the sherpa-onnx
 * shared libs (same version as the installed sherpa-onnx platform package) plus the
 * CUDA 12 runtime, cuBLAS, cuRAND and cuDNN 9. Only added to the speech worker's
 * loader path when PASEO_STT_PROVIDER=cuda, never to the daemon or agents.
 */
export const STT_CUDA_LIBRARY_PATH_ENV = "PASEO_STT_CUDA_LIBRARY_PATH";

export interface ParsedSttProvider {
  provider: SherpaExecutionProvider;
  /** Set when the env var held an unrecognised value (we then use cpu). */
  invalidValue?: string;
}

export function parseSttProviderEnv(value: string | undefined): ParsedSttProvider {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "" || normalized === "cpu") {
    return { provider: "cpu" };
  }
  if (normalized === "cuda" || normalized === "gpu") {
    return { provider: "cuda" };
  }
  return { provider: "cpu", invalidValue: value };
}

export interface SttCudaLibraryEnvResult {
  applied: boolean;
  reason?: string;
}

/**
 * The GPU sherpa-onnx libs replace the platform package's libsherpa-onnx-c-api.so
 * for the whole worker (TTS and VAD too), and a version mismatch with the
 * prebuilt addon crashes natively. So check the versions in a throwaway child.
 */
export function verifySherpaAddonVersion(env: NodeJS.ProcessEnv): SttCudaLibraryEnvResult {
  const resolved = resolveSherpaLoaderEnv();
  if (!resolved) {
    return { applied: false, reason: "sherpa-onnx platform package not found" };
  }
  let expected: string;
  let sherpaEntry: string;
  try {
    const pkg = JSON.parse(readFileSync(path.join(resolved.libDir, "package.json"), "utf8")) as {
      version?: string;
    };
    expected = String(pkg.version ?? "");
    sherpaEntry = createRequire(import.meta.url).resolve("sherpa-onnx-node");
  } catch (error) {
    return { applied: false, reason: `cannot resolve sherpa-onnx: ${String(error)}` };
  }
  const result = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(String(require(process.argv[1]).version))", sherpaEntry],
    {
      encoding: "utf8",
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const actual = (result.stdout ?? "").trim();
  if (result.status !== 0 || !actual) {
    return {
      applied: false,
      reason: `version check failed: ${(result.stderr ?? "").trim().slice(-300)}`,
    };
  }
  if (actual !== expected) {
    return {
      applied: false,
      reason: `GPU sherpa-onnx libs are ${actual} but the installed addon is ${expected}`,
    };
  }
  return { applied: true };
}

/**
 * When PASEO_STT_PROVIDER=cuda, prepend PASEO_STT_CUDA_LIBRARY_PATH to the loader
 * path in `env` (the speech worker's env), ahead of the platform package dir.
 * Call after applySherpaLoaderEnv.
 */
export function applySttCudaLibraryEnv(
  env: NodeJS.ProcessEnv,
  options: {
    verify?: (candidateEnv: NodeJS.ProcessEnv) => SttCudaLibraryEnvResult;
    platform?: NodeJS.Platform;
  } = {},
): SttCudaLibraryEnvResult {
  if (parseSttProviderEnv(env[STT_PROVIDER_ENV]).provider !== "cuda") {
    return { applied: false };
  }
  const extra = (env[STT_CUDA_LIBRARY_PATH_ENV] ?? "").split(path.delimiter).filter(Boolean);
  if (extra.length === 0) {
    return { applied: false, reason: `${STT_CUDA_LIBRARY_PATH_ENV} is not set` };
  }
  const key = sherpaLoaderEnvKey(options.platform);
  if (key !== "LD_LIBRARY_PATH") {
    return { applied: false, reason: "CUDA library path is only supported on linux" };
  }
  const existing = (env[key] ?? "").split(path.delimiter).filter((p) => p && !extra.includes(p));
  const candidate = { ...env, [key]: [...extra, ...existing].join(path.delimiter) };
  const verdict = (options.verify ?? verifySherpaAddonVersion)(candidate);
  if (!verdict.applied) {
    return verdict;
  }
  env[key] = candidate[key];
  return { applied: true };
}
