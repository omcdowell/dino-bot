import { describe, expect, it } from "vitest";

import { AgentTimelineItemPayloadSchema } from "./messages.js";
import { extractUploadedFileBlocks, renderUploadedFileText } from "./uploaded-file-text.js";

const REPORT = {
  fileName: "Q3 report (final).pdf",
  path: "/srv/paseo/uploads/upload_1/Q3 report (final).pdf",
  mimeType: "application/pdf",
  size: 48213,
};
const NOTES = {
  fileName: "notes.txt",
  path: "C:\\paseo\\uploads\\upload_2\\notes.txt",
  mimeType: "text/plain",
  size: 11,
};

describe("uploaded file text", () => {
  it("reads back the files a prompt named, and leaves the user's text", () => {
    const text = ["read these", renderUploadedFileText(REPORT), renderUploadedFileText(NOTES)].join(
      "\n",
    );
    expect(extractUploadedFileBlocks(text)).toEqual({ text: "read these", files: [REPORT, NOTES] });
  });

  it("a message of only a file has empty text", () => {
    expect(extractUploadedFileBlocks(renderUploadedFileText(REPORT))).toEqual({
      text: "",
      files: [REPORT],
    });
  });

  it("a video's duration line is part of its block, so it reads back as a chip with no stray line", () => {
    const CLIP = {
      fileName: "clip.mov",
      path: "/srv/paseo/uploads/upload_v/clip.mov",
      mimeType: "video/quicktime",
      size: 4_200_000,
    };
    const block = renderUploadedFileText({ ...CLIP, durationMs: 12_480 });
    expect(block.endsWith("\nDuration: 12.48 s")).toBe(true);
    expect(
      extractUploadedFileBlocks(`what happens here?\n${block}\n${renderUploadedFileText(NOTES)}`),
    ).toEqual({
      text: "what happens here?",
      files: [CLIP, NOTES],
    });
  });

  it("leaves text that only looks like a block alone", () => {
    for (const text of [
      "hello",
      "Uploaded file: a.pdf",
      "Uploaded file: a.pdf\nPath: relative/a.pdf\nMIME: application/pdf\nSize: 1 bytes",
      "Uploaded file: a.pdf\nPath: /a.pdf\nMIME: application/pdf\nSize: many bytes",
    ]) {
      expect(extractUploadedFileBlocks(text)).toEqual({ text, files: [] });
    }
  });

  it("files ride on user messages; old payloads without them still parse", () => {
    const files = [{ ...REPORT, id: "upload_1" }, NOTES];
    expect(AgentTimelineItemPayloadSchema.parse({ type: "user_message", text: "", files })).toEqual(
      { type: "user_message", text: "", files },
    );
    expect(AgentTimelineItemPayloadSchema.parse({ type: "user_message", text: "hi" })).toEqual({
      type: "user_message",
      text: "hi",
    });
  });
});
