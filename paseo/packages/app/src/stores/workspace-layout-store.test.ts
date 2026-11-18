import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createViewedTimelineSync } from "@/timeline/viewed-timeline-sync";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTab } from "@/workspace-tabs/model";
import { defaultFileState } from "@/panels/file/state";
import {
  canDismissPaneInLayout,
  collectAllPanes,
  collectAllTabs,
  createWorkspaceLayoutStore,
  observeOpenWorkspaceAgentIds,
  createWorkspaceLayoutWithExplorerSidebar,
  findPaneById,
  findPaneContainingTab,
  getTreeDepth,
  insertSplit,
  removePaneFromTree,
  type SplitNode,
  type SplitPane,
} from "@/stores/workspace-layout-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-main";

function createDeterministicWorkspaceLayoutIds() {
  let values: string[] = [];
  let fallbackIndex = 0;

  function nextValue(): string {
    const value = values.shift();
    if (value) {
      return value;
    }
    fallbackIndex += 1;
    return `generated-${fallbackIndex}`;
  }

  return {
    useValues: (nextValues: string[]) => {
      values = nextValues.slice();
      fallbackIndex = 0;
    },
    reset: () => {
      values = [];
      fallbackIndex = 0;
    },
    createNodeId: (prefix: "pane" | "group") => `${prefix}_${nextValue()}`,
    createFocusRestorationToken: () => `workspace-focus-${nextValue()}`,
  };
}

const workspaceLayoutIds = createDeterministicWorkspaceLayoutIds();
const workspaceLayoutStore = createWorkspaceLayoutStore(workspaceLayoutIds);

it("observes open chats across unmounted workspaces until their tabs close", () => {
  const store = createWorkspaceLayoutStore(workspaceLayoutIds);
  store.setState({ layoutByWorkspace: {} });
  const received: string[][] = [];
  const stop = observeOpenWorkspaceAgentIds("server-1", (ids) => received.push(ids), store);
  const first = store.getState().openTab({
    workspaceKey: "server-1:workspace-a",
    target: { kind: "agent", agentId: "agent-a" },
    intent: "reveal",
  });
  store.getState().openTab({
    workspaceKey: "server-1:workspace-b",
    target: { kind: "agent", agentId: "agent-b" },
    intent: "background",
  });
  store.getState().openTab({
    workspaceKey: "server-2:workspace-a",
    target: { kind: "agent", agentId: "other-host-agent" },
    intent: "reveal",
  });
  expect(received).toEqual([[], ["agent-a"], ["agent-a", "agent-b"]]);
  if (!first) throw new Error("Expected an open agent tab");
  store.getState().closeTab("server-1:workspace-a", first);
  expect(received.at(-1)).toEqual(["agent-b"]);
  stop();
  store.getState().openTab({
    workspaceKey: "server-1:workspace-a",
    target: { kind: "agent", agentId: "after-dispose" },
    intent: "reveal",
  });
  expect(received).toEqual([[], ["agent-a"], ["agent-a", "agent-b"], ["agent-b"]]);
});

it("feeds restored layout to timeline sync as a release signal, not a subscription source", async () => {
  const store = createWorkspaceLayoutStore(workspaceLayoutIds);
  store.setState({ layoutByWorkspace: {} });
  // Launch: layout rehydrates tabs the user opened in earlier sessions.
  const restored = store.getState().openTab({
    workspaceKey: "server-1:workspace-a",
    target: { kind: "agent", agentId: "agent-a" },
    intent: "reveal",
  });
  store.getState().openTab({
    workspaceKey: "server-1:workspace-b",
    target: { kind: "agent", agentId: "agent-b" },
    intent: "background",
  });

  const observed: string[][] = [];
  const sync = createViewedTimelineSync({
    replaceDemandedAgentIds: () => undefined,
    prepare: async () => undefined,
    observe: (agentIds) => {
      observed.push(agentIds);
      return { ready: Promise.resolve(), release: async () => undefined };
    },
    readCursor: () => undefined,
    fetchPage: async () => ({ hasNewer: false, endCursor: null }),
    fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
    onCatchUpEnded: () => undefined,
    reportError: () => undefined,
    schedule: () => () => undefined,
  });
  // The edge session-context.tsx owns. Pointing it at subscription instead would resume every
  // agent behind a restored tab on the daemon.
  const stop = observeOpenWorkspaceAgentIds(
    "server-1",
    (agentIds) => sync.replaceOpenTabAgentIds(agentIds),
    store,
  );

  sync.setConnected(true);
  expect(observed).toEqual([]);

  sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  await vi.waitFor(() => expect(observed).toEqual([["agent-a"]]));

  if (!restored) throw new Error("Expected an open agent tab");
  store.getState().closeTab("server-1:workspace-a", restored);
  sync.replaceVisibleAgentIds("workspace", []);
  await vi.waitFor(() => expect(observed.at(-1)).toEqual([]));

  stop();
  sync.dispose();
});

function useWorkspaceLayoutIds(...values: string[]) {
  workspaceLayoutIds.useValues(values);
}

function createTab(
  tabId: string,
  target?: WorkspaceTab["target"],
  state?: WorkspaceTab["state"],
): WorkspaceTab {
  return {
    tabId,
    target: target ?? { kind: "agent", agentId: tabId },
    createdAt: 1,
    ...(state === undefined ? {} : { state }),
  };
}

function createPane(input: {
  id: string;
  tabIds: string[];
  focusedTabId?: string | null;
  hidden?: boolean;
  targetsByTabId?: Record<string, WorkspaceTab["target"]>;
  stateByTabId?: Record<string, WorkspaceTab["state"]>;
}): SplitNode {
  const tabs = input.tabIds.map((tabId) =>
    createTab(tabId, input.targetsByTabId?.[tabId], input.stateByTabId?.[tabId]),
  );
  return {
    kind: "pane",
    pane: {
      id: input.id,
      tabIds: input.tabIds,
      focusedTabId: input.focusedTabId ?? input.tabIds[input.tabIds.length - 1] ?? null,
      ...(input.hidden === true ? { hidden: true } : {}),
      tabs,
    } as SplitPane,
  };
}

function createWorkspaceKey(): string {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: SERVER_ID,
    workspaceId: WORKSPACE_ID,
  });
  expect(key).toBeTruthy();
  return key as string;
}

function collectTabIds(root: SplitNode): string[] {
  return collectAllTabs(root).map((tab) => tab.tabId);
}

function collectContentTabs(root: SplitNode): WorkspaceTab[] {
  return contentTabs(collectAllTabs(root));
}

function contentTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
  return tabs.filter((tab) => tab.target.kind !== "files");
}

function expectGroup(node: SplitNode): Extract<SplitNode, { kind: "group" }> {
  expect(node.kind).toBe("group");
  return node as Extract<SplitNode, { kind: "group" }>;
}

describe("workspace-layout-store helpers", () => {
  it("finds panes and tabs across nested groups", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.4, 0.6],
        children: [
          createPane({ id: "left", tabIds: ["tab-a", "tab-b"], focusedTabId: "tab-a" }),
          {
            kind: "group",
            group: {
              id: "group-right",
              direction: "vertical",
              sizes: [0.5, 0.5],
              children: [
                createPane({ id: "top-right", tabIds: ["tab-c"] }),
                createPane({ id: "bottom-right", tabIds: ["tab-d"] }),
              ],
            },
          },
        ],
      },
    };

    expect(findPaneById(root, "top-right")?.tabIds).toEqual(["tab-c"]);
    expect(findPaneContainingTab(root, "tab-b")?.id).toBe("left");
    expect(getTreeDepth(root)).toBe(3);
    expect(collectAllPanes(root).map((pane) => pane.id)).toEqual([
      "left",
      "top-right",
      "bottom-right",
    ]);
    expect(collectAllTabs(root).map((tab) => tab.tabId)).toEqual([
      "tab-a",
      "tab-b",
      "tab-c",
      "tab-d",
    ]);
  });

  it("keeps tabs in hidden panes while excluding those panes from focus helpers", () => {
    const root = createPane({ id: "hidden", tabIds: ["tab-a"], hidden: true });

    expect(collectAllTabs(root).map((tab) => tab.tabId)).toEqual(["tab-a"]);
    expect(collectAllPanes(root)).toEqual([]);
  });
});

