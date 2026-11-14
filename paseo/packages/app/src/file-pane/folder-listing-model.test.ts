import { describe, expect, it } from "vitest";
import {
  folderEntryPath,
  isNotAFileError,
  parentFolderPath,
  sortFolderEntries,
} from "./folder-listing-model";

describe("isNotAFileError", () => {
  it("matches the daemon's message for a folder read as a file", () => {
    expect(isNotAFileError("Requested path is not a file")).toBe(true);
    expect(isNotAFileError("File not found")).toBe(false);
    expect(isNotAFileError(null)).toBe(false);
  });
});

describe("sortFolderEntries", () => {
  it("puts folders first, then sorts by name ignoring case", () => {
    const sorted = sortFolderEntries([
      { name: "b.md", kind: "file" as const },
      { name: "Zeta", kind: "directory" as const },
      { name: "a.md", kind: "file" as const },
      { name: "alpha", kind: "directory" as const },
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(["alpha", "Zeta", "a.md", "b.md"]);
  });
});

describe("folderEntryPath", () => {
  it("keeps the folder's form", () => {
    expect(folderEntryPath("~/bots", "emmet")).toBe("~/bots/emmet");
    expect(folderEntryPath("~/bots/", "x.md")).toBe("~/bots/x.md");
    expect(folderEntryPath("~", "bots")).toBe("~/bots");
    expect(folderEntryPath("/", "etc")).toBe("/etc");
    expect(folderEntryPath("/home/alice", "bots")).toBe("/home/alice/bots");
    expect(folderEntryPath(".", "src")).toBe("src");
    expect(folderEntryPath("src", "app.ts")).toBe("src/app.ts");
  });
});

describe("parentFolderPath", () => {
  it("goes up one level and stops at the top", () => {
    expect(parentFolderPath("~/bots/emmet")).toBe("~/bots");
    expect(parentFolderPath("~/bots")).toBe("~");
    expect(parentFolderPath("~")).toBeNull();
    expect(parentFolderPath("/home")).toBe("/");
    expect(parentFolderPath("/")).toBeNull();
    expect(parentFolderPath("C:/Users")).toBe("C:/");
    expect(parentFolderPath("src/lib")).toBe("src");
    expect(parentFolderPath("src")).toBeNull();
  });
});
