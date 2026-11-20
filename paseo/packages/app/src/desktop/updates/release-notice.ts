import { invokeDesktopCommand } from "@/desktop/electron/invoke";

/**
 * The public desktop app's new-release notice (no update feed, no auto-install). The main process
 * (packages/desktop/src/features/release-notice.ts) reads the latest GitHub release, caches it and
 * answers `check_release_notice` with a newer release or null; this side shows it.
 */
export interface ReleaseNotice {
  currentVersion: string;
  latestVersion: string;
  notesLine: string | null;
  pageUrl: string;
  downloadUrl: string | null;
  downloadName: string | null;
}

export type ReleaseNoticeActionRole = "download" | "releaseNotes";

export interface ReleaseNoticeCalloutDescriptor {
  id: "desktop-release-notice";
  /** One per version: dismissing 0.2.0 hides it until 0.2.1 is out. */
  dismissalKey: string;
  priority: number;
  latestVersion: string;
  currentVersion: string;
  notesLine: string | null;
  actions: { role: ReleaseNoticeActionRole; url: string; variant: "primary" | "secondary" }[];
  testID: "release-notice-callout";
}

const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

function isHttpsGithubUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com";
  } catch {
    return false;
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The main process's answer, or null when it is empty or not shaped as expected. */
export function parseReleaseNotice(raw: unknown): ReleaseNotice | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.latestVersion !== "string" || !VERSION_RE.test(record.latestVersion)) {
    return null;
  }
  if (typeof record.currentVersion !== "string" || !VERSION_RE.test(record.currentVersion)) {
    return null;
  }
  if (!isHttpsGithubUrl(record.pageUrl)) return null;
  const downloadUrl = isHttpsGithubUrl(record.downloadUrl) ? record.downloadUrl : null;
  return {
    currentVersion: record.currentVersion,
    latestVersion: record.latestVersion,
    notesLine: optionalString(record.notesLine),
    pageUrl: record.pageUrl,
    downloadUrl,
    downloadName: downloadUrl ? optionalString(record.downloadName) : null,
  };
}

export function releaseNoticeDismissalKey(version: string): string {
  return `desktop-release-notice:${version}`;
}

export function resolveReleaseNoticeCallout(
  notice: ReleaseNotice | null,
): ReleaseNoticeCalloutDescriptor | null {
  if (!notice) return null;
  const actions: ReleaseNoticeCalloutDescriptor["actions"] = notice.downloadUrl
    ? [
        { role: "download", url: notice.downloadUrl, variant: "primary" },
        { role: "releaseNotes", url: notice.pageUrl, variant: "secondary" },
      ]
    : // No build for this computer among the assets: the release page lists them all.
      [{ role: "download", url: notice.pageUrl, variant: "primary" }];
  return {
    id: "desktop-release-notice",
    dismissalKey: releaseNoticeDismissalKey(notice.latestVersion),
    priority: 200,
    latestVersion: notice.latestVersion,
    currentVersion: notice.currentVersion,
    notesLine: notice.notesLine,
    actions,
    testID: "release-notice-callout",
  };
}

/** Asks the main process; any failure (older main without the command, offline) is "no notice". */
export async function checkReleaseNotice(): Promise<ReleaseNotice | null> {
  try {
    return parseReleaseNotice(await invokeDesktopCommand<unknown>("check_release_notice"));
  } catch {
    return null;
  }
}
