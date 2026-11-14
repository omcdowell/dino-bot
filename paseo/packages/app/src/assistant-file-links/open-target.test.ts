import { describe, expect, it, vi } from "vitest";
import {
  explorerDirectoryAncestry,
  resolveInlinePathOpenTarget,
  shouldProbeForDirectory,
  type DirectoryProbe,
} from "./open-target";

const CWD = "/home/alice";

function probeFor(directories: Record<string, string>): DirectoryProbe {
  return vi.fn(async (path: string) => {
    const explorerPath = directories[path];
    if (explorerPath === undefined) {
      throw new Error("Requested path is not a directory");
    }
    return explorerPath;
  });
}

describe("resolveInlinePathOpenTarget", () => {
  it("opens an extension-less ~/ folder in the explorer (the ~/bots crash report)", async () => {
    const probeDirectory = probeFor({ "~/bots": "bots" });
    await expect(
      resolveInlinePathOpenTarget({
        target: { raw: "~/bots", path: "~/bots" },
        cwd: CWD,
        probeDirectory,
      }),
    ).resolves.toEqual({ kind: "directory", path: "bots" });
    expect(probeDirectory).toHaveBeenCalledWith("~/bots");
  });

  it("opens a dot-named folder in the explorer", async () => {
    const probeDirectory = probeFor({ "~/.optchat": ".optchat" });
    await expect(
      resolveInlinePathOpenTarget({
        target: { raw: "~/.optchat", path: "~/.optchat" },
        cwd: CWD,
        probeDirectory,
      }),
    ).resolves.toEqual({ kind: "directory", path: ".optchat" });
  });

  it("opens an absolute folder inside the workspace in the explorer", async () => {
    const probeDirectory = probeFor({ "code/dinobot": "code/dinobot" });
    await expect(
      resolveInlinePathOpenTarget({
        target: { raw: "/home/alice/code/dinobot", path: "/home/alice/code/dinobot" },
        cwd: CWD,
        probeDirectory,
      }),
    ).resolves.toEqual({ kind: "directory", path: "code/dinobot" });
  });

  it("opens a file with a known extension directly, without asking the daemon", async () => {
    const probeDirectory = probeFor({});
    await expect(
      resolveInlinePathOpenTarget({
        target: { raw: "~/x.md", path: "~/x.md" },
        cwd: CWD,
        probeDirectory,
      }),
    ).resolves.toEqual({ kind: "file", path: "~/x.md" });
    expect(probeDirectory).not.toHaveBeenCalled();
  });

  it("opens a path with line numbers as a file without asking the daemon", async () => {
    const probeDirectory = probeFor({ "~/bots": "bots" });
    await expect(
      resolveInlinePathOpenTarget({
        target: { raw: "~/bots:12", path: "~/bots", lineStart: 12 },
        cwd: CWD,
        probeDirectory,
      }),
    ).resolves.toEqual({ kind: "file", path: "~/bots" });
    expect(probeDirectory).not.toHaveBeenCalled();
  });

  it("opens a missing path as a file tab (the pane reports it), never failing the press", async () => {
    const probeDirectory = probeFor({});
    await expect(
      resolveInlinePathOpenTarget({
        target: { raw: "~/nope", path: "~/nope" },
        cwd: CWD,
        probeDirectory,
      }),
    ).resolves.toEqual({ kind: "file", path: "~/nope" });
    expect(probeDirectory).toHaveBeenCalledWith("~/nope");
  });

  it("opens an extension-less file as a file when the daemon says it is not a folder", async () => {
    const probeDirectory: DirectoryProbe = async () => null;
    await expect(
      resolveInlinePathOpenTarget({
        target: { raw: "~/bin/deploy", path: "~/bin/deploy" },
        cwd: CWD,
        probeDirectory,
      }),
    ).resolves.toEqual({ kind: "file", path: "~/bin/deploy" });
  });

  it("falls back to a file tab when the daemon does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      const probeDirectory: DirectoryProbe = () => new Promise(() => {});
      const resolved = resolveInlinePathOpenTarget({
        target: { raw: "~/bots", path: "~/bots" },
        cwd: CWD,
        probeDirectory,
        timeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(resolved).resolves.toEqual({ kind: "file", path: "~/bots" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the file when there is no daemon to ask", async () => {
    await expect(
      resolveInlinePathOpenTarget({ target: { raw: "~/bots", path: "~/bots" }, cwd: CWD }),
    ).resolves.toEqual({ kind: "file", path: "~/bots" });
  });

  it("keeps a trailing slash as a folder without asking the daemon", async () => {
    const probeDirectory = probeFor({});
    await expect(
      resolveInlinePathOpenTarget({
        target: { raw: "src/", path: "src/" },
        cwd: CWD,
        probeDirectory,
      }),
    ).resolves.toEqual({ kind: "directory", path: "src" });
    expect(probeDirectory).not.toHaveBeenCalled();
  });

  it("ignores an empty path", async () => {
    await expect(
      resolveInlinePathOpenTarget({ target: { raw: "", path: "" }, cwd: CWD }),
    ).resolves.toBeNull();
  });
});

describe("shouldProbeForDirectory", () => {
  it("probes only ambiguous names without line numbers", () => {
    expect(shouldProbeForDirectory({ raw: "~/bots", path: "~/bots" }, "~/bots")).toBe(true);
    expect(shouldProbeForDirectory({ raw: "a.ts", path: "a.ts" }, "a.ts")).toBe(false);
    expect(
      shouldProbeForDirectory({ raw: "Makefile:3", path: "Makefile", lineStart: 3 }, "Makefile"),
    ).toBe(false);
  });
});

describe("explorerDirectoryAncestry", () => {
  it("lists every folder to expand down to the target", () => {
    expect(explorerDirectoryAncestry("bots")).toEqual(["bots"]);
    expect(explorerDirectoryAncestry("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
    expect(explorerDirectoryAncestry("./a/b/")).toEqual(["a", "a/b"]);
    expect(explorerDirectoryAncestry(".")).toEqual([]);
  });
});