describe("workspace-layout-store version 2 migration", () => {
  const workspaceKey = "workspace";
  const preservedFileState = { treeVisible: true, treeWidth: 333 };

  function createVersionOneLayout(includeExplorerDefaults: boolean) {
    const explorerTabIds = [
      ...(includeExplorerDefaults ? ["files"] : []),
      "legacy-file",
      "legacy-agent",
    ];
    return {
      root: {
        kind: "group" as const,
        group: {
          id: "workspace-root",
          direction: "horizontal" as const,
          sizes: [0.61, 0.39],
          children: [
            createPane({
              id: "main",
              tabIds: ["main-draft"],
              targetsByTabId: {
                "main-draft": { kind: "agent", agentId: "main-draft" },
              },
            }),
            createPane({
              id: "explorer",
              tabIds: explorerTabIds,
              focusedTabId: "legacy-file",
              hidden: true,
              targetsByTabId: {
                files: { kind: "files" },
                "legacy-file": { kind: "file", path: "/repo/preserved.ts" },
                "legacy-agent": { kind: "agent", agentId: "preserved-agent" },
              },
              stateByTabId: { "legacy-file": preservedFileState },
            }),
          ],
        },
      },
      focusedPaneId: "main",
    };
  }

  async function persistVersionOneLayout(
    source: "v0.5" | "v0.6",
    options: { withSidePane?: boolean } = {},
  ) {
    const layout = createVersionOneLayout(source === "v0.6");
    const persistedLayout = options.withSidePane
      ? {
          ...layout,
          root: {
            kind: "group" as const,
            group: {
              id: "side-root",
              direction: "horizontal" as const,
              sizes: [0.7, 0.3],
              children: [
                layout.root,
                createPane({
                  id: "existing-side",
                  tabIds: ["existing-side-file"],
                  targetsByTabId: {
                    "existing-side-file": { kind: "file", path: "/repo/already-beside.ts" },
                  },
                }),
              ],
            },
          },
        }
      : layout;
    await AsyncStorage.removeItem("workspace-layout-state");
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: {
            [workspaceKey]: persistedLayout,
          },
          splitSizesByWorkspace: {},
          explorerPaneIdByWorkspace: { [workspaceKey]: "explorer" },
          ...(source === "v0.6"
            ? {
                explorerSidebarWidthByWorkspace: {},
                sidePaneIdByWorkspace: options.withSidePane
                  ? { [workspaceKey]: "existing-side" }
                  : {},
              }
            : {}),
        },
        version: 1,
      }),
    );
  }

  function expectMigratedLayout(
    store: {
      getState: () => {
        layoutByWorkspace: Record<string, { root: SplitNode }>;
        explorerSidebarPaneIdByWorkspace: Record<string, string | null>;
        sidePaneIdByWorkspace: Record<string, string | null>;
      };
    },
    expected: {
      sidePaneId?: string;
      sideTabIds?: string[];
    } = {},
  ) {
    const state = store.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    const explorerPaneId = state.explorerSidebarPaneIdByWorkspace[workspaceKey];
    const sidePaneId = state.sidePaneIdByWorkspace[workspaceKey];
    expect(explorerPaneId).toBe("explorer");
    expect(sidePaneId).toBeTruthy();
    expect(sidePaneId).not.toBe(explorerPaneId);

    const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
    const explorerPane = findPaneById(layout.root, explorerPaneId);
    expect(explorerPane?.tabIds.map((tabId) => tabsById.get(tabId)?.target)).toEqual([
      { kind: "files" },
    ]);

    const sidePane = findPaneById(layout.root, sidePaneId);
    expect(sidePane?.hidden).not.toBe(true);
    expect(sidePane?.tabIds).toEqual(expected.sideTabIds ?? ["legacy-file", "legacy-agent"]);
    expect(tabsById.get("legacy-file")).toMatchObject({
      target: { kind: "file", path: "/repo/preserved.ts" },
      state: preservedFileState,
    });
    expect(sidePaneId).toBe(expected.sidePaneId ?? sidePaneId);
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main", sidePaneId]);
  }

  it.each(["v0.5", "v0.6"] as const)(
    "replaces Explorer once and preserves persisted side content when upgrading from %s",
    async (source) => {
      await persistVersionOneLayout(source);
      const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

      await restored.persist.rehydrate();

      expectMigratedLayout(restored);
      await vi.waitFor(async () => {
        const persisted = JSON.parse(
          (await AsyncStorage.getItem("workspace-layout-state")) ?? "{}",
        );
        expect(persisted.version).toBe(2);
      });
    },
  );

  it("reuses an ordinary side pane already created by v0.6", async () => {
    await persistVersionOneLayout("v0.6", { withSidePane: true });
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    expectMigratedLayout(restored, {
      sidePaneId: "existing-side",
      sideTabIds: ["existing-side-file", "legacy-file", "legacy-agent"],
    });
  });

  it("writes version 2 preserving the existing Explorer key", async () => {
    await persistVersionOneLayout("v0.6");
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    await vi.waitFor(async () => {
      const persisted = JSON.parse((await AsyncStorage.getItem("workspace-layout-state")) ?? "{}");
      expect(persisted.version).toBe(2);
      expect(Object.keys(persisted.state).sort()).toEqual([
        "explorerPaneIdByWorkspace",
        "explorerSidebarWidthByWorkspace",
        "layoutByWorkspace",
        "pinnedAgentIdsByWorkspace",
        "sidePaneIdByWorkspace",
        "splitSizesByWorkspace",
      ]);
      expect(persisted.state.explorerPaneIdByWorkspace).toEqual({
        [workspaceKey]: "explorer",
      });
    });
  });

  it("does not replace Explorer again when the migrated version 2 layout reloads", async () => {
    await persistVersionOneLayout("v0.6");
    const migrated = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await migrated.persist.rehydrate();
    expectMigratedLayout(migrated);
    const explorerPaneId = migrated.getState().explorerSidebarPaneIdByWorkspace[workspaceKey];
    if (!explorerPaneId) {
      throw new Error("Migrated Explorer pane is missing");
    }
    const addedTabId = migrated.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "added-after-migration" },
      intent: "new",
      placement: { mode: "pane", paneId: explorerPaneId },
    });
    expect(addedTabId).toBeTruthy();

    await vi.waitFor(async () => {
      const persisted = JSON.parse((await AsyncStorage.getItem("workspace-layout-state")) ?? "{}");
      expect(persisted.version).toBe(2);
    });
    const reloaded = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await reloaded.persist.rehydrate();

    const reloadedState = reloaded.getState();
    const reloadedLayout = reloadedState.layoutByWorkspace[workspaceKey];
    const reloadedExplorer = findPaneById(
      reloadedLayout.root,
      reloadedState.explorerSidebarPaneIdByWorkspace[workspaceKey],
    );
    expect(reloadedExplorer?.tabIds).toContain(addedTabId);
    expect(findPaneContainingTab(reloadedLayout.root, addedTabId as string)?.id).toBe(
      reloadedExplorer?.id,
    );
  });
});

