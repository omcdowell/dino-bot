import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Keyboard } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { PluginHeaderButtons } from "@/plugins";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { WorkspaceScriptsButton } from "@/screens/workspace/workspace-scripts-button";
import { WorkspaceExplorerToggle } from "@/screens/workspace/workspace-explorer-toggle";
import {
  WorkspaceHeaderMenuMobile,
  type WorkspaceHeaderMenuMobileProps,
} from "@/screens/workspace/workspace-header-menu";
import {
  WorkspaceAvatar,
  WorkspaceMenuContextCard,
  WorkspaceMenuTabRow,
  WorkspaceMenuTabsLabel,
} from "@/screens/workspace/workspace-header-menu-tabs";
import {
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { MobileTabTrailingAccessory } from "@/screens/workspace/workspace-tab-trailing-accessory";
import {
  buildWorkspaceTabMenuEntries,
  type WorkspaceTabMenuLabels,
} from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  MobileFloatingHeader,
  MobileFloatingHeaderIdentity,
  mobileFloatingHeaderCircleButtonStyle,
  mobileFloatingHeaderPillButtonStyle,
} from "./mobile-floating-header";
import {
  orderTabsActiveFirst,
  resolveMobileFloatingHeaderInset,
} from "./mobile-floating-header-model";
import { useWorkspaceBot } from "./use-workspace-bot";

/** How much of the workspace's top the floating header covers: the phone only, else none. */
export function useMobileFloatingHeaderInset(isMobile: boolean): number {
  const insets = useSafeAreaInsets();
  return isMobile ? resolveMobileFloatingHeaderInset(insets.top) : 0;
}

/** What a tab row in the header sheet can do: switch to the tab, or run one of its own actions. */
export interface WorkspaceMobileTabActions {
  onSelectTab: (key: string) => void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCloseTabsAbove: (tabId: string) => Promise<void> | void;
  onCloseTabsBelow: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
}

/** The header sheet's own props, minus what the floating header decides itself. */
export type WorkspaceMobileHeaderMenuProps = Omit<
  WorkspaceHeaderMenuMobileProps,
  "hideTrigger" | "leadingContent" | "open" | "onOpenChange"
>;

export interface WorkspaceMobileExplorerToggleProps {
  onPress: () => void;
  label: string;
  tooltipLabel: string;
  tooltipKeys: ShortcutKey[];
  accessibilityState: { expanded: boolean };
}

export interface WorkspaceMobileScriptsProps {
  scripts: WorkspaceDescriptor["scripts"];
  liveTerminalIds: string[];
  onScriptTerminalStarted: (terminalId: string) => void;
  onViewTerminal: (terminalId: string) => void;
  onOpenUrlInBrowserTab: (url: string) => void;
}

function getFallbackTabOptionLabel(
  tab: WorkspaceTabDescriptor,
  labels: {
    newTab: string;
    newAgent: string;
    setup: string;
    terminal: string;
    browser: string;
    agent: string;
    changes: string;
    files: string;
    pullRequest: string;
    network: string;
  },
): string {
  if (tab.target.kind === "new_tab") {
    return labels.newTab;
  }
  if (tab.target.kind === "draft") {
    return labels.newAgent;
  }
  if (tab.target.kind === "setup") {
    return labels.setup;
  }
  if (tab.target.kind === "terminal") {
    return labels.terminal;
  }
  if (tab.target.kind === "browser") {
    return labels.browser;
  }
  if (tab.target.kind === "file") {
    return tab.target.path.split("/").findLast(Boolean) ?? tab.target.path;
  }
  if (tab.target.kind === "working_diff" || tab.target.kind === "changes_tree") {
    return labels.changes;
  }
  if (tab.target.kind === "files") {
    return labels.files;
  }
  if (tab.target.kind === "pull_request") {
    return labels.pullRequest;
  }
  if (tab.target.kind === "network_status") {
    return labels.network;
  }
  if (tab.target.kind === "commit_diff") {
    return tab.target.sha.slice(0, 7);
  }
  return labels.agent;
}

