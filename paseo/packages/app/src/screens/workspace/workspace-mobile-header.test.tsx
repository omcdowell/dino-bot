/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React from "react";
import { act, fireEvent } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

void testI18n;

// The header renders real UI components (switches, form fields), so the mock theme is the
// real dark theme with this test's own colours and sizes on top.
const { mockTheme } = await vi.hoisted(async () => {
  const { darkTheme } = await import("@/styles/theme");
  const overrides = {
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      foregroundExtraMuted: "#777",
      surface0: "#111",
      surface1: "#161616",
      surface2: "#222",
      borderAccent: "#333",
    },
    colorScheme: "dark",
    spacing: { 0: 0, 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16 },
    borderRadius: { md: 6, lg: 8, full: 999 },
    borderWidth: { 1: 1 },
    fontSize: { sm: 12, base: 14 },
    fontWeight: { medium: "500", semibold: "600" },
  };
  return {
    mockTheme: {
      ...darkTheme,
      ...overrides,
      colors: { ...darkTheme.colors, ...overrides.colors },
    },
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (theme: unknown) => unknown)(mockTheme) : factory,
    hairlineWidth: 1,
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: { uniProps?: (theme: unknown) => Record<string, unknown> } & Record<string, unknown>) =>
      React.createElement(Component, { ...rest, ...(uniProps ? uniProps(mockTheme) : {}) }),
}));

vi.mock("lucide-react-native", async (importOriginal) => {
  const icon = (name: string) => () => <span data-icon={name} />;
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    Check: icon("check"),
    GitBranch: icon("git-branch"),
  };
});

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuHint: ({
    children,
    trailing,
    testID,
  }: {
    children: React.ReactNode;
    trailing?: React.ReactNode;
    testID?: string;
  }) => (
    <div data-testid={testID}>
      <span>{children}</span>
      <span>{trailing}</span>
    </div>
  ),
  DropdownMenuItem: ({
    children,
    leading,
    trailing,
    selected,
    onSelect,
    testID,
  }: {
    children: React.ReactNode;
    leading?: React.ReactNode;
    trailing?: React.ReactNode;
    selected?: boolean;
    onSelect?: () => void;
    testID?: string;
  }) => (
    <div data-testid={testID} data-row="tab" aria-checked={selected}>
      <button type="button" data-testid={`${testID}-select`} onClick={onSelect}>
        {leading}
        {children}
      </button>
      {trailing}
    </div>
  ),
}));

vi.mock("@/screens/workspace/workspace-tab-presentation", () => ({
  WorkspaceTabPresentationResolver: ({
    tab,
    children,
  }: {
    tab: WorkspaceTabDescriptor;
    children: (presentation: Record<string, unknown>) => React.ReactNode;
  }) =>
    children({
      key: tab.key,
      kind: tab.kind,
      label: `label:${tab.key}`,
      titleState: "ready",
      icon: () => null,
      statusBucket: null,
    }),
  WorkspaceTabIcon: () => <span data-icon="tab" />,
}));

vi.mock("@/screens/workspace/workspace-tab-trailing-accessory", () => ({
  MobileTabTrailingAccessory: ({ menuTestIDBase }: { menuTestIDBase: string }) => (
    <button type="button" data-testid={`${menuTestIDBase}-trigger`} />
  ),
}));

vi.mock("@/hosts/use-host-badges", () => ({
  useHostBadges: () => new Map([["srv", { label: "my-pc" }]]),
}));
vi.mock("@/hosts/host-badge", () => ({
  HostBadge: ({ badge }: { badge: { label: string } }) => <span>{badge.label}</span>,
}));

// The header's other pieces are not under test here.
vi.mock("@/components/headers/menu-header", () => ({ SidebarMenuToggle: () => null }));
vi.mock("@/plugins", () => ({ PluginHeaderButtons: () => null }));
vi.mock("@/screens/workspace/workspace-scripts-button", () => ({
  WorkspaceScriptsButton: () => null,
}));
vi.mock("@/screens/workspace/workspace-explorer-toggle", () => ({
  WorkspaceExplorerToggle: () => <button type="button" data-testid="workspace-explorer-toggle" />,
}));
// The sheet: shows whether it draws its own trigger and whether it is open.
vi.mock("@/screens/workspace/workspace-header-menu", () => ({
  WorkspaceHeaderMenuMobile: ({ hideTrigger, open }: { hideTrigger?: boolean; open?: boolean }) => (
    <div data-testid="workspace-header-menu" data-open={String(Boolean(open))}>
      {hideTrigger ? null : <button type="button" data-testid="workspace-header-menu-trigger" />}
    </div>
  ),
}));
vi.mock("./mobile-floating-header", () => ({
  MobileFloatingHeader: ({
    leading,
    controls,
    identity,
  }: {
    leading: React.ReactNode;
    controls: React.ReactNode;
    identity: React.ReactNode;
  }) => (
    <div>
      {leading}
      {identity}
      <div data-testid="workspace-header-controls-pill">{controls}</div>
    </div>
  ),
  MobileFloatingHeaderIdentity: ({ title, onPress }: { title: string; onPress: () => void }) => (
    <button type="button" data-testid="workspace-tab-switcher-trigger" onClick={onPress}>
      {title}
    </button>
  ),
  mobileFloatingHeaderCircleButtonStyle: {},
  mobileFloatingHeaderPillButtonStyle: {},
}));
vi.mock("./use-workspace-bot", () => ({ useWorkspaceBot: () => null }));

