// Files a person sends to a Claude Code bot: the daemon saves each on the host and passes an uploaded_file block.
// The bot is told the name and path in the four lines Paseo uses for pi (protocol uploaded-file-text.ts), so the
// daemon can read them back as the message's file chips, live and in a reopened chat.
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promptText, uploadedFileText } from "../server/cc/provider";

const PROFILE = mkdtempSync(join(tmpdir(), "cc-files-"));
const FILE = {
  type: "uploaded_file" as const,
  id: "upload_1",
  fileName: "Q3 report.pdf",
  mimeType: "application/pdf",
  size: 48213,
  path: "/srv/paseo/uploads/upload_1/Q3 report.pdf",
};

describe("cc provider: sent files", () => {
  it("names each file for the bot with its path, type and size", () => {
    assert.equal(
      promptText([{ type: "text", text: "read this" }, FILE], PROFILE),
      [
        "read this",
        "Uploaded file: Q3 report.pdf",
        "Path: /srv/paseo/uploads/upload_1/Q3 report.pdf",
        "MIME: application/pdf",
        "Size: 48213 bytes",
      ].join("\n"),
    );
  });

  it("a message of only a file is not empty (it used to be dropped)", () => {
    assert.equal(promptText([FILE], PROFILE), uploadedFileText(FILE));
  });

  it("text attachments still pass through as text", () => {
    assert.equal(
      promptText([{ type: "text", mimeType: "text/plain", text: "pasted" } as never], PROFILE),
      "pasted",
    );
  });
});
