import { useMemo } from "react";
import type { AgentTimelineFile } from "@getpaseo/protocol/agent-types";
import type { AgentAttachment } from "@getpaseo/protocol/messages";

/**
 * Files the user sent with a message, shown as chips under it. The daemon's row carries them as
 * `files` (rows rebuilt from a bot's history too: the daemon reads the "Uploaded file" blocks
 * back); a message still on its way has only the composer's uploaded_file attachments.
 */
export function sentFilesOf(message: {
  files?: readonly AgentTimelineFile[];
  attachments?: readonly AgentAttachment[];
}): AgentTimelineFile[] {
  if (message.files?.length) return [...message.files];
  const files: AgentTimelineFile[] = [];
  for (const attachment of message.attachments ?? []) {
    if (attachment.type !== "uploaded_file") continue;
    files.push({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      path: attachment.path,
      id: attachment.id,
    });
  }
  return files;
}

/** A message still on its way (a pinned bubble) shows the files its outbox record carries. */
export function usePendingSentFiles(
  record: { attachments?: readonly AgentAttachment[] } | null | undefined,
): AgentTimelineFile[] {
  const attachments = record?.attachments;
  return useMemo(() => sentFilesOf({ attachments }), [attachments]);
}

/** The attachments still shown as pills: everything but sent files (those are chips). */
export function attachmentsWithoutFiles(
  attachments: readonly AgentAttachment[] | undefined,
): AgentAttachment[] {
  return (attachments ?? []).filter((attachment) => attachment.type !== "uploaded_file");
}

/** Characters of a file name a chip shows before it shortens the middle (fits the 260pt chip label). */
export const FILE_CHIP_NAME_CHARS = 26;

/**
 * Shortens a long file name in the middle, keeping its start and its extension, so
 * "quarterly-financial-report-final-v3.pdf" reads "quarterly-financi…l-v3.pdf".
 */
export function middleTruncateFileName(name: string, max = FILE_CHIP_NAME_CHARS): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 8 ? Array.from(name.slice(dot)) : [];
  const room = max - 1;
  const tail = Math.max(extension.length, Math.floor(room / 3));
  const head = room - tail;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** A sent file's chip key: stable across the local row and the daemon's row. */
export function sentFileKey(file: AgentTimelineFile, index: number): string {
  return `${file.path}:${index}`;
}