function MobileWorkspaceTabOption({
  tab,
  tabIndex,
  tabCount,
  normalizedServerId,
  normalizedWorkspaceId,
  selected,
  actions,
}: {
  tab: WorkspaceTabDescriptor;
  tabIndex: number;
  tabCount: number;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  selected: boolean;
  actions: WorkspaceMobileTabActions;
}) {
  const { t } = useTranslation();
  const {
    onSelectTab,
    onCopyResumeCommand,
    onCopyAgentId,
    onCopyTerminalId,
    onCopyFilePath,
    onReloadAgent,
    onRenameTab,
    onCloseTab,
    onCloseTabsAbove,
    onCloseTabsBelow,
    onCloseOtherTabs,
  } = actions;
  const tabMenuLabels = useMemo<WorkspaceTabMenuLabels>(
    () => ({
      copyResumeCommand: t("workspace.tabs.menu.copyResumeCommand"),
      copyAgentId: t("workspace.tabs.menu.copyAgentId"),
      copyTerminalId: t("workspace.tabs.menu.copyTerminalId"),
      copyFilePath: t("workspace.tabs.menu.copyFilePath"),
      rename: t("workspace.tabs.menu.rename"),
      closeAbove: t("workspace.tabs.menu.closeAbove"),
      closeBelow: t("workspace.tabs.menu.closeBelow"),
      closeLeft: t("workspace.tabs.menu.closeLeft"),
      closeRight: t("workspace.tabs.menu.closeRight"),
      closeOthers: t("workspace.tabs.menu.closeOthers"),
      reloadAgent: t("workspace.tabs.menu.reloadAgent"),
      reloadAgentTooltip: t("workspace.tabs.menu.reloadAgentTooltip"),
      close: t("workspace.tabs.menu.close"),
    }),
    [t],
  );
  const menuTestIDBase = `workspace-tab-menu-${tab.tabId}`;
  const menuEntries = buildWorkspaceTabMenuEntries({
    surface: "mobile",
    tab,
    index: tabIndex,
    tabCount,
    menuTestIDBase,
    onCopyResumeCommand,
    onCopyAgentId,
    onCopyTerminalId,
    onCopyFilePath,
    onReloadAgent,
    onRenameTab,
    onCloseTab,
    onCloseTabsBefore: onCloseTabsAbove,
    onCloseTabsAfter: onCloseTabsBelow,
    onCloseOtherTabs,
    labels: tabMenuLabels,
  });

  const fallbackLabels = useMemo(
    () => ({
      newTab: t("workspace.tabs.actions.newTab"),
      newAgent: t("workspace.tabs.fallback.newAgent"),
      setup: t("workspace.tabs.fallback.setup"),
      terminal: t("workspace.tabs.fallback.terminal"),
      browser: t("workspace.tabs.fallback.browser"),
      agent: t("workspace.tabs.fallback.agent"),
      changes: t("panels.diff.changesLabel"),
      files: t("panels.files.label"),
      pullRequest: t("panels.pullRequest.label"),
      network: t("network.tabLabel"),
    }),
    [t],
  );
  const fallbackLabel = getFallbackTabOptionLabel(tab, fallbackLabels);
  const trailingAccessory = useMemo(
    () => (
      <MobileTabTrailingAccessory
        menuTestIDBase={menuTestIDBase}
        presentationLabel={fallbackLabel}
        menuEntries={menuEntries}
      />
    ),
    [menuTestIDBase, fallbackLabel, menuEntries],
  );

  const handleSelect = useCallback(() => onSelectTab(tab.key), [onSelectTab, tab.key]);
  const renderPresentation = useCallback(
    (presentation: WorkspaceTabPresentation) => (
      <WorkspaceMenuTabRow
        presentation={presentation}
        selected={selected}
        onSelect={handleSelect}
        trailingAccessory={trailingAccessory}
        testID={`workspace-header-tab-${tab.tabId}`}
      />
    ),
    [selected, handleSelect, trailingAccessory, tab.tabId],
  );

  return (
    <WorkspaceTabPresentationResolver
      tab={tab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {renderPresentation}
    </WorkspaceTabPresentationResolver>
  );
}

export function MobileHeaderMenuLeading({
  tabs,
  activeTabKey,
  normalizedServerId,
  normalizedWorkspaceId,
  title,
  avatarUri,
  branchName,
  actions,
}: {
  tabs: WorkspaceTabDescriptor[];
  activeTabKey: string;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  title: string;
  avatarUri: string | null;
  branchName: string | null;
  actions: WorkspaceMobileTabActions;
}): ReactElement {
  const indexByKey = useMemo(() => new Map(tabs.map((tab, index) => [tab.key, index])), [tabs]);
  const ordered = useMemo(() => orderTabsActiveFirst(tabs, activeTabKey), [activeTabKey, tabs]);
  const avatar = useMemo(
    () => (avatarUri ? <WorkspaceAvatar uri={avatarUri} size={32} /> : null),
    [avatarUri],
  );
  return (
    <>
      <WorkspaceMenuContextCard
        leading={avatar}
        title={title}
        branchName={branchName}
        serverId={normalizedServerId}
      />
      <WorkspaceMenuTabsLabel count={tabs.length} />
      {ordered.map((tab) => (
        <MobileWorkspaceTabOption
          key={tab.key}
          tab={tab}
          tabIndex={indexByKey.get(tab.key) ?? 0}
          tabCount={tabs.length}
          normalizedServerId={normalizedServerId}
          normalizedWorkspaceId={normalizedWorkspaceId}
          selected={tab.key === activeTabKey}
          actions={actions}
        />
      ))}
    </>
  );
}

/**
 * The phone's workspace header (option D, as corrected by the owner): the wide header's controls in
 * the same places, as floating glass — [back] [avatar · bot name] ······ [plugin buttons |
 * scripts | Explorer]. The tab row is gone; tabs are the header sheet's Tabs group. The title
 * pill is the sheet's only opener: a ⋯ button beside it opened the same sheet, so it went
 * (after build 23).
 */
export function WorkspaceMobileHeader({
  normalizedServerId,
  normalizedWorkspaceId,
  workspaceDirectory,
  workspaceTitle,
  isWorkspaceTitleLoading,
  currentBranchName,
  tabs,
  activeTabKey,
  tabActions,
  explorer,
  scripts,
  menu,
}: {
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  workspaceDirectory: string | null | undefined;
  workspaceTitle: string;
  isWorkspaceTitleLoading: boolean;
  currentBranchName: string | null;
  tabs: WorkspaceTabDescriptor[];
  activeTabKey: string;
  tabActions: WorkspaceMobileTabActions;
  explorer: WorkspaceMobileExplorerToggleProps;
  scripts: WorkspaceMobileScriptsProps;
  menu: WorkspaceMobileHeaderMenuProps;
}): ReactElement {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const openMenu = useCallback(() => {
    Keyboard.dismiss();
    setIsMenuOpen(true);
  }, []);
  const workspaceBot = useWorkspaceBot({
    serverId: normalizedServerId,
    workspaceDirectory: workspaceDirectory ?? null,
    enabled: true,
  });
  const botAvatarUri = workspaceBot?.avatarUri ?? null;
  const botName = workspaceBot?.bot.name ?? null;

  const menuLeading = useMemo(
    () => (
      <MobileHeaderMenuLeading
        tabs={tabs}
        activeTabKey={activeTabKey}
        normalizedServerId={normalizedServerId}
        normalizedWorkspaceId={normalizedWorkspaceId}
        title={botName ?? workspaceTitle}
        avatarUri={botAvatarUri}
        branchName={currentBranchName}
        actions={tabActions}
      />
    ),
    [
      activeTabKey,
      botAvatarUri,
      botName,
      currentBranchName,
      normalizedServerId,
      normalizedWorkspaceId,
      tabActions,
      tabs,
      workspaceTitle,
    ],
  );
  const leading = useMemo(
    () => <SidebarMenuToggle style={mobileFloatingHeaderCircleButtonStyle} />,
    [],
  );
  const controls = useMemo(
    () => (
      <>
        <PluginHeaderButtons serverId={normalizedServerId} workspaceId={normalizedWorkspaceId} />
        {scripts.scripts.length > 0 ? (
          <WorkspaceScriptsButton
            serverId={normalizedServerId}
            workspaceId={normalizedWorkspaceId}
            scripts={scripts.scripts}
            liveTerminalIds={scripts.liveTerminalIds}
            onScriptTerminalStarted={scripts.onScriptTerminalStarted}
            onViewTerminal={scripts.onViewTerminal}
            onOpenUrlInBrowserTab={scripts.onOpenUrlInBrowserTab}
            hideLabels
            presentation="ghost"
          />
        ) : null}
        <WorkspaceExplorerToggle
          onPress={explorer.onPress}
          label={explorer.label}
          tooltipLabel={explorer.tooltipLabel}
          tooltipKeys={explorer.tooltipKeys}
          accessibilityState={explorer.accessibilityState}
          mobile
          glass
          style={mobileFloatingHeaderPillButtonStyle}
        />
      </>
    ),
    [explorer, normalizedServerId, normalizedWorkspaceId, scripts],
  );
  // The sheet presents from a portal, so it takes no room beside the pill that opens it.
  const identity = useMemo(
    () => (
      <>
        <MobileFloatingHeaderIdentity
          title={botName ?? workspaceTitle}
          avatarUri={botAvatarUri}
          isLoading={isWorkspaceTitleLoading && botName === null}
          tabCount={tabs.length}
          onPress={openMenu}
        />
        <WorkspaceHeaderMenuMobile
          {...menu}
          hideTrigger
          open={isMenuOpen}
          onOpenChange={setIsMenuOpen}
          leadingContent={menuLeading}
        />
      </>
    ),
    [
      botAvatarUri,
      botName,
      isMenuOpen,
      isWorkspaceTitleLoading,
      menu,
      menuLeading,
      openMenu,
      tabs.length,
      workspaceTitle,
    ],
  );
  return <MobileFloatingHeader leading={leading} controls={controls} identity={identity} />;
}
