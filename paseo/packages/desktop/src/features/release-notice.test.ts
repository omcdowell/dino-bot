import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_TTL_MS,
  compareVersions,
  createDesktopReleaseNoticeChecker,
  createReleaseNoticeChecker,
  isNewerVersion,
  parseLatestRelease,
  pickReleaseAsset,
  RELEASE_NOTICE_CACHE_FILE,
  releaseNotesLine,
  type ReleaseNoticeCheckerDeps,
} from "./release-notice";

const REPO = "example-owner/example-repo";
const BASE = `https://github.com/${REPO}/releases`;

function asset(name: string, version = "0.2.0") {
  return { name, browser_download_url: `${BASE}/download/v${version}/${name}` };
}

function githubRelease(version: string, overrides: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    html_url: `${BASE}/tag/v${version}`,
    draft: false,
    prerelease: false,
    body: "### New\n- Bots show a running command's output as it runs.\n- Other things.",
    assets: [
      asset(`DinoBot-${version}-arm64.dmg`, version),
      asset(`DinoBot-${version}-arm64.dmg.sha256`, version),
      asset(`DinoBot-${version}-arm64.dmg.sigstore.json`, version),
      asset("DinoBot-x86_64.AppImage", version),
      asset("DinoBot-x86_64.AppImage.sha256", version),
      asset("dinobot-linux-x64.tar.gz", version),
    ],
    ...overrides,
  };
}

