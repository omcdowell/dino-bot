import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

interface HostNavigationOwner {
  openAgent(input: { serverId: string; agentId: string }): void;
  openWorkspace(input: NavigateToWorkspaceInput): void;
}

/**
 * `beforeNavigate` runs once a request is valid and just before it navigates. Sidebar items use it to
 * close their popover and the compact drawer, as their `openScreen` does.
 */
export function createPluginHostNavigation(
  serverId: string,
  owner: HostNavigationOwner,
  beforeNavigate?: () => void,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return {
    openAgent: ({ agentId, serverId: targetServerId }) => {
      beforeNavigate?.();
      owner.openAgent({ serverId: targetServerId ?? serverId, agentId });
    },
    openWorkspace: ({ workspaceId, serverId: targetServerId }) => {
      beforeNavigate?.();
      owner.openWorkspace({ serverId: targetServerId ?? serverId, workspaceId });
    },
  };
}