describe("workspace-layout-store tree transforms", () => {
  beforeEach(() => {
    workspaceLayoutIds.reset();
  });

  it("insertSplit adds root-level same-direction splits as a flat sibling", () => {
    useWorkspaceLayoutIds("11111111-1111-1111-1111-111111111111");

    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.25, 0.75],
        children: [
          createPane({ id: "left", tabIds: ["tab-a"] }),
          createPane({ id: "right", tabIds: ["tab-b", "tab-c"] }),
        ],
      },
    };

    const nextRoot = insertSplit(root, "right", "tab-c", "right", workspaceLayoutIds.createNodeId);
    const nextGroup = expectGroup(nextRoot);

    expect(nextGroup.group.id).toBe("group-root");
    expect(nextGroup.group.direction).toBe("horizontal");
    expect(nextGroup.group.children).toHaveLength(3);
    expect(nextGroup.group.sizes).toEqual([0.25, 0.375, 0.375]);
    expect(getTreeDepth(nextRoot)).toBe(getTreeDepth(root));
    expect(collectAllPanes(nextRoot).map((pane) => pane.id)).toEqual([
      "left",
      "right",
      "pane_11111111-1111-1111-1111-111111111111",
    ]);
    expect(findPaneById(nextRoot, "right")?.tabIds).toEqual(["tab-b"]);
    expect(findPaneById(nextRoot, "pane_11111111-1111-1111-1111-111111111111")?.tabIds).toEqual([
      "tab-c",
    ]);
  });

  /**
   * The renderer keys panes by id and reconciles them positionally, so a pane that changes render
   * path is unmounted and rebuilt — the composer, terminal, and scroll state in it are lost. A
   * same-direction split has no reason to move anything: it appends a sibling into the group that
   * is already running in that direction. Perpendicular splits are excluded because nesting is the
   * only way to change axis.
   */
  describe("same-direction splits never move an existing pane", () => {
    function panePathsById(root: SplitNode, path: string[] = []): Map<string, string> {
      if (root.kind === "pane") {
        return new Map([[root.pane.id, path.join("/")]]);
      }
      const paths = new Map<string, string>();
      for (const child of root.group.children) {
        const childKey = child.kind === "pane" ? child.pane.id : child.group.id;
        for (const [paneId, childPath] of panePathsById(child, [...path, childKey])) {
          paths.set(paneId, childPath);
        }
      }
      return paths;
    }

    function withPaneTabs(root: SplitNode, paneId: string, tabIds: string[]): SplitNode {
      if (root.kind === "pane") {
        return root.pane.id === paneId ? createPane({ id: paneId, tabIds }) : root;
      }
      return {
        kind: "group",
        group: {
          ...root.group,
          children: root.group.children.map((child) => withPaneTabs(child, paneId, tabIds)),
        },
      };
    }

    function expectExistingPanesUnmoved(before: SplitNode, after: SplitNode) {
      const beforePaths = panePathsById(before);
      const afterPaths = panePathsById(after);
      for (const [paneId, panePath] of beforePaths) {
        expect(afterPaths.get(paneId)).toBe(panePath);
      }
      expect(getTreeDepth(after)).toBe(getTreeDepth(before));
    }

    for (const position of ["left", "right"] as const) {
      it(`keeps every pane in place when a tab is dragged ${position} from the default layout`, () => {
        workspaceLayoutIds.reset();
        const mainPaneId = collectAllPanes(createWorkspaceLayoutWithExplorerSidebar().root)[0]?.id;
        expect(mainPaneId).toBeTruthy();
        const root = withPaneTabs(
          createWorkspaceLayoutWithExplorerSidebar().root,
          mainPaneId as string,
          ["tab-a", "tab-b"],
        );

        const nextRoot = insertSplit(
          root,
          mainPaneId as string,
          "tab-a",
          position,
          workspaceLayoutIds.createNodeId,
        );

        expectExistingPanesUnmoved(root, nextRoot);
      });
    }

    it("keeps every pane in place when splitPaneEmpty opens the first split pane", () => {
      workspaceLayoutIds.reset();
      const workspaceKey = createWorkspaceKey();
      const store = workspaceLayoutStore.getState();
      const before = createWorkspaceLayoutWithExplorerSidebar();
      const mainPaneId = collectAllPanes(before.root)[0]?.id;
      expect(mainPaneId).toBeTruthy();

      const newPaneId = store.splitPaneEmpty(workspaceKey, {
        targetPaneId: mainPaneId as string,
        position: "right",
      });

      expect(newPaneId).not.toBeNull();
      const after = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
      expectExistingPanesUnmoved(before.root, after.root);
    });
  });

  it("removePaneFromTree unwraps single-child groups and renormalizes siblings", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.2, 0.8],
        children: [
          createPane({ id: "left", tabIds: ["tab-a"] }),
          {
            kind: "group",
            group: {
              id: "group-right",
              direction: "vertical",
              sizes: [0.5, 0.5],
              children: [
                createPane({ id: "top-right", tabIds: ["tab-b"] }),
                createPane({ id: "bottom-right", tabIds: ["tab-c"] }),
              ],
            },
          },
        ],
      },
    };

    const nextRoot = removePaneFromTree(root, "top-right");
    const nextGroup = expectGroup(nextRoot);

    expect(nextGroup.group.sizes).toEqual([0.2, 0.8]);
    expect(collectAllPanes(nextRoot).map((pane) => pane.id)).toEqual(["left", "bottom-right"]);
    expect(nextGroup.group.children[1]).toEqual(
      createPane({ id: "bottom-right", tabIds: ["tab-c"] }),
    );
  });
});

