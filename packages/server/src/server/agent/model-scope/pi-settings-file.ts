/**
 * Reads and edits `enabledModels` in Pi's global `settings.json`, the file the Pi TUI reads, so the
 * scope stays shared.
 *
 * Writes take the same lock Pi takes (proper-lockfile's `<file>.lock` directory, stale after 10 s),
 * re-read the file under it, change only `enabledModels`, keep every other key in its order and the
 * file's indentation and final newline, and replace the file by renaming a temp file into place.
 */
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;

export class PiSettingsError extends Error {}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detectIndent(text: string): string | number {
  const match = /^[{[]\s*\n([ \t]+)\S/.exec(text);
  return match?.[1] ?? 2;
}

function readPatterns(settings: JsonObject): string[] | undefined {
  const value = settings.enabledModels;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new PiSettingsError("enabledModels in Pi's settings.json is not a list of strings.");
  }
  return value as string[];
}

function parseSettings(text: string, path: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PiSettingsError(`Pi's settings file does not parse: ${path}`);
  }
  if (!isObject(parsed)) throw new PiSettingsError(`Pi's settings file is not an object: ${path}`);
  return parsed;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rmdir(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        // proper-lockfile treats a lock untouched for 10 s as abandoned.
        await rmdir(lockPath).catch(() => undefined);
        continue;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new PiSettingsError("Pi's settings.json is locked by another process. Try again.");
}

export class PiSettingsFile {
  constructor(readonly path: string) {}

  /** `undefined` when the file or the key is missing (Pi then offers every model). */
  async readEnabledModels(): Promise<string[] | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return readPatterns(parseSettings(text, this.path));
  }

  /** Applies `change` to the current list under Pi's lock; returns the list written. */
  async updateEnabledModels(
    change: (current: string[] | undefined) => string[],
  ): Promise<string[]> {
    await mkdir(dirname(this.path), { recursive: true });
    const release = await acquireLock(this.path);
    try {
      let text: string | null = null;
      let mode = 0o644;
      try {
        text = await readFile(this.path, "utf8");
        mode = (await stat(this.path)).mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const settings = text === null ? {} : parseSettings(text, this.path);
      const next = change(readPatterns(settings));
      // Assigning an existing key keeps its position; a new key goes last.
      settings.enabledModels = next;
      const indent = text === null ? 2 : detectIndent(text);
      const trailingNewline = text === null ? true : text.endsWith("\n");
      const output = JSON.stringify(settings, null, indent) + (trailingNewline ? "\n" : "");
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, output, { mode });
      await rename(tmp, this.path);
      return next;
    } finally {
      await release();
    }
  }
}
