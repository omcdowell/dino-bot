import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";

export type ImageAttachment = AttachmentMetadata;

export interface MessagePayload {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  forceSend?: boolean;
  /** Some of the text came from the dictation button; the daemon marks the message for the agent. */
  dictated?: boolean;
}

export interface TextReplacement {
  key: string;
  text: string;
}
