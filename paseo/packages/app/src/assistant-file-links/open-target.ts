import { hasKnownFileExtension, normalizeInlinePathTarget, type InlinePathTarget } from "./parse";

/**
 * Where a tapped path in the chat should open: a file tab, or the Files explorer for a folder.
 * `~/bots` has no trailing `/`, so the parser alone cannot tell it is a folder (it used to open a
 * file tab that failed with "Requested path is not a file"). Ambiguous paths are checked first.
 */
export type InlinePathOpenTarget =
  | { kind: "file"; path: string }
  | { kind: "directory"; path: string };

/**
 * Asks the daemon whether `path` is a folder. Resolves the folder's path as the Files explorer
 * knows it (relative to the workspace root), or null when it is not a folder, is missing or is
 * outside the workspace. May reject; a rejection counts as "not a folder".
 */
export type DirectoryProbe = (path: string) => Promise<string | null>;

export const DIRECTORY_PROBE_TIMEOUT_MS = 2500;

/** Only ambiguous names are probed: no line numbers, and no known file extension. */
export function shouldProbeForDirectory(target: InlinePathTarget, filePath: string): boolean {
  if (target.lineStart !== undefined || target.lineEnd !== undefined) {
    return false;
  }
  return !hasKnownFileExtension(filePath);
}

export async function resolveInlinePathOpenTarget(input: {
  target: InlinePathTarget;
  cwd?: string;
  probeDirectory?: DirectoryProbe | null;
  timeoutMs?: number;
}): Promise<InlinePathOpenTarget | null> {
  if (!input.target.path) {
    return null;
  }
  const normalized = normalizeInlinePathTarget(input.target.path, input.cwd);
  if (!normalized) {
    return null;
  }
  if (!normalized.file) {
    return { kind: "directory", path: normalized.directory };
  }
  const file: InlinePathOpenTarget = { kind: "file", path: normalized.file };
  if (!input.probeDirectory || !shouldProbeForDirectory(input.target, normalized.file)) {
    return file;
  }
  const directory = await probeWithTimeout(
    input.probeDirectory,
    normalized.file,
    input.timeoutMs ?? DIRECTORY_PROBE_TIMEOUT_MS,
  );
  return directory ? { kind: "directory", path: directory } : file;
}

async function probeWithTimeout(
  probe: DirectoryProbe,
  path: string,
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([probe(path).catch(() => null), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Explorer paths to expand so `directory` is visible: "a/b" -> ["a", "a/b"]; "." -> []. */
export function explorerDirectoryAncestry(directory: string): string[] {
  const segments = directory
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}
