import type { PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import { createPluginHostNavigation } from "./host-navigation-model";

const hostNavigationOwner = {
  openAgent: navigateToAgent,
  openWorkspace: navigateToWorkspace,
};

export function usePluginHostNavigation(
  serverId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return useMemo(() => createPluginHostNavigation(serverId, hostNavigationOwner), [serverId]);
}

/** Navigation for a sidebar item: `beforeNavigate` closes the item's popover and the compact drawer. */
export function usePluginSidebarNavigation(
  serverId: string,
  beforeNavigate: () => void,
): NonNullable<PluginSidebarItemProps["navigation"]> {
  return useMemo(
    () => createPluginHostNavigation(serverId, hostNavigationOwner, beforeNavigate),
    [beforeNavigate, serverId],
  );
}
