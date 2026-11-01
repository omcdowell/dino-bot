import { useMemo, type ReactElement, type ReactNode } from "react";
import { Image, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, GitBranch } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DropdownMenuHint, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { HostBadge } from "@/hosts/host-badge";
import { useHostBadges } from "@/hosts/use-host-badges";
import { useHosts } from "@/runtime/host-runtime";
import { isPublicFlavour } from "@/constants/flavour";
import type { Theme } from "@/styles/theme";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";

const ThemedCheck = withUnistyles(Check);
const ThemedGitBranch = withUnistyles(GitBranch);
const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

/**
 * "Tabs · 3 open": the heading of the header sheet's tab group, laid out like the Terminal profiles
 * heading below it, with the count on the right.
 */
export function WorkspaceMenuTabsLabel({ count }: { count: number }): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenuHint
      style={styles.tabsLabel}
      trailing={t("workspace.tabs.switcher.groupCount", { count })}
      testID="workspace-header-tabs-label"
    >
      {t("workspace.tabs.switcher.groupLabel")}
    </DropdownMenuHint>
  );
}

/**
 * One tab in the header sheet. Pressing the row switches to the tab (and closes the sheet); the
 * trailing ⋯ opens that tab's own actions (rename, close, close others…) as a stacked sheet.
 * The tab you are on carries the check, as a chosen option does everywhere in the menus.
 */
export function WorkspaceMenuTabRow({
  presentation,
  selected,
  onSelect,
  trailingAccessory,
  testID,
}: {
  presentation: WorkspaceTabPresentation;
  selected: boolean;
  onSelect: () => void;
  trailingAccessory: ReactNode;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const leading = useMemo(
    () => (
      <View style={styles.tabIconSlot}>
        <WorkspaceTabIcon presentation={presentation} active={selected} backdrop="surface0" />
      </View>
    ),
    [presentation, selected],
  );
  const trailing = useMemo(
    () => (
      <View style={styles.tabTrailing}>
        {selected ? <ThemedCheck size={16} uniProps={mutedColorMapping} /> : null}
        {trailingAccessory}
      </View>
    ),
    [selected, trailingAccessory],
  );
  return (
    <DropdownMenuItem
      leading={leading}
      trailing={trailing}
      selected={selected}
      onSelect={onSelect}
      testID={testID}
    >
      {presentation.titleState === "loading" ? t("workspace.tabs.loading") : presentation.label}
    </DropdownMenuItem>
  );
}

/** A bot's avatar (or any round image) with no ring or backdrop behind it. */
export function WorkspaceAvatar({ uri, size }: { uri: string; size: number }): ReactElement {
  const source = useMemo(() => ({ uri }), [uri]);
  const style = useMemo(() => ({ width: size, height: size, borderRadius: size / 2 }), [size]);
  return <Image source={source} style={style} accessibilityIgnoresInvertColors />;
}

/**
 * Top of the phone's header sheet: who and where this workspace is (name, branch, host). The floating
 * header shows only the name, so this is where branch and host went.
 */
export function WorkspaceMenuContextCard({
  leading,
  title,
  branchName,
  serverId,
}: {
  leading: ReactNode;
  title: string;
  branchName: string | null;
  serverId: string;
}): ReactElement {
  // Public flavour: the host name only when there is more than one host to tell apart.
  const hostCount = useHosts().length;
  const hostBadge =
    useHostBadges({ enabled: !isPublicFlavour || hostCount > 1 }).get(serverId) ?? null;
  return (
    <View style={styles.contextCard} testID="workspace-header-context-card">
      {leading}
      <View style={styles.contextText}>
        <Text style={styles.contextTitle} numberOfLines={1}>
          {title}
        </Text>
        {branchName || hostBadge ? (
          <View style={styles.contextSubtitle}>
            {branchName ? (
              <View style={styles.contextBranch}>
                <ThemedGitBranch size={12} uniProps={mutedColorMapping} />
                <Text style={styles.contextSubtitleText} numberOfLines={1}>
                  {branchName}
                </Text>
              </View>
            ) : null}
            {branchName && hostBadge ? <Text style={styles.contextSeparator}>·</Text> : null}
            {hostBadge ? <HostBadge badge={hostBadge} /> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabsLabel: {
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  tabIconSlot: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  tabTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  contextCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
  },
  contextText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  contextTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  contextSubtitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
  },
  contextBranch: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    flexShrink: 1,
    minWidth: 0,
  },
  contextSubtitleText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  contextSeparator: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
}));
