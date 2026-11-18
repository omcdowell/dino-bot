import { router, type Href } from "expo-router";
import { useCallback } from "react";
import { goToMobileHome, useMobileHome } from "@/plugins/mobile-home-runtime";
import type { MobileHome } from "@/plugins/mobile-home";
import { navigateToLastWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";

export type SettingsView =
  | { kind: "plugin"; serverId: string; pluginId: string; screenId: string }
  | { kind: "root" }
  | { kind: "section"; section: SettingsSectionSlug }
  | { kind: "host"; serverId: string; section: HostSectionSlug };

export function openHostOverview(serverId: string): void {
  router.push(buildSettingsHostSectionRoute(serverId, "host"));
}

export function returnFromSettings(view: SettingsView, mobileHome: MobileHome | null = null): void {
  if (view.kind === "root") {
    // Phones with a plugin home: Settings is opened from the home's "⋯" menu, so leaving it goes
    // back to the home, not to the last workspace (the home replaces the workspace main menu).
    if (mobileHome) {
      goToMobileHome(mobileHome);
      return;
    }
    if (!navigateToLastWorkspace()) {
      router.replace("/");
    }
    return;
  }

  let parent: Href = buildSettingsRoute();
  if (view.kind === "plugin") parent = buildSettingsHostSectionRoute(view.serverId, "plugins");
  router.dismissTo(parent as Href);
}

/** `returnFromSettings` bound to the phone home (null off phones or without a home plugin). */
export function useReturnFromSettings(): (view: SettingsView) => void {
  const mobileHome = useMobileHome();
  return useCallback((view: SettingsView) => returnFromSettings(view, mobileHome), [mobileHome]);
}
