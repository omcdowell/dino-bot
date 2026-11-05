import { router, type Href } from "expo-router";
import {
  CalendarClock,
  FolderTree,
  History,
  MoreHorizontal,
  Plus,
  Search,
  Server,
  Settings,
} from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import type { Theme } from "@/styles/theme";
import type { PluginMobileHomeMenu, PluginMobileHomeMenuItem } from "@getpaseo/plugin/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon as PluginIcon } from "@/plugins/icons";
import { HEADER_INNER_HEIGHT_MOBILE, HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { usePanelStore } from "@/stores/panel-store";
import {
  buildNewWorkspaceRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
  buildSettingsHostRoute,
  buildSettingsRoute,
} from "@/utils/host-routes";

/** The round "⋯" button's size, and the bar's padding under it (MobileHomeTopFade measures from it). */
export const HOME_MENU_TRIGGER_SIZE = 44;
export const HOME_TOP_BAR_PADDING_BOTTOM = 8;

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const MENU_ICONS = {
  search: withUnistyles(Search),
  newWorkspace: withUnistyles(Plus),
  history: withUnistyles(History),
  schedules: withUnistyles(CalendarClock),
  workspaces: withUnistyles(FolderTree),
  settings: withUnistyles(Settings),
  hosts: withUnistyles(Server),
};

function MenuItemIcon({ name }: { name: keyof typeof MENU_ICONS }) {
  const Icon = MENU_ICONS[name];
  return <Icon size={18} uniProps={mutedIconColorMapping} />;
}

const ThemedPluginIcon = withUnistyles(PluginIcon);

function PluginMenuItem({ item }: { item: PluginMobileHomeMenuItem }) {
  const onSelect = useCallback(() => {
    try {
      item.onSelect();
    } catch (error) {
      console.error("[MobileHomeMenu] plugin item failed:", error);
    }
  }, [item]);
  const leading = useMemo(
    () => <ThemedPluginIcon name={item.icon} size={18} uniProps={mutedIconColorMapping} />,
    [item.icon],
  );
  return (
    <DropdownMenuItem testID={`home-menu-plugin-${item.id}`} leading={leading} onSelect={onSelect}>
      {item.title}
    </DropdownMenuItem>
  );
}

/** The home plugin's own entries (`mobileHomeMenu`), above the app's. A throwing handler is logged. */
function PluginMenuItems({ menu }: { menu: PluginMobileHomeMenu }) {
  return (
    <>
      {menu.title ? <DropdownMenuLabel>{menu.title}</DropdownMenuLabel> : null}
      {menu.items.map((item) => (
        <PluginMenuItem key={item.id} item={item} />
      ))}
      <DropdownMenuSeparator />
    </>
  );
}

/**
 * Top bar of the phone home (a plugin screen registered with `mobileHome`). No title and no
 * avatar: one round "⋯" button holding everything the main menu had (layout A, decision 4).
 * It floats over the content and has no background of its own: the top fade behind it
 * (MobileHomeTopFade) is the bar's colour.
 */
export function MobileHomeTopBar({
  serverId,
  pluginMenu,
}: {
  serverId: string;
  pluginMenu?: PluginMobileHomeMenu;
}) {
  const insets = useSafeAreaInsets();
  const barStyle = useMemo(
    () => [styles.bar, { paddingTop: insets.top + HEADER_TOP_PADDING_MOBILE }],
    [insets.top],
  );
  return (
    <View style={barStyle} testID="mobile-home-top-bar">
      <View style={styles.spacer} />
      <MobileHomeMenu serverId={serverId} pluginMenu={pluginMenu} />
    </View>
  );
}

function MobileHomeMenu({
  serverId,
  pluginMenu,
}: {
  serverId: string;
  pluginMenu?: PluginMobileHomeMenu;
}) {
  const { t } = useTranslation();
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const showMobileAgentList = usePanelStore((state) => state.showMobileAgentList);

  const openSearch = useCallback(() => setCommandCenterOpen(true), [setCommandCenterOpen]);
  const openNewWorkspace = useCallback(
    () => router.push(buildNewWorkspaceRoute({ serverId }) as Href),
    [serverId],
  );
  const openHistory = useCallback(() => router.push(buildSessionsRoute() as Href), []);
  const openSchedules = useCallback(() => router.push(buildSchedulesRoute() as Href), []);
  // Today's drawer is the workspace list; it stays as it is, reached from here.
  const openWorkspaces = useCallback(() => showMobileAgentList(), [showMobileAgentList]);
  const openSettings = useCallback(() => router.push(buildSettingsRoute() as Href), []);
  const openHosts = useCallback(
    () => router.push(buildSettingsHostRoute(serverId) as Href),
    [serverId],
  );

  const icon = (name: keyof typeof MENU_ICONS) => <MenuItemIcon name={name} />;

  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        testID="home-menu-trigger"
        style={styles.trigger}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("shell.menu.open")}
      >
        <ThemedMoreHorizontal size={22} uniProps={foregroundColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={240} testID="home-menu">
        {pluginMenu ? <PluginMenuItems menu={pluginMenu} /> : null}
        <DropdownMenuItem testID="home-menu-search" leading={icon("search")} onSelect={openSearch}>
          {t("sidebar.sections.search")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="home-menu-new-workspace"
          leading={icon("newWorkspace")}
          onSelect={openNewWorkspace}
        >
          {t("sidebar.actions.newWorkspace")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="home-menu-history"
          leading={icon("history")}
          onSelect={openHistory}
        >
          {t("sidebar.sections.sessions")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="home-menu-schedules"
          leading={icon("schedules")}
          onSelect={openSchedules}
        >
          {t("sidebar.sections.schedules")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="home-menu-workspaces"
          leading={icon("workspaces")}
          onSelect={openWorkspaces}
        >
          {t("shell.commandCenter.workspaces")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          testID="home-menu-settings"
          leading={icon("settings")}
          onSelect={openSettings}
        >
          {t("sidebar.actions.settings")}
        </DropdownMenuItem>
        <DropdownMenuItem testID="home-menu-hosts" leading={icon("hosts")} onSelect={openHosts}>
          {t("sidebar.actions.hosts")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The DinoBot desktop app's Bots home: the plugin's own entries (New bot, New group chat,
 * Archived) in a "⋯" menu in the screen's header bar, where other plugin screens have Close. The
 * rest of the phone menu is the desktop sidebar.
 */
export function DesktopHomeMenu({
  pluginMenu,
}: {
  serverId: string;
  pluginMenu?: PluginMobileHomeMenu;
}) {
  const { t } = useTranslation();
  if (!pluginMenu || pluginMenu.items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        testID="desktop-home-menu-trigger"
        style={styles.desktopTrigger}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("shell.menu.open")}
      >
        <ThemedMoreHorizontal size={18} uniProps={foregroundColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220} testID="desktop-home-menu">
        {pluginMenu.title ? <DropdownMenuLabel>{pluginMenu.title}</DropdownMenuLabel> : null}
        {pluginMenu.items.map((item) => (
          <PluginMenuItem key={item.id} item={item} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  desktopTrigger: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: HEADER_INNER_HEIGHT_MOBILE,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: HOME_TOP_BAR_PADDING_BOTTOM,
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  spacer: {
    flex: 1,
  },
  trigger: {
    width: HOME_MENU_TRIGGER_SIZE,
    height: HOME_MENU_TRIGGER_SIZE,
    borderRadius: HOME_MENU_TRIGGER_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
}));
