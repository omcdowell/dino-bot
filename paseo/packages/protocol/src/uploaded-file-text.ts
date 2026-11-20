import type { AgentTimelineFile } from "./agent-types.js";

/**
 * How a sent file reaches a text-only agent (pi, a Claude Code bot): a short block naming it.
 * Provider history keeps only that text, so a chat rebuilt from it (a reopened bot chat, a replay)
 * reads the files back from these blocks with `extractUploadedFileBlocks`.
 *
 * A video adds a fifth line, its duration: the bot pulls frames itself (ffmpeg), so it needs the
 * length. The bots plugin (plugins/bots/server/cc/provider.ts) writes the same lines; keep the two
 * in step.
 */
export function renderUploadedFileText(file: {
  fileName: string;
  path: string;
  mimeType: string;
  size: number;
  durationMs?: number;
}): string {
  return [
    `Uploaded file: ${file.fileName}`,
    `Path: ${file.path}`,
    `MIME: ${file.mimeType}`,
    `Size: ${file.size} bytes`,
    ...(typeof file.durationMs === "number"
      ? [`Duration: ${formatDurationSeconds(file.durationMs)} s`]
      : []),
  ].join("\n");
}

/** Milliseconds as seconds with at most 3 decimals ("12.5", "3", "0.04"). */
function formatDurationSeconds(durationMs: number): string {
  return String(Math.round(durationMs) / 1000);
}

const BLOCK =
  /(^|\n)Uploaded file: ([^\n]+)\nPath: (\/[^\n]*|[A-Za-z]:[\\/][^\n]*)\nMIME: ([^\n]+)\nSize: (\d+) bytes(?:\nDuration: \d+(?:\.\d+)? s)?(?=\n|$)/g;

/** The text without its uploaded-file blocks, and the files they name (in order). */
export function extractUploadedFileBlocks(text: string): {
  text: string;
  files: AgentTimelineFile[];
} {
  if (!text.includes("Uploaded file: ")) return { text, files: [] };
  const files: AgentTimelineFile[] = [];
  const rest = text.replace(
    BLOCK,
    (_match, lead: string, fileName: string, path: string, mimeType: string, size: string) => {
      files.push({
        fileName: fileName.trim(),
        path: path.trim(),
        mimeType: mimeType.trim(),
        size: Number(size),
      });
      return lead;
    },
  );
  if (files.length === 0) return { text, files };
  return { text: rest.replace(/\n{3,}/g, "\n\n").trim(), files };
}
