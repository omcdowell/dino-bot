import { memo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { GlassSurface } from "@/components/ui/glass-surface";
import { WorkspaceAvatar } from "@/screens/workspace/workspace-header-menu-tabs";
import { MOBILE_FLOATING_HEADER_CONTROL_SIZE } from "./mobile-floating-header-model";
import { mobileFloatingHeaderStyles as styles } from "./mobile-floating-header-chrome";

// The chrome lives in ./mobile-floating-header-chrome (no workspace imports, so plugin screens can
// use it without an import cycle); re-exported here for the workspace header.
export {
  MobileFloatingHeader,
  MobileFloatingHeaderTitle,
  mobileFloatingHeaderCircleButtonStyle,
  mobileFloatingHeaderPillButtonStyle,
} from "./mobile-floating-header-chrome";

const PILL_RADIUS = MOBILE_FLOATING_HEADER_CONTROL_SIZE / 2;

const AVATAR_SIZE = 28;

/**
 * The title pill ("a simple avatar + bot name"): the bot's avatar (plain, no ring or
 * backdrop) and its name. Nothing else: no status dot ("remove"); host, branch and project
 * are in the header sheet's card. Outside a bot workspace it is the workspace title alone.
 * Tapping it opens the header sheet, where the Tabs group is.
 */
export const MobileFloatingHeaderIdentity = memo(function MobileFloatingHeaderIdentity({
  title,
  avatarUri,
  isLoading,
  tabCount,
  onPress,
}: {
  title: string;
  avatarUri: string | null;
  isLoading: boolean;
  tabCount: number;
  onPress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <GlassSurface style={styles.identityPill} radius={PILL_RADIUS} interactive>
      <Pressable
        onPress={onPress}
        style={avatarUri ? styles.identityPressableWithAvatar : styles.identityPressable}
        accessibilityRole="button"
        accessibilityLabel={t("workspace.tabs.switcher.trigger", { count: tabCount })}
        testID="workspace-tab-switcher-trigger"
      >
        {avatarUri ? (
          <View testID="workspace-header-avatar">
            <WorkspaceAvatar uri={avatarUri} size={AVATAR_SIZE} />
          </View>
        ) : null}
        <Text style={styles.identityTitle} numberOfLines={1} testID="workspace-header-title">
          {isLoading ? t("workspace.tabs.loading") : title}
        </Text>
      </Pressable>
    </GlassSurface>
  );
});
