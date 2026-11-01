/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileHome } from "@/plugins/mobile-home";

const mocks = vi.hoisted(() => ({
  dismissTo: vi.fn(),
  replace: vi.fn(),
  navigateToLastWorkspace: vi.fn(() => true),
  mobileHome: null as MobileHome | null,
}));

vi.mock("expo-router", () => ({
  router: { dismissTo: mocks.dismissTo, replace: mocks.replace, push: vi.fn() },
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToLastWorkspace: mocks.navigateToLastWorkspace,
}));
vi.mock("@/plugins/mobile-home-runtime", () => ({
  useMobileHome: () => mocks.mobileHome,
  goToMobileHome: (home: MobileHome) =>
    mocks.dismissTo(`/h/${home.serverId}/plugin/${home.pluginId}/surface/${home.screenId}`),
}));

import { useReturnFromSettings } from "./settings-navigation";

const HOME: MobileHome = { serverId: "srv", pluginId: "bots", screenId: "home" };

describe("useReturnFromSettings", () => {
  beforeEach(() => {
    mocks.dismissTo.mockClear();
    mocks.replace.mockClear();
    mocks.navigateToLastWorkspace.mockClear();
    mocks.mobileHome = null;
  });

  // Sam 2026-10-11: "pressing back from settings goes back to this chat rather than the bot
  // home page." Settings is opened from the home's "⋯" menu; Back went to the last workspace.
  it("returns to the phone home from the Settings root when a home exists", () => {
    mocks.mobileHome = HOME;
    const { result } = renderHook(() => useReturnFromSettings());
    result.current({ kind: "root" });
    expect(mocks.dismissTo).toHaveBeenCalledWith("/h/srv/plugin/bots/surface/home");
    expect(mocks.navigateToLastWorkspace).not.toHaveBeenCalled();
  });

  it("returns to the last workspace from the Settings root without a phone home", () => {
    const { result } = renderHook(() => useReturnFromSettings());
    result.current({ kind: "root" });
    expect(mocks.navigateToLastWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.dismissTo).not.toHaveBeenCalled();
  });

  it("keeps detail screens returning to their settings parent when a home exists", () => {
    mocks.mobileHome = HOME;
    const { result } = renderHook(() => useReturnFromSettings());
    result.current({ kind: "section", section: "general" });
    expect(mocks.dismissTo).toHaveBeenCalledWith("/settings");
    expect(mocks.navigateToLastWorkspace).not.toHaveBeenCalled();
  });

  it("is what the settings screen's Back uses", () => {
    const screen = readFileSync(join(__dirname, "../screens/settings-screen.tsx"), "utf8");
    expect(screen).toMatch(/useReturnFromSettings\(\)/);
    expect(screen).not.toMatch(/\breturnFromSettings\(/);
  });
});
