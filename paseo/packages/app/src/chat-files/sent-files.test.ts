import { describe, expect, it } from "vitest";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import {
  attachmentsWithoutFiles,
  formatFileSize,
  middleTruncateFileName,
  sentFilesOf,
} from "./sent-files";

const REPORT = {
  fileName: "Q3 report.pdf",
  mimeType: "application/pdf",
  size: 48213,
  path: "/srv/paseo/uploads/upload_1/Q3 report.pdf",
};
const UPLOADED: AgentAttachment = { type: "uploaded_file", id: "upload_1", ...REPORT };
const PASTED: AgentAttachment = { type: "text", mimeType: "text/plain", text: "pasted" };

describe("sent files", () => {
  it("prefers the daemon's files, else reads the composer's uploaded_file attachments", () => {
    expect(sentFilesOf({ files: [REPORT], attachments: [PASTED] })).toEqual([REPORT]);
    expect(sentFilesOf({ attachments: [PASTED, UPLOADED] })).toEqual([
      { ...REPORT, id: "upload_1" },
    ]);
    expect(sentFilesOf({})).toEqual([]);
  });

  it("files leave the pill list; other attachments stay", () => {
    expect(attachmentsWithoutFiles([UPLOADED, PASTED])).toEqual([PASTED]);
    expect(attachmentsWithoutFiles(undefined)).toEqual([]);
  });

  it("shortens long names in the middle and keeps the extension", () => {
    expect(middleTruncateFileName("notes.txt")).toBe("notes.txt");
    const long = "quarterly-financial-report-final-v3.pdf";
    expect(middleTruncateFileName(long)).toBe("quarterly-financi…l-v3.pdf");
    expect(Array.from(middleTruncateFileName(long))).toHaveLength(26);
    // A long extension is not kept whole; the name still fits.
    expect(Array.from(middleTruncateFileName(`${"a".repeat(40)}.verylongextension`))).toHaveLength(
      26,
    );
  });

  it("formats sizes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(48213)).toBe("47 KB");
    expect(formatFileSize(5 * 1024 * 1024 + 300_000)).toBe("5.3 MB");
    expect(formatFileSize(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});
