import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Release notice for the public (DinoBot) desktop app. It has no update feed (electron-builder
 * `publish: null`, ad hoc signed on macOS, so no in-place install): instead it reads the latest
 * GitHub release of its own repo (lib/product.json `releaseRepo`, stamped into flavour.json),
 * compares it with the release it was built for (flavour displayVersion) and, when newer, the
 * renderer shows a sidebar notice with a button that opens the right download (.dmg on Apple
 * silicon, AppImage on Linux) or the release page.
 *
 * Unauthenticated GitHub API (60 requests/hour per address): one request at most every
 * CHECK_TTL_MS, cached in userData so restarts do not ask again. Offline or any error: the last
 * cached answer (or nothing), never an error in the UI.
 */

export const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const NOTES_LINE_MAX = 140;
export const RELEASE_NOTICE_CACHE_FILE = "release-notice.json";

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface LatestRelease {
  version: string;
  notesLine: string | null;
  pageUrl: string;
  assets: ReleaseAsset[];
}

export interface ReleaseNotice {
  currentVersion: string;
  latestVersion: string;
  notesLine: string | null;
  pageUrl: string;
  /** The asset for this computer, or null (then the button opens pageUrl). */
  downloadUrl: string | null;
  downloadName: string | null;
}

interface CacheFile {
  checkedAt: number;
  release: LatestRelease | null;
}

const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

function parseVersion(value: string): [number, number, number] | null {
  const match = VERSION_RE.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** x.y.z (optional leading v). >0 when a is newer, <0 when older, 0 equal; null if either is not x.y.z. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const cmp = compareVersions(latest, current);
  return cmp !== null && cmp > 0;
}

/**
 * The download for this computer, from the release's asset names (electron-builder.dinobot.cjs):
 * macOS arm64 `DinoBot-<v>-arm64.dmg`, Linux `DinoBot-x86_64.AppImage` / `DinoBot-arm64.AppImage`.
 * Checksums and signatures (.sha256, .sigstore.json) never match. Anything else: null.
 */
