import { describe, expect, it, vi } from "vitest";
import {
  buildBulkCloseConfirmationMessage,
  classifyBulkClosableTabs,
  closeBulkWorkspaceTabs,
} from "@/screens/workspace/workspace-bulk-close";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

function makeAgentTab(id: string): WorkspaceTabDescriptor {
  return {
    key: `agent_${id}`,
    tabId: `agent_${id}`,
    kind: "agent",
    target: { kind: "agent", agentId: id },
  };
}

function makeUtilityTab(id: string): WorkspaceTabDescriptor {
  return {
    key: `plugin_${id}`,
    tabId: `plugin_${id}`,
    kind: "plugin",
    target: { kind: "plugin", pluginId: "p", panelId: id, context: "workspace" },
  };
}

function makeFileTab(path: string): WorkspaceTabDescriptor {
  return {
    key: `file_${path}`,
    tabId: `file_${path}`,
    kind: "file",
    target: { kind: "file", path },
  };
}

describe("workspace bulk close helpers", () => {
  it("classifies agent and passive tabs for shared bulk close handling", () => {
    const groups = classifyBulkClosableTabs([
      makeAgentTab("a1"),
      makeUtilityTab("t1"),
      makeFileTab("/repo/README.md"),
    ]);

    expect(groups).toEqual({
      archiveAgentTabs: [{ tabId: "agent_a1", agentId: "a1" }],
      layoutOnlyAgentTabs: [],
      otherTabs: [
        {
          tabId: "plugin_t1",
          target: { kind: "plugin", pluginId: "p", panelId: "t1", context: "workspace" },
        },
        {
          tabId: "file_/repo/README.md",
          target: { kind: "file", path: "/repo/README.md" },
        },
      ],
    });
  });

  it("separates subagent tabs from agents that archive on close", () => {
    const groups = classifyBulkClosableTabs(
      [makeAgentTab("root"), makeAgentTab("child")],
      (agentId) => (agentId === "child" ? "layout-only" : "archive"),
    );

    expect(groups).toMatchObject({
      archiveAgentTabs: [{ tabId: "agent_root", agentId: "root" }],
      layoutOnlyAgentTabs: [{ tabId: "agent_child", agentId: "child" }],
    });
    expect(buildBulkCloseConfirmationMessage(groups)).toBe(
      "This will archive 1 agent(s) and close 1 tab(s).",
    );
  });

  it("describes mixed destructive bulk close operations in the confirmation copy", () => {
    const message = buildBulkCloseConfirmationMessage(
      classifyBulkClosableTabs([
        makeAgentTab("a1"),
        makeAgentTab("a2"),
        makeUtilityTab("t1"),
        makeFileTab("/repo/README.md"),
      ]),
    );

    expect(message).toBe("This will archive 2 agent(s) and close 2 tab(s).");
  });

  it("describes tab-only bulk closes without archiving", () => {
    const message = buildBulkCloseConfirmationMessage(
      classifyBulkClosableTabs([makeUtilityTab("t1")]),
    );

    expect(message).toBe("This will close 1 tab(s).");
  });

  it("closes all tabs immediately and fires one closeItems RPC in the background", async () => {
    const groups = classifyBulkClosableTabs([
      makeAgentTab("a1"),
      makeUtilityTab("t1"),
      makeUtilityTab("t2"),
      makeFileTab("/repo/README.md"),
    ]);
    const closedTabIds: string[] = [];
    const cleanupCalls: Array<{ tabId: string; target?: WorkspaceTabDescriptor["target"] }> = [];
    const closeItems = vi.fn(async () => ({
      agents: [{ agentId: "a1", archivedAt: "2026-04-01T04:00:00.000Z" }],
      terminals: [],
      requestId: "req-1",
    }));

    await closeBulkWorkspaceTabs({
      groups,
      client: { closeItems },
      closeTab: async (tabId, action) => {
        closedTabIds.push(tabId);
        await action();
      },
      closeWorkspaceTabWithCleanup: (input) => {
        cleanupCalls.push(input);
      },
      closeLayoutOnlyAgent: async () => {},
      logLabel: "all tabs",
    });

    expect(closeItems).toHaveBeenCalledTimes(1);
    expect(closeItems).toHaveBeenCalledWith({
      agentIds: ["a1"],
    });
    expect(closedTabIds).toEqual(["agent_a1", "plugin_t1", "plugin_t2", "file_/repo/README.md"]);
    expect(cleanupCalls).toEqual([
      { tabId: "agent_a1", target: { kind: "agent", agentId: "a1" } },
      {
        tabId: "plugin_t1",
        target: { kind: "plugin", pluginId: "p", panelId: "t1", context: "workspace" },
      },
      {
        tabId: "plugin_t2",
        target: { kind: "plugin", pluginId: "p", panelId: "t2", context: "workspace" },
      },
      { tabId: "file_/repo/README.md", target: { kind: "file", path: "/repo/README.md" } },
    ]);
  });

  it("still closes all tabs when the closeItems RPC fails", async () => {
    const groups = classifyBulkClosableTabs([
      makeAgentTab("a1"),
      makeUtilityTab("t1"),
      makeFileTab("/repo/README.md"),
    ]);
    const closedTabIds: string[] = [];
    const cleanupCalls: Array<{ tabId: string; target?: WorkspaceTabDescriptor["target"] }> = [];
    const warn = vi.fn();

    await closeBulkWorkspaceTabs({
      groups,
      client: {
        closeItems: async () => {
          throw new Error("rpc failed");
        },
      },
      closeTab: async (tabId, action) => {
        closedTabIds.push(tabId);
        await action();
      },
      closeWorkspaceTabWithCleanup: (input) => {
        cleanupCalls.push(input);
      },
      closeLayoutOnlyAgent: async () => {},
      warn,
      logLabel: "others",
    });

    await Promise.resolve();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(closedTabIds).toEqual(["agent_a1", "plugin_t1", "file_/repo/README.md"]);
    expect(cleanupCalls).toEqual([
      { tabId: "agent_a1", target: { kind: "agent", agentId: "a1" } },
      {
        tabId: "plugin_t1",
        target: { kind: "plugin", pluginId: "p", panelId: "t1", context: "workspace" },
      },
      { tabId: "file_/repo/README.md", target: { kind: "file", path: "/repo/README.md" } },
    ]);
  });

  it("closes subagent tabs without sending them to closeItems", async () => {
    const groups = classifyBulkClosableTabs(
      [makeAgentTab("root"), makeAgentTab("child")],
      (agentId) => (agentId === "child" ? "layout-only" : "archive"),
    );
    const closeItems = vi.fn(async () => ({ agents: [], terminals: [], requestId: "req-1" }));
    const preparedSubagents: string[] = [];
    const cleanedTabs: string[] = [];

    await closeBulkWorkspaceTabs({
      groups,
      client: { closeItems },
      closeTab: async (_tabId, action) => action(),
      closeLayoutOnlyAgent: async (agentId) => {
        preparedSubagents.push(agentId);
      },
      closeWorkspaceTabWithCleanup: ({ tabId }) => {
        cleanedTabs.push(tabId);
      },
      logLabel: "others",
    });

    expect(closeItems).toHaveBeenCalledWith({ agentIds: ["root"] });
    expect(preparedSubagents).toEqual(["child"]);
    expect(cleanedTabs).toEqual(["agent_child", "agent_root"]);
  });
});
