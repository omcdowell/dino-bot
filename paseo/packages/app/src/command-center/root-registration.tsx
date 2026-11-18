import { useMemo } from "react";
import { router, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { CalendarClock, Keyboard, PanelLeft, Settings } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { getIsElectronRuntime, useIsCompactFormFactor } from "@/constants/layout";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import { resolveShortcutKeysForAction } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { usePanelStore } from "@/stores/panel-store";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { buildSchedulesRoute, buildSettingsRoute } from "@/utils/host-routes";
import { getShortcutOs } from "@/utils/shortcut-platform";
import type { CommandCenterContribution, CommandCenterIconProps } from "./contributions";
import { useCommandCenterActions } from "./provider";

const ThemedCalendarClock = withUnistyles(CalendarClock, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedKeyboard = withUnistyles(Keyboard, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedSettings = withUnistyles(Settings, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedPanelLeft = withUnistyles(PanelLeft, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

function SettingsIcon({ size }: CommandCenterIconProps) {
  return <ThemedSettings size={size} strokeWidth={2.2} />;
}

function SchedulesIcon({ size }: CommandCenterIconProps) {
  return <ThemedCalendarClock size={size} strokeWidth={2.2} />;
}

function KeyboardIcon({ size }: CommandCenterIconProps) {
  return <ThemedKeyboard size={size} strokeWidth={2.2} />;
}

function PanelLeftIcon({ size }: CommandCenterIconProps) {
  return <ThemedPanelLeft size={size} strokeWidth={2.2} />;
}

export function CommandCenterRootActions() {
  const { t } = useTranslation();
  const { overrides } = useKeyboardShortcutOverrides();
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  const settingsRoute = useMemo<Href>(() => buildSettingsRoute(), []);
  const schedulesRoute = useMemo<Href>(() => buildSchedulesRoute(), []);
  const setShortcutsDialogOpen = useKeyboardShortcutsStore((state) => state.setShortcutsDialogOpen);
  const isCompact = useIsCompactFormFactor();
  const toggleMobileAgentList = usePanelStore((state) => state.toggleMobileAgentList);
  const toggleDesktopAgentList = usePanelStore((state) => state.toggleDesktopAgentList);
  const toggleAgentList = isCompact ? toggleMobileAgentList : toggleDesktopAgentList;
  const shortcutPlatform = useMemo(
    () => ({ isMac: getShortcutOs() === "mac", isDesktop: getIsElectronRuntime() }),
    [],
  );
  const actions = useMemo<CommandCenterContribution[]>(() => {
    const availableActions: CommandCenterContribution[] = [
      {
        id: "schedules",
        group: "actions",
        groupRank: 0,
        rank: 5,
        keywords: ["schedules", "scheduled", "automation", "recurring"],
        visibility: "always",
        run: () => {
          clearCommandCenterFocusRestoreElement();
          router.push(schedulesRoute);
        },
        presentation: {
          kind: "action",
          title: t("sidebar.sections.schedules"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: SchedulesIcon,
        },
      },
      {
        id: "settings",
        group: "actions",
        groupRank: 0,
        rank: 6,
        keywords: ["settings", "preferences", "config", "configuration"],
        visibility: "always",
        run: () => {
          clearCommandCenterFocusRestoreElement();
          router.push(settingsRoute);
        },
        presentation: {
          kind: "action",
          title: t("sidebar.actions.settings"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: SettingsIcon,
          shortcutKeys:
            resolveShortcutKeysForAction("toggle-settings", overrides, shortcutPlatform) ??
            undefined,
        },
      },
      // Toggle left sidebar is global: it calls the panel store directly and works on every route.
      // The right sidebar and focus toggles do NOT belong here — their handlers live in
      // workspace-screen.tsx behind `enabled: isRouteFocused && ...`, so registering them globally
      // would list entries that silently no-op off a workspace route. They live in
      // workspace-contributions.ts instead. That is why the three toggles render in two
      // non-adjacent sections; don't "tidy" them back together.
      {
        id: "toggle-left-sidebar",
        group: "actions",
        groupRank: 0,
        rank: 8,
        keywords: ["toggle", "sidebar", "left", "panel", "workspaces"],
        visibility: "query",
        run: () => {
          clearCommandCenterFocusRestoreElement();
          toggleAgentList();
        },
        presentation: {
          kind: "action",
          title: t("settings.shortcuts.help.toggleLeftSidebar"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: PanelLeftIcon,
          shortcutKeys:
            resolveShortcutKeysForAction("toggle-left-sidebar", overrides, shortcutPlatform) ??
            undefined,
        },
      },
    ];

    if (shortcutsAvailable) {
      availableActions.push({
        id: "keyboard-shortcuts",
        group: "actions",
        groupRank: 0,
        rank: 7,
        keywords: ["keyboard", "shortcuts", "keys", "hotkeys"],
        visibility: "always",
        run: () => setShortcutsDialogOpen(true),
        presentation: {
          kind: "action",
          title: t("sidebar.help.shortcuts"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: KeyboardIcon,
          shortcutKeys:
            resolveShortcutKeysForAction("show-shortcuts", overrides, shortcutPlatform) ??
            undefined,
        },
      });
    }

    return availableActions;
  }, [
    overrides,
    schedulesRoute,
    setShortcutsDialogOpen,
    settingsRoute,
    shortcutPlatform,
    shortcutsAvailable,
    t,
    toggleAgentList,
  ]);

  useCommandCenterActions({ sourceId: "root", enabled: true, actions });
  return null;
}
