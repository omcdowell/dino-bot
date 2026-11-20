import { Gift } from "lucide-react-native";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { SidebarCalloutDescriptionText } from "@/components/sidebar-callout";
import { APP_DISPLAY_NAME, RELEASE_POLICY } from "@/constants/flavour";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { isElectronRuntime } from "@/desktop/host";
import {
  checkReleaseNotice,
  resolveReleaseNoticeCallout,
  type ReleaseNotice,
} from "@/desktop/updates/release-notice";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

/** The main process asks GitHub at most every 6 hours (its cache); this only re-reads its answer. */
const RECHECK_MS = 60 * 60 * 1000;

const ThemedGift = withUnistyles(Gift);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Public desktop app: "New version available" in the sidebar callout slot when the release repo
 * has a newer GitHub release. Download opens the .dmg / AppImage (or the release page); dismissing
 * hides that version only.
 */
export function ReleaseNoticeCalloutSource() {
  const { t } = useTranslation();
  const callouts = useSidebarCallouts();
  const [notice, setNotice] = useState<ReleaseNotice | null>(null);
  const enabled = RELEASE_POLICY.desktopReleaseNotice && isElectronRuntime();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = async () => {
      const next = await checkReleaseNotice();
      if (!cancelled) setNotice(next);
    };
    void run();
    const interval = setInterval(() => void run(), RECHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled]);

  useEffect(() => {
    const descriptor = resolveReleaseNoticeCallout(enabled ? notice : null);
    if (!descriptor) return;
    return callouts.show({
      id: descriptor.id,
      dismissalKey: descriptor.dismissalKey,
      priority: descriptor.priority,
      title: t("desktop.releaseNotice.title"),
      description: (
        <>
          <SidebarCalloutDescriptionText>
            {t("desktop.releaseNotice.versionAvailable", {
              appName: APP_DISPLAY_NAME,
              version: `v${descriptor.latestVersion}`,
              current: `v${descriptor.currentVersion}`,
            })}
          </SidebarCalloutDescriptionText>
          {descriptor.notesLine ? (
            <SidebarCalloutDescriptionText>{descriptor.notesLine}</SidebarCalloutDescriptionText>
          ) : null}
        </>
      ),
      icon: <ThemedGift size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />,
      actions: descriptor.actions.map((action) => ({
        label:
          action.role === "download"
            ? t("desktop.releaseNotice.download")
            : t("desktop.releaseNotice.releaseNotes"),
        onPress: () => {
          void openExternalUrl(action.url);
        },
        variant: action.variant,
        testID: `release-notice-${action.role}`,
      })),
      testID: descriptor.testID,
    });
  }, [callouts, enabled, notice, t]);

  return null;
}