const { MobileHeaderMenuLeading, WorkspaceMobileHeader } =
  await import("./workspace-mobile-header");

function makeTab(kind: "agent" | "terminal", id: string): WorkspaceTabDescriptor {
  return kind === "agent"
    ? { key: id, tabId: id, kind, target: { kind, agentId: id } }
    : { key: id, tabId: id, kind, target: { kind, terminalId: id } };
}

const tabs = [makeTab("terminal", "t1"), makeTab("agent", "a1"), makeTab("terminal", "t2")];

function actions() {
  return {
    onSelectTab: vi.fn(),
    onCopyResumeCommand: vi.fn(),
    onCopyAgentId: vi.fn(),
    onCopyTerminalId: vi.fn(),
    onCopyFilePath: vi.fn(),
    onReloadAgent: vi.fn(),
    onRenameTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseTabsAbove: vi.fn(),
    onCloseTabsBelow: vi.fn(),
    onCloseOtherTabs: vi.fn(),
  };
}

describe("MobileHeaderMenuLeading (the header sheet's context card and Tabs group)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(activeTabKey: string, tabActions = actions()) {
    root = createRoot(container);
    act(() => {
      root?.render(
        <MobileHeaderMenuLeading
          tabs={tabs}
          activeTabKey={activeTabKey}
          normalizedServerId="srv"
          normalizedWorkspaceId="ws"
          title="Emmet"
          avatarUri={null}
          branchName="main"
          actions={tabActions}
        />,
      );
    });
    return tabActions;
  }

  it("lists every tab, the active one first and checked, each with its own ⋯", () => {
    render("a1");
    const rows = [...container.querySelectorAll('[data-row="tab"]')];
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "workspace-header-tab-a1",
      "workspace-header-tab-t1",
      "workspace-header-tab-t2",
    ]);
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(rows[0].querySelector('[data-icon="check"]')).not.toBeNull();
    expect(rows[1].querySelector('[data-icon="check"]')).toBeNull();
    for (const id of ["a1", "t1", "t2"]) {
      expect(
        container.querySelector(`[data-testid="workspace-tab-menu-${id}-trigger"]`),
      ).not.toBeNull();
    }
  });

  it("heads the group 'Tabs' with the open count, under the workspace context card", () => {
    render("a1");
    const label = container.querySelector('[data-testid="workspace-header-tabs-label"]');
    expect(label?.textContent).toBe("Tabs3 open");
    const card = container.querySelector('[data-testid="workspace-header-context-card"]');
    expect(card?.textContent).toContain("Emmet");
    expect(card?.textContent).toContain("main");
    expect(card?.textContent).toContain("my-pc");
  });

  it("switches to a tab when its row is pressed", () => {
    const tabActions = render("a1");
    fireEvent.click(
      container.querySelector('[data-testid="workspace-header-tab-t2-select"]') as Element,
    );
    expect(tabActions.onSelectTab).toHaveBeenCalledWith("t2");
  });
});

const explorerProps = {
  onPress: vi.fn(),
  label: "Explorer",
  tooltipLabel: "Explorer",
  tooltipKeys: [],
  accessibilityState: { expanded: false },
};
const scriptsProps = {
  scripts: [],
  liveTerminalIds: [],
  onScriptTerminalStarted: vi.fn(),
  onViewTerminal: vi.fn(),
  onOpenUrlInBrowserTab: vi.fn(),
};
const menuProps = {
  normalizedServerId: "srv",
  currentBranchName: "main",
  showWorkspaceSetup: false,
  importAgentDisabled: false,
  copyPathDisabled: false,
  onOpenImportSheet: vi.fn(),
  onCopyWorkspacePath: vi.fn(),
  onCopyBranchName: vi.fn(),
  onOpenSetupTab: vi.fn(),
  showCreateBrowserTab: false,
  createTerminalDisabled: false,
  onCreateDraftTab: vi.fn(),
  onCreateTerminal: vi.fn(),
  onCreateTerminalWithProfile: vi.fn(),
  onCreateBrowser: vi.fn(),
};

describe("WorkspaceMobileHeader", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  function render() {
    root = createRoot(container);
    act(() => {
      root?.render(
        <WorkspaceMobileHeader
          normalizedServerId="srv"
          normalizedWorkspaceId="ws"
          workspaceDirectory="/repo"
          workspaceTitle="Emmet"
          isWorkspaceTitleLoading={false}
          currentBranchName="main"
          tabs={tabs}
          activeTabKey="a1"
          tabActions={actions()}
          explorer={explorerProps}
          scripts={scriptsProps}
          menu={menuProps}
        />,
      );
    });
  }

  it("has no ⋯ button: the controls pill holds the Explorer toggle alone", () => {
    render();
    expect(container.querySelector('[data-testid="workspace-header-menu-trigger"]')).toBeNull();
    const pill = container.querySelector('[data-testid="workspace-header-controls-pill"]');
    expect(
      [...(pill?.querySelectorAll("[data-testid]") ?? [])].map((node) =>
        node.getAttribute("data-testid"),
      ),
    ).toEqual(["workspace-explorer-toggle"]);
  });

  it("opens the sheet from the title pill", () => {
    render();
    const sheet = () => container.querySelector('[data-testid="workspace-header-menu"]');
    expect(sheet()?.getAttribute("data-open")).toBe("false");
    fireEvent.click(
      container.querySelector('[data-testid="workspace-tab-switcher-trigger"]') as Element,
    );
    expect(sheet()?.getAttribute("data-open")).toBe("true");
  });
});