describe("workspace-layout-store actions", () => {
  it("restores a revealed file's parent after local replacement", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const parent = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "parent" },
      intent: "new",
    })!;
    const file = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts", lineStart: 1 },
      intent: "new",
    })!;
    store.setTabState(workspaceKey, file, {
      treeVisible: true,
      treeWidth: 300,
    });
    expect(
      store.openTab({
        workspaceKey: workspaceKey,
        target: { kind: "file", path: "/repo/a.ts", lineStart: 9 },
        intent: "reveal",
        placement: undefined,
        parentTabId: parent,
      }),
    ).toBe(file);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === file)).toMatchObject({
      target: { path: "/repo/a.ts", lineStart: 9 },
      state: { ...defaultFileState, treeVisible: true, treeWidth: 300 },
    });
    expect(layout.parentTabIdByTabId?.[file]).toBe(parent);

    const replacement = store.replaceTab(
      workspaceKey,
      file,
      { kind: "file", path: "/repo/b.ts" },
      { ...defaultFileState, treeVisible: true, treeWidth: 300 },
    );
    expect(replacement).toBe(file);
    const replacedLayout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(replacedLayout.parentTabIdByTabId?.[file]).toBe(parent);

    store.closeTab(workspaceKey, replacement as string);
    expect(
      findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, "main")
        ?.focusedTabId,
    ).toBe(parent);
  });

  it("reveals provider children through the child capability in a compact pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const parent = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "parent" },
      intent: "new",
    })!;
    const target = {
      kind: "provider_subagent" as const,
      parentAgentId: "parent",
      subagentId: "provider-child",
    };
    const compactPanePlacement = { mode: "pane" as const, paneId: "main" };

    const child = store.openTab({
      workspaceKey: workspaceKey,
      target: target,
      intent: "reveal",
      parentTabId: parent,
      placement: compactPanePlacement,
    })!;
    expect(
      store.openTab({
        workspaceKey: workspaceKey,
        target: target,
        intent: "reveal",
        parentTabId: parent,
        placement: compactPanePlacement,
      }),
    ).toBe(child);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, child)?.id).toBe("main");
    expect(layout.parentTabIdByTabId?.[child]).toBe(parent);

    store.closeTab(workspaceKey, child);
    expect(
      findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, "main")
        ?.focusedTabId,
    ).toBe(parent);
  });

  it("replaces only the supplied file slot and carries its state", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const preserved = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "new",
    });
    const local = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/b.ts" },
      intent: "new",
    });

    const replacement = store.replaceTab(
      workspaceKey,
      local as string,
      { kind: "file", path: "/repo/a.ts" },
      { ...defaultFileState, treeVisible: true, treeWidth: 280 },
    );

    const tabs = collectAllTabs(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
    );
    expect(replacement).not.toBe(preserved);
    expect(tabs.find((tab) => tab.tabId === preserved)?.target).toEqual({
      kind: "file",
      path: "/repo/a.ts",
    });
    expect(tabs.find((tab) => tab.tabId === replacement)?.state).toEqual({
      ...defaultFileState,
      treeVisible: true,
      treeWidth: 280,
    });
  });
  beforeEach(() => {
    workspaceLayoutIds.reset();
    workspaceLayoutStore.setState({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      pinnedAgentIdsByWorkspace: {},
      hiddenAgentIdsByWorkspace: {},
      focusRestorationByWorkspace: {},
      explorerSidebarPaneIdByWorkspace: {},
    });
  });

  it("replaces a pane's sole New tab when real content opens", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const initialLayout = createWorkspaceLayoutWithExplorerSidebar();
    workspaceLayoutStore.setState({ layoutByWorkspace: { [workspaceKey]: initialLayout } });
    const initialMainTabId = findPaneById(initialLayout.root, "main")?.focusedTabId;

    const agentTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "background",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([agentTabId]);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(agentTabId);
    expect(collectTabIds(layout.root)).not.toContain(initialMainTabId);
  });

  it.each(["hideExplorerSidebar", "showExplorerSidebar"] as const)(
    "retains the last ordinary split after %s",
    (setExplorerVisibility) => {
      const workspaceKey = createWorkspaceKey();
      const store = workspaceLayoutStore.getState();
      const tabId = store.openTab({
        workspaceKey,
        target: { kind: "agent", agentId: "draft-origin" },
        intent: "new",
      }) as string;
      store[setExplorerVisibility](workspaceKey);
      const splitPaneId = store.splitPaneEmpty(workspaceKey, {
        targetPaneId: "main",
        position: "right",
      }) as string;
      store.moveTabToPane(workspaceKey, tabId, splitPaneId);
      expect(
        findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, "main"),
      ).toBeNull();

      store.closeTab(workspaceKey, tabId);

      const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
      expect(
        collectAllPanes(layout.root)
          .filter((pane) => pane.id !== "explorer")
          .map((pane) => pane.id),
      ).toEqual([splitPaneId]);
      expect(findPaneById(layout.root, splitPaneId)?.tabIds).toHaveLength(0);
      expect(layout.focusedPaneId).toBe(splitPaneId);
    },
  );

  it.each(["explorer", "pane_generated_explorer"])(
    "restores an ordinary pane beside saved hidden %s without losing tabs",
    async (explorerId) => {
      const workspaceKey = createWorkspaceKey();
      const saved = createPane({
        id: explorerId,
        hidden: true,
        tabIds: ["files", "draft_saved"],
        targetsByTabId: {
          files: { kind: "files" },
          draft_saved: { kind: "file", path: "/repo/saved.ts" },
        },
        stateByTabId: { draft_saved: { savedContent: "preserve me" } },
      });
      await AsyncStorage.setItem(
        "workspace-layout-state",
        JSON.stringify({
          version: 2,
          state: {
            layoutByWorkspace: { [workspaceKey]: { root: saved, focusedPaneId: null } },
            explorerPaneIdByWorkspace: { [workspaceKey]: explorerId },
          },
        }),
      );
      const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
      await restored.persist.rehydrate();
      const state = restored.getState();
      const layout = state.layoutByWorkspace[workspaceKey];
      expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main"]);
      expect(layout.focusedPaneId).toBe("main");
      expect(findPaneById(layout.root, explorerId)).toEqual(
        saved.kind === "pane" ? saved.pane : null,
      );
      expect(state.explorerSidebarPaneIdByWorkspace[workspaceKey]).toBe(explorerId);
      const snapshot = {
        agentsHydrated: true,
        activeAgentIds: [],
        autoOpenAgentIds: [],
      };
      state.reconcileTabs(workspaceKey, snapshot);
      const afterFirstReconcile = restored.getState().layoutByWorkspace[workspaceKey];
      state.reconcileTabs(workspaceKey, snapshot);
      expect(restored.getState().layoutByWorkspace[workspaceKey]).toEqual(afterFirstReconcile);
      expect(
        collectAllTabs(afterFirstReconcile.root).filter((tab) => tab.tabId === "draft_saved"),
      ).toHaveLength(1);
      expect(
        collectAllTabs(afterFirstReconcile.root).find((tab) => tab.tabId === "draft_saved")?.state,
      ).toEqual({ savedContent: "preserve me" });
    },
  );

  it("reveals a saved hidden ordinary pane without replacing its content", async () => {
    const workspaceKey = createWorkspaceKey();
    const saved = createPane({
      id: "pane_saved_ordinary",
      hidden: true,
      tabIds: ["draft_saved"],
      stateByTabId: { draft_saved: { savedContent: "preserve me" } },
    });
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        version: 2,
        state: {
          layoutByWorkspace: { [workspaceKey]: { root: saved, focusedPaneId: null } },
        },
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await restored.persist.rehydrate();
    const layout = restored.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["pane_saved_ordinary"]);
    expect(layout.focusedPaneId).toBe("pane_saved_ordinary");
    expect(findPaneById(layout.root, "pane_saved_ordinary")?.tabIds).toEqual(["draft_saved"]);
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === "draft_saved")?.state).toEqual({
      savedContent: "preserve me",
    });
  });

  it("restores a layout saved before the Side panel rename, PR bookkeeping and all", async () => {
    const savedLayout = createWorkspaceLayoutWithExplorerSidebar();
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: { renamed: savedLayout },
          explorerPaneIdByWorkspace: { renamed: "explorer" },
          acknowledgedPullRequestByWorkspace: { renamed: "url:https://example.test/pulls/1" },
        },
        version: 1,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    const state = restored.getState();
    expect(state.layoutByWorkspace.renamed).toBeTruthy();
    expect(state.explorerSidebarPaneIdByWorkspace.renamed).toBe("explorer");
  });

  it("keeps ambient draft opens out of the focused explorer pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.focusPane(workspaceKey, "explorer");

    const draftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "draft-1" },
      intent: "reveal",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, draftTabId as string)?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
  });

  it("keeps non-entity tabs in the focused explorer pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.focusPane(workspaceKey, "explorer");

    const filesTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "files" },
      intent: "reveal",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, filesTabId as string)?.id).toBe("explorer");
  });

  it("keeps an agent where the user moved it in Explorer", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const agentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.showExplorerSidebar(workspaceKey);
    store.moveTabToPane(workspaceKey, agentTabId as string, "explorer");
    store.focusPane(workspaceKey, "main");

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, agentTabId as string)?.id).toBe("explorer");
    expect(layout.focusedPaneId).toBe("main");
  });

  it.each([{ kind: "file", path: "src/app.ts" } as const])(
    "allows $kind tabs to move into Explorer",
    (target) => {
      const workspaceKey = createWorkspaceKey();
      const store = workspaceLayoutStore.getState();
      const tabId = store.openTab({ workspaceKey, target, intent: "reveal" });

      store.showExplorerSidebar(workspaceKey);
      store.moveTabToPane(workspaceKey, tabId as string, "explorer");

      const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
      expect(findPaneContainingTab(layout.root, tabId as string)?.id).toBe("explorer");
    },
  );

  it("keeps reconcile auto-opened agents out of the focused explorer pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.focusPane(workspaceKey, "explorer");

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: ["agent-1", "agent-2"],
      autoOpenAgentIds: ["agent-1", "agent-2"],
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, "agent_agent-2")?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
  });

  it("opens file content in Explorer when explicitly preferred there", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const paneId = store.showExplorerSidebar(workspaceKey) as string;
    const tabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
      parentTabId: "agent_agent-a",
      placement: { mode: "prefer", paneId },
    });
    const createdState = workspaceLayoutStore.getState();
    const explorerSidebarPaneId = createdState.explorerSidebarPaneIdByWorkspace[workspaceKey];

    expect(explorerSidebarPaneId).toBe("explorer");
    expect(
      findPaneContainingTab(createdState.layoutByWorkspace[workspaceKey].root, tabId!)?.id,
    ).toBe("explorer");
    expect(collectAllTabs(createdState.layoutByWorkspace[workspaceKey].root)).toContainEqual({
      tabId,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      createdAt: expect.any(Number),
    });

    store.hideExplorerSidebar(workspaceKey);
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
      placement: { mode: "prefer", paneId: store.showExplorerSidebar(workspaceKey) as string },
    });
    const revealedLayout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(findPaneById(revealedLayout.root, explorerSidebarPaneId)?.hidden).toBeUndefined();
    expect(findPaneContainingTab(revealedLayout.root, "file_/repo/worktree/b.ts")?.id).toBe(
      "explorer",
    );
  });

  it("leaves a canonical duplicate file tab where the user placed it in Explorer", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    useWorkspaceLayoutIds("explorer");
    const paneId = store.showExplorerSidebar(workspaceKey) as string;
    const tabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    });
    store.hideExplorerSidebar(workspaceKey);

    store.showExplorerSidebar(workspaceKey);
    const duplicateTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts", lineStart: 12 },
      intent: "reveal",
      parentTabId: "agent_agent-a",
      placement: { mode: "prefer", paneId },
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(duplicateTabId).toBe(tabId);
    expect(collectAllTabs(layout.root).filter((tab) => tab.tabId === tabId)).toHaveLength(1);
    expect(findPaneContainingTab(layout.root, tabId as string)?.id).toBe("explorer");
    expect(findPaneById(layout.root, paneId)?.hidden).toBeUndefined();
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, paneId)?.focusedTabId).toBe(tabId);
  });

  it("restores workspace and agent plugin panel targets", async () => {
    const workspaceTarget = {
      kind: "plugin",
      pluginId: "review",
      panelId: "summary",
      context: "workspace",
    };
    const agentTarget = {
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "agent",
      agentId: "agent-1",
    };
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: {
            workspace: {
              root: {
                kind: "pane",
                pane: {
                  id: "main",
                  tabIds: ["workspace-panel", "agent-panel"],
                  focusedTabId: "agent-panel",
                  tabs: [
                    { tabId: "workspace-panel", target: workspaceTarget, createdAt: 1 },
                    { tabId: "agent-panel", target: agentTarget, createdAt: 2 },
                  ],
                },
              },
              focusedPaneId: "main",
            },
          },
          splitSizesByWorkspace: {},
        },
        version: 1,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    const layout = restored.getState().layoutByWorkspace.workspace;
    expect(layout && collectContentTabs(layout.root).map((tab) => tab.target)).toEqual([
      workspaceTarget,
      agentTarget,
    ]);
  });

  it("opens tabs into the focused pane and focuses duplicate opens instead of creating them", () => {
    useWorkspaceLayoutIds("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    expect(splitPaneId).toBe("pane_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

    store.focusPane(workspaceKey, "main");
    const duplicateTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstTabId).toBe("file_/repo/worktree/a.ts");
    expect(secondTabId).toBe("file_/repo/worktree/b.ts");
    expect(duplicateTabId).toBe(secondTabId);
    expect(layout.focusedPaneId).toBe("pane_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(collectContentTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      "file_/repo/worktree/a.ts",
      "file_/repo/worktree/b.ts",
    ]);
  });

  it("updates an existing file tab when opening the same path at a new line range", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
        lineStart: 5,
      },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
        lineStart: 10,
        lineEnd: 12,
      },
      intent: "reveal",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstTabId).toBe("file_/repo/worktree/a.ts");
    expect(secondTabId).toBe(firstTabId);
    expect(collectContentTabs(layout.root)).toEqual([
      {
        tabId: "file_/repo/worktree/a.ts",
        target: {
          kind: "file",
          path: "/repo/worktree/a.ts",
          lineStart: 10,
          lineEnd: 12,
        },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("openTab background intent on an existing target is a no-op", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const duplicateTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "background",
    });
    const layoutAfter = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layoutAfter.root, "main")!;

    expect(duplicateTabId).toBe(firstTabId);
    expect(pane.tabIds).toEqual([firstTabId, secondTabId]);
    expect(pane.focusedTabId).toBe(secondTabId);
  });

  it("closing a focused middle tab selects the tab to its right", () => {
    const workspaceKey = createWorkspaceKey();
    const firstTabId = "draft-1";
    const closedTabId = "draft-2";
    const rightTabId = "draft-3";

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: createPane({
            id: "main",
            tabIds: [firstTabId, closedTabId, rightTabId],
            focusedTabId: closedTabId,
          }),
          focusedPaneId: "main",
        },
      },
    }));

    workspaceLayoutStore.getState().closeTab(workspaceKey, closedTabId);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;

    expect(pane.tabIds).toEqual([firstTabId, rightTabId]);
    expect(pane.focusedTabId).toBe(rightTabId);
  });

  it("closing a focused child tab returns to its parent before using tab-strip order", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const parentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "agent",
        agentId: "draft-parent",
      },
      intent: "reveal",
    });
    const childTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "draft-child" },
      intent: "reveal",
      parentTabId: parentTabId!,
    });
    const rightTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "agent",
        agentId: "draft-right",
      },
      intent: "reveal",
    });
    store.focusTab(workspaceKey, childTabId!);

    workspaceLayoutStore.getState().closeTab(workspaceKey, childTabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;

    expect(pane.tabIds).toEqual([parentTabId, rightTabId]);
    expect(pane.focusedTabId).toBe(parentTabId);
  });

  it("closing a focused last tab selects the tab to its left", () => {
    const workspaceKey = createWorkspaceKey();
    const leftTabId = "draft-1";
    const closedTabId = "draft-2";

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: createPane({
            id: "main",
            tabIds: [leftTabId, closedTabId],
            focusedTabId: closedTabId,
          }),
          focusedPaneId: "main",
        },
      },
    }));

    workspaceLayoutStore.getState().closeTab(workspaceKey, closedTabId);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;

    expect(pane.tabIds).toEqual([leftTabId]);
    expect(pane.focusedTabId).toBe(leftTabId);
  });

  it("unfocuses and restores the previous focused pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const token = store.unfocusPane(workspaceKey);
    expect(token).toBeTruthy();
    expect(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId,
    ).toBeNull();

    store.restorePaneFocus(workspaceKey, token!);
    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "main",
    );
  });

  it("does not restore stale focus after another pane is focused", () => {
    useWorkspaceLayoutIds("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "draft-1" },
      intent: "reveal",
    });
    store.splitPane(workspaceKey, {
      tabId: firstTabId!,
      targetPaneId: "main",
      position: "right",
    });
    store.focusPane(workspaceKey, "main");

    const token = store.unfocusPane(workspaceKey);
    store.focusPane(workspaceKey, "pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    store.restorePaneFocus(workspaceKey, token!);

    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
  });

  it("waits for nested focus restorations before restoring", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const outerToken = store.unfocusPane(workspaceKey);
    const innerToken = store.unfocusPane(workspaceKey);

    store.restorePaneFocus(workspaceKey, outerToken!);
    expect(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId,
    ).toBeNull();

    store.restorePaneFocus(workspaceKey, innerToken!);
    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "main",
    );
  });

  it("focusTab moves workspace focus to the pane containing the tab", () => {
    useWorkspaceLayoutIds("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const fileTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "reveal",
    });
    const terminalTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "agent",
        agentId: "term-1",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: terminalTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.focusTab(workspaceKey, fileTabId!);
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout.focusedPaneId).toBe("main");

    store.focusTab(workspaceKey, terminalTabId!);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;
    expect(splitPaneId).toBe("pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(layout.focusedPaneId).toBe(splitPaneId);
    expect(findPaneById(layout.root, splitPaneId)?.focusedTabId).toBe(terminalTabId);
  });

  it("replaceTab keeps a pane-local replacement beside an existing matching target", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstDraftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "agent",
        agentId: "draft-agent-1",
      },
      intent: "reveal",
    });
    const firstAgentTabId = store.replaceTab(workspaceKey, firstDraftTabId!, {
      kind: "agent",
      agentId: "agent-1",
    });
    const secondDraftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "agent",
        agentId: "draft-agent-2",
      },
      intent: "reveal",
    });

    const nextTabId = store.replaceTab(workspaceKey, secondDraftTabId!, {
      kind: "agent",
      agentId: "agent-1",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstAgentTabId).toBe(firstDraftTabId);
    expect(nextTabId).not.toBe(firstDraftTabId);
    expect(collectContentTabs(layout.root)).toHaveLength(2);
    expect(collectAllTabs(layout.root).filter((tab) => tab.target.kind === "agent")).toHaveLength(
      2,
    );
  });

  it("reorderTabs reorders tabs within the focused pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const thirdTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/c.ts",
      },
      intent: "reveal",
    });

    store.reorderTabs(workspaceKey, [thirdTabId!, firstTabId!]);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(findPaneById(layout.root, "main")).toEqual({
      id: "main",
      tabIds: [thirdTabId!, firstTabId!, secondTabId!],
      focusedTabId: thirdTabId,
      tabs: [
        {
          tabId: thirdTabId,
          target: { kind: "file", path: "/repo/worktree/c.ts" },
          createdAt: expect.any(Number),
        },
        {
          tabId: firstTabId,
          target: { kind: "file", path: "/repo/worktree/a.ts" },
          createdAt: expect.any(Number),
        },
        {
          tabId: secondTabId,
          target: { kind: "file", path: "/repo/worktree/b.ts" },
          createdAt: expect.any(Number),
        },
      ],
    });
  });

  it("reorderTabsInPane reorders tabs in the requested pane without changing focused pane", () => {
    useWorkspaceLayoutIds("34343434-3434-3434-3434-343434343434");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const thirdTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/c.ts",
      },
      intent: "reveal",
    });
    const fourthTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/d.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: thirdTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.moveTabToPane(workspaceKey, fourthTabId!, splitPaneId!);
    store.focusPane(workspaceKey, "main");
    store.reorderTabsInPane(workspaceKey, splitPaneId!, [fourthTabId!, thirdTabId!]);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(splitPaneId).toBe("pane_34343434-3434-3434-3434-343434343434");
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, splitPaneId)).toEqual({
      id: splitPaneId,
      tabIds: [fourthTabId!, thirdTabId!],
      focusedTabId: fourthTabId,
      tabs: [
        {
          tabId: fourthTabId,
          target: { kind: "file", path: "/repo/worktree/d.ts" },
          createdAt: expect.any(Number),
        },
        {
          tabId: thirdTabId,
          target: { kind: "file", path: "/repo/worktree/c.ts" },
          createdAt: expect.any(Number),
        },
      ],
    });
  });

  it("focusPane switches workspace focus to a different pane", () => {
    useWorkspaceLayoutIds("56565656-5656-5656-5656-565656565656");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.focusPane(workspaceKey, "main");
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout.focusedPaneId).toBe("main");

    store.focusPane(workspaceKey, splitPaneId!);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;

    expect(splitPaneId).toBe("pane_56565656-5656-5656-5656-565656565656");
    expect(layout.focusedPaneId).toBe(splitPaneId);
  });

  it("focusPane does not turn Explorer into workspace focus", () => {
    useWorkspaceLayoutIds("57575757-5757-5757-5757-575757575757");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const paneId = store.showExplorerSidebar(workspaceKey)!;
    store.focusPane(workspaceKey, "main");
    store.hideExplorerSidebar(workspaceKey);

    store.focusPane(workspaceKey, paneId);

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, paneId)?.hidden).toBe(true);
  });

  it("closeTab collapses an emptied pane and keeps the nearest sibling focused", () => {
    useWorkspaceLayoutIds("cccccccc-cccc-cccc-cccc-cccccccccccc");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.closeTab(workspaceKey, secondTabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(splitPaneId).toBe("pane_cccccccc-cccc-cccc-cccc-cccccccccccc");
    expect(layout.focusedPaneId).toBe("main");
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main"]);
  });

  it("splitPane preserves four user-created levels beneath the explorer split", () => {
    useWorkspaceLayoutIds(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
      "44444444-4444-4444-4444-444444444444",
      "55555555-5555-5555-5555-555555555555",
      "66666666-6666-6666-6666-666666666666",
      "77777777-7777-7777-7777-777777777777",
      "88888888-8888-8888-8888-888888888888",
    );

    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const a = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const b = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
    });
    const c = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/c.ts" },
      intent: "reveal",
    });
    const d = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/d.ts" },
      intent: "reveal",
    });
    const e = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/e.ts" },
      intent: "reveal",
    });

    expect(a).toBeTruthy();
    const pane1 = store.splitPane(workspaceKey, {
      tabId: b!,
      targetPaneId: "main",
      position: "right",
    });
    const pane2 = store.splitPane(workspaceKey, {
      tabId: c!,
      targetPaneId: pane1!,
      position: "bottom",
    });
    const pane3 = store.splitPane(workspaceKey, {
      tabId: d!,
      targetPaneId: pane2!,
      position: "right",
    });
    const pane4 = store.splitPane(workspaceKey, {
      tabId: e!,
      targetPaneId: pane3!,
      position: "bottom",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    // The first split joins the root group instead of nesting under it, so it spends a pane id and
    // no group id, and the four user splits all fit inside the depth cap.
    expect(pane1).toBe("pane_11111111-1111-1111-1111-111111111111");
    expect(pane2).toBe("pane_22222222-2222-2222-2222-222222222222");
    expect(pane3).toBe("pane_44444444-4444-4444-4444-444444444444");
    expect(pane4).toBe("pane_66666666-6666-6666-6666-666666666666");
    expect(getTreeDepth(layout.root)).toBe(5);
  });

  it("moveTabToPane collapses the source pane when its last tab moves out", () => {
    useWorkspaceLayoutIds("dddddddd-dddd-dddd-dddd-dddddddddddd");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const leftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "reveal",
    });
    const rightTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: rightTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.moveTabToPane(workspaceKey, leftTabId!, splitPaneId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(layout.focusedPaneId).toBe(splitPaneId);
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([splitPaneId!]);
    expect(findPaneById(layout.root, splitPaneId)?.tabIds).toEqual([
      "file_/repo/worktree/b.ts",
      "file_/repo/worktree/a.ts",
    ]);
  });

  it("closeTab cascades group unwrapping when an inner split collapses to a single pane", () => {
    useWorkspaceLayoutIds(
      "78787878-7878-7878-7878-787878787878",
      "89898989-8989-8989-8989-898989898989",
      "9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a9a",
    );

    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const thirdTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/c.ts",
      },
      intent: "reveal",
    });
    const paneBId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });
    const paneCId = store.splitPane(workspaceKey, {
      tabId: thirdTabId!,
      targetPaneId: paneBId!,
      position: "bottom",
    });

    store.closeTab(workspaceKey, secondTabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(paneBId).toBe("pane_78787878-7878-7878-7878-787878787878");
    expect(paneCId).toBe("pane_89898989-8989-8989-8989-898989898989");
    expect(layout.focusedPaneId).toBe(paneCId);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual(["file_/repo/worktree/a.ts"]);
    expect(findPaneById(layout.root, paneCId)?.tabIds).toEqual(["file_/repo/worktree/c.ts"]);
    expect(findPaneById(layout.root, "explorer")?.hidden).toBe(true);
  });

  it("openTab focuses the existing tab instead of creating a duplicate entry", () => {
    useWorkspaceLayoutIds("abababab-abab-abab-abab-abababababab");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.focusPane(workspaceKey, "main");
    const duplicateTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(splitPaneId).toBe("pane_abababab-abab-abab-abab-abababababab");
    expect(duplicateTabId).toBe(secondTabId);
    expect(layout.focusedPaneId).toBe(splitPaneId);
    expect(collectContentTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      "file_/repo/worktree/a.ts",
      "file_/repo/worktree/b.ts",
    ]);
  });

  it("resizeSplit keeps sizes normalized while enforcing the minimum proportion", () => {
    useWorkspaceLayoutIds(
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "11111111-1111-1111-1111-111111111111",
    );

    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const a = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const b = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
    });
    const c = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/c.ts" },
      intent: "reveal",
    });

    expect(a).toBeTruthy();
    const rightPaneId = store.splitPane(workspaceKey, {
      tabId: b!,
      targetPaneId: "main",
      position: "right",
    });
    const farRightPaneId = store.splitPane(workspaceKey, {
      tabId: c!,
      targetPaneId: rightPaneId!,
      position: "bottom",
    });

    const splitRoot = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root;
    const splitGroup = expectGroup(splitRoot);
    const nestedGroup = expectGroup(
      splitGroup.group.children.find((child) => child.kind === "group")!,
    );
    store.resizeSplit(workspaceKey, nestedGroup.group.id, [0.01, 0.99]);

    const resizedRoot = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root;
    const resizedGroup = expectGroup(resizedRoot);
    const resizedNestedGroup = expectGroup(
      resizedGroup.group.children.find((child) => child.kind === "group")!,
    );
    const total = resizedNestedGroup.group.sizes.reduce((sum, size) => sum + size, 0);

    expect(rightPaneId).toBe("pane_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
    expect(farRightPaneId).toBe("pane_ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(resizedNestedGroup.group.sizes[0]).toBeGreaterThanOrEqual(0.1);
    expect(resizedNestedGroup.group.sizes[1]).toBeGreaterThanOrEqual(0.1);
    expect(total).toBeCloseTo(1, 10);
  });

  it("persists explicit agent opens per workspace", () => {
    const workspaceKey = createWorkspaceKey();
    const otherWorkspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: "ws-other-worktree",
    });

    expect(otherWorkspaceKey).toBeTruthy();

    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    store.openTab({
      workspaceKey: otherWorkspaceKey as string,
      target: { kind: "agent", agentId: "agent-2" },
      intent: "reveal",
      pin: true,
    });

    let state = workspaceLayoutStore.getState();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
    expect(Array.from(state.pinnedAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    store.unpinAgent(workspaceKey, "agent-1");

    state = workspaceLayoutStore.getState();
    expect(state.pinnedAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    const partialize = workspaceLayoutStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    expect(partialize?.(state)).toHaveProperty("pinnedAgentIdsByWorkspace", {
      [otherWorkspaceKey as string]: ["agent-2"],
    });
  });

  it("keeps hidden agent intents in memory per workspace without persisting them", () => {
    const workspaceKey = createWorkspaceKey();
    const otherWorkspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: "ws-other-worktree",
    });

    expect(otherWorkspaceKey).toBeTruthy();

    const store = workspaceLayoutStore.getState();
    store.hideAgent(workspaceKey, "agent-1");
    store.hideAgent(workspaceKey, "agent-1");
    store.hideAgent(otherWorkspaceKey as string, "agent-2");

    let state = workspaceLayoutStore.getState();
    expect(Array.from(state.hiddenAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
    expect(Array.from(state.hiddenAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    store.unhideAgent(workspaceKey, "agent-1");

    state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.hiddenAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    const partialize = workspaceLayoutStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    expect(partialize?.(state)).toEqual({
      layoutByWorkspace: {},
      pinnedAgentIdsByWorkspace: {},
      splitSizesByWorkspace: {},
      explorerSidebarWidthByWorkspace: {},
      explorerPaneIdByWorkspace: {},
      sidePaneIdByWorkspace: {},
    });
  });

  it("reconcileTabs preserves a draft-origin agent tab id when there is no duplicate", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: {
            kind: "pane",
            pane: {
              id: "main",
              tabIds: ["draft-agent"],
              focusedTabId: "draft-agent",
              tabs: [
                {
                  tabId: "draft-agent",
                  target: { kind: "agent", agentId: "agent-1" },
                  createdAt: 1,
                },
              ],
            } as SplitPane,
          },
          focusedPaneId: "main",
        },
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(collectContentTabs(layout.root)).toEqual([
      {
        tabId: "draft-agent",
        target: { kind: "agent", agentId: "agent-1" },
        createdAt: 1,
      },
    ]);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe("draft-agent");
  });

  it("reconcileTabs does not re-add locally hidden agent tabs", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.setState((state) => ({
      ...state,
      hiddenAgentIdsByWorkspace: {
        [workspaceKey]: new Set<string>(["agent-1"]),
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
    });

    expect(contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey))).toEqual([]);
  });

  it("reconcileTabs lands on an existing agent instead of the initial New tab", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual(["agent_agent-1"]);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe("agent_agent-1");
  });

  it.each([
    ["main", "explorer"],
    ["pane_ordinary", "pane_generated_explorer"],
  ])(
    "reconcileTabs stays stable when startup removes a duplicate from %s beside %s",
    (ordinaryPaneId, explorerPaneId) => {
      const workspaceKey = createWorkspaceKey();
      const store = workspaceLayoutStore.getState();
      workspaceLayoutStore.setState((state) => ({
        layoutByWorkspace: {
          ...state.layoutByWorkspace,
          [workspaceKey]: {
            root: {
              kind: "group",
              group: {
                id: "root",
                direction: "horizontal",
                sizes: [0.78, 0.22],
                children: [
                  createPane({
                    id: ordinaryPaneId,
                    tabIds: ["draft-origin-agent"],
                    focusedTabId: "draft-origin-agent",
                    targetsByTabId: {
                      "draft-origin-agent": { kind: "agent", agentId: "agent-1" },
                    },
                  }),
                  createPane({
                    id: explorerPaneId,
                    tabIds: ["files", "agent_agent-1"],
                    focusedTabId: "agent_agent-1",
                    targetsByTabId: {
                      files: { kind: "files" },
                      "agent_agent-1": { kind: "agent", agentId: "agent-1" },
                    },
                  }),
                ],
              },
            },
            focusedPaneId: ordinaryPaneId,
          },
        },
        explorerSidebarPaneIdByWorkspace: {
          ...state.explorerSidebarPaneIdByWorkspace,
          [workspaceKey]: explorerPaneId,
        },
      }));

      store.reconcileTabs(workspaceKey, {
        agentsHydrated: false,
        activeAgentIds: [],
        autoOpenAgentIds: [],
      });
      expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].focusedPaneId).toBe(
        ordinaryPaneId,
      );

      workspaceLayoutStore.setState((state) => ({
        layoutByWorkspace: {
          ...state.layoutByWorkspace,
          [workspaceKey]: {
            ...state.layoutByWorkspace[workspaceKey],
            focusedPaneId: explorerPaneId,
          },
        },
      }));

      const emptySnapshot = {
        agentsHydrated: true,
        activeAgentIds: [],
        autoOpenAgentIds: [],
      };
      store.reconcileTabs(workspaceKey, emptySnapshot);
      store.reconcileTabs(workspaceKey, emptySnapshot);
      const afterSecondReconcile = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
      store.reconcileTabs(workspaceKey, emptySnapshot);
      const afterThirdReconcile = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

      expect(afterThirdReconcile).toBe(afterSecondReconcile);
      const mainTabs = collectAllTabs(afterThirdReconcile.root).filter(
        (tab) => findPaneContainingTab(afterThirdReconcile.root, tab.tabId)?.id === ordinaryPaneId,
      );
      expect(mainTabs).toEqual([]);
    },
  );

  it("reconcileTabs does not auto-open subagents omitted from autoOpenAgentIds", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: ["parent-agent", "child-agent"],
      autoOpenAgentIds: ["parent-agent"],
    });

    expect(
      contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).map(
        (tab) => tab.tabId,
      ),
    ).toEqual(["agent_parent-agent"]);
  });

  it("reconcileTabs keeps manually opened subagent tabs that remain active", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "child-agent" },
      intent: "reveal",
    });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: ["parent-agent", "child-agent"],
      autoOpenAgentIds: ["parent-agent"],
    });

    expect(
      contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).map(
        (tab) => tab.tabId,
      ),
    ).toEqual(["agent_child-agent", "agent_parent-agent"]);
  });

  it("reconcileTabs prunes archived subagent tabs that are no longer active", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "child-agent" },
      intent: "reveal",
    });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: ["parent-agent"],
      autoOpenAgentIds: ["parent-agent"],
    });

    expect(
      contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).map(
        (tab) => tab.tabId,
      ),
    ).toEqual(["agent_parent-agent"]);
  });

  it("openTab reveal intent reopens hidden subagent tabs and clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "child-agent");
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: ["child-agent"],
      autoOpenAgentIds: [],
    });

    expect(contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey))).toEqual([]);

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "child-agent" },
      intent: "reveal",
    });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(contentTabs(state.getWorkspaceTabs(workspaceKey)).map((tab) => tab.tabId)).toEqual([
      "agent_child-agent",
    ]);
  });

  it("explicitly opening an agent tab clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(contentTabs(state.getWorkspaceTabs(workspaceKey)).map((tab) => tab.tabId)).toEqual([
      "agent_agent-1",
    ]);
  });

  it("opening a pinned agent clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    expect(workspaceLayoutStore.getState().hiddenAgentIdsByWorkspace[workspaceKey]).toBeDefined();

    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
  });

  it("keeps an explicitly opened agent when its detail leaves client memory", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "archived-agent" },
      intent: "reveal",
      pin: true,
    });
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
    });

    expect(
      store
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.tabId),
    ).toEqual(["agent_archived-agent"]);

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
    });

    expect(
      store
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.tabId),
    ).toEqual(["agent_archived-agent"]);

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
    });

    expect(
      store
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.tabId),
    ).toEqual(["agent_archived-agent"]);

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "archived-agent" },
      intent: "reveal",
      pin: true,
    });
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
    });

    expect(
      store
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.tabId),
    ).toEqual(["agent_archived-agent"]);
  });

  it("restores the selected historical agent before any server data or cache is available", async () => {
    const workspaceKey = createWorkspaceKey();
    workspaceLayoutStore.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "archived-agent" },
      intent: "reveal",
      pin: true,
    });
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await restored.persist.rehydrate();
    restored.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
    });
    const layout = restored.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(
      "agent_archived-agent",
    );
  });

  it("follows server archive after an explicitly opened agent becomes active", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
      pin: true,
    });
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
    });
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
    });
    expect(store.getWorkspaceTabs(workspaceKey).some((tab) => tab.target.kind === "agent")).toBe(
      false,
    );
  });

  it("atomically reveals, focuses, and pins an archived agent against reconciliation", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "first-agent" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "second-agent" },
      intent: "reveal",
    });
    store.hideAgent(workspaceKey, "archived-agent");

    const archivedTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "archived-agent" },
      intent: "reveal",
      pin: true,
    });
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      activeAgentIds: ["first-agent", "second-agent"],
      autoOpenAgentIds: ["first-agent", "second-agent"],
    });

    const state = workspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    expect(contentTabs(state.getWorkspaceTabs(workspaceKey)).map((tab) => tab.tabId)).toContain(
      archivedTabId,
    );
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(archivedTabId);
    expect(Array.from(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? [])).toContain(
      "archived-agent",
    );
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
  });

  it("retargeting a tab to an agent clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    const tabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    store.replaceTab(workspaceKey, tabId!, { kind: "agent", agentId: "agent-1" });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
  });

  it("closePane removes an emptied main pane and moves focus to the surviving pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const keptTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "kept" },
      intent: "reveal",
    });
    useWorkspaceLayoutIds("split", "group-1");
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: keptTabId as string,
      targetPaneId: "main",
      position: "right",
    });
    const strandedTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "agent",
        agentId: "stranded",
      },
      intent: "reveal",
    });
    store.moveTabToPane(workspaceKey, strandedTabId as string, "main");
    store.closeTab(workspaceKey, strandedTabId as string);
    expect(
      findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, "main"),
    ).toBeTruthy();

    store.closePane(workspaceKey, "main");

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([splitPaneId]);
    expect(layout.focusedPaneId).toBe(splitPaneId);
  });

  it("closePane drops the tabs the pane was still holding", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const keptTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "kept" },
      intent: "reveal",
    });
    useWorkspaceLayoutIds("split", "group-1");
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: keptTabId as string,
      targetPaneId: "main",
      position: "right",
    });
    const doomedTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "doomed" },
      intent: "reveal",
    });
    store.moveTabToPane(workspaceKey, doomedTabId as string, "main");

    store.closePane(workspaceKey, "main");

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectContentTabs(layout.root).map((tab) => tab.tabId)).toEqual([keptTabId]);
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([splitPaneId]);
  });

  it("closePane refuses to close the last visible pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const before = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    store.closePane(workspaceKey, "main");

    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]).toBe(before);
  });

  it("closePane hides Explorer instead of removing it, keeping its tabs", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "kept" },
      intent: "reveal",
    });
    const paneId = store.showExplorerSidebar(workspaceKey) as string;
    const filesTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "files" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    });

    store.closePane(workspaceKey, paneId);

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, paneId)?.hidden).toBe(true);
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toContain(filesTabId);
    expect(store.showExplorerSidebar(workspaceKey)).toBe(paneId);
    expect(
      findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, paneId)
        ?.hidden,
    ).toBeUndefined();
  });

  it("a preferred open focuses an existing tab where the user left it", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const explorerSidebarPaneId = store.showExplorerSidebar(workspaceKey) as string;
    const fileTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "reveal",
      placement: { mode: "prefer", paneId: explorerSidebarPaneId },
    }) as string;
    store.moveTabToPane(workspaceKey, fileTabId, "main");

    const reopened = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "reveal",
      placement: { mode: "prefer", paneId: explorerSidebarPaneId },
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(reopened).toBe(fileTabId);
    expect(findPaneContainingTab(layout.root, fileTabId)?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
  });
  it("keeps the final ordinary pane when Explorer is visible", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const agentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const paneId = store.showExplorerSidebar(workspaceKey) as string;
    const before = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    store.closePane(workspaceKey, "main");

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout).toBe(before);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([agentTabId]);
    expect(findPaneById(layout.root, paneId)?.hidden).toBeUndefined();
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main", paneId]);
  });

  it("canDismissPaneInLayout treats Explorer separately from ordinary panes", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const loadedFinal = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    // Only `main` is on screen; Explorer is present but hidden.
    expect(collectAllPanes(loadedFinal.root).map((pane) => pane.id)).toEqual(["main"]);
    expect(canDismissPaneInLayout(loadedFinal, "main", "explorer")).toBe(false);
    expect(canDismissPaneInLayout(loadedFinal, "explorer", "explorer")).toBe(false);

    const paneId = store.showExplorerSidebar(workspaceKey) as string;
    const bothVisible = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(canDismissPaneInLayout(bothVisible, "main", paneId)).toBe(false);
    expect(canDismissPaneInLayout(bothVisible, paneId, paneId)).toBe(true);
  });

  it("closePane on a loaded final pane keeps the pane and every tab in it", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const agentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const before = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    store.closePane(workspaceKey, "main");

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout).toBe(before);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([agentTabId]);
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main"]);
  });
});
