/**
 * @vitest-environment jsdom
 */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => true }));
vi.mock("@/constants/platform", () => ({ isNative: true }));
vi.mock("expo-router", () => ({ router: { dismissTo: vi.fn() }, usePathname: () => "/" }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useLastWorkspaceSelection: () => null,
}));
const workspaceNavigation = vi.hoisted(() => ({ setWorkspaceNavigationMobileHome: vi.fn() }));
vi.mock("@/navigation/workspace-route-navigation", () => workspaceNavigation);
vi.mock("./registry", () => ({
  pluginRegistry: { hasCatalog: () => true },
  useInstalledPlugins: () => [
    { serverId: "srv", id: "bots", surfaces: [{ id: "home", mobileHome: true }] },
  ],
}));

import { MobileHomeSync } from "./mobile-home-runtime";
import { MOBILE_HOME_STORAGE_KEY } from "./mobile-home";

describe("MobileHomeSync", () => {
  it("writes the live phone home to the record the cold-start redirect reads", async () => {
    render(<MobileHomeSync />);
    await waitFor(async () =>
      expect(JSON.parse((await AsyncStorage.getItem(MOBILE_HOME_STORAGE_KEY)) ?? "null")).toEqual({
        serverId: "srv",
        pluginId: "bots",
        screenId: "home",
      }),
    );
  });

  // Cold start opened a workspace / "Add a project" because MobileHomeSync was never mounted,
  // so `paseo:mobile-home` was never written (2026-10-08, bots-home build 3).
  it("is mounted by the root layout", () => {
    const layout = readFileSync(join(__dirname, "../app/_layout.tsx"), "utf8");
    expect(layout).toMatch(/<MobileHomeSync \/>/);
  });

  // Opening a chat from the home pushes it over the home (native slide + edge swipe back), which
  // needs the workspace navigator to know the phone home.
  it("tells workspace navigation which screen is the phone home", async () => {
    render(<MobileHomeSync />);
    await waitFor(() =>
      expect(workspaceNavigation.setWorkspaceNavigationMobileHome).toHaveBeenLastCalledWith({
        serverId: "srv",
        pluginId: "bots",
        screenId: "home",
      }),
    );
  });

  it("gives the host stack's chat screen the phone-home push options", () => {
    const layout = readFileSync(join(__dirname, "../app/h/[serverId]/_layout.tsx"), "utf8");
    expect(layout).toMatch(
      /<Stack\.Screen name="workspace\/\[workspaceId\]\/index" options=\{workspaceOptions\} \/>/,
    );
    expect(layout).toMatch(/workspaceScreenOptions\(/);
  });

  it("gives the host stack's plugin screens the push options for screens that open like a chat", () => {
    const layout = readFileSync(join(__dirname, "../app/h/[serverId]/_layout.tsx"), "utf8");
    expect(layout).toMatch(
      /name="plugin\/\[pluginId\]\/\[contributionKind\]\/\[contributionId\]"\s+options=\{pluginOptions\}/,
    );
    expect(layout).toMatch(/isPluginChatScreen: isInstalledPluginChatScreen/);
  });

  it("leaves left-edge touches to the native back swipe in the panel pan", () => {
    const gestures = readFileSync(join(__dirname, "../mobile-panels/gestures.ts"), "utf8");
    expect(gestures).toMatch(/leavesTouchToNativeBack\(touchStartX\.value, chatOverHome\)/);
  });
});
