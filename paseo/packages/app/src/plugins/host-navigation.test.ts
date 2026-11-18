import { describe, expect, it } from "vitest";
import { createPluginHostNavigation } from "./host-navigation-model";

describe("plugin host navigation", () => {
  it("opens agents and workspaces on the selected or explicit host, and offers no browser", () => {
    const destinations: unknown[] = [];
    const navigation = createPluginHostNavigation("selected", {
      openAgent: (input) => destinations.push(input),
      openWorkspace: (input) => destinations.push(input),
    });
    navigation.openAgent({ agentId: "agent-1" });
    navigation.openWorkspace({ workspaceId: "two", serverId: "remote" });
    expect(destinations).toEqual([
      { serverId: "selected", agentId: "agent-1" },
      { serverId: "remote", workspaceId: "two" },
    ]);
    expect(navigation.openBrowser).toBeUndefined();
  });
});

describe("sidebar item navigation", () => {
  it("closes the sidebar surface before it opens an agent or a workspace", () => {
    const calls: unknown[] = [];
    const navigation = createPluginHostNavigation(
      "selected",
      {
        openAgent: (input) => calls.push({ open: "agent", ...input }),
        openWorkspace: (input) => calls.push({ open: "workspace", ...input }),
      },
      () => calls.push("before"),
    );
    navigation.openAgent({ agentId: "agent-1" });
    navigation.openWorkspace({ workspaceId: "one", serverId: "remote" });
    expect(calls).toEqual([
      "before",
      { open: "agent", serverId: "selected", agentId: "agent-1" },
      "before",
      { open: "workspace", serverId: "remote", workspaceId: "one" },
    ]);
  });
});
