import { describe, expect, it } from "vitest";
import {
  createSidebarCalloutState,
  dismissSidebarCallout,
  loadDismissedCalloutKeys,
  selectActiveSidebarCallout,
  showSidebarCallout,
} from "@/contexts/sidebar-callout-state";
import {
  parseReleaseNotice,
  releaseNoticeDismissalKey,
  resolveReleaseNoticeCallout,
} from "./release-notice";

const BASE = "https://github.com/example-owner/example-repo/releases";

const notice = {
  currentVersion: "0.1.15",
  latestVersion: "0.2.0",
  notesLine: "Bots show a running command's output as it runs.",
  pageUrl: `${BASE}/tag/v0.2.0`,
  downloadUrl: `${BASE}/download/v0.2.0/DinoBot-0.2.0-arm64.dmg`,
  downloadName: "DinoBot-0.2.0-arm64.dmg",
};

describe("parseReleaseNotice", () => {
  it("accepts the main process's answer", () => {
    expect(parseReleaseNotice(notice)).toEqual(notice);
  });

  it("null, junk and non-GitHub links: no notice", () => {
    expect(parseReleaseNotice(null)).toBeNull();
    expect(parseReleaseNotice({ ...notice, latestVersion: "soon" })).toBeNull();
    expect(parseReleaseNotice({ ...notice, pageUrl: "https://evil.example/x" })).toBeNull();
  });

  it("drops a download link that is not GitHub's (the release page stays)", () => {
    expect(parseReleaseNotice({ ...notice, downloadUrl: "javascript:alert(1)" })).toMatchObject({
      downloadUrl: null,
      downloadName: null,
      pageUrl: notice.pageUrl,
    });
  });
});

describe("resolveReleaseNoticeCallout", () => {
  it("download button opens the asset, a second button the release notes", () => {
    const descriptor = resolveReleaseNoticeCallout(notice)!;
    expect(descriptor.actions).toEqual([
      { role: "download", url: notice.downloadUrl, variant: "primary" },
      { role: "releaseNotes", url: notice.pageUrl, variant: "secondary" },
    ]);
    expect(descriptor.notesLine).toBe(notice.notesLine);
  });

  it("no build for this computer: download opens the release page", () => {
    const descriptor = resolveReleaseNoticeCallout({ ...notice, downloadUrl: null })!;
    expect(descriptor.actions).toEqual([
      { role: "download", url: notice.pageUrl, variant: "primary" },
    ]);
  });

  it("no notice: no callout", () => {
    expect(resolveReleaseNoticeCallout(null)).toBeNull();
  });
});

describe("dismissing the notice", () => {
  function showFor(version: string, dismissed: ReadonlySet<string>) {
    const descriptor = resolveReleaseNoticeCallout({ ...notice, latestVersion: version })!;
    const state = loadDismissedCalloutKeys(createSidebarCalloutState(), dismissed);
    return showSidebarCallout(state, {
      id: descriptor.id,
      dismissalKey: descriptor.dismissalKey,
      title: "New version available",
    }).state;
  }

  it("hides that version only; the next release shows again", () => {
    const shown = showFor("0.2.0", new Set());
    expect(selectActiveSidebarCallout(shown)?.id).toBe("desktop-release-notice");
    const dismissed = dismissSidebarCallout(shown, "desktop-release-notice");
    expect(dismissed.dismissalKey).toBe(releaseNoticeDismissalKey("0.2.0"));

    // Next launch: the same version stays hidden, a newer one shows.
    expect(selectActiveSidebarCallout(showFor("0.2.0", dismissed.state.dismissedKeys))).toBeNull();
    expect(selectActiveSidebarCallout(showFor("0.2.1", dismissed.state.dismissedKeys))?.id).toBe(
      "desktop-release-notice",
    );
  });
});
