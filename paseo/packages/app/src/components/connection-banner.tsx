import { useRouter, type Href } from "expo-router";
import { ChevronRight, WifiOff } from "lucide-react-native";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useConnectionFault, type ConnectionFaultView } from "@/hooks/use-connection-fault";
import type { Theme } from "@/styles/theme";
import { buildNetworkRoute } from "@/utils/host-routes";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

const ThemedWifiOff = withUnistyles(WifiOff);
const ThemedChevronRight = withUnistyles(ChevronRight);
const warningIcon = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function describeConnectionFault(
  t: (key: string, params?: Record<string, unknown>) => string,
  fault: ConnectionFaultView,
): string {
  const reason = t(`network.reasons.${fault.reason}`, fault.params ?? {});
  const host = fault.params?.host;
  const subject = fault.link === "phone" || !host ? reason : `${host}: ${reason}`;
  return fault.waiting > 0
    ? `${subject} · ${t("network.banner.waiting", { count: fault.waiting })}`
    : subject;
}

/**
 * Says which link is down (lowest failing first) and how many messages are waiting. Tapping it
 * opens the Network page: the Explorer tab where there is an Explorer, else the full-screen route.
 */
export const ConnectionBanner = memo(function ConnectionBanner({
  serverId,
  workspaceId,
  cwd,
}: {
  serverId: string;
  workspaceId?: string | null;
  cwd?: string | null;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const isCompact = useIsCompactFormFactor();
  const fault = useConnectionFault(serverId);
  const handlePress = useCallback(() => {
    if (workspaceId && cwd) {
      openExplorerSidebarView({
        isCompact,
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        checkout: { serverId, cwd, isGit: true },
        view: "network",
      });
      return;
    }
    router.push(buildNetworkRoute(serverId) as Href);
  }, [cwd, isCompact, router, serverId, workspaceId]);
  if (!fault) return null;
  const text = describeConnectionFault(t, fault);
  return (
    <Pressable
      onPress={handlePress}
      style={styles.banner}
      accessibilityRole="button"
      accessibilityLabel={`${text}. ${t("network.banner.open")}`}
      testID="connection-banner"
    >
      <ThemedWifiOff size={14} uniProps={warningIcon} />
      <View style={styles.textWrap}>
        <Text style={styles.text} numberOfLines={2}>
          {text}
        </Text>
      </View>
      <ThemedChevronRight size={14} uniProps={mutedIcon} />
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.statusWarningTint,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  textWrap: {
    flex: 1,
    minWidth: 0,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
