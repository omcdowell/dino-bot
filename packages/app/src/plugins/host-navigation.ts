import type { PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { createPluginHostNavigation } from "./host-navigation-model";

const hostNavigationOwner = {
  openAgent: navigateToAgent,
  openWorkspace: navigateToWorkspace,
  createBrowser: createWorkspaceBrowser,
  resolveWorkspace: ({ serverId, workspaceId }: { serverId: string; workspaceId: string }) =>
    resolveWorkspaceMapKeyByIdentity({
      workspaces: useSessionStore.getState().sessions[serverId]?.workspaces,
      workspaceId,
    }),
};

export function usePluginHostNavigation(
  serverId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return useMemo(
    () =>
      createPluginHostNavigation(serverId, {
        ...hostNavigationOwner,
        browserAvailable: getIsElectron(),
      }),
    [serverId],
  );
}

/** Navigation for a sidebar item: `beforeNavigate` closes the item's popover and the compact drawer. */
export function usePluginSidebarNavigation(
  serverId: string,
  beforeNavigate: () => void,
): NonNullable<PluginSidebarItemProps["navigation"]> {
  return useMemo(
    () =>
      createPluginHostNavigation(
        serverId,
        { ...hostNavigationOwner, browserAvailable: getIsElectron() },
        beforeNavigate,
      ),
    [beforeNavigate, serverId],
  );
}