export function pickReleaseAsset(
  assets: readonly ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset | null {
  let pattern: RegExp | null = null;
  if (platform === "darwin" && arch === "arm64") pattern = /-arm64\.dmg$/i;
  else if (platform === "darwin" && arch === "x64") pattern = /-x64\.dmg$/i;
  else if (platform === "linux" && arch === "x64") pattern = /[-_](x86_64|x64|amd64)\.AppImage$/i;
  else if (platform === "linux" && arch === "arm64") pattern = /[-_](arm64|aarch64)\.AppImage$/i;
  if (!pattern) return null;
  return assets.find((asset) => pattern.test(asset.name)) ?? null;
}

function stripMarkdown(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first real line of the release notes (headings skipped), plain text, at most 140 chars. */
export function releaseNotesLine(body: unknown): string | null {
  if (typeof body !== "string") return null;
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || /^\s*(?:<!--|---|\|)/.test(raw)) continue;
    const line = stripMarkdown(raw);
    if (!line) continue;
    if (line.length <= NOTES_LINE_MAX) return line;
    const cut = line.slice(0, NOTES_LINE_MAX - 1);
    const space = cut.lastIndexOf(" ");
    return `${(space > 80 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGithubUrlOf(url: unknown, repo: string, kind: "page" | "download"): url is string {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return false;
  const prefix = `/${repo}/releases/${kind === "page" ? "tag" : "download"}/`;
  return parsed.pathname.toLowerCase().startsWith(prefix.toLowerCase());
}

/** A GitHub `releases/latest` response, or null if it is not a usable published x.y.z release of `repo`. */
export function parseLatestRelease(raw: unknown, repo: string): LatestRelease | null {
  if (!isRecord(raw) || raw.draft === true || raw.prerelease === true) return null;
  if (typeof raw.tag_name !== "string" || !parseVersion(raw.tag_name)) return null;
  if (!isGithubUrlOf(raw.html_url, repo, "page")) return null;
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(raw.assets)) {
    for (const asset of raw.assets) {
      if (!isRecord(asset) || typeof asset.name !== "string") continue;
      if (!isGithubUrlOf(asset.browser_download_url, repo, "download")) continue;
      assets.push({ name: asset.name, url: asset.browser_download_url });
    }
  }
  return {
    version: raw.tag_name.trim().replace(/^v/i, ""),
    notesLine: releaseNotesLine(raw.body),
    pageUrl: raw.html_url,
    assets,
  };
}

function isLatestRelease(value: unknown): value is LatestRelease {
  return (
    isRecord(value) &&
    typeof value.version === "string" &&
    parseVersion(value.version) !== null &&
    (value.notesLine === null || typeof value.notesLine === "string") &&
    typeof value.pageUrl === "string" &&
    Array.isArray(value.assets) &&
    value.assets.every(
      (asset) => isRecord(asset) && typeof asset.name === "string" && typeof asset.url === "string",
    )
  );
}

export function parseCacheFile(raw: unknown): CacheFile | null {
  if (!isRecord(raw) || typeof raw.checkedAt !== "number" || !Number.isFinite(raw.checkedAt)) {
    return null;
  }
  if (raw.release !== null && !isLatestRelease(raw.release)) return null;
  return { checkedAt: raw.checkedAt, release: raw.release as LatestRelease | null };
}

export function buildReleaseNotice(input: {
  release: LatestRelease | null;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}): ReleaseNotice | null {
  const { release, currentVersion } = input;
  if (!release || !isNewerVersion(release.version, currentVersion)) return null;
  const asset = pickReleaseAsset(release.assets, input.platform, input.arch);
  return {
    currentVersion,
    latestVersion: release.version,
    notesLine: release.notesLine,
    pageUrl: release.pageUrl,
    downloadUrl: asset?.url ?? null,
    downloadName: asset?.name ?? null,
  };
}

export interface ReleaseNoticeCheckerDeps {
  repo: string;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  now(): number;
  /** GET the URL, parsed JSON; throws on network or HTTP errors. */
  fetchJson(url: string): Promise<unknown>;
  readCache(): Promise<unknown>;
  writeCache(value: CacheFile): Promise<void>;
  ttlMs?: number;
}

export interface ReleaseNoticeChecker {
  check(): Promise<ReleaseNotice | null>;
}

export function createReleaseNoticeChecker(deps: ReleaseNoticeCheckerDeps): ReleaseNoticeChecker {
  const ttl = deps.ttlMs ?? CHECK_TTL_MS;
  let memory: CacheFile | null = null;
  let inFlight: Promise<LatestRelease | null> | null = null;

  async function loadCache(): Promise<CacheFile | null> {
    if (memory) return memory;
    try {
      memory = parseCacheFile(await deps.readCache());
    } catch {
      memory = null;
    }
    return memory;
  }

  async function latest(): Promise<LatestRelease | null> {
    const cached = await loadCache();
    const age = cached ? deps.now() - cached.checkedAt : Infinity;
    if (cached && age >= 0 && age < ttl) return cached.release;
    try {
      const raw = await deps.fetchJson(`https://api.github.com/repos/${deps.repo}/releases/latest`);
      const release = parseLatestRelease(raw, deps.repo);
      memory = { checkedAt: deps.now(), release };
      try {
        await deps.writeCache(memory);
      } catch {
        // A read-only userData only costs a fresh request next launch.
      }
      return release;
    } catch {
      // Offline, rate limited or GitHub down: keep the last answer, ask again next time.
      return cached?.release ?? null;
    }
  }

  return {
    async check() {
      if (!REPO_RE.test(deps.repo) || !parseVersion(deps.currentVersion)) return null;
      inFlight ??= latest().finally(() => {
        inFlight = null;
      });
      const release = await inFlight;
      return buildReleaseNotice({
        release,
        currentVersion: deps.currentVersion,
        platform: deps.platform,
        arch: deps.arch,
      });
    },
  };
}

async function fetchJsonWithTimeout(url: string, userAgent: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": userAgent,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** The checker used by the app: real fetch, cache in `<userDataDir>/release-notice.json`. */
export function createDesktopReleaseNoticeChecker(input: {
  repo: string;
  currentVersion: string;
  appName: string;
  userDataDir: string;
}): ReleaseNoticeChecker {
  const cachePath = path.join(input.userDataDir, RELEASE_NOTICE_CACHE_FILE);
  return createReleaseNoticeChecker({
    repo: input.repo,
    currentVersion: input.currentVersion,
    platform: process.platform,
    arch: process.arch,
    now: () => Date.now(),
    fetchJson: (url) => fetchJsonWithTimeout(url, `${input.appName}/${input.currentVersion}`),
    readCache: async () => JSON.parse(await readFile(cachePath, "utf8")),
    writeCache: async (value) => {
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, `${JSON.stringify(value)}\n`);
    },
  });
}
