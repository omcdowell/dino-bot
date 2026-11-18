import { describe, expect, it, test } from "vitest";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "./identity";
import type { WorkspaceTabTarget } from "./model";

describe("removed tab kinds", () => {
  it.each(["draft", "terminal", "browser", "working_diff", "pull_request", "setup", "new_tab"])(
    "drops a persisted %s tab",
    (kind) => {
      expect(normalizeWorkspaceTabTarget({ kind } as unknown as WorkspaceTabTarget)).toBeNull();
    },
  );
});

describe("provider subagent tab identity", () => {
  test("normalizes and compares the parent and provider child as one tab identity", () => {
    const target = normalizeWorkspaceTabTarget({
      kind: "provider_subagent",
      parentAgentId: " parent-a ",
      subagentId: " child-a ",
    });

    expect(target).toEqual({
      kind: "provider_subagent",
      parentAgentId: "parent-a",
      subagentId: "child-a",
    });
    expect(
      target &&
        workspaceTabTargetsEqual(target, {
          kind: "provider_subagent",
          parentAgentId: "parent-a",
          subagentId: "child-a",
        }),
    ).toBe(true);
  });

  test("does not collide when parent and child ids contain separators", () => {
    const first = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a_b",
      subagentId: "c",
    });
    const second = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a",
      subagentId: "b_c",
    });

    expect(first).not.toBe(second);
  });
});

describe("workspace utility panel identity", () => {
  it.each(["files", "network_status"] as const)(
    "normalizes and deterministically keys %s",
    (kind) => {
      const target = { kind };

      expect(normalizeWorkspaceTabTarget(target)).toEqual(target);
      expect(buildDeterministicWorkspaceTabId(target)).toBe(kind);
      expect(workspaceTabTargetsEqual(target, target)).toBe(true);
    },
  );
});

describe("plugin panel tab identity", () => {
  it("normalizes exact workspace and agent context", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "plugin",
        pluginId: " review ",
        panelId: " details ",
        context: "agent",
        agentId: " agent-1 ",
      }),
    ).toEqual({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "agent",
      agentId: "agent-1",
    });
  });

  it("gives workspace and agent instances distinct stable ids", () => {
    const workspace = buildDeterministicWorkspaceTabId({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "workspace",
    });
    const agent = buildDeterministicWorkspaceTabId({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "agent",
      agentId: "agent-1",
    });

    expect(workspace).toBe("plugin_workspace_6_review_7_details");
    expect(agent).toBe("plugin_agent_6_review_7_details_7_agent-1");
  });
});
