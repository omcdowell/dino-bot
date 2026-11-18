import { router, usePathname } from "expo-router";
import { Bot, CalendarClock, Search } from "lucide-react-native";
import { useCallback, useMemo, useRef, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { isMobileHomePathname } from "@/plugins/mobile-home";
import { goToMobileHome, useMobileHome, useStartHome } from "@/plugins/mobile-home-runtime";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
} from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { buildSchedulesRoute } from "@/utils/host-routes";

interface SidebarNavRowProps {
  onBeforeNavigate?: () => void;
}

interface SidebarNavRowsProps extends SidebarNavRowProps {
  /** Style for the group wrapper, which the sidebar owns. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Top-level sidebar navigation, ordered and filtered by the user's
 * `sidebarNavItems` preference. Renders nothing — not even the bordered group
 * wrapper — when every item is hidden.
 */
export function SidebarNavRows({ style, onBeforeNavigate }: SidebarNavRowsProps) {
  const { items } = useSidebarNavItems("header");
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items]);
  const groupRef = useRef<View | null>(null);

  if (visibleItems.length === 0) return null;

  return (
    <View ref={groupRef} collapsable={false} style={style}>
      <SidebarStartHomeRow onBeforeNavigate={onBeforeNavigate} />
      {visibleItems.map((item) => {
        if (item.kind === "plugin") {
          return (
            <PluginSidebarItem
              key={item.key}
              group={item.group}
              section="header"
              fallbackAnchorRef={groupRef}
              onBeforeNavigate={onBeforeNavigate}
            />
          );
        }
        const Row = BUILTIN_ROWS[item.id];
        return <Row key={item.key} onBeforeNavigate={onBeforeNavigate} />;
      })}
    </View>
  );
}

/**
 * DinoBot desktop app: a "Bots" row back to the start home (the plugin's Bots home). Only where the
 * start home is not the phone home (phones have their own top bar), so nowhere in the own build.
 */
function SidebarStartHomeRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const pathname = usePathname();
  const phoneHome = useMobileHome();
  const startHome = useStartHome();
  const handlePress = useCallback(() => {
    if (!startHome) return;
    onBeforeNavigate?.();
    goToMobileHome(startHome);
  }, [onBeforeNavigate, startHome]);
  if (!startHome || phoneHome) return null;
  return (
    <SidebarHeaderRow
      icon={Bot}
      label="Bots"
      onPress={handlePress}
      isActive={isMobileHomePathname(pathname, startHome)}
      testID="sidebar-bots-home"
      variant="compact"
    />
  );
}

function SidebarSearchRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("search"));
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    setCommandCenterOpen(true);
  }, [onBeforeNavigate, setCommandCenterOpen]);

  return (
    <SidebarHeaderRow
      icon={Search}
      label={t(builtinSidebarNavLabelKey("search"))}
      onPress={handlePress}
      testID="sidebar-search"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
}

function SidebarSchedulesRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSchedulesRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={CalendarClock}
      label={t(builtinSidebarNavLabelKey("schedules"))}
      onPress={handlePress}
      isActive={pathname.includes("/schedules")}
      testID="sidebar-schedules"
      variant="compact"
    />
  );
}

const BUILTIN_ROWS: Record<BuiltinSidebarNavId, ComponentType<SidebarNavRowProps>> = {
  search: SidebarSearchRow,
  schedules: SidebarSchedulesRow,
};
