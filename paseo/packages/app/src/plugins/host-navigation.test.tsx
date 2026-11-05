/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { usePluginHostNavigation, usePluginSidebarNavigation } from "./host-navigation";

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: vi.fn(),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: vi.fn(),
}));

const navigateToAgentMock = vi.mocked(navigateToAgent);
const navigateToWorkspaceMock = vi.mocked(navigateToWorkspace);

describe("usePluginHostNavigation", () => {
  beforeEach(() => {
    navigateToAgentMock.mockReset();
    navigateToWorkspaceMock.mockReset();
  });

  it("opens agents and workspaces on the rendering host", () => {
    const { result } = renderHook(() => usePluginHostNavigation("host-1"));

    act(() => result.current.openAgent({ agentId: "agent-1" }));
    act(() => result.current.openWorkspace({ workspaceId: "workspace-1" }));

    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-1", agentId: "agent-1" });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-1",
      workspaceId: "workspace-1",
    });
  });

  it("keeps the capability stable until the rendering host changes", () => {
    const { result, rerender } = renderHook(({ serverId }) => usePluginHostNavigation(serverId), {
      initialProps: { serverId: "host-1" },
    });
    const initialNavigation = result.current;

    rerender({ serverId: "host-1" });
    expect(result.current).toBe(initialNavigation);

    rerender({ serverId: "host-2" });
    expect(result.current).not.toBe(initialNavigation);

    act(() => result.current.openAgent({ agentId: "agent-2" }));
    act(() => result.current.openWorkspace({ workspaceId: "workspace-2" }));
    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-2", agentId: "agent-2" });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-2",
      workspaceId: "workspace-2",
    });
  });
});

describe("usePluginSidebarNavigation", () => {
  beforeEach(() => {
    navigateToAgentMock.mockReset();
    navigateToWorkspaceMock.mockReset();
  });

  it("runs the sidebar's before-navigate step, then opens the agent on the item's host", () => {
    const order: string[] = [];
    const before = vi.fn(() => order.push("before"));
    navigateToAgentMock.mockImplementation(() => {
      order.push("agent");
    });
    const { result } = renderHook(() => usePluginSidebarNavigation("host-1", before));

    act(() => result.current.openAgent({ agentId: "agent-1" }));

    expect(order).toEqual(["before", "agent"]);
    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-1", agentId: "agent-1" });
  });

  it("opens workspaces the same way", () => {
    const before = vi.fn();
    const { result } = renderHook(() => usePluginSidebarNavigation("host-1", before));

    act(() => result.current.openWorkspace({ workspaceId: "workspace-1" }));

    expect(before).toHaveBeenCalledTimes(1);
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-1",
      workspaceId: "workspace-1",
    });
  });

  it("stays stable while the host and the before step stay the same", () => {
    const before = vi.fn();
    const { result, rerender } = renderHook(
      ({ serverId }) => usePluginSidebarNavigation(serverId, before),
      { initialProps: { serverId: "host-1" } },
    );
    const initial = result.current;
    rerender({ serverId: "host-1" });
    expect(result.current).toBe(initial);
    rerender({ serverId: "host-2" });
    expect(result.current).not.toBe(initial);
  });
});