describe("compareVersions", () => {
  it("compares x.y.z numerically, with or without a leading v", () => {
    expect(compareVersions("0.1.16", "0.1.15")).toBeGreaterThan(0);
    expect(compareVersions("v0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "v1.0.0")).toBe(0);
  });

  it("refuses anything that is not x.y.z", () => {
    expect(compareVersions("0.2.0-beta.1", "0.1.0")).toBeNull();
    expect(compareVersions("latest", "0.1.0")).toBeNull();
    expect(isNewerVersion("garbage", "0.1.0")).toBe(false);
  });

  it("only a strictly newer release counts", () => {
    expect(isNewerVersion("0.1.16", "0.1.15")).toBe(true);
    expect(isNewerVersion("0.1.15", "0.1.15")).toBe(false);
    expect(isNewerVersion("0.1.14", "0.1.15")).toBe(false);
  });
});

describe("pickReleaseAsset", () => {
  const assets = parseLatestRelease(githubRelease("0.2.0"), REPO)!.assets;

  it("macOS Apple silicon gets the arm64 dmg, never its checksum or signature", () => {
    expect(pickReleaseAsset(assets, "darwin", "arm64")?.name).toBe("DinoBot-0.2.0-arm64.dmg");
  });

  it("Linux x64 gets the AppImage, not the server tarball", () => {
    expect(pickReleaseAsset(assets, "linux", "x64")?.name).toBe("DinoBot-x86_64.AppImage");
  });

  it("no matching build: null (the button opens the release page)", () => {
    expect(pickReleaseAsset(assets, "linux", "arm64")).toBeNull();
    expect(pickReleaseAsset(assets, "darwin", "x64")).toBeNull();
    expect(pickReleaseAsset(assets, "win32", "x64")).toBeNull();
  });
});

describe("releaseNotesLine", () => {
  it("takes the first real line, without headings or markdown", () => {
    expect(releaseNotesLine("### New\n\n- **Bots** show [output](https://x.y) as it runs.")).toBe(
      "Bots show output as it runs.",
    );
  });

  it("shortens long lines at a word", () => {
    const line = releaseNotesLine(`- ${"word ".repeat(60)}`)!;
    expect(line.length).toBeLessThanOrEqual(140);
    expect(line.endsWith("…")).toBe(true);
  });

  it("no body: null", () => {
    expect(releaseNotesLine(null)).toBeNull();
    expect(releaseNotesLine("## Only a heading\n")).toBeNull();
  });
});

describe("parseLatestRelease", () => {
  it("reads version, notes line, page and assets", () => {
    expect(parseLatestRelease(githubRelease("0.2.0"), REPO)).toMatchObject({
      version: "0.2.0",
      notesLine: "Bots show a running command's output as it runs.",
      pageUrl: `${BASE}/tag/v0.2.0`,
    });
  });

  it("ignores drafts, prereleases, odd tags and links outside the repo", () => {
    expect(parseLatestRelease(githubRelease("0.2.0", { draft: true }), REPO)).toBeNull();
    expect(parseLatestRelease(githubRelease("0.2.0", { prerelease: true }), REPO)).toBeNull();
    expect(parseLatestRelease(githubRelease("0.2.0", { tag_name: "nightly" }), REPO)).toBeNull();
    expect(
      parseLatestRelease(
        githubRelease("0.2.0", { html_url: "https://evil.example/tag/v0.2.0" }),
        REPO,
      ),
    ).toBeNull();
    const withForeignAsset = githubRelease("0.2.0", {
      assets: [{ name: "DinoBot-0.2.0-arm64.dmg", browser_download_url: "https://evil.example/x" }],
    });
    expect(parseLatestRelease(withForeignAsset, REPO)!.assets).toEqual([]);
  });
});

function makeDeps(overrides: Partial<ReleaseNoticeCheckerDeps> = {}) {
  let cache: unknown = undefined;
  let now = 1_000_000;
  const deps: ReleaseNoticeCheckerDeps = {
    repo: REPO,
    currentVersion: "0.1.15",
    platform: "darwin",
    arch: "arm64",
    now: () => now,
    fetchJson: vi.fn(async () => githubRelease("0.2.0")),
    readCache: async () => {
      if (cache === undefined) throw new Error("ENOENT");
      return cache;
    },
    writeCache: async (value) => {
      cache = JSON.parse(JSON.stringify(value));
    },
    ...overrides,
  };
  return {
    deps,
    advance: (ms: number) => {
      now += ms;
    },
    getCache: () => cache,
  };
}

describe("createReleaseNoticeChecker", () => {
  it("newer release: a notice with the dmg for this Mac", async () => {
    const { deps } = makeDeps();
    expect(await createReleaseNoticeChecker(deps).check()).toEqual({
      currentVersion: "0.1.15",
      latestVersion: "0.2.0",
      notesLine: "Bots show a running command's output as it runs.",
      pageUrl: `${BASE}/tag/v0.2.0`,
      downloadUrl: `${BASE}/download/v0.2.0/DinoBot-0.2.0-arm64.dmg`,
      downloadName: "DinoBot-0.2.0-arm64.dmg",
    });
    expect(deps.fetchJson).toHaveBeenCalledWith(
      `https://api.github.com/repos/${REPO}/releases/latest`,
    );
  });

  it("same or older release: no notice", async () => {
    const { deps } = makeDeps({ currentVersion: "0.2.0" });
    expect(await createReleaseNoticeChecker(deps).check()).toBeNull();
  });

  it("asks GitHub at most once per TTL, across restarts too", async () => {
    const harness = makeDeps();
    await createReleaseNoticeChecker(harness.deps).check();
    await createReleaseNoticeChecker(harness.deps).check(); // a restart: reads the cache file
    expect(harness.deps.fetchJson).toHaveBeenCalledTimes(1);
    harness.advance(CHECK_TTL_MS);
    await createReleaseNoticeChecker(harness.deps).check();
    expect(harness.deps.fetchJson).toHaveBeenCalledTimes(2);
  });

  it("offline: the last cached release, and no error", async () => {
    const harness = makeDeps();
    await createReleaseNoticeChecker(harness.deps).check();
    harness.advance(CHECK_TTL_MS + 1);
    harness.deps.fetchJson = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    });
    expect((await createReleaseNoticeChecker(harness.deps).check())?.latestVersion).toBe("0.2.0");
  });

  it("offline with nothing cached: null", async () => {
    const { deps } = makeDeps({
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    expect(await createReleaseNoticeChecker(deps).check()).toBeNull();
  });

  it("concurrent checks share one request", async () => {
    const { deps } = makeDeps();
    const checker = createReleaseNoticeChecker(deps);
    await Promise.all([checker.check(), checker.check(), checker.check()]);
    expect(deps.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("a bad repo or version never reaches the network", async () => {
    const { deps } = makeDeps({ repo: "not a repo" });
    expect(await createReleaseNoticeChecker(deps).check()).toBeNull();
    expect(deps.fetchJson).not.toHaveBeenCalled();
  });
});

describe("createDesktopReleaseNoticeChecker", () => {
  let dir: string | null = null;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("caches the answer in userData and ignores a corrupt cache file", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "release-notice-"));
    writeFileSync(path.join(dir, RELEASE_NOTICE_CACHE_FILE), "{not json");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(githubRelease("0.2.0"))));
    vi.stubGlobal("fetch", fetchMock);
    const checker = createDesktopReleaseNoticeChecker({
      repo: REPO,
      currentVersion: "0.1.15",
      appName: "DinoBot",
      userDataDir: dir,
    });
    expect((await checker.check())?.latestVersion).toBe("0.2.0");
    const saved = JSON.parse(readFileSync(path.join(dir, RELEASE_NOTICE_CACHE_FILE), "utf8"));
    expect(saved.release.version).toBe("0.2.0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("HTTP errors (rate limit) stay silent", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "release-notice-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 403 })),
    );
    const checker = createDesktopReleaseNoticeChecker({
      repo: REPO,
      currentVersion: "0.1.15",
      appName: "DinoBot",
      userDataDir: dir,
    });
    expect(await checker.check()).toBeNull();
  });
});
